import { z } from "zod/v3";
import { createHash, randomBytes } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { get as httpsGet } from "node:https";
import { isIP } from "node:net";
import { constants, openSync, closeSync, readFileSync, writeFileSync, renameSync,
  unlinkSync, mkdirSync, lstatSync, fstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No Post.type or PostAttachment.type: removed aggregated attachment fields.
export const PUBLISHED_POST_FIELDS =
  "id,message,created_time,permalink_url,full_picture,is_published,attachments{media_type,title,url}";

type Registrar = { tool(name: string, description: string, schema: any, handler: any): unknown };
type Request = (method: "GET" | "POST" | "DELETE", path: string,
  params?: Record<string, string>, token?: string) => Promise<Record<string, any>>;
class PublishingFailure extends Error {
  constructor(readonly stage: string, readonly code: string,
    readonly writeAttempted: boolean | null = false,
    readonly meta: { meta_code?: number; meta_subcode?: number; http_status?: number } = {}) {
    super(code);
  }
}
function providerCodes(data: any, status: number) {
  const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  return { ...(integer(data?.error?.code) ? { meta_code: data.error.code } : {}),
    ...(integer(data?.error?.error_subcode) ? { meta_subcode: data.error.error_subcode } : {}),
    ...(integer(status) ? { http_status: status } : {}) };
}
function safeFailure(error: unknown) {
  if (error instanceof PublishingFailure) return { failure_stage: error.stage,
    failure_code: error.code, meta_write_attempted: error.writeAttempted, ...error.meta };
  if (error instanceof z.ZodError) return { failure_stage: "validation",
    failure_code: "invalid_arguments", meta_write_attempted: false };
  return { failure_stage: "internal", failure_code: "unclassified_failure",
    meta_write_attempted: null };
}
async function operation<T>(stage: string, write: boolean, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    throw new PublishingFailure(stage,
      error instanceof PublishingFailure ? error.code : "operation_failed", write,
      error instanceof PublishingFailure ? error.meta : {});
  }
}
type StateMap = Iterable<[string, any]> & {
  readonly size: number; get(key: string): any; has(key: string): boolean;
  set(key: string, value: any): unknown; delete(key: string): boolean;
};
type PublishingState = {
  scope: "container_local" | "process_local";
  pending: StateMap; containers: StateMap; reels: StateMap; deletions: StateMap;
  claim(bucket: "containers" | "reels" | "deletions", key: string): () => void;
};
export function createMemoryPublishingState(): PublishingState {
  const locks = new Set<string>();
  return { scope: "process_local", pending: new Map(), containers: new Map(), reels: new Map(), deletions: new Map(),
    claim(bucket, key) {
      const lock = `${bucket}.${key}`;
      if (locks.has(lock)) throw new PublishingFailure("state", "mutation_locked");
      locks.add(lock); return () => { locks.delete(lock); };
    } };
}
// The bridge starts separate stdio children for separate MCP sessions.
// Private container-local files share state across those children, not across replicas/redeploys.
// Token rotation intentionally selects a new namespace; no raw secret is written to disk.
export function createFilePublishingState(root = join(tmpdir(), "meta-publishing-" +
  createHash("sha256").update(mainToken()).digest("hex").slice(0, 32))): PublishingState {
  try { mkdirSync(root, { mode: 0o700 }); }
  catch (error: any) { if (error?.code !== "EEXIST") throw new PublishingFailure("state", "state_unavailable"); }
  const directory = lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
    (process.getuid && directory.uid !== process.getuid()))
    throw new PublishingFailure("state", "unsafe_state_directory");
  function path(bucket: string, key: string, suffix = "json") {
    if (!/^(?:\d{1,64}|[a-f0-9]{48})$/.test(key))
      throw new PublishingFailure("state", "invalid_state_key");
    return join(root, `${bucket}.${key}.${suffix}`);
  }
  function fileMap(bucket: string): StateMap {
    const keys = () => readdirSync(root).filter(n => n.startsWith(`${bucket}.`) && n.endsWith(".json"))
      .map(n => n.slice(bucket.length + 1, -5));
    const map: StateMap = {
      get size() { return keys().length; },
      get(key) {
        let fd: number | undefined;
        try {
          fd = openSync(path(bucket, key), constants.O_RDONLY | constants.O_NOFOLLOW);
          const info = fstatSync(fd);
          if (!info.isFile() || info.size > 1024 * 1024 || (info.mode & 0o077) !== 0 ||
            (process.getuid && info.uid !== process.getuid()))
            throw new PublishingFailure("state", "unsafe_state_record");
          return JSON.parse(readFileSync(fd, "utf8"));
        } catch (error: any) {
          if (error?.code === "ENOENT") return undefined;
          if (error instanceof PublishingFailure) throw error;
          throw new PublishingFailure("state", "state_read_failed");
        } finally { if (fd !== undefined) closeSync(fd); }
      },
      has(key) { return map.get(key) !== undefined; },
      set(key, value) {
        const target = path(bucket, key), data = JSON.stringify(value);
        if (Buffer.byteLength(data) > 1024 * 1024) throw new PublishingFailure("state", "state_record_too_large");
        const temp = `${target}.${randomBytes(16).toString("hex")}.tmp`;
        let fd: number | undefined;
        try {
          fd = openSync(temp, "wx", 0o600); writeFileSync(fd, data); closeSync(fd); fd = undefined;
          renameSync(temp, target);
        } catch { throw new PublishingFailure("state", "state_write_failed"); }
        finally {
          if (fd !== undefined) closeSync(fd);
          try { unlinkSync(temp); } catch {}
        }
        return map;
      },
      // unlink is atomic: only one process can consume a validated approval.
      delete(key) {
        try { unlinkSync(path(bucket, key)); return true; }
        catch (error: any) {
          if (error?.code === "ENOENT") return false;
          if (error instanceof PublishingFailure) throw error;
          throw new PublishingFailure("state", "state_consume_failed");
        }
      },
      *[Symbol.iterator]() { for (const key of keys()) { const value = map.get(key);
        if (value !== undefined) yield [key, value] as [string, any]; } },
    };
    return map;
  }
  return { scope: "container_local", pending: fileMap("pending"),
    containers: fileMap("containers"), reels: fileMap("reels"), deletions: fileMap("deletions"),
    claim(bucket, key) {
      const lock = path(bucket, key, "lock");
      try { const fd = openSync(lock, "wx", 0o600); closeSync(fd); }
      catch { throw new PublishingFailure("state", "mutation_locked"); }
      let released = false;
      // Never auto-expire orphaned locks: reconcile ambiguous writes manually.
      return () => { if (!released) { released = true; try { unlinkSync(lock); } catch {} } };
    } };
}
const id = z.string().regex(/^\d+$/);
const publicUrl = z.string().url().refine(value => {
  const u = new URL(value);
  return u.protocol === "https:" && !u.username && !u.password;
}, "Use a public HTTPS URL without embedded credentials");
const approval = {
  approval_token: z.string().optional(),
  confidence: z.literal("approved").optional(),
};
export const facebookPostSchema = z.object({
  page_id: id,
  message: z.string().max(63206).default(""),
  link: publicUrl.optional(),
  photo_url: publicUrl.optional(),
  ...approval,
}).strict().superRefine((a, ctx) => {
  if ((!a.message.trim() && !a.link && !a.photo_url) || (a.link && a.photo_url))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide content; link and photo_url are mutually exclusive." });
});
export const instagramPostSchema = z.object({
  ig_account_id: id,
  media_type: z.enum(["IMAGE", "REELS"]),
  media_url: publicUrl,
  caption: z.string().max(2200).default(""),
  share_to_feed: z.boolean().default(true),
  cover_url: publicUrl.optional().describe("Reels only: public JPEG cover, maximum 8 MB. Convert PNG covers to JPEG first."),
  ...approval,
}).strict();

