import { z } from "zod/v3";
import { createHash, randomBytes } from "node:crypto";

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
  ...approval,
}).strict();

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
  now: () => number = Date.now): void {
  // Process-local, expiring, bounded, payload-bound, single-use approvals.
  // A server restart invalidates previews; do not silently recreate or replay them.
  const pending = new Map<string, { hash: string; expires: number }>();
  const containers = new Map<string, { owner: string; published: boolean }>();
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
    "Publish one Instagram IMAGE or REELS video from a public HTTPS URL. Preview first; exact-content approval required. Creates an unpublished container only after approval. If processing is pending, use get_instagram_container_status then publish_instagram_container with a fresh preview/approval. No carousels or stories.",
    instagramPostSchema.shape, guarded(async raw => {
      const a = instagramPostSchema.parse(raw);
      const preview = authorize(a, "instagram");
      if (preview) return preview;
      if (containers.size >= 1000) throw new Error("Container capacity reached; reconcile existing containers");
      const params: Record<string, string> = { caption: a.caption };
      if (a.media_type === "IMAGE") params.image_url = a.media_url;
      else Object.assign(params, { media_type: "REELS", video_url: a.media_url,
        share_to_feed: String(a.share_to_feed) });
      const container = await request("POST", `/${a.ig_account_id}/media`, params);
      if (!/^\d+$/.test(String(container.id))) throw new Error("No container ID");
      const creation_id = String(container.id);
      containers.set(creation_id, { owner: a.ig_account_id, published: false });
      // Keep the ID even if Meta's status read fails, so a caller can reconcile.
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
      const preview = authorize(a, "instagram_container");
      if (preview) return preview;
      const status = await request("GET", `/${a.creation_id}`, { fields: "status_code" });
      if (status.status_code !== "FINISHED") throw new Error("Container not ready");
      return publishContainer(a.ig_account_id, a.creation_id);
    }));
}
