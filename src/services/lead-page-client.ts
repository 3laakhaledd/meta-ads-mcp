import { AdsClient } from "./ads-client.js";
import { loadConfig } from "../config.js";

/** Keep Page credentials isolated from the shared ads client. */
export async function leadPageClient(client: AdsClient, pageId?: string): Promise<AdsClient> {
  const configuredPageId = process.env.META_PAGE_ID?.trim();
  const targetPageId = pageId || configuredPageId;
  const pageToken = process.env.META_PAGE_ACCESS_TOKEN?.trim();
  if (pageToken && (!configuredPageId || !targetPageId || configuredPageId === targetPageId)) {
    return new AdsClient({ ...loadConfig(), accessToken: pageToken });
  }
  // Keep legacy direct lead lookups compatible when no Page context is known.
  if (!targetPageId) return client;
  if (!/^\d+$/.test(targetPageId)) throw new Error("A numeric Facebook Page ID is required.");

  let data: unknown;
  try {
    ({ data } = await client.get(`/${targetPageId}`, { fields: "access_token" }));
  } catch {
    // Never expose token lookup responses, which may contain credentials.
    throw new Error("Could not resolve a Page access token. Configure META_PAGE_ACCESS_TOKEN for the target Page, or authorize the ads credential to access that Page.");
  }
  const token = (data as { access_token?: unknown } | null)?.access_token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Meta did not return a Page access token. Configure META_PAGE_ACCESS_TOKEN and META_PAGE_ID; reading leads also requires leads_retrieval permission and access to the Page's leads.");
  }
  return new AdsClient({ ...loadConfig(), accessToken: token });
}

/** The shared client's code-190 hint incorrectly treats every auth error as expiry. */
export function leadError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  if (message.includes("[Token Expired]") && /code=190\b/.test(message)) {
    const label = /page access token/i.test(message) ? "[Page Token Required]"
      : /subcode=463\b/.test(message) || /expired/i.test(message.replace("[Token Expired]", ""))
        ? "[Token Expired]" : "[Authentication Error]";
    message = message.replace("[Token Expired]", label).replace(
      ". Use exchange_token or refresh_token to obtain a new long-lived token.", ""
    );
  }
  return message;
}
