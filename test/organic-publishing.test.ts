import test from "node:test";
import assert from "node:assert/strict";
import { registerOrganicPublishingTools, facebookPostSchema, instagramPostSchema,
  PUBLISHED_POST_FIELDS, graphRequest } from "../src/tools/organic-publishing.js";

process.env.META_ADS_ACCESS_TOKEN = "test-only-system-token";
function harness(replies: Record<string, any>[] = [], clock: () => number = Date.now) {
  const tools: Record<string, (a: any) => Promise<any>> = {};
  const calls: any[] = [];
  registerOrganicPublishingTools({ tool(name, _description, _schema, handler) { tools[name] = handler; } },
    async (...args) => {
      calls.push(args);
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected network call");
      if (reply.fail) throw new Error("secret-token must never appear");
      return reply;
    }, clock);
  const run = async (name: string, a: any) => {
    const response = await tools[name](a);
    return { error: response.isError === true, ...JSON.parse(response.content[0].text) };
  };
  return { tools, calls, run };
}
const fb = { page_id: "123", message: "Approved post" };
const ig = { ig_account_id: "456", media_type: "IMAGE", media_url: "https://cdn.example.org/photo.jpg", caption: "Caption" };
async function approved(h: ReturnType<typeof harness>, name: string, a: any) {
  const preview = await h.run(name, a);
  return { ...a, approval_token: preview.approval_token, confidence: "approved" };
}

