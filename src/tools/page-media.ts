import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AdsClient } from "../services/ads-client.js";

export function registerPageMediaTools(server: McpServer, client: AdsClient): void {

  // ─── list_page_published_posts ─────────────────────────────────
  server.tool(
    "list_page_published_posts",
    "List recent published posts from a Facebook Page. Returns object_story_id (page_id_post_id format) for creating ads via the Marketing API. Includes reels, photos, videos, and link posts.",
    {
      page_id: z.string().optional().describe("Facebook Page ID. Falls back to META_PAGE_ID env var if omitted."),
      limit: z.number().optional().default(10).describe("Number of posts to return (default 10, max 100)"),
      after: z.string().optional().describe("Pagination cursor for next page"),
    },
    async ({ page_id, limit, after }) => {
      try {
        const pid = page_id || process.env.META_PAGE_ID;
        if (!pid) {
          return { content: [{ type: "text" as const, text: "Provide page_id or set META_PAGE_ID env var." }], isError: true };
        }
        const params: Record<string, unknown> = {
          fields: "id,message,created_time,permalink_url,type,full_picture,is_published,attachments{type,media_type,title,url}",
          limit: Math.min(limit ?? 10, 100),
        };
        if (after) params.after = after;

        const { data, rateLimit } = await client.get(`/${pid}/published_posts`, params);
        const raw = data as { data?: Array<Record<string, unknown>>; paging?: Record<string, unknown> };

        const posts = (raw.data || []).map((p) => {
          const msg = (p.message as string) || "";
          const attachments = ((p.attachments as Record<string, unknown>)?.data as Array<Record<string, unknown>>) || [];
          const att = attachments[0] || null;
          return {
            object_story_id: p.id,
            message_preview: msg.length > 120 ? msg.slice(0, 120) + "..." : msg,
            created_time: p.created_time,
            permalink_url: p.permalink_url,
            type: p.type,
            attachment: att ? { type: att.type, media_type: att.media_type, title: att.title } : null,
          };
        });

        const paging = raw.paging as Record<string, unknown> | undefined;
        const cursors = (paging?.cursors as Record<string, string>) || {};
        const result: Record<string, unknown> = { posts, count: posts.length, _rateLimit: rateLimit };
        if (cursors.after) result.next_cursor = cursors.after;

        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ─── list_page_videos ──────────────────────────────────────────
  server.tool(
    "list_page_videos",
    "List videos and reels published on a Facebook Page. Returns video IDs and their associated post IDs for ad creation.",
    {
      page_id: z.string().optional().describe("Facebook Page ID. Falls back to META_PAGE_ID env var if omitted."),
      limit: z.number().optional().default(10).describe("Number of videos to return (default 10, max 100)"),
      after: z.string().optional().describe("Pagination cursor for next page"),
    },
    async ({ page_id, limit, after }) => {
      try {
        const pid = page_id || process.env.META_PAGE_ID;
        if (!pid) {
          return { content: [{ type: "text" as const, text: "Provide page_id or set META_PAGE_ID env var." }], isError: true };
        }
        const params: Record<string, unknown> = {
          fields: "id,title,description,created_time,permalink_url,length,post_id,embeddable",
          limit: Math.min(limit ?? 10, 100),
        };
        if (after) params.after = after;

        const { data, rateLimit } = await client.get(`/${pid}/videos`, params);
        const raw = data as { data?: Array<Record<string, unknown>>; paging?: Record<string, unknown> };

        const videos = (raw.data || []).map((v) => {
          const desc = (v.description as string) || "";
          return {
            video_id: v.id,
            post_id: v.post_id,
            title: v.title || "",
            description_preview: desc.length > 120 ? desc.slice(0, 120) + "..." : desc,
            created_time: v.created_time,
            permalink_url: v.permalink_url,
            length_seconds: v.length,
          };
        });

        const paging = raw.paging as Record<string, unknown> | undefined;
        const cursors = (paging?.cursors as Record<string, string>) || {};
        const result: Record<string, unknown> = { videos, count: videos.length, _rateLimit: rateLimit };
        if (cursors.after) result.next_cursor = cursors.after;

        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ─── list_instagram_media ──────────────────────────────────────
  server.tool(
    "list_instagram_media",
    "List recent media (posts, reels, carousels) from a connected Instagram Business account. Returns IG media IDs for creating Instagram ads.",
    {
      ig_account_id: z.string().optional().describe("Instagram Business Account ID. Falls back to META_INSTAGRAM_ACCOUNT_ID env var if omitted."),
      limit: z.number().optional().default(10).describe("Number of media items to return (default 10, max 100)"),
      after: z.string().optional().describe("Pagination cursor for next page"),
    },
    async ({ ig_account_id, limit, after }) => {
      try {
        const igId = ig_account_id || process.env.META_INSTAGRAM_ACCOUNT_ID;
        if (!igId) {
          return { content: [{ type: "text" as const, text: "Provide ig_account_id or set META_INSTAGRAM_ACCOUNT_ID env var." }], isError: true };
        }
        const params: Record<string, unknown> = {
          fields: "id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url",
          limit: Math.min(limit ?? 10, 100),
        };
        if (after) params.after = after;

        const { data, rateLimit } = await client.get(`/${igId}/media`, params);
        const raw = data as { data?: Array<Record<string, unknown>>; paging?: Record<string, unknown> };

        const media = (raw.data || []).map((m) => {
          const caption = (m.caption as string) || "";
          return {
            ig_media_id: m.id,
            caption_preview: caption.length > 120 ? caption.slice(0, 120) + "..." : caption,
            media_type: m.media_type,
            product_type: m.media_product_type,
            permalink: m.permalink,
            timestamp: m.timestamp,
          };
        });

        const paging = raw.paging as Record<string, unknown> | undefined;
        const cursors = (paging?.cursors as Record<string, string>) || {};
        const result: Record<string, unknown> = { media, count: media.length, _rateLimit: rateLimit };
        if (cursors.after) result.next_cursor = cursors.after;

        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ─── get_instagram_media_by_shortcode ───────────────────────────
  server.tool(
    "get_instagram_media_by_shortcode",
    "Look up an Instagram media item by its URL shortcode (e.g. 'DdWO5ekMOix' from instagram.com/reel/DdWO5ekMOix/). Decodes the shortcode to a numeric media ID and fetches its details.",
    {
      shortcode: z.string().describe("The shortcode from an Instagram URL"),
    },
    async ({ shortcode }) => {
      try {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mediaId = BigInt(0);
        for (const char of shortcode) {
          const idx = alphabet.indexOf(char);
          if (idx === -1) {
            return { content: [{ type: "text" as const, text: `Invalid shortcode character: ${char}` }], isError: true };
          }
          mediaId = mediaId * BigInt(64) + BigInt(idx);
        }

        const { data, rateLimit } = await client.get(`/${mediaId.toString()}`, {
          fields: "id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url",
        });
        const m = data as Record<string, unknown>;
        const caption = (m.caption as string) || "";

        const result = {
          ig_media_id: m.id,
          caption_preview: caption.length > 120 ? caption.slice(0, 120) + "..." : caption,
          media_type: m.media_type,
          product_type: m.media_product_type,
          permalink: m.permalink,
          timestamp: m.timestamp,
          _rateLimit: rateLimit,
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );
}
