import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const API_VERSION = "v26.0";
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

function getPageToken(): string {
  const token = process.env.META_PAGE_ACCESS_TOKEN || process.env.META_ADS_ACCESS_TOKEN || "";
  if (!token) throw new Error("META_PAGE_ACCESS_TOKEN (or META_ADS_ACCESS_TOKEN) env var not set");
  return token;
}

function getPageId(): string {
  return process.env.META_PAGE_ID || "";
}

function getIgId(): string {
  return process.env.META_INSTAGRAM_ACCOUNT_ID || "";
}

async function pageGet(path: string): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE_URL}${path}${sep}access_token=${encodeURIComponent(getPageToken())}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const data = await res.json() as any;
  if (!res.ok || data.error) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    throw new Error(`Graph API error: ${msg}`);
  }
  return data;
}

function textResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

export function registerConversationTools(server: McpServer) {
  // ── Facebook Page Conversations ──

  server.tool(
    "fb_list_conversations",
    "List recent Facebook Page conversations (Messenger inbox). Returns participant names, message count, and last update time. Use to find leads who messaged the Page.",
    {
      page_id: z.string().describe("Facebook Page ID. Falls back to META_PAGE_ID env var if omitted.").optional(),
      limit: z.number().min(1).max(100).default(25).describe("Number of conversations to return (max 100, default 25)"),
      after: z.string().describe("Pagination cursor from a previous response").optional(),
    },
    async ({ page_id, limit, after }) => {
      const pid = page_id || getPageId();
      if (!pid) throw new Error("No page_id provided and META_PAGE_ID env var not set");
      let path = `/${pid}/conversations?fields=participants,updated_time,message_count,id&limit=${limit}`;
      if (after) path += `&after=${encodeURIComponent(after)}`;
      const data = await pageGet(path);
      const conversations = (data.data || []).map((conv: any) => ({
        conversation_id: conv.id,
        participants: (conv.participants?.data || []).map((p: any) => ({ name: p.name || "", id: p.id || "" })),
        message_count: conv.message_count,
        updated_time: conv.updated_time,
      }));
      const paging = data.paging || {};
      const nextCursor = paging.cursors?.after || null;
      const hasMore = !!paging.next;
      return textResult({ conversations, count: conversations.length, has_more: hasMore, next_cursor: hasMore ? nextCursor : null });
    }
  );

  server.tool(
    "fb_get_conversation_messages",
    "Get messages from a specific Facebook Page conversation.",
    {
      conversation_id: z.string().describe("The conversation ID from fb_list_conversations"),
      limit: z.number().min(1).max(100).default(10).describe("Number of messages to return (max 100, default 10)"),
      after: z.string().describe("Pagination cursor for next page").optional(),
    },
    async ({ conversation_id, limit, after }) => {
      let path = `/${conversation_id}/messages?fields=message,from,created_time,attachments&limit=${limit}`;
      if (after) path += `&after=${encodeURIComponent(after)}`;
      const data = await pageGet(path);
      const messages = (data.data || []).map((msg: any) => ({
        id: msg.id,
        from: msg.from || {},
        message: msg.message || "",
        created_time: msg.created_time,
      }));
      const paging = data.paging || {};
      const nextCursor = paging.cursors?.after || null;
      const hasMore = !!paging.next;
      return textResult({ messages, count: messages.length, has_more: hasMore, next_cursor: hasMore ? nextCursor : null });
    }
  );

  server.tool(
    "fb_get_participant_profile",
    "Get a Facebook user profile from a Page conversation (name, profile pic). Only works for users who have messaged the Page.",
    {
      user_id: z.string().describe("The participant user ID from fb_list_conversations or fb_get_conversation_messages"),
    },
    async ({ user_id }) => {
      const data = await pageGet(`/${user_id}?fields=name,first_name,last_name,profile_pic`);
      return textResult(data);
    }
  );

  // ── Instagram Direct Conversations ──

  server.tool(
    "ig_list_conversations",
    "List recent Instagram Direct conversations. Returns participant usernames and last update time. Use to find leads who messaged the Instagram account.",
    {
      ig_user_id: z.string().describe("Instagram Business Account ID. Falls back to META_INSTAGRAM_ACCOUNT_ID env var if omitted.").optional(),
      limit: z.number().min(1).max(100).default(25).describe("Number of conversations to return (max 100, default 25)"),
      after: z.string().describe("Pagination cursor from a previous response").optional(),
    },
    async ({ ig_user_id, limit, after }) => {
      const igId = ig_user_id || getIgId();
      if (!igId) throw new Error("No ig_user_id provided and META_INSTAGRAM_ACCOUNT_ID env var not set");
      let path = `/${igId}/conversations?fields=participants,updated_time,id&platform=instagram&limit=${limit}`;
      if (after) path += `&after=${encodeURIComponent(after)}`;
      const data = await pageGet(path);
      const conversations = (data.data || []).map((conv: any) => ({
        conversation_id: conv.id,
        participants: (conv.participants?.data || []).map((p: any) => ({ name: p.name || "", username: p.username || "", id: p.id || "" })),
        updated_time: conv.updated_time,
      }));
      const paging = data.paging || {};
      const nextCursor = paging.cursors?.after || null;
      const hasMore = !!paging.next;
      return textResult({ conversations, count: conversations.length, has_more: hasMore, next_cursor: hasMore ? nextCursor : null });
    }
  );

  server.tool(
    "ig_get_conversation_messages",
    "Get messages from a specific Instagram Direct conversation.",
    {
      conversation_id: z.string().describe("The conversation ID from ig_list_conversations"),
      limit: z.number().min(1).max(100).default(10).describe("Number of messages to return (max 100, default 10)"),
      after: z.string().describe("Pagination cursor for next page").optional(),
    },
    async ({ conversation_id, limit, after }) => {
      let path = `/${conversation_id}/messages?fields=message,from,created_time&limit=${limit}`;
      if (after) path += `&after=${encodeURIComponent(after)}`;
      const data = await pageGet(path);
      const messages = (data.data || []).map((msg: any) => ({
        id: msg.id,
        from: msg.from || {},
        message: msg.message || "",
        created_time: msg.created_time,
      }));
      const paging = data.paging || {};
      const nextCursor = paging.cursors?.after || null;
      const hasMore = !!paging.next;
      return textResult({ messages, count: messages.length, has_more: hasMore, next_cursor: hasMore ? nextCursor : null });
    }
  );
}