test("Facebook read fields omit both deprecated type fields", () => {
  assert.equal(PUBLISHED_POST_FIELDS, "id,message,created_time,permalink_url,full_picture,is_published,attachments{media_type,title,url}");
});
test("previews make zero requests and show exact destination/content", async () => {
  const h = harness();
  const a = await h.run("publish_facebook_post", fb);
  const b = await h.run("publish_instagram_post", ig);
  assert.equal(a.status, "confirmation_required");
  assert.equal(a.preview.page_id, "123");
  assert.equal(b.preview.caption, "Caption");
  assert.equal(h.calls.length, 0);
});
test("approval cannot be skipped, changed, replayed or crossed between platforms", async () => {
  const h = harness([{ id: "123", access_token: "page-token" }, { id: "123_789" }]);
  assert.equal((await h.run("publish_facebook_post", { ...fb, confidence: "approved" })).error, true);
  const a = await approved(h, "publish_facebook_post", fb);
  assert.equal((await h.run("publish_facebook_post", { ...a, message: "Changed" })).error, true);
  assert.equal((await h.run("publish_instagram_post", { ...ig, approval_token: a.approval_token, confidence: "approved" })).error, true);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.run("publish_facebook_post", a)).status, "published");
  assert.equal((await h.run("publish_facebook_post", a)).error, true);
  assert.equal(h.calls.length, 2);
});
test("expired approvals cannot write", async () => {
  let now = 0;
  const h = harness([], () => now);
  const a = await approved(h, "publish_facebook_post", fb);
  now = 600001;
  assert.equal((await h.run("publish_facebook_post", a)).error, true);
  assert.equal(h.calls.length, 0);
});
test("Facebook resolves a destination-specific Page token", async () => {
  const h = harness([{ id: "123", access_token: "page-token" }, { id: "123_789" }]);
  const response = await h.run("publish_facebook_post", await approved(h, "publish_facebook_post", fb));
  assert.equal(response.status, "published");
  assert.deepEqual(h.calls[1], ["POST", "/123/feed", { message: "Approved post" }, "page-token"]);
  assert.ok(!JSON.stringify(response).includes("page-token"));
});
test("Facebook photo uses photos endpoint and caption", async () => {
  const h = harness([{ id: "123", access_token: "page-token" }, { id: "789", post_id: "123_789" }]);
  const a = { ...fb, photo_url: "https://cdn.example.org/a.jpg" };
  const response = await h.run("publish_facebook_post", await approved(h, "publish_facebook_post", a));
  assert.equal(response.post_id, "123_789");
  assert.equal(h.calls[1][1], "/123/photos");
  assert.equal(h.calls[1][2].caption, fb.message);
});
test("Facebook refuses mismatched Page or missing token", async () => {
  for (const reply of [{ id: "999", access_token: "wrong" }, { id: "123" }]) {
    const h = harness([reply]);
    assert.equal((await h.run("publish_facebook_post", await approved(h, "publish_facebook_post", fb))).error, true);
    assert.equal(h.calls.length, 1);
  }
});
test("schemas reject empty posts, invalid IDs, mixed media, unsafe protocols and oversized captions", () => {
  for (const a of [{ page_id: "123" }, { ...fb, page_id: "../me" },
    { ...fb, link: "https://example.org", photo_url: "https://example.org/a.jpg" },
    { ...fb, link: "http://example.org" }, { ...fb, link: "https://user:pass@example.org" }])
    assert.equal(facebookPostSchema.safeParse(a).success, false);
  assert.equal(instagramPostSchema.safeParse({ ...ig, caption: "x".repeat(2201) }).success, false);
});
test("ready Instagram image creates then publishes one container", async () => {
  const h = harness([{ id: "789" }, { status_code: "FINISHED" }, { id: "1000" }]);
  const response = await h.run("publish_instagram_post", await approved(h, "publish_instagram_post", ig));
  assert.equal(response.status, "published");
  assert.deepEqual(h.calls.map(c => c.slice(0, 2)), [["POST", "/456/media"], ["GET", "/789"], ["POST", "/456/media_publish"]]);
  assert.equal(h.calls[0][2].image_url, ig.media_url);
});
test("processing Reel is not published and resumes same container only after new approval", async () => {
  const h = harness([{ id: "789" }, { status_code: "IN_PROGRESS" },
    { status_code: "FINISHED" }, { status_code: "FINISHED" }, { id: "1000" }]);
  const reel = { ...ig, media_type: "REELS", share_to_feed: false };
  assert.equal((await h.run("publish_instagram_post", await approved(h, "publish_instagram_post", reel))).status, "container_not_published");
  assert.equal(h.calls[0][2].video_url, ig.media_url);
  assert.equal(h.calls[0][2].share_to_feed, "false");
  assert.equal((await h.run("get_instagram_container_status", { creation_id: "789" })).status_code, "FINISHED");
  const resume = { ig_account_id: "456", creation_id: "789" };
  const a = await approved(h, "publish_instagram_container", resume);
  assert.equal(h.calls.length, 3);
  assert.equal((await h.run("publish_instagram_container", a)).status, "published");
  assert.equal(h.calls.filter(c => c[1] === "/456/media").length, 1);
});
test("container status failure preserves ID for reconciliation", async () => {
  const h = harness([{ id: "789" }, { fail: true }]);
  const response = await h.run("publish_instagram_post", await approved(h, "publish_instagram_post", ig));
  assert.equal(response.status, "container_created_status_unknown");
  assert.equal(response.creation_id, "789");
});
test("foreign containers and destination substitution cannot publish", async () => {
  const h = harness([{ id: "789" }, { status_code: "IN_PROGRESS" }]);
  await h.run("publish_instagram_post", await approved(h, "publish_instagram_post", ig));
  for (const a of [{ ig_account_id: "999", creation_id: "789" }, { ig_account_id: "456", creation_id: "111" }])
    assert.equal((await h.run("publish_instagram_container", a)).error, true);
  assert.equal(h.calls.length, 2);
});
test("ambiguous POST failures consume approval, do not retry and do not leak secrets", async () => {
  const h = harness([{ id: "123", access_token: "page-token" }, { fail: true }]);
  const a = await approved(h, "publish_facebook_post", fb);
  const response = await h.run("publish_facebook_post", a);
  assert.equal(response.status, "not_confirmed");
  assert.ok(!JSON.stringify(response).includes("secret-token"));
  await h.run("publish_facebook_post", a);
  assert.equal(h.calls.length, 2);
});
test("real Graph transport keeps tokens out of URLs and rejects arbitrary paths", async () => {
  const original = globalThis.fetch;
  const calls: any[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init]);
    return new Response('{"id":"789"}', { status: 200 });
  };
  try {
    await graphRequest("POST", "/123/feed", { message: "Hello" }, "private-token");
    await graphRequest("GET", "/123", { fields: "id" }, "private-token");
    assert.ok(calls.every(c => !c[0].includes("private-token")));
    assert.equal(calls[0][1].headers.Authorization, "Bearer private-token");
    await assert.rejects(() => graphRequest("GET", "/me/../../evil"));
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
});
