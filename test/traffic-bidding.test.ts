import { test } from "node:test";
import assert from "node:assert/strict";
import { registerLaunchControls } from "../src/tools/launch-controls.js";

const base = {
  name: "Validation only", campaign_id: "123", account_id: "act_456",
  targeting: '{"geo_locations":{"countries":["EG"]}}', promoted_object: "{}",
  optimization_goal: "LINK_CLICKS", destination_type: "WEBSITE",
  start_time: "2026-09-15T18:00:00+03:00", end_time: "2026-09-25T16:00:00+03:00",
};
async function run(parent: object, extras: object) {
  const handlers: Record<string, any> = {};
  const posts: any[] = [];
  registerLaunchControls({ tool(name: string, _desc: string, _schema: any, handler: any) { handlers[name] = handler; } }, {
    accountPath: () => "act_456",
    get: async () => ({ data: parent }),
    post: async (path, params) => { posts.push({ path, params }); return { data: { success: true } }; },
  });
  const result: any = await handlers.create_launch_adset({ ...base, ...extras });
  assert.ok(!result.isError);
  return posts[0].params;
}
test("ABO traffic explicitly uses automatic bidding and remains validate-only", async () => {
  const p = await run({}, { daily_budget: "28000" });
  assert.equal(p.bid_strategy, "LOWEST_COST_WITHOUT_CAP");
  assert.equal(p.status, "PAUSED");
  assert.deepEqual(JSON.parse(p.execution_options), ["validate_only"]);
  assert.equal(p.promoted_object, "{}");
});
test("CBO traffic leaves campaign bidding untouched", async () => {
  const p = await run({ daily_budget: "28000" }, {});
  assert.equal(p.bid_strategy, undefined);
  assert.equal(p.daily_budget, undefined);
  assert.deepEqual(JSON.parse(p.execution_options), ["validate_only"]);
});