export const facebookReelSchema = z.object({
  page_id: id,
  video_url: publicUrl,
  description: z.string().max(63206).default(""),
  cover_url: publicUrl.optional().describe("Optional public JPEG/PNG cover, maximum 8 MB. A requested cover is never silently dropped."),
  audience: z.literal("PUBLIC").default("PUBLIC"),
  ...approval,
}).strict();

// Cover bytes are fetched locally for Meta\x27s multipart thumbnails endpoint.
// IPv4-only, public DNS answers, connection-pinned lookup, no redirects or credentials.
export function isPublicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 ||
      (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 ||
      (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
function imageType(bytes: Uint8Array): "image/jpeg" | "image/png" {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  throw new Error("Cover must be JPEG or PNG");
}
export async function loadFacebookCover(value: string,
  dns: typeof resolve4 = resolve4, get: typeof httpsGet = httpsGet): Promise<Uint8Array> {
  const u = new URL(publicUrl.parse(value));
  if ((u.port && u.port !== "443") || isIP(u.hostname) || u.hostname.endsWith("."))
    throw new Error("Unsupported cover host");
  const addresses = await dns(u.hostname);
  if (!addresses.length || !addresses.every(isPublicIPv4)) throw new Error("Non-public cover host");
  return new Promise((resolve, reject) => {
    const req = get(u, {
      signal: AbortSignal.timeout(30000),
      lookup: ((_host: string, options: any, callback: any) => {
        if (options?.all) callback(null, [{ address: addresses[0], family: 4 }]);
        else callback(null, addresses[0], 4);
      }) as any,
    }, response => {
      void (async () => {
        try {
          if (response.statusCode !== 200) throw new Error("Cover fetch failed; redirects are not followed");
          const type = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
          if (!["image/jpeg", "image/png"].includes(type)) throw new Error("Unsupported cover type");
          const declared = Number(response.headers["content-length"]);
          if (declared > 8 * 1024 * 1024) throw new Error("Cover too large");
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of response) {
            const bytes = Buffer.from(chunk); size += bytes.length;
            if (size > 8 * 1024 * 1024) throw new Error("Cover too large");
            chunks.push(bytes);
          }
          const bytes = Buffer.concat(chunks);
          if (!bytes.length || imageType(bytes) !== type) throw new Error("Cover type mismatch");
          resolve(bytes);
        } catch (error) { response.destroy(); reject(error); }
      })();
    });
    req.on("error", reject);
  });
}
async function checkedResponse(response: Response) {
  const data = await response.json() as Record<string, any>;
  if (!response.ok || data.error || data.success !== true)
    throw new PublishingFailure("meta_upload", "meta_rejected", true, providerCodes(data, response.status));
}
export async function uploadFacebookReel(uploadUrl: string, videoId: string, videoUrl: string, token: string) {
  id.parse(videoId); publicUrl.parse(videoUrl);
  let u: URL;
  try {
    u = new URL(uploadUrl);
    // Accept the version/path supplied by Meta, but only on the fixed host and exact video ID.
    if (u.origin !== "https://rupload.facebook.com" || u.username || u.password ||
      u.search || u.hash || !new RegExp(`^/video-upload/(?:v[1-9][0-9]?\\.[0-9]/)?${videoId}/?$`).test(u.pathname))
      throw new Error("Rejected destination");
  } catch { throw new PublishingFailure("facebook_upload", "upload_destination_rejected", false); }
  let response: Response;
  try {
    response = await fetch(u, { method: "POST", redirect: "error",
      headers: { Authorization: `OAuth ${token}`, file_url: videoUrl },
      signal: AbortSignal.timeout(30000) });
  } catch (error: any) {
    const code = error?.cause?.code ?? error?.code;
    const message = typeof error?.cause?.message === "string" ? error.cause.message.slice(0, 200) : "";
    const failure = error?.name === "TimeoutError" || error?.name === "AbortError" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ? "upload_timeout" :
      code === "ENOTFOUND" || code === "EAI_AGAIN" ? "upload_dns_failed" :
      ["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID",
        "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(code) ? "upload_tls_failed" :
      ["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(code) ? "upload_connection_failed" :
      /unexpected redirect|redirect mode/i.test(message) ? "upload_redirect_rejected" :
      code === "ERR_INVALID_CHAR" ? "upload_header_rejected" : "upload_transport_failed";
    // Only fixed labels are exposed, never message text, nested causes, URLs or credentials.
    throw new PublishingFailure("facebook_upload", failure, true);
  }
  let data: Record<string, any>;
  try { data = await response.json() as Record<string, any>; }
  catch { throw new PublishingFailure("facebook_upload", "upload_non_json_response", true,
    { http_status: response.status }); }
  if (!response.ok || data?.error || data?.success !== true)
    throw new PublishingFailure("facebook_upload", "meta_rejected", true, providerCodes(data, response.status));
}
export async function uploadFacebookCover(videoId: string, bytes: Uint8Array, token: string) {
  id.parse(videoId);
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("Invalid cover size");
  const type = imageType(bytes), body = new FormData();
  body.set("is_preferred", "true");
  body.set("source", new Blob([new Uint8Array(bytes)], { type }), type === "image/png" ? "cover.png" : "cover.jpg");
  await checkedResponse(await fetch(`https://graph.facebook.com/v26.0/${videoId}/thumbnails`,
    { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${token}` },
      body, signal: AbortSignal.timeout(30000) }));
}
type ReelTransport = {
  loadCover: typeof loadFacebookCover;
  uploadVideo: typeof uploadFacebookReel;
  uploadCover: typeof uploadFacebookCover;
};
const reelTransport: ReelTransport = {
  loadCover: loadFacebookCover, uploadVideo: uploadFacebookReel, uploadCover: uploadFacebookCover,
};

function result(value: unknown, isError = false) {
  return { ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
function fingerprint(a: Record<string, unknown>) {
  const { approval_token, confidence, ...content } = a;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
function mainToken() {
  const token = process.env.META_ADS_ACCESS_TOKEN;
  if (!token) throw new Error("Missing token");
  return token;
}
// Never put credentials in URLs, tool responses, or error messages. No automatic POST retry.
export const graphRequest: Request = async (method, path, params = {}, token = mainToken()) => {
  if (!/^\/\d+(?:\/[a-z_]+)?$/.test(path)) throw new Error("Invalid Graph path");
  const url = new URL(`https://graph.facebook.com/v26.0${path}`);
  if (method === "GET") url.search = new URLSearchParams(params).toString();
  try {
    const response = await fetch(url, {
      method,
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`,
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      ...(method === "POST" ? { body: new URLSearchParams(params) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json() as Record<string, any>;
    if (!response.ok || data.error)
      throw new PublishingFailure("meta_graph", "meta_rejected", method !== "GET", providerCodes(data, response.status));
    return data;
  } catch (error) {
    if (error instanceof PublishingFailure) throw error;
    throw new PublishingFailure("meta_graph", "transport_or_response_failed", method !== "GET");
  }
};

export function registerOrganicPublishingTools(server: Registrar, rawRequest: Request = graphRequest,
  now: () => number = Date.now, transport: ReelTransport = reelTransport,
  state: PublishingState = rawRequest === graphRequest ? createFilePublishingState() : createMemoryPublishingState()): void {
  // Production state is shared across session children on one container only.
  // Injected test transports remain isolated unless the caller supplies a state store.
  const { pending, containers, reels, deletions } = state;
  const request: Request = (method, path, params = {}, token) => {
    const stage = method === "DELETE" ? "facebook_delete" :
      params.fields === "id,access_token" ? "page_token" :
      path.endsWith("/media_publish") ? "instagram_publish" :
      path.endsWith("/media") ? "instagram_container_create" :
      params.fields === "status_code" ? "instagram_status" :
      params.fields === "status" ? "facebook_status" :
      path.endsWith("/video_reels") ? (params.upload_phase === "start" ? "facebook_initialize" : "facebook_finish") :
      path.endsWith("/photos") || path.endsWith("/feed") ? "facebook_post" : "meta_read";
    return operation(stage, method !== "GET", () => rawRequest(method, path, params, token));
  };
  type Reel = { owner: string; content: Omit<z.infer<typeof facebookReelSchema>, "approval_token" | "confidence">;
    blocked: boolean; submitted: boolean; coverHash?: string };
  async function pageToken(pageId: string): Promise<string> {
    const page = await request("GET", `/${pageId}`, { fields: "id,access_token" }, mainToken());
    if (String(page.id) !== pageId || typeof page.access_token !== "string" || !page.access_token)
      throw new PublishingFailure("page_token", "page_token_unavailable");
    return page.access_token;
  }
  function trackedReel(pageId: string, videoId: string) {
    if (deletions.has(videoId)) throw new PublishingFailure("state", "deletion_requires_reconciliation");
    const entry = reels.get(videoId);
    if (!entry || entry.owner !== pageId) throw new PublishingFailure("state", "unknown_reel");
    return entry as Reel;
  }
  function reelStatus(data: Record<string, any>) {
    // Do not echo provider errors/messages that could include credentials.
    const safe = (v: unknown) => typeof v === "string" &&
      /^(?:ready|uploading|processing|error|expired|in_progress|not_started|complete|published|failed)$/i.test(v) ? v : "unknown";
    return { video_status: safe(data.status?.video_status),
      uploading: safe(data.status?.uploading_phase?.status),
      processing: safe(data.status?.processing_phase?.status),
      publishing: safe(data.status?.publishing_phase?.status) };
  }
  function reconcile(videoId: string, entry: Reel, error: unknown) {
    return result({ status: "reel_action_unknown", page_id: entry.owner, video_id: videoId,
      ...safeFailure(error), meta_write_attempted: true,
      instruction: "Do not recreate, re-upload or blindly retry. Read this video\x27s status and reconcile the destination manually. Automatic mutation is blocked." }, true);
  }
  async function finishReel(videoId: string, entry: Reel, token: string, cover?: Uint8Array) {
    const data = await request("GET", `/${videoId}`, { fields: "status" }, token);
    const state = reelStatus(data);
    if (state.publishing === "complete" || state.publishing === "in_progress") {
      entry.submitted = true; entry.blocked = true;
      reels.set(videoId, entry);
      return result({ status: state.publishing === "complete" ? "published" : "publication_submitted",
        page_id: entry.owner, video_id: videoId, ...state });
    }
    if (state.uploading !== "complete" || state.processing !== "complete")
      return result({ status: "reel_not_published", page_id: entry.owner, video_id: videoId, ...state,
        instruction: "Read status; when upload and processing are complete, use publish_facebook_reel_upload with a fresh preview/approval. Do not create another Reel." });
    if (state.publishing !== "not_started") throw new Error("Unverified publishing state");
    // Fail closed: apply requested cover before finish. Unknown thumbnail/finish outcomes cannot replay.
    entry.blocked = true;
    reels.set(videoId, entry);
    if (entry.content.cover_url) {
      cover ??= await operation("cover_fetch", false, () => transport.loadCover(entry.content.cover_url!));
      if (createHash("sha256").update(cover).digest("hex") !== entry.coverHash) throw new Error("Cover changed");
      await operation("facebook_thumbnail", true, () => transport.uploadCover(videoId, cover!, token));
    }
    entry.submitted = true;
    reels.set(videoId, entry);
    const response = await request("POST", `/${entry.owner}/video_reels`, {
      upload_phase: "finish", video_state: "PUBLISHED", video_id: videoId,
      description: entry.content.description,
    }, token);
    if (response.success !== true) throw new Error("Publication not confirmed");
    return result({ status: "publication_submitted", page_id: entry.owner, video_id: videoId,
      instruction: "Publication accepted, not yet verified live. Use get_facebook_reel_status and confirm publishing is complete before reporting published." });
  }
  function authorize(a: Record<string, any>, platform: string) {
    const hash = fingerprint({ platform, ...a });
    if (a.confidence !== "approved" || !a.approval_token) {
      if (a.confidence || a.approval_token) throw new PublishingFailure("approval", "incomplete_approval");
      for (const [key, entry] of pending) if (entry.expires <= now()) pending.delete(key);
      if (pending.size >= 1000) throw new Error("Too many previews");
      const token = randomBytes(24).toString("hex");
      pending.set(token, { hash, expires: now() + 600000 });
      const { approval_token, confidence, ...content } = a;
      return result({ status: "confirmation_required", platform, preview: content,
        approval_token: token, expires_in_seconds: 600,
        instruction: "Show this exact preview to the user. Only after their explicit approval, call with identical content, this approval_token and confidence=approved. Nothing has been sent to Meta." });
    }
    const entry = pending.get(a.approval_token);
    if (!entry) throw new PublishingFailure("approval", "approval_missing_or_consumed");
    if (entry.expires <= now()) {
      pending.delete(a.approval_token);
      throw new PublishingFailure("approval", "approval_expired");
    }
    if (entry.hash !== hash) throw new PublishingFailure("approval", "approval_content_mismatch");
    // Consume before networking. A timeout must not replay a possibly successful post.
    if (!pending.delete(a.approval_token)) throw new PublishingFailure("approval", "approval_already_consumed");
    return null;
  }
  function guarded(fn: (args: unknown) => Promise<unknown>) {
    return async (args: unknown) => {
      try { return await fn(args); }
      catch (error) {
        return result({ status: "not_confirmed",
          ...safeFailure(error),
          message: "Validation, approval or Meta request failed. No success is confirmed. After a submitted request or timeout, check the destination before creating another preview; never blindly retry." }, true);
      }
    };
  }
  server.tool("get_organic_publishing_diagnostics",
    "Read-only local publishing-state diagnostics. Optionally checks whether an approval exists across MCP sessions; never consumes it, calls Meta, or returns tokens, paths, captions or URLs. Container-local state does not span replicas/redeploys.",
    { approval_token: z.string().regex(/^[a-f0-9]{48}$/).optional() }, guarded(async raw => {
      const a = z.object({ approval_token: z.string().regex(/^[a-f0-9]{48}$/).optional() }).strict().parse(raw);
      const entry = a.approval_token ? pending.get(a.approval_token) : undefined;
      return result({ state_scope: state.scope,
        approval_state: !a.approval_token ? "not_checked" : !entry ? "missing_or_consumed" :
          entry.expires <= now() ? "expired" : "active",
        pending_approvals: pending.size, known_instagram_containers: containers.size,
        known_facebook_reels: reels.size, known_facebook_deletions: deletions.size,
        limitation: "Single container only. Replicas require shared durable storage or sticky routing. Reconcile IDs before restart; do not blindly retry ambiguous writes." });
    }));
  const deletePageVideoSchema = z.object({ page_id: id, video_id: id,
    allow_published: z.boolean().default(false).describe("Default refuses live or unknown publication state. Explicit true must be included in the human-approved preview to delete those videos."),
    ...approval }).strict();
  async function deletionTarget(pageId: string, videoId: string, token: string) {
    const video = await request("GET", `/${videoId}`, {
      fields: "id,from,status,published,privacy",
    }, token);
    if (String(video.id) !== videoId || String(video.from?.id) !== pageId)
      throw new PublishingFailure("ownership", "page_video_owner_mismatch");
    const phases = reelStatus(video);
    return { page_id: pageId, video_id: videoId, owner_id: String(video.from.id),
      owner_name: typeof video.from.name === "string" ? video.from.name.slice(0, 160) : "",
      published_flag: video.published === true, ...phases,
      privacy: video.privacy?.value === "EVERYONE" ? "EVERYONE" : "not_verified_public" };
  }
  server.tool("delete_facebook_page_video",
    "IRREVERSIBLY delete one Facebook Page-owned video using a freshly resolved Page access token, not the ads client. First call reads ownership/status and returns an exact-target approval preview; ZERO DELETE calls until explicit human approval. Default refuses live/unknown state. No automatic retries, permission changes or account fallback. Does not delete Instagram media or publish a replacement.",
    deletePageVideoSchema.shape, guarded(async raw => {
      const a = deletePageVideoSchema.parse(raw);
      if (deletions.has(a.video_id))
        throw new PublishingFailure("state", "deletion_requires_reconciliation");
      if (deletions.size >= 1000) throw new PublishingFailure("state", "deletion_capacity_reached");
      const token = await pageToken(a.page_id);
      const target = await deletionTarget(a.page_id, a.video_id, token);
      const definitelyIncomplete = target.publishing === "not_started" &&
        ["uploading", "processing", "error"].includes(target.video_status);
      if (!a.allow_published && !definitelyIncomplete)
        throw new PublishingFailure("validation", "live_or_unknown_delete_not_allowed");
      const preview = authorize({ ...a, target }, "facebook_page_video_delete");
      if (preview) return preview;
      // Same lock as Reel finalisation prevents racing a publish against deletion.
      const release = state.claim("reels", a.video_id);
      try {
        if (deletions.has(a.video_id))
          throw new PublishingFailure("state", "deletion_requires_reconciliation");
        const current = await deletionTarget(a.page_id, a.video_id, token);
        if (JSON.stringify(current) !== JSON.stringify(target))
          throw new PublishingFailure("ownership", "delete_target_changed");
        // Persist before networking. An ambiguous DELETE is never automatically replayed.
        deletions.set(a.video_id, { page_id: a.page_id, attempted: true, confirmed: false });
        const deleted = await request("DELETE", `/${a.video_id}`, {}, token);
        if (deleted?.success !== true)
          throw new PublishingFailure("facebook_delete", "deletion_not_confirmed", true);
        try {
          deletions.set(a.video_id, { page_id: a.page_id, attempted: true, confirmed: true });
          const existing = reels.get(a.video_id);
          if (existing) reels.set(a.video_id, { ...existing, blocked: true, deleted: true });
        } catch {
          return result({ status: "deleted_tracking_failed", deleted: true,
            page_id: a.page_id, video_id: a.video_id,
            instruction: "Meta confirmed deletion, but local tracking update failed. Do not retry deletion; reconcile manually." });
        }
        return result({ status: "deleted", page_id: a.page_id, video_id: a.video_id,
          instruction: "Only this Facebook Page video was deleted. Instagram is unchanged. Any replacement requires its own publishing preview and approval." });
      } finally { release(); }
    }));
  server.tool("publish_facebook_reel",
    "Publish a Facebook Page Reel with exact description and optional custom cover_url. Page Reels are PUBLIC. First call previews locally with ZERO network calls. Requires explicit human approval, identical content and a single-use approval token before upload or publication. No automatic retries; retain video_id for reconciliation. Container-local state spans MCP sessions on one replica, not redeploys. No scheduling.",
    facebookReelSchema.shape, guarded(async raw => {
      const a = facebookReelSchema.parse(raw);
      const preview = authorize(a, "facebook_reel");
      if (preview) return preview;
      if (reels.size >= 1000) throw new Error("Reel capacity reached");
      const cover = a.cover_url ? await operation("cover_fetch", false, () => transport.loadCover(a.cover_url!)) : undefined;
      const token = await pageToken(a.page_id);
      const created = await request("POST", `/${a.page_id}/video_reels`, { upload_phase: "start" }, token);
      const videoId = id.parse(String(created.video_id));
      const { approval_token, confidence, ...content } = a;
      const entry: Reel = { owner: a.page_id, content, blocked: true, submitted: false,
        ...(cover ? { coverHash: createHash("sha256").update(cover).digest("hex") } : {}) };
      try {
        reels.set(videoId, entry);
        await operation("facebook_upload", true, () => transport.uploadVideo(created.upload_url, videoId, a.video_url, token));
        const response = await finishReel(videoId, entry, token, cover);
        if (!entry.submitted) entry.blocked = false;
        reels.set(videoId, entry);
        return response;
      } catch (error) {
        entry.blocked = true;
        try { reels.set(videoId, entry); } catch {}
        return reconcile(videoId, entry, error);
      }
    }));
  const reelIdSchema = z.object({ page_id: id, video_id: id }).strict();
  server.tool("get_facebook_reel_status",
    "Read a Facebook Reel tracked on this server container, across MCP sessions. Returns safe phase status, never publishes. State does not span replicas or redeploys.",
    reelIdSchema.shape, guarded(async raw => {
      const a = reelIdSchema.parse(raw), entry = trackedReel(a.page_id, a.video_id);
      const token = await pageToken(a.page_id);
      const state = reelStatus(await request("GET", `/${a.video_id}`, { fields: "status" }, token));
      if (state.publishing === "complete" || state.publishing === "in_progress") {
        entry.submitted = true; entry.blocked = true;
        reels.set(a.video_id, entry);
      }
      return result({ page_id: a.page_id, video_id: a.video_id, ...state,
        status: state.publishing === "complete" ? "published" :
          entry.submitted ? "publication_submitted" : "reel_not_published",
        mutation_blocked: entry.blocked });
    }));
  const resumeSchema = z.object({ page_id: id, video_id: id, ...approval }).strict();
  server.tool("publish_facebook_reel_upload",
    "Finish the SAME processing Facebook Reel tracked on this server container, with its original exact caption and cover. First call previews original content; new explicit approval required. Never creates/re-uploads videos, accepts foreign videos, or retries an ambiguous mutation.",
    resumeSchema.shape, guarded(async raw => {
      const a = resumeSchema.parse(raw), entry = trackedReel(a.page_id, a.video_id);
      if (entry.blocked || entry.submitted) throw new Error("Reel requires reconciliation");
      const preview = authorize({ ...a, reel: entry.content }, "facebook_reel_resume");
      if (preview) return preview;
      const release = state.claim("reels", a.video_id);
      try {
        // Re-read under the inter-process lock; an older session snapshot is not authoritative.
        const current = trackedReel(a.page_id, a.video_id);
        if (current.blocked || current.submitted) throw new PublishingFailure("state", "reel_requires_reconciliation");
        current.blocked = true; reels.set(a.video_id, current);
        const token = await pageToken(a.page_id);
        const response = await finishReel(a.video_id, current, token);
        if (!current.submitted) current.blocked = false;
        reels.set(a.video_id, current);
        return response;
      } catch (error) { return reconcile(a.video_id, trackedReel(a.page_id, a.video_id), error); }
      finally { release(); }
    }));
  server.tool("publish_facebook_post",
    "Publish a Facebook Page text/link post or single photo. First call is a local preview with ZERO Meta writes. Re-call identical content with approval_token and confidence=approved only after explicit user approval. No scheduling, videos or reels.",
    facebookPostSchema.innerType().shape, guarded(async raw => {
      const a = facebookPostSchema.parse(raw);
      const preview = authorize(a, "facebook");
      if (preview) return preview;
      // Resolve the correct Page token, rather than reusing a stale global Page token.
      const page = await request("GET", `/${a.page_id}`, { fields: "id,access_token" }, mainToken());
      if (String(page.id) !== a.page_id || !page.access_token) throw new Error("Page token unavailable");
      const params: Record<string, string> = a.photo_url ? { url: a.photo_url, caption: a.message, published: "true" } :
        { message: a.message, ...(a.link ? { link: a.link } : {}) };
      const data = await request("POST", `/${a.page_id}/${a.photo_url ? "photos" : "feed"}`,
        params, page.access_token);
      if (!data.id) throw new Error("No published object ID");
      return result({ status: "published", platform: "facebook", page_id: a.page_id,
        id: data.id, ...(data.post_id ? { post_id: data.post_id } : {}) });
    }));

  server.tool("publish_instagram_post",
    "Publish one Instagram IMAGE or REELS video from a public HTTPS URL, with optional cover_url for REELS (JPEG, max 8 MB). Preview first; exact-content approval includes the cover URL. Creates an unpublished container only after approval. If processing is pending, use get_instagram_container_status then publish_instagram_container with a fresh preview/approval. No carousels or stories.",
    instagramPostSchema.shape, guarded(async raw => {
      const a = instagramPostSchema.parse(raw);
      if (a.media_type !== "REELS" && a.cover_url) throw new Error("cover_url is Reels only");
      const preview = authorize(a, "instagram");
      if (preview) return preview;
      if (containers.size >= 1000) throw new Error("Container capacity reached; reconcile existing containers");
      const params: Record<string, string> = { caption: a.caption };
      if (a.media_type === "IMAGE") params.image_url = a.media_url;
      else Object.assign(params, { media_type: "REELS", video_url: a.media_url,
        share_to_feed: String(a.share_to_feed), ...(a.cover_url ? { cover_url: a.cover_url } : {}) });
      const container = await request("POST", `/${a.ig_account_id}/media`, params);
      if (!/^\d+$/.test(String(container.id))) throw new Error("No container ID");
      const creation_id = String(container.id);
      const { approval_token, confidence, ...content } = a;
      try { containers.set(creation_id, { owner: a.ig_account_id, published: false, content }); }
      catch (error) {
        return result({ status: "container_created_state_unknown", creation_id,
          ig_account_id: a.ig_account_id, published: false, ...safeFailure(error),
          meta_write_attempted: true,
          instruction: "Container created but local tracking failed. Reconcile this ID manually; do not recreate or blindly retry." }, true);
      }
      // Keep the ID even if Meta\x27s status read fails, so a caller can reconcile.
      let state: Record<string, any>;
      try { state = await request("GET", `/${creation_id}`, { fields: "status_code" }); }
      catch {
        return result({ status: "container_created_status_unknown", creation_id,
          ig_account_id: a.ig_account_id, published: false, instruction: "Check this container; do not recreate it." });
      }
      if (state.status_code !== "FINISHED")
        return result({ status: "container_not_published", creation_id,
          ig_account_id: a.ig_account_id, status_code: state.status_code,
          instruction: "Check status; publish this same container after FINISHED using a new confirmation preview. Do not recreate it." });
      return publishContainer(a.ig_account_id, creation_id);
    }));

  const containerSchema = z.object({ ig_account_id: id, creation_id: id, ...approval }).strict();
  async function publishContainer(owner: string, creation: string) {
    const release = state.claim("containers", creation);
    try {
      const entry = containers.get(creation);
      if (!entry || entry.owner !== owner || entry.published) throw new PublishingFailure("state", "container_consumed_or_unknown");
      // Persist before sending to prevent ambiguous retries across session processes.
      entry.published = true; containers.set(creation, entry);
      const data = await request("POST", `/${owner}/media_publish`, { creation_id: creation });
      if (!data.id) throw new PublishingFailure("instagram_publish", "missing_media_id", true);
      return result({ status: "published", platform: "instagram", ig_account_id: owner, id: data.id });
    } finally { release(); }
  }
  server.tool("get_instagram_container_status",
    "Read processing status for an Instagram container tracked on this server container, across MCP sessions. Does not publish.",
    { creation_id: id }, guarded(async raw => {
      const a = z.object({ creation_id: id }).strict().parse(raw);
      if (!containers.has(a.creation_id)) throw new Error("Unknown container");
      const data = await request("GET", `/${a.creation_id}`, { fields: "status_code" });
      return result({ creation_id: a.creation_id, status_code: data.status_code });
    }));
  server.tool("publish_instagram_container",
    "Publish a FINISHED Instagram container tracked on this server container, across MCP sessions. First call only previews original content; explicit approval and payload-bound token required. Not for arbitrary external containers.",
    containerSchema.shape, guarded(async raw => {
      const a = containerSchema.parse(raw);
      const entry = containers.get(a.creation_id);
      if (!entry || entry.owner !== a.ig_account_id || entry.published) throw new Error("Invalid container");
      const preview = authorize({ ...a, post: entry.content }, "instagram_container");
      if (preview) return preview;
      const status = await request("GET", `/${a.creation_id}`, { fields: "status_code" });
      if (status.status_code !== "FINISHED") throw new Error("Container not ready");
      return publishContainer(a.ig_account_id, a.creation_id);
    }));
}
