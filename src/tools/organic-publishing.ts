import { z } from "zod/v3";
import { createHash, randomBytes } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { get as httpsGet } from "node:https";
import { isIP } from "node:net";

// No Post.type or PostAttachment.type: removed aggregated attachment fields.
export const PUBLISHED_POST_FIELDS =
  "id,message,created_time,permalink_url,full_picture,is_published,attachments{media_type,title,url}";

type Registrar = { tool(name: string, description: string, schema: any, handler: any): unknown };
type Request = (method: "GET" | "POST", path: string,
  params?: Record<string, string>, token?: string) => Promise<Record<string, any>>;
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
  if (!response.ok || data.error || data.success !== true) throw new Error("Meta upload failed");
}
export async function uploadFacebookReel(uploadUrl: string, videoId: string, videoUrl: string, token: string) {
  id.parse(videoId); publicUrl.parse(videoUrl);
  const u = new URL(uploadUrl);
  if (u.origin !== "https://rupload.facebook.com" || u.username || u.password ||
    u.search || u.hash || !new RegExp(`^/video-upload/(?:v26\\.0/)?${videoId}$`).test(u.pathname))
    throw new Error("Untrusted Meta upload URL");
  await checkedResponse(await fetch(u, { method: "POST", redirect: "error",
    headers: { Authorization: `OAuth ${token}`, file_url: videoUrl },
    signal: AbortSignal.timeout(30000) }));
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
  const response = await fetch(url, {
    method,
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(method === "POST" ? { body: new URLSearchParams(params) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json() as Record<string, any>;
  if (!response.ok || data.error) throw new Error("Meta request failed");
  return data;
};

export function registerOrganicPublishingTools(server: Registrar, request: Request = graphRequest,
  now: () => number = Date.now, transport: ReelTransport = reelTransport): void {
  // Process-local, expiring, bounded, payload-bound, single-use approvals.
  // A server restart invalidates previews; do not silently recreate or replay them.
  const pending = new Map<string, { hash: string; expires: number }>();
  const containers = new Map<string, { owner: string; published: boolean; content: Record<string, unknown> }>();
  type Reel = { owner: string; content: Omit<z.infer<typeof facebookReelSchema>, "approval_token" | "confidence">;
    blocked: boolean; submitted: boolean; coverHash?: string };
  const reels = new Map<string, Reel>();
  async function pageToken(pageId: string): Promise<string> {
    const page = await request("GET", `/${pageId}`, { fields: "id,access_token" }, mainToken());
    if (String(page.id) !== pageId || typeof page.access_token !== "string" || !page.access_token)
      throw new Error("Page token unavailable");
    return page.access_token;
  }
  function trackedReel(pageId: string, videoId: string) {
    const entry = reels.get(videoId);
    if (!entry || entry.owner !== pageId) throw new Error("Unknown Reel");
    return entry;
  }
  function reelStatus(data: Record<string, any>) {
    // Do not echo provider errors/messages that could include credentials.
    const safe = (v: unknown) => typeof v === "string" &&
      /^(?:ready|processing|error|expired|in_progress|not_started|complete|published|failed)$/i.test(v) ? v : "unknown";
    return { video_status: safe(data.status?.video_status),
      uploading: safe(data.status?.uploading_phase?.status),
      processing: safe(data.status?.processing_phase?.status),
      publishing: safe(data.status?.publishing_phase?.status) };
  }
  function reconcile(videoId: string, entry: Reel) {
    return result({ status: "reel_action_unknown", page_id: entry.owner, video_id: videoId,
      instruction: "Do not recreate, re-upload or blindly retry. Read this video\x27s status and reconcile the destination manually. Automatic mutation is blocked." }, true);
  }
  async function finishReel(videoId: string, entry: Reel, token: string, cover?: Uint8Array) {
    const data = await request("GET", `/${videoId}`, { fields: "status" }, token);
    const state = reelStatus(data);
    if (state.publishing === "complete" || state.publishing === "in_progress") {
      entry.submitted = true; entry.blocked = true;
      return result({ status: state.publishing === "complete" ? "published" : "publication_submitted",
        page_id: entry.owner, video_id: videoId, ...state });
    }
    if (state.uploading !== "complete" || state.processing !== "complete")
      return result({ status: "reel_not_published", page_id: entry.owner, video_id: videoId, ...state,
        instruction: "Read status; when upload and processing are complete, use publish_facebook_reel_upload with a fresh preview/approval. Do not create another Reel." });
    if (state.publishing !== "not_started") throw new Error("Unverified publishing state");
    // Fail closed: apply requested cover before finish. Unknown thumbnail/finish outcomes cannot replay.
    entry.blocked = true;
    if (entry.content.cover_url) {
      cover ??= await transport.loadCover(entry.content.cover_url);
      if (createHash("sha256").update(cover).digest("hex") !== entry.coverHash) throw new Error("Cover changed");
      await transport.uploadCover(videoId, cover, token);
    }
    entry.submitted = true;
    const response = await request("POST", `/${entry.owner}/video_reels`, {
      upload_phase: "finish", video_state: "PUBLISHED", video_id: videoId,
      description: entry.content.description,
    }, token);
    if (response.success !== true) throw new Error("Publication not confirmed");
    return result({ status: "publication_submitted", page_id: entry.owner, video_id: videoId,
      instruction: "Publication accepted, not yet verified live. Use get_facebook_reel_status and confirm publishing is complete before reporting published." });
  }
  function authorize(a: Record<string, any>, platform: string) {
    for (const [key, entry] of pending) if (entry.expires <= now()) pending.delete(key);
    const hash = fingerprint({ platform, ...a });
    if (a.confidence !== "approved" || !a.approval_token) {
      if (a.confidence || a.approval_token) throw new Error("Incomplete approval");
      if (pending.size >= 1000) throw new Error("Too many previews");
      const token = randomBytes(24).toString("hex");
      pending.set(token, { hash, expires: now() + 600000 });
      const { approval_token, confidence, ...content } = a;
      return result({ status: "confirmation_required", platform, preview: content,
        approval_token: token, expires_in_seconds: 600,
        instruction: "Show this exact preview to the user. Only after their explicit approval, call with identical content, this approval_token and confidence=approved. Nothing has been sent to Meta." });
    }
    const entry = pending.get(a.approval_token);
    if (!entry || entry.hash !== hash || entry.expires <= now()) throw new Error("Invalid approval");
    // Consume before networking. A timeout must not replay a possibly successful post.
    pending.delete(a.approval_token);
    return null;
  }
  function guarded(fn: (args: unknown) => Promise<unknown>) {
    return async (args: unknown) => {
      try { return await fn(args); }
      catch {
        return result({ status: "not_confirmed",
          message: "Validation, approval or Meta request failed. No success is confirmed. After a submitted request or timeout, check the destination before creating another preview; never blindly retry." }, true);
      }
    };
  }
  server.tool("publish_facebook_reel",
    "Publish a Facebook Page Reel with exact description and optional custom cover_url. Page Reels are PUBLIC. First call previews locally with ZERO network calls. Requires explicit human approval, identical content and a single-use approval token before upload or publication. No automatic retries; retain video_id for reconciliation. Process-local state; no scheduling.",
    facebookReelSchema.shape, guarded(async raw => {
      const a = facebookReelSchema.parse(raw);
      const preview = authorize(a, "facebook_reel");
      if (preview) return preview;
      if (reels.size >= 1000) throw new Error("Reel capacity reached");
      const cover = a.cover_url ? await transport.loadCover(a.cover_url) : undefined;
      const token = await pageToken(a.page_id);
      const created = await request("POST", `/${a.page_id}/video_reels`, { upload_phase: "start" }, token);
      const videoId = id.parse(String(created.video_id));
      const { approval_token, confidence, ...content } = a;
      const entry: Reel = { owner: a.page_id, content, blocked: true, submitted: false,
        ...(cover ? { coverHash: createHash("sha256").update(cover).digest("hex") } : {}) };
      reels.set(videoId, entry);
      try {
        await transport.uploadVideo(created.upload_url, videoId, a.video_url, token);
        const response = await finishReel(videoId, entry, token, cover);
        if (!entry.submitted) entry.blocked = false;
        return response;
      } catch { entry.blocked = true; return reconcile(videoId, entry); }
    }));
  const reelIdSchema = z.object({ page_id: id, video_id: id }).strict();
  server.tool("get_facebook_reel_status",
    "Read a Facebook Reel created in this server process. Returns safe phase status, never publishes. State is not durable across restarts/replicas.",
    reelIdSchema.shape, guarded(async raw => {
      const a = reelIdSchema.parse(raw), entry = trackedReel(a.page_id, a.video_id);
      const token = await pageToken(a.page_id);
      const state = reelStatus(await request("GET", `/${a.video_id}`, { fields: "status" }, token));
      if (state.publishing === "complete" || state.publishing === "in_progress") {
        entry.submitted = true; entry.blocked = true;
      }
      return result({ page_id: a.page_id, video_id: a.video_id, ...state,
        status: state.publishing === "complete" ? "published" :
          entry.submitted ? "publication_submitted" : "reel_not_published",
        mutation_blocked: entry.blocked });
    }));
  const resumeSchema = z.object({ page_id: id, video_id: id, ...approval }).strict();
  server.tool("publish_facebook_reel_upload",
    "Finish the SAME processing Facebook Reel created by this server process, with its original exact caption and cover. First call previews original content; new explicit approval required. Never creates/re-uploads videos, accepts foreign videos, or retries an ambiguous mutation.",
    resumeSchema.shape, guarded(async raw => {
      const a = resumeSchema.parse(raw), entry = trackedReel(a.page_id, a.video_id);
      if (entry.blocked || entry.submitted) throw new Error("Reel requires reconciliation");
      const preview = authorize({ ...a, reel: entry.content }, "facebook_reel_resume");
      if (preview) return preview;
      const token = await pageToken(a.page_id);
      // Claim before any await to prevent concurrent finish calls for the same video.
      if (entry.blocked || entry.submitted) throw new Error("Reel requires reconciliation");
      entry.blocked = true;
      try {
        const response = await finishReel(a.video_id, entry, token);
        if (!entry.submitted) entry.blocked = false;
        return response;
      } catch { return reconcile(a.video_id, entry); }
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
      containers.set(creation_id, { owner: a.ig_account_id, published: false, content });
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
    const entry = containers.get(creation);
    if (!entry || entry.owner !== owner || entry.published) throw new Error("Unknown or consumed container");
    // Mark before sending to prevent ambiguous retries.
    entry.published = true;
    const data = await request("POST", `/${owner}/media_publish`, { creation_id: creation });
    if (!data.id) throw new Error("No published media ID");
    return result({ status: "published", platform: "instagram", ig_account_id: owner, id: data.id });
  }
  server.tool("get_instagram_container_status",
    "Read processing status for a container created by this server process. Does not publish.",
    { creation_id: id }, guarded(async raw => {
      const a = z.object({ creation_id: id }).strict().parse(raw);
      if (!containers.has(a.creation_id)) throw new Error("Unknown container");
      const data = await request("GET", `/${a.creation_id}`, { fields: "status_code" });
      return result({ creation_id: a.creation_id, status_code: data.status_code });
    }));
  server.tool("publish_instagram_container",
    "Publish a FINISHED Instagram container created by this server process. First call only previews; explicit approval and payload-bound token required. Not for arbitrary external containers.",
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
