import test from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AdsClient } from "../src/services/ads-client.js";
import { leadPageClient, leadError } from "../src/services/lead-page-client.js";
import { registerLeadTools } from "../src/tools/leads.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>; isError?: boolean;
}>;
function capture(client: AdsClient) {
  const handlers = new Map<string, Handler>();
  registerLeadTools({
    tool(name: string, _description: string, _schema: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer, client);
  return handlers;
}
function newClient() {
  return new AdsClient({
    accessToken: "ads-test-token", adAccountId: "123", appId: "",
    appSecret: "", businessId: "", pixelId: "",
  });
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" },
  });
}

test("lead Page authentication regression tests", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalPage = process.env.META_PAGE_ID;
  const originalToken = process.env.META_PAGE_ACCESS_TOKEN;
  function reset() {
    delete process.env.META_PAGE_ID;
    delete process.env.META_PAGE_ACCESS_TOKEN;
  }
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalPage === undefined) delete process.env.META_PAGE_ID;
    else process.env.META_PAGE_ID = originalPage;
    if (originalToken === undefined) delete process.env.META_PAGE_ACCESS_TOKEN;
    else process.env.META_PAGE_ACCESS_TOKEN = originalToken;
  });

  await t.test("configured Page token does not change ads authentication", async () => {
    reset(); process.env.META_PAGE_ACCESS_TOKEN = "page-test-token";
    const tokens: Array<string | null> = [];
    globalThis.fetch = async (input) => {
      tokens.push(new URL(String(input)).searchParams.get("access_token"));
      return json({ data: [] });
    };
    const client = newClient();
    await (await leadPageClient(client, "718")).get("/718/leadgen_forms");
    await client.get("/act_123/campaigns");
    assert.deepEqual(tokens, ["page-test-token", "ads-test-token"]);
  });
  await t.test("Page token resolution remains internal and preserves pagination", async () => {
    reset();
    const calls: URL[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input)); calls.push(url);
      if (url.pathname === "/v26.0/718") return json({ access_token: "derived-test-token" });
      return json({ data: [{ id: "form1" }], paging: { cursors: { after: "next" }, next: "https://graph.facebook.com/v26.0/718/leadgen_forms?after=next&access_token=derived-test-token&appsecret_proof=test-proof" } });
    };
    const response = await capture(newClient()).get("list_lead_forms")!({ page_id: "718", limit: 100, after: "cursor" });
    assert.equal(response.isError, undefined);
    assert.equal(calls[0].searchParams.get("fields"), "access_token");
    assert.equal(calls[0].searchParams.get("access_token"), "ads-test-token");
    assert.equal(calls[1].searchParams.get("access_token"), "derived-test-token");
    assert.equal(calls[1].searchParams.get("after"), "cursor");
    assert.equal(calls[1].searchParams.get("limit"), "100");
    assert.doesNotMatch(response.content[0].text, /derived-test-token|ads-test-token|test-proof/);
    assert.equal(JSON.parse(response.content[0].text).paging.cursors.after, "next");
  });
  await t.test("forms and leads retain Page context for subsequent calls", async () => {
    reset();
    const resolutions: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("fields") === "access_token") {
        resolutions.push(url.pathname); return json({ access_token: "derived-test-token" });
      }
      assert.equal(url.searchParams.get("access_token"), "derived-test-token");
      if (url.pathname.endsWith("/leadgen_forms")) return json({ data: [{ id: "form1" }] });
      if (url.pathname.endsWith("/leads")) return json({ data: [{ id: "lead1" }] });
      return json({ id: url.pathname.split("/").pop() });
    };
    const handlers = capture(newClient());
    for (const [name, args] of [
      ["list_lead_forms", { page_id: "718" }],
      ["get_form_leads", { form_id: "form1" }],
      ["get_lead", { lead_id: "lead1" }],
      ["get_lead_form", { form_id: "form1" }],
    ] as Array<[string, Record<string, unknown>]>) {
      assert.equal((await handlers.get(name)!(args)).isError, undefined);
    }
    assert.deepEqual(resolutions, Array(4).fill("/v26.0/718"));
  });
  await t.test("explicit Page hint is not forwarded as a Graph parameter", async () => {
    reset();
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v26.0/719") return json({ access_token: "other-test-token" });
      assert.equal(url.searchParams.get("page_id"), null);
      assert.equal(url.searchParams.get("access_token"), "other-test-token");
      return json({ data: [] });
    };
    assert.equal((await capture(newClient()).get("get_form_leads")!({ form_id: "form2", page_id: "719" })).isError, undefined);
  });
  await t.test("configured Page ID supplies context after restart", async () => {
    reset(); process.env.META_PAGE_ID = "718";
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v26.0/718") return json({ access_token: "derived-test-token" });
      assert.equal(url.searchParams.get("access_token"), "derived-test-token");
      return json({ id: "lead1" });
    };
    assert.equal((await capture(newClient()).get("get_lead")!({ lead_id: "lead1" })).isError, undefined);
  });
  await t.test("different Page does not receive the configured Page token", async () => {
    reset(); process.env.META_PAGE_ID = "718"; process.env.META_PAGE_ACCESS_TOKEN = "page-test-token";
    const tokens: Array<string | null> = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input)); tokens.push(url.searchParams.get("access_token"));
      return url.pathname === "/v26.0/719" ? json({ access_token: "other-test-token" }) : json({ data: [] });
    };
    await (await leadPageClient(newClient(), "719")).get("/719/leadgen_forms");
    assert.deepEqual(tokens, ["ads-test-token", "other-test-token"]);
  });
  await t.test("missing Page token fails before any lead request", async () => {
    reset(); let calls = 0;
    globalThis.fetch = async () => { calls++; return json({ id: "718" }); };
    const response = await capture(newClient()).get("list_lead_forms")!({ page_id: "718" });
    assert.equal(response.isError, true); assert.equal(calls, 1);
    assert.match(response.content[0].text, /did not return a Page access token/);
  });
  await t.test("token lookup failures cannot leak upstream secrets", async () => {
    reset();
    const client = { get: async () => { throw new Error("secret-test-value"); } } as unknown as AdsClient;
    await assert.rejects(leadPageClient(client, "718"), (error: Error) => {
      assert.match(error.message, /Could not resolve/);
      assert.doesNotMatch(error.message, /secret-test-value/); return true;
    });
  });
  await t.test("legacy direct lookup retains its client when no Page is known", async () => {
    reset(); const client = newClient();
    assert.equal(await leadPageClient(client), client);
  });
  await t.test("wrong Page token is not mislabeled as expiration", () => {
    const message = leadError(new Error("Meta Ads API error: [Token Expired] This method must be called with a Page Access Token.. Use exchange_token or refresh_token to obtain a new long-lived token. | code=190 | trace=test-trace"));
    assert.match(message, /\[Page Token Required\]/);
    assert.doesNotMatch(message, /Token Expired|refresh_token/);
    assert.match(message, /trace=test-trace/);
  });
  await t.test("actual expiry and generic authentication remain distinct", () => {
    assert.match(leadError(new Error("[Token Expired] Invalid token | code=190 | subcode=463")), /\[Token Expired\]/);
    assert.match(leadError(new Error("[Token Expired] Invalid token | code=190 | subcode=467")), /\[Authentication Error\]/);
  });
  await t.test("form creation keeps its payload and uses Page authentication", async () => {
    reset(); process.env.META_PAGE_ACCESS_TOKEN = "page-test-token";
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(init?.method, "POST"); assert.equal(body.access_token, "page-test-token");
      assert.equal(body.name, "Test form");
      assert.deepEqual(JSON.parse(body.privacy_policy), { url: "https://example.com/privacy" });
      return json({ id: "form1" });
    };
    const response = await capture(newClient()).get("create_lead_form")!({
      page_id: "718", name: "Test form", questions: "[]", privacy_policy_url: "https://example.com/privacy",
    });
    assert.equal(response.isError, undefined);
  });
});
