import test from "node:test";
import assert from "node:assert/strict";
import { safeMetaDiagnostic } from "../src/tools/safe-meta-diagnostic.js";
test("retains Meta error codes but never arbitrary text", () => {
  const out = safeMetaDiagnostic(new Error("Meta Ads API error: bad budget https://example.com/?access_token=SECRET | code=100 | subcode=1885260 | type=OAuthException | trace=SECRET"));
  assert.equal(out.code, 100);
  assert.equal(out.subcode, 1885260);
  assert.equal(out.category, "invalid_parameter");
  assert.equal(JSON.stringify(out).includes("SECRET"), false);
  assert.equal(JSON.stringify(out).includes("example.com"), false);
});
test("unknown thrown values never leak", () => {
  for (const value of ["SECRET", { token: "SECRET" }, new Error('{"access_token":"SECRET"}'), null]) {
    assert.equal(JSON.stringify(safeMetaDiagnostic(value)).includes("SECRET"), false);
  }
});
test("classifies known error families", () => {
  for (const [code, category] of [["190","authentication"],["200","permissions"],["17","rate_limit"]]) {
    assert.equal(safeMetaDiagnostic(new Error(`Meta error | code=${code}`)).category, category);
  }
});
