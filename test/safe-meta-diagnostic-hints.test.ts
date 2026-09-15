import { test } from "node:test";
import assert from "node:assert/strict";
import { safeMetaDiagnostic } from "../src/tools/safe-meta-diagnostic.js";

test("exposes bidding clues without leaking raw credentials or URLs", () => {
  const result = safeMetaDiagnostic(new Error("Bid strategy requires bid_amount. https://example.invalid/?access_token=SECRET | code=100 | subcode=2490487"));
  assert.equal(result.code, 100);
  assert.equal(result.subcode, 2490487);
  assert.deepEqual(result.hints, ["bid_strategy", "bid_amount"]);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.ok(!JSON.stringify(result).includes("example.invalid"));
});
test("identifies objective and destination terms without assigning code meanings", () => {
  const result = safeMetaDiagnostic(new Error("Optimization goal not supported for campaign objective and destination type | code=100 | subcode=1885760"));
  assert.deepEqual(result.hints, ["optimization_goal", "campaign_objective", "destination_type", "incompatible"]);
});
test("unknown text never becomes output", () => {
  assert.deepEqual(safeMetaDiagnostic(new Error("PRIVATE_CUSTOMER_DATA")).hints, []);
  assert.ok(!JSON.stringify(safeMetaDiagnostic(new Error("PRIVATE_CUSTOMER_DATA"))).includes("PRIVATE_CUSTOMER_DATA"));
  assert.equal(safeMetaDiagnostic(null).category, "unknown");
});
