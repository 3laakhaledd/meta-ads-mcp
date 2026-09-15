import test from "node:test";
import assert from "node:assert/strict";
import { registerLaunchControls } from "../src/tools/launch-controls.js";
function fixture(reject = false) {
  const handlers: Record<string, any> = {};
  const posts: any[] = [];
  registerLaunchControls({ tool: (n, _d, _s, h) => { handlers[n] = h; } }, {
    accountPath: a => "/act_" + a?.replace(/^act_/, ""),
    get: async () => ({ data: {} }),
    post: async (path, params) => {
      posts.push({ path, params });
      if (reject) throw new Error("secret token | code=100 | subcode=3858558");
      return { data: params.execution_options ? { success: true } : { id: "789" } };
    },
  });
  return { handlers, posts };
}
const campaign = { name: "Parents", account_id: "act_456", objective: "OUTCOME_LEADS", lifetime_budget: "280000" };
test("campaign defaults to validation only with CBO and PAUSED", async () => {
  const f = fixture();
  const r = await f.handlers.create_lifetime_campaign(campaign);
  assert.equal(r.isError, undefined);
  assert.equal(f.posts[0].path, "/act_456/campaigns");
  assert.equal(f.posts[0].params.execution_options, '["validate_only"]');
  assert.equal(f.posts[0].params.status, "PAUSED");
  assert.equal(f.posts[0].params.daily_budget, undefined);
  assert.equal(f.posts[0].params.bid_strategy, "LOWEST_COST_WITHOUT_CAP");
});
test("explicit creation stays paused", async () => {
  const f = fixture();
  await f.handlers.create_lifetime_campaign({ ...campaign, dry_run: false });
  assert.equal(f.posts[0].params.execution_options, undefined);
  assert.equal(f.posts[0].params.status, "PAUSED");
});
test("rejects unsafe amounts and activation input", async () => {
  for (const a of [{ ...campaign, lifetime_budget: "0" }, { ...campaign, lifetime_budget: "999999999999999999" },
    { ...campaign, status: "ACTIVE" }, { ...campaign, daily_budget: "123" }]) {
    const f = fixture(); assert.equal((await f.handlers.create_lifetime_campaign(a)).isError, true);
    assert.equal(f.posts.length, 0);
  }
});
test("array is sent verbatim with ENGAGEMENT and prefill", async () => {
  const f = fixture();
  const rule = '[{"object_id":"123","event_name":"video_view_50_percent"}]';
  const r = await f.handlers.create_rule_audience({ name: "Viewers", subtype: "ENGAGEMENT", rule, prefill: true });
  assert.equal(r.isError, undefined);
  assert.equal(f.posts[0].params.rule, rule);
  assert.equal(f.posts[0].params.prefill, true);
});
test("rejects invalid video arrays and wrong subtype", async () => {
  for (const rule of ["[]", '[{"object_id":"123","event_name":"wrong"}]', '[{"object_id":"bad","event_name":"video_watched"}]']) {
    const f = fixture();
    assert.equal((await f.handlers.create_rule_audience({ name: "V", subtype: "ENGAGEMENT", rule })).isError, true);
    assert.equal(f.posts.length, 0);
  }
  const f = fixture();
  assert.equal((await f.handlers.create_rule_audience({ name: "V", subtype: "WEBSITE",
    rule: '[{"object_id":"123","event_name":"video_watched"}]', pixel_id: "456" })).isError, true);
});
test("campaign errors include safe diagnostics without secret text", async () => {
  const f = fixture(true); const r = await f.handlers.create_lifetime_campaign(campaign);
  assert.equal(r.isError, true);
  assert.equal(JSON.parse(r.content[0].text).diagnostic.subcode, 3858558);
  assert.equal(JSON.stringify(r).includes("secret token"), false);
});
