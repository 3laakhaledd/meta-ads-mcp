import test from "node:test";
import assert from "node:assert/strict";
import { registerCampaignBudgetValidation } from "../src/tools/campaign-budget-validation.js";

const input = { campaign_id: "123", account_id: "act_456", lifetime_budget: "280000",
  expected_daily_budget: "21000" };
function fixture(options: { reject?: boolean; ignore?: boolean; change?: boolean; readFail?: boolean;
  status?: string; account?: string } = {}) {
  let handler: any;
  let reads = 0;
  let state = { id: "123", account_id: options.account || "456", name: "Parents",
    status: options.status || "PAUSED", daily_budget: "21000", lifetime_budget: "0",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP" };
  const posts: Record<string, unknown>[] = [];
  registerCampaignBudgetValidation({ tool: (_n, _d, _s, h) => { handler = h; } }, {
    get: async () => {
      reads++;
      if (options.readFail && reads === 3) throw new Error("token=SECRET");
      if (options.change && reads === 2) state.daily_budget = "22000";
      return { data: { ...state } };
    },
    post: async (_p, params) => {
      posts.push(params);
      if (options.reject) throw new Error("access_token=SECRET");
      if (!params.execution_options && !options.ignore)
        state = { ...state, daily_budget: String(params.daily_budget), lifetime_budget: String(params.lifetime_budget) };
      return { data: { success: true } };
    },
  });
  return { run: (a: unknown) => handler(a), posts };
}
test("dry run is default and only sends validate_only", async () => {
  const f = fixture(); const result = await f.run(input);
  assert.equal(result.isError, undefined);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].execution_options, '["validate_only"]');
  assert.equal(f.posts[0].daily_budget, "0");
  assert.equal(f.posts[0].status, "PAUSED");
});
test("explicit apply validates first and verifies persisted budget", async () => {
  const f = fixture(); const result = await f.run({ ...input, dry_run: false });
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[1].execution_options, undefined);
  assert.equal(JSON.parse(result.content[0].text).verified, true);
  assert.equal(f.posts[1].bid_strategy, undefined);
});
test("wrong account or active campaign cannot be edited", async () => {
  for (const options of [{ account: "999" }, { status: "ACTIVE" }]) {
    const f = fixture(options);
    assert.equal((await f.run(input)).isError, true);
    assert.equal(f.posts.length, 0);
  }
});
test("stale preview cannot apply", async () => {
  const f = fixture();
  assert.equal((await f.run({ ...input, expected_daily_budget: "100" })).isError, true);
  assert.equal(f.posts.length, 0);
});
test("concurrent budget change after validation stops apply", async () => {
  const f = fixture({ change: true });
  assert.equal((await f.run({ ...input, dry_run: false })).isError, true);
  assert.equal(f.posts.length, 1);
});
test("invalid money and unsupported fields are rejected", async () => {
  for (const args of [{ ...input, lifetime_budget: "-1" }, { ...input, lifetime_budget: "0" },
    { ...input, lifetime_budget: "1.2" }, { ...input, lifetime_budget: "999999999999999999" },
    { ...input, status: "ACTIVE" }]) {
    const f = fixture();
    assert.equal((await f.run(args)).isError, true);
    assert.equal(f.posts.length, 0);
  }
});
test("Meta rejection makes no apply call and redacts secrets", async () => {
  const f = fixture({ reject: true }); const r = await f.run({ ...input, dry_run: false });
  assert.equal(r.isError, true);
  assert.equal(f.posts.length, 1);
  assert.equal(JSON.stringify(r).includes("SECRET"), false);
});
test("silent API normalization is not claimed verified", async () => {
  const f = fixture({ ignore: true });
  const r = await f.run({ ...input, dry_run: false });
  assert.equal(r.isError, true);
  assert.equal(JSON.parse(r.content[0].text).applied, true);
  assert.equal(JSON.parse(r.content[0].text).verified, false);
});
test("readback failure reports applied but unverified", async () => {
  const f = fixture({ readFail: true }); const r = await f.run({ ...input, dry_run: false });
  assert.equal(r.isError, true);
  assert.equal(JSON.parse(r.content[0].text).applied, true);
  assert.equal(JSON.stringify(r).includes("SECRET"), false);
});
