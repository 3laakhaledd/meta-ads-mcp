import { z } from "zod";

// Structural interfaces keep these handlers independently testable.
type Client = {
  accountPath(id?: string): string;
  get(path: string, params?: Record<string, unknown>): Promise<{ data: unknown }>;
  post(path: string, params: Record<string, unknown>): Promise<{ data: unknown }>;
};
type Registrar = {
  tool(name: string, description: string, schema: any, handler: any): unknown;
};
const jsonObject = z.string().transform((text, ctx) => {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a JSON object" });
    return z.NEVER;
  }
});
const schedule = z.array(z.object({
  start_minute: z.number().int().min(0).max(1439),
  end_minute: z.number().int().min(1).max(1440),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  timezone_type: z.literal("ADVERTISER").default("ADVERTISER"),
}).strict()).min(1).superRefine((slots, ctx) => {
  for (let i = 0; i < slots.length; i++) {
    const a = slots[i];
    if (a.end_minute <= a.start_minute || new Set(a.days).size !== a.days.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid time range or duplicate day" });
    for (const b of slots.slice(0, i)) {
      if (a.days.some(d => b.days.includes(d)) &&
          a.start_minute < b.end_minute && b.start_minute < a.end_minute)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Schedule intervals overlap" });
    }
  }
});
const attribution = z.array(z.object({
  event_type: z.enum(["CLICK_THROUGH", "VIEW_THROUGH"]),
  window_days: z.union([z.literal(1), z.literal(7)]),
}).strict()).min(1).superRefine((items, ctx) => {
  if (new Set(items.map(i => i.event_type)).size !== items.length ||
      items.some(i => i.event_type === "VIEW_THROUGH" && i.window_days !== 1))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate event or invalid view window" });
});
const id = z.string().regex(/^\d+$/);
const money = z.string().regex(/^[1-9]\d*$/);
const date = z.string().datetime({ offset: true });
const write = { dry_run: z.boolean().default(true).describe("Validate only by default. Set false only after approval.") };

export const audienceSchema = z.object({
  name: z.string().min(1),
  subtype: z.enum(["ENGAGEMENT", "VIDEO", "WEBSITE"]),
  rule: jsonObject,
  retention_days: z.number().int().min(1).max(180).optional(),
  pixel_id: id.optional(),
  account_id: z.string().optional(),
  ...write,
}).strict();
export const adsetSchema = z.object({
  name: z.string().min(1), campaign_id: id,
  targeting: jsonObject, promoted_object: jsonObject,
  optimization_goal: z.enum(["CONVERSATIONS", "OFFSITE_CONVERSIONS", "LINK_CLICKS", "LANDING_PAGE_VIEWS"]),
  destination_type: z.enum(["WEBSITE", "MESSENGER", "INSTAGRAM_DIRECT", "WHATSAPP"]),
  attribution_spec: attribution.optional(),
  start_time: date, end_time: date,
  daily_budget: money.optional(), lifetime_budget: money.optional(),
  adset_schedule: schedule.optional(),
  account_id: z.string().optional(),
  ...write,
}).strict();
export const scheduleSchema = z.object({
  adset_id: id, adset_schedule: schedule, ...write,
}).strict();

function payload(params: Record<string, unknown>, dryRun: boolean) {
  return dryRun ? { ...params, execution_options: JSON.stringify(["validate_only"]) } : params;
}
function response(data: unknown, dryRun: boolean) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ dry_run: dryRun, result: data }) }] };
}
function guarded(fn: (args: any) => Promise<unknown>) {
  return async (args: unknown) => {
    try { return await fn(args); }
    catch (error) {
      // Do not echo API errors containing URLs or credentials.
      const text = error instanceof z.ZodError ? "Invalid launch-control arguments." :
        error instanceof Error && error.message.startsWith("Validation:") ? error.message :
        "Meta request failed. Check permissions and API compatibility; no success is confirmed.";
      return { isError: true, content: [{ type: "text" as const, text }] };
    }
  };
}
function requireValid(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`Validation: ${message}`);
}
export function registerLaunchControls(server: Registrar, client: Client): void {
  server.tool("create_rule_audience",
    "Create a rule-based video/engagement/website audience. Defaults to validate-only. Meta validates rule semantics and source permissions; this does not populate viewers.",
    audienceSchema.shape, guarded(async raw => {
      const a = audienceSchema.parse(raw);
      requireValid(Object.keys(a.rule).length > 0, "Audience rule cannot be empty.");
      requireValid(a.subtype !== "WEBSITE" || !!a.pixel_id, "Website audience requires pixel_id.");
      const { account_id, dry_run, rule, ...rest } = a;
      const { data } = await client.post(`${client.accountPath(account_id)}/customaudiences`,
        payload({ ...rest, rule: JSON.stringify(rule) }, dry_run));
      return response(data, dry_run);
    }));
  server.tool("create_launch_adset",
    "Create a PAUSED ad set with explicit destination and creation-time attribution. Optional hourly delivery requires lifetime budget. Cannot change attribution on existing ad sets; does not migrate ads.",
    adsetSchema.shape, guarded(async raw => {
      const a = adsetSchema.parse(raw);
      requireValid(Date.parse(a.end_time) > Date.parse(a.start_time), "End must follow start.");
      requireValid(!(a.daily_budget && a.lifetime_budget), "Choose one budget type.");
      if (a.optimization_goal === "CONVERSATIONS") {
        requireValid(a.destination_type !== "WEBSITE" && !!a.promoted_object.page_id, "Messaging requires a messaging destination and page_id.");
        requireValid(!!a.attribution_spec && a.attribution_spec.length === 1 &&
          a.attribution_spec[0].event_type === "CLICK_THROUGH" &&
          a.attribution_spec[0].window_days === 1, "Use one-day click attribution for this messaging tool.");
      }
      const { data } = await client.get(`/${a.campaign_id}`, { fields: "daily_budget,lifetime_budget" });
      const parent = data as Record<string, unknown>;
      const cbo = Number(parent.daily_budget || 0) > 0 || Number(parent.lifetime_budget || 0) > 0;
      requireValid(!(cbo && (a.daily_budget || a.lifetime_budget)), "CBO budgets belong on the campaign.");
      requireValid(cbo || !!a.daily_budget || !!a.lifetime_budget, "ABO requires an ad-set budget.");
      requireValid(!a.adset_schedule || Number(parent.lifetime_budget || a.lifetime_budget || 0) > 0,
        "Hourly delivery requires a lifetime budget; no automatic budget conversion.");
      const { account_id, dry_run, targeting, promoted_object, attribution_spec, adset_schedule, ...rest } = a;
      const params: Record<string, unknown> = {
        ...rest, status: "PAUSED", billing_event: "IMPRESSIONS",
        targeting: JSON.stringify(targeting), promoted_object: JSON.stringify(promoted_object),
      };
      if (attribution_spec) params.attribution_spec = JSON.stringify(attribution_spec);
      if (adset_schedule) {
        params.adset_schedule = JSON.stringify(adset_schedule);
        params.pacing_type = JSON.stringify(["day_parting"]);
      }
      const result = await client.post(`${client.accountPath(account_id)}/adsets`, payload(params, dry_run));
      return response(result.data, dry_run);
    }));
  server.tool("set_adset_hourly_schedule",
    "Set advertiser-timezone hourly delivery on an existing lifetime-budget ad set. Preserves status and budget; validate-only by default.",
    scheduleSchema.shape, guarded(async raw => {
      const a = scheduleSchema.parse(raw);
      const { data } = await client.get(`/${a.adset_id}`, { fields: "campaign_id,lifetime_budget,daily_budget,end_time" });
      const set = data as Record<string, unknown>;
      const parent = await client.get(`/${set.campaign_id}`, { fields: "lifetime_budget,daily_budget" });
      requireValid(Number(set.lifetime_budget || (parent.data as any).lifetime_budget || 0) > 0 &&
        !!set.end_time, "Hourly delivery requires lifetime budget and end_time.");
      const result = await client.post(`/${a.adset_id}`, payload({
        adset_schedule: JSON.stringify(a.adset_schedule), pacing_type: JSON.stringify(["day_parting"]),
      }, a.dry_run));
      return response(result.data, a.dry_run);
    }));
}
