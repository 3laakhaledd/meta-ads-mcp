import test from "node:test";
import assert from "node:assert/strict";
import { registerLaunchControls, adsetSchema, audienceSchema, scheduleSchema } from "../src/tools/launch-controls.js";

const slots = [{ start_minute: 960, end_minute: 1440, days: [0, 1, 2, 3, 4, 5, 6] }];
const base = {
  name: "Test", campaign_id: "123", targeting: '{"geo_locations":{"countries":["EG"]}}',
  promoted_object: '{"page_id":"456"}', optimization_goal: "CONVERSATIONS",
  destination_type: "MESSENGER", start_time: "2026-09-20T16:00:00+03:00",
  end_time: "2026-09-25T16:00:00+03:00",
  attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
};
function fixture(parent: Record<string, unknown> = { daily_budget: "10000" }) {
  const handlers: Record<string, (a: unknown) => Promise<any>> = {};
  const posts: { path: string; params: Record<string, unknown> }[] = [];
  const client = {
    accountPath: () => "/act_123",
    get: async () => ({ data: parent }),
    post: async (path: string, params: Record<string, unknown>) => {
      posts.push({ path, params }); return { data: { id: "789" } };
    },
  };
  registerLaunchControls({ tool: (name, _description, _schema, handler) => { handlers[name] = handler; } }, client);
  return { handlers, posts };
}
test("registers four isolated tools", () => {
  assert.equal(Object.keys(fixture().handlers).length, 4);
});
test("audience forwards rules and defaults to validate only", async () => {
  const f = fixture();
  await f.handlers.create_rule_audience({ name: "Viewers", subtype: "ENGAGEMENT", rule: '[{"object_id":"42","event_name":"video_view_50_percent"}]' });
  assert.equal(f.posts[0].params.rule, '[{"object_id":"42","event_name":"video_view_50_percent"}]');
  assert.equal(f.posts[0].params.execution_options, '["validate_only"]');
});
test("invalid JSON, arrays and empty rules make no writes", async () => {
  const f = fixture();
  for (const rule of ["bad", "[]", "{}"]) {
    const result = await f.handlers.create_rule_audience({ name: "V", subtype: "VIDEO", rule });
    assert.equal(result.isError, true);
  }
  assert.equal(f.posts.length, 0);
});
test("website audience requires pixel", async () => {
  const f = fixture();
  assert.equal((await f.handlers.create_rule_audience({ name: "V", subtype: "WEBSITE", rule: '{"x":1}' })).isError, true);
});
test("creation forwards attribution and always pauses", async () => {
  const f = fixture();
  await f.handlers.create_launch_adset({ ...base, dry_run: false });
  assert.equal(f.posts[0].params.status, "PAUSED");
  assert.equal(f.posts[0].params.attribution_spec, JSON.stringify(base.attribution_spec));
  assert.equal(f.posts[0].params.execution_options, undefined);
});
test("messaging rejects seven-day attribution", async () => {
  const f = fixture();
  assert.equal((await f.handlers.create_launch_adset({ ...base,
    attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 7 }] })).isError, true);
  assert.equal(f.posts.length, 0);
});
test("CBO rejects ad-set budget", async () => {
  const f = fixture();
  assert.equal((await f.handlers.create_launch_adset({ ...base, daily_budget: "10000" })).isError, true);
});
test("ABO requires budget and validates dates", async () => {
  const f = fixture({});
  assert.equal((await f.handlers.create_launch_adset(base)).isError, true);
  assert.equal((await f.handlers.create_launch_adset({ ...base, daily_budget: "10000", end_time: base.start_time })).isError, true);
});
test("daily budget cannot enable hourly delivery", async () => {
  const f = fixture();
  assert.equal((await f.handlers.create_launch_adset({ ...base, adset_schedule: slots })).isError, true);
  assert.equal(f.posts.length, 0);
});
test("lifetime budget supports hourly delivery", async () => {
  const f = fixture({ lifetime_budget: "100000" });
  await f.handlers.create_launch_adset({ ...base, adset_schedule: slots });
  assert.equal(f.posts[0].params.pacing_type, '["day_parting"]');
  assert.equal(JSON.parse(f.posts[0].params.adset_schedule as string)[0].timezone_type, "ADVERTISER");
});
test("schedule validation rejects invalid or overlapping slots", () => {
  for (const adset_schedule of [
    [{ start_minute: 960, end_minute: 900, days: [1] }],
    [{ start_minute: 960, end_minute: 1440, days: [7] }],
    [{ start_minute: 960, end_minute: 1440, days: [1, 1] }],
    [...slots, ...slots],
  ]) assert.equal(scheduleSchema.safeParse({ adset_id: "123", adset_schedule }).success, false);
});
test("scheduling preserves status and budget", async () => {
  const f = fixture({ campaign_id: "123", lifetime_budget: "100000", end_time: base.end_time });
  await f.handlers.set_adset_hourly_schedule({ adset_id: "456", adset_schedule: slots });
  assert.deepEqual(Object.keys(f.posts[0].params).sort(), ["adset_schedule", "execution_options", "pacing_type"]);
});
test("schemas reject activation and immutable attribution on updates", () => {
  assert.equal(adsetSchema.safeParse({ ...base, status: "ACTIVE" }).success, false);
  assert.equal(scheduleSchema.safeParse({ adset_id: "123", adset_schedule: slots, attribution_spec: [] }).success, false);
  assert.equal(audienceSchema.safeParse({ name: "V", subtype: "VIDEO", rule: "{}", retention_days: 181 }).success, false);
});
