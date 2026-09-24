import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AdsClient } from "../services/ads-client.js";
import { leadPageClient, leadError } from "../services/lead-page-client.js";

export function registerLeadTools(server: McpServer, client: AdsClient): void {
  // Store only object-to-Page IDs, never tokens or lead contact details.
  const objectPages = new Map<string, string>();
  const pageHint = z.string().optional().describe("Facebook Page ID for authentication. Defaults to the Page remembered from listing forms/leads, or META_PAGE_ID.");
  function remember(data: unknown, pageId?: string): void {
    if (!pageId || !data || typeof data !== "object") return;
    const payload = data as { id?: string; data?: Array<{ id?: string }> };
    for (const row of Array.isArray(payload.data) ? payload.data : [payload]) {
      if (typeof row?.id === "string") {
        if (objectPages.size >= 10000) {
          const oldest = objectPages.keys().next().value;
          if (oldest !== undefined) objectPages.delete(oldest);
        }
        objectPages.set(row.id, pageId);
      }
    }
  }
  function result(data: unknown, rateLimit: unknown) {
    const payload: Record<string, unknown> = { ...data as Record<string, unknown>, _rateLimit: rateLimit };
    delete payload.access_token;
    const paging = payload.paging;
    if (paging && typeof paging === "object") {
      const safePaging = { ...paging as Record<string, unknown> };
      for (const key of ["next", "previous"]) {
        if (typeof safePaging[key] === "string") {
          try {
            const url = new URL(safePaging[key] as string);
            url.searchParams.delete("access_token");
            url.searchParams.delete("appsecret_proof");
            safePaging[key] = url.toString();
          } catch { delete safePaging[key]; }
        }
      }
      payload.paging = safePaging;
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
  }
  function failure(error: unknown) {
    return { content: [{ type: "text" as const, text: `Failed: ${leadError(error)}` }], isError: true };
  }
  async function getObject(id: string, edge: string, pageId: string | undefined, params: Record<string, unknown>) {
    const pid = pageId || objectPages.get(id) || process.env.META_PAGE_ID;
    const pageClient = await leadPageClient(client, pid);
    const { data, rateLimit } = await pageClient.get(`/${id}${edge}`, params);
    remember(data, pid);
    return result(data, rateLimit);
  }

  server.tool(
    "get_form_leads",
    "Get leads submitted through a lead generation form. Requires leads_retrieval permission and access to the Page's leads.",
    {
      form_id: z.string().describe("Lead form ID"),
      page_id: pageHint,
      fields: z.string().optional().describe("Comma-separated fields to return"),
      limit: z.number().optional().default(25).describe("Number of results to return"),
      after: z.string().optional().describe("Pagination cursor for next page"),
    },
    async ({ form_id, page_id, ...params }) => {
      try { return await getObject(form_id, "/leads", page_id, params); }
      catch (error) { return failure(error); }
    }
  );
  server.tool(
    "get_lead",
    "Get details of a specific lead by ID.",
    {
      lead_id: z.string().describe("Lead ID"),
      page_id: pageHint,
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ lead_id, page_id, ...params }) => {
      try { return await getObject(lead_id, "", page_id, params); }
      catch (error) { return failure(error); }
    }
  );
  server.tool(
    "list_lead_forms",
    "List lead generation forms for a Facebook Page.",
    {
      page_id: z.string().describe("Facebook Page ID"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
      limit: z.number().optional().default(25).describe("Number of results to return"),
      after: z.string().optional().describe("Pagination cursor for next page"),
    },
    async ({ page_id, ...params }) => {
      try {
        const pageClient = await leadPageClient(client, page_id);
        const { data, rateLimit } = await pageClient.get(`/${page_id}/leadgen_forms`, params);
        remember(data, page_id);
        return result(data, rateLimit);
      } catch (error) { return failure(error); }
    }
  );
  server.tool(
    "create_lead_form",
    "Create a new lead generation form on a Facebook Page. Requires pages_manage_ads permission.",
    {
      page_id: z.string().describe("Facebook Page ID"),
      name: z.string().describe("Lead form name"),
      questions: z.string().describe("JSON array of questions. Each: {key: string, type: 'CUSTOM'|'EMAIL'|'PHONE'|'FULL_NAME'|'CITY'|'STATE'|'COUNTRY'|'ZIP'|'JOB_TITLE'|'COMPANY_NAME', label?: string}"),
      privacy_policy_url: z.string().describe("URL to privacy policy"),
      follow_up_action_url: z.string().optional().describe("URL to redirect after submission"),
      thank_you_page: z.string().optional().describe("JSON object: {title: string, body: string, button_text?: string, button_type?: 'VIEW_WEBSITE'|'DOWNLOAD'}"),
    },
    async ({ page_id, name, questions, privacy_policy_url, follow_up_action_url, thank_you_page }) => {
      try {
        const params: Record<string, unknown> = {
          name, questions, privacy_policy: JSON.stringify({ url: privacy_policy_url }),
        };
        if (follow_up_action_url) params.follow_up_action_url = follow_up_action_url;
        if (thank_you_page) params.thank_you_page = thank_you_page;
        const pageClient = await leadPageClient(client, page_id);
        const { data, rateLimit } = await pageClient.post(`/${page_id}/leadgen_forms`, params);
        remember(data, page_id);
        return result(data, rateLimit);
      } catch (error) { return failure(error); }
    }
  );
  server.tool(
    "get_lead_form",
    "Get details of a specific lead generation form.",
    {
      form_id: z.string().describe("Lead form ID"),
      page_id: pageHint,
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ form_id, page_id, ...params }) => {
      try { return await getObject(form_id, "", page_id, params); }
      catch (error) { return failure(error); }
    }
  );
}
