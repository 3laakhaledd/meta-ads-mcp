import test from "node:test";
import assert from "node:assert/strict";
import { audienceSchema, registerLaunchControls } from "../src/tools/launch-controls.js";

test("accepts arguments already transformed by MCP schema validation", async () => {
  const handlers: Record<string, any> = {};
  const posts: any[] = [];
  registerLaunchControls({ tool: (name, _d, _s, handler) => { handlers[name] = handler; } }, {
    accountPath: () => "/act_123",
    get: async () => ({ data: {} }),
    post: async (_p, params) => { posts.push(params); return { data: { id: "456" } }; },
  });
  const args = audienceSchema.parse({ name: "Viewers", subtype: "ENGAGEMENT", rule: '[{"object_id":"42","event_name":"video_view_50_percent"}]' });
  const result = await handlers.create_rule_audience(args);
  assert.equal(result.isError, undefined);
  assert.equal(posts[0].rule, '[{"object_id":"42","event_name":"video_view_50_percent"}]');
  assert.equal(posts[0].execution_options, '["validate_only"]');
});
test("API failure cannot masquerade as success or leak credentials", async () => {
  const handlers: Record<string, any> = {};
  registerLaunchControls({ tool: (name, _d, _s, handler) => { handlers[name] = handler; } }, {
    accountPath: () => "/act_123",
    get: async () => ({ data: {} }),
    post: async () => { throw new Error("access_token=SECRET"); },
  });
  const result = await handlers.create_rule_audience({ name: "V", subtype: "ENGAGEMENT", rule: '[{"object_id":"42","event_name":"video_view_50_percent"}]' });
  assert.equal(result.isError, true);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});
