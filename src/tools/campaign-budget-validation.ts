import { z } from "zod";
import { safeMetaDiagnostic } from "./safe-meta-diagnostic.js";

type Client = {
  get(path: string, params: Record<string, unknown>): Promise<{ data: unknown }>;
  post(path: string, params: Record<string, unknown>): Promise<{ data: unknown }>;
};
type Registrar = { tool(name: string, description: string, schema: any, handler: any): unknown };
const money = z.string().regex(/^(0|[1-9]\d*)$/).refine(
  value => Number.isSafeInteger(Number(value)), "Amount exceeds safe integer range");
export const budgetSchema = z.object({
  campaign_id: z.string().regex(/^\d+$/),
  account_id: z.string().regex(/^(act_)?\d+$/),
  lifetime_budget: money.refine(value => Number(value) > 0, "Lifetime budget must be positive"),
  expected_daily_budget: money,
  expected_lifetime_budget: money.default("0"),
  dry_run: z.boolean().default(true),
}).strict();

function requireValid(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`Validation: ${message}`);
}
function object(data: unknown): Record<string, unknown> {
  requireValid(!!data && typeof data === "object" && !Array.isArray(data), "Invalid Meta response.");
  return data as Record<string, unknown>;
}
function reply(data: unknown, isError = false) {
  return { ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
export function registerCampaignBudgetValidation(server: Registrar, client: Client): void {
  server.tool("set_campaign_lifetime_budget",
    "Validate a campaign-level lifetime budget (CBO). Defaults to dry_run=true. Requires PAUSED campaign and expected current budgets. Explicitly clears daily budget. Apply revalidates, checks for concurrent changes, then reads back. Never activates campaigns or edits ad sets. Meta may reject budget-type conversion.",
    budgetSchema.shape, async (raw: unknown) => {
      let applied = false;
      let stage = "input_validation";
      let applyAttempted = false;
      try {
        const a = budgetSchema.parse(raw);
        const path = `/${a.campaign_id}`;
        const fields = "id,account_id,name,status,daily_budget,lifetime_budget,bid_strategy";
        async function read() { return object((await client.get(path, { fields })).data); }
        function check(current: Record<string, unknown>) {
          requireValid(String(current.account_id) === a.account_id.replace(/^act_/, ""), "Campaign belongs to another account.");
          requireValid(current.status === "PAUSED", "Campaign must already be paused.");
          requireValid(Number(current.daily_budget || 0) === Number(a.expected_daily_budget) &&
            Number(current.lifetime_budget || 0) === Number(a.expected_lifetime_budget),
            "Budgets changed; refresh the preview.");
          requireValid(Number(current.daily_budget || 0) > 0 || Number(current.lifetime_budget || 0) > 0,
            "Existing campaign must use campaign-level budgeting.");
        }
        stage = "read_current";
        const before = await read();
        check(before);
        const params = { daily_budget: "0", lifetime_budget: a.lifetime_budget, status: "PAUSED" };
        stage = "meta_validation";
        const validation = object((await client.post(path, {
          ...params, execution_options: JSON.stringify(["validate_only"]),
        })).data);
        requireValid(validation.success === true, "Meta did not confirm validation.");
        if (a.dry_run) return reply({ dry_run: true, validated: true, before, proposed: params });
        stage = "concurrency_check";
        check(await read());
        stage = "apply";
        applyAttempted = true;
        const result = object((await client.post(path, params)).data);
        requireValid(result.success === true, "Meta did not confirm the update; inspect current state before retrying.");
        applied = true;
        stage = "readback";
        const after = await read();
        const verified = after.status === "PAUSED" &&
          Number(after.daily_budget || 0) === 0 &&
          Number(after.lifetime_budget || 0) === Number(a.lifetime_budget) &&
          after.bid_strategy === before.bid_strategy;
        return reply({ dry_run: false, applied, verified, before, after }, !verified);
      } catch (error) {
        const message = error instanceof z.ZodError ? "Invalid budget arguments." :
          error instanceof Error && error.message.startsWith("Validation:") ? error.message :
          "Meta request failed. Inspect campaign state before retrying; no automatic retry was performed.";
        return reply({ applied, applyAttempted, state_uncertain: applyAttempted && !applied,
          stage, verified: false, message, diagnostic: safeMetaDiagnostic(error) }, true);
      }
    });
}
