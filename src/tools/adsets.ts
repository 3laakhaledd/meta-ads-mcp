import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AdsClient } from "../services/ads-client.js";

/**
 * Fields below are passed straight through to the Meta Marketing API.
 * Kept as strings (JSON) to match the rest of this server's surface: the
 * Graph API expects JSON-encoded values for these params anyway.
 */
const DESTINATION_TYPE_DESC =
  "Where the ad sends people. Values: WEBSITE, APP, MESSENGER, INSTAGRAM_DIRECT, WHATSAPP, PHONE_CALL, ON_AD, ON_EVENT, ON_PAGE, ON_POST, ON_VIDEO, INSTAGRAM_PROFILE, FACEBOOK_PAGE, INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE, LEAD_FORM_MESSENGER. REQUIRED pairings, omitting these makes the ad set undeliverable or blocks the creative: LEAD_GENERATION / QUALITY_LEAD with an instant form -> ON_AD (without it, attaching a lead-form creative fails with error 1892040); CONVERSATIONS / MESSAGING_PURCHASE_CONVERSION / MEANINGFUL_CALL_ATTEMPT -> MESSENGER, WHATSAPP or INSTAGRAM_DIRECT; VISIT_INSTAGRAM_PROFILE -> INSTAGRAM_PROFILE; PROFILE_VISIT -> FACEBOOK_PAGE or INSTAGRAM_PROFILE; PROFILE_AND_PAGE_ENGAGEMENT -> INSTAGRAM_PROFILE, FACEBOOK_PAGE or INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE. LANDING_PAGE_VIEWS / OFFSITE_CONVERSIONS / VALUE typically pair with WEBSITE.";

const ADSET_SCHEDULE_DESC =
  "JSON array of dayparting blocks. Meta only honours this when the ad set uses a lifetime_budget, so a daily_budget ad set silently delivers around the clock. Minutes are from midnight, days are 0 (Sunday) to 6 (Saturday), and timezone_type ADVERTISER means the ad account's timezone. Example, 4 PM to midnight every day: [{\"start_minute\":960,\"end_minute\":1440,\"days\":[0,1,2,3,4,5,6],\"timezone_type\":\"ADVERTISER\"}]";

const PACING_TYPE_DESC =
  "JSON array controlling delivery pacing. Values: [\"standard\"] (default, spreads spend), [\"day_parting\"] (pair this with adset_schedule), [\"no_pacing\"].";

const ATTRIBUTION_SPEC_DESC =
  "JSON array of attribution windows for conversion tracking. Omit to keep Meta's default of 7-day click plus 1-day view. Valid event_type values: CLICK_THROUGH, VIEW_THROUGH, ENGAGED_VIDEO_VIEW. Example, 7-day click only: [{\"event_type\":\"CLICK_THROUGH\",\"window_days\":7}]";

const FREQUENCY_CONTROL_DESC =
  "JSON array of frequency caps. Example, at most 2 impressions per person per day: [{\"event\":\"IMPRESSIONS\",\"interval_days\":1,\"max_frequency\":2}]";

const TARGETING_DESC =
  "JSON string of targeting spec (age_min, age_max, genders, geo_locations, interests, etc.). Advantage+ Audience automation and other flags go inside this object too, e.g. targeting_automation: {\"advantage_audience\":1}. As of v26.0, ad sets in the Housing, Employment, or Financial Products and Services (HEC-F) special ad categories with relaxable (non-broad) targeting must explicitly set targeting.targeting_automation.advantage_audience to 1 or 0 — omitting it now returns ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG. Not required for broad/default audience setups. Also note: as of Marketing API v26.0, the Instagram Explore Feed placement was removed (explicitly specifying it in publisher_platforms/instagram_positions now returns an error) and the 'story' value in messenger_positions is silently dropped.";

const PROMOTED_OBJECT_DESC =
  "JSON string of the promoted_object spec. Required for many objectives, e.g. OUTCOME_SALES needs {\"pixel_id\":\"...\",\"custom_event_type\":\"PURCHASE\"}, OUTCOME_APP_PROMOTION needs {\"application_id\":\"...\",\"object_store_url\":\"...\"}, LEAD_GENERATION / QUALITY_LEAD and OUTCOME_ENGAGEMENT page goals need {\"page_id\":\"...\"}. Omitting it when the objective requires one causes ad set creation to fail.";

const OPTIMIZATION_GOAL_DESC =
  "Optimization goal: NONE, APP_INSTALLS, AD_RECALL_LIFT, ENGAGED_USERS, EVENT_RESPONSES, IMPRESSIONS, LEAD_GENERATION, QUALITY_LEAD, LINK_CLICKS, OFFSITE_CONVERSIONS, PAGE_LIKES, POST_ENGAGEMENT, QUALITY_CALL, REACH, LANDING_PAGE_VIEWS, VISIT_INSTAGRAM_PROFILE, ENGAGED_PAGE_VIEWS, VALUE, THRUPLAY, DERIVED_EVENTS, APP_INSTALLS_AND_OFFSITE_CONVERSIONS, CONVERSATIONS, IN_APP_VALUE, MESSAGING_PURCHASE_CONVERSION, MESSAGING_DEEP_CONVERSATION_AND_FOLLOW, SUBSCRIBERS, REMINDERS_SET, MEANINGFUL_CALL_ATTEMPT, PROFILE_VISIT, PROFILE_AND_PAGE_ENGAGEMENT, ADVERTISER_SILOED_VALUE, AUTOMATIC_OBJECTIVE, MESSAGING_APPOINTMENT_CONVERSION. Must be compatible with the parent campaign's objective, and several goals require a matching destination_type — see that field.";

const BILLING_EVENT_DESC =
  "Billing event: APP_INSTALLS, CLICKS, IMPRESSIONS, LINK_CLICKS, NONE, OFFER_CLAIMS, PAGE_LIKES, POST_ENGAGEMENT, THRUPLAY, PURCHASE, LISTING_INTERACTION";

const BID_STRATEGY_DESC =
  "Bid strategy: LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, COST_CAP, LOWEST_COST_WITH_MIN_ROAS. Do not set this on an ad set whose parent campaign carries the budget (CBO) — the campaign bid strategy governs its children and the API rejects it.";

export function registerAdsetTools(server: McpServer, client: AdsClient): void {
  // ─── list_adsets ───────────────────────────────────────────
  server.tool(
    "list_adsets",
    "List ad sets in the ad account. Optionally filter by campaign or status.",
    {
      campaign_id: z.string().optional().describe("Filter by campaign ID"),
      status: z.string().optional().describe("Filter by status: ACTIVE, PAUSED, DELETED, ARCHIVED"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
      limit: z.number().optional().default(25).describe("Number of results (default 25)"),
      after: z.string().optional().describe("Pagination cursor for next page"),
      account_id: z.string().optional().describe("Ad account ID to query (e.g. 'act_123' or '123'). Falls back to META_AD_ACCOUNT_ID env var if omitted."),
    },
    async ({ campaign_id, status, fields, limit, after, account_id }) => {
      try {
        const params: Record<string, unknown> = {};
        if (fields) params.fields = fields;
        if (limit) params.limit = limit;
        if (after) params.after = after;
        if (campaign_id) params.campaign_id = campaign_id;
        if (status) params.effective_status = `["${status}"]`;
        const { data, rateLimit } = await client.get(`${client.accountPath(account_id)}/adsets`, params);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...data as object, _rateLimit: rateLimit }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ─── get_adset ─────────────────────────────────────────────
  server.tool(
    "get_adset",
    "Get details of a specific ad set by ID.",
    {
      adset_id: z.string().describe("Ad set ID"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ adset_id, fields }) => {
      try {
        const params: Record<string, unknown> = {};
        if (fields) params.fields = fields;
        const { data, rateLimit } = await client.get(`/${adset_id}`, params);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...data as object, _rateLimit: rateLimit }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ─── create_adset ──────────────────────────────────────────
  server.tool(
    "create_adset",
    "Create a new ad set. Requires name, campaign_id, budget, optimization_goal, billing_event, and targeting. Defaults to PAUSED status. Set destination_type whenever the optimization goal implies one (instant-form lead ads need ON_AD, messaging goals need a messaging destination) — leaving it unset produces an ad set with destination UNDEFINED that later rejects the matching creative.",
    {
      name: z.string().describe("Ad set name"),
      campaign_id: z.string().describe("Parent campaign ID"),
      daily_budget: z.string().optional().describe("Daily budget in currency cents (e.g. '5000' = $50.00). Do not set if the parent campaign uses CBO. Note: dayparting via adset_schedule is ignored on daily budgets."),
      lifetime_budget: z.string().optional().describe("Lifetime budget in currency cents. Required if you want adset_schedule (dayparting) to take effect, and requires end_time."),
      optimization_goal: z.string().describe(OPTIMIZATION_GOAL_DESC),
      billing_event: z.string().describe(BILLING_EVENT_DESC),
      bid_strategy: z.string().optional().describe(BID_STRATEGY_DESC),
      bid_amount: z.string().optional().describe("Bid cap or cost target in currency cents. Required when bid_strategy is LOWEST_COST_WITH_BID_CAP or COST_CAP."),
      targeting: z.string().describe(TARGETING_DESC),
      promoted_object: z.string().optional().describe(PROMOTED_OBJECT_DESC),
      destination_type: z.string().optional().describe(DESTINATION_TYPE_DESC),
      adset_schedule: z.string().optional().describe(ADSET_SCHEDULE_DESC),
      pacing_type: z.string().optional().describe(PACING_TYPE_DESC),
      attribution_spec: z.string().optional().describe(ATTRIBUTION_SPEC_DESC),
      frequency_control_specs: z.string().optional().describe(FREQUENCY_CONTROL_DESC),
      start_time: z.string().optional().describe("Start time (ISO 8601)"),
      end_time: z.string().optional().describe("End time (ISO 8601). Required when using lifetime_budget."),
      status: z.string().optional().default("PAUSED").describe("Ad set status (default PAUSED)"),
      account_id: z.string().optional().describe("Ad account ID to create the ad set in (e.g. 'act_123' or '123'). Falls back to META_AD_ACCOUNT_ID env var if omitted."),
    },
    async ({ name, campaign_id, daily_budget, lifetime_budget, optimization_goal, billing_event, bid_strategy, bid_amount, targeting, promoted_object, destination_type, adset_schedule, pacing_type, attribution_spec, frequency_control_specs, start_time, end_time, status, account_id }) => {
      try {
        const params: Record<string, unknown> = {
          name,
          campaign_id,
          optimization_goal,
          billing_event,
          targeting,
          status,
        };
        if (daily_budget) params.daily_budget = daily_budget;
        if (lifetime_budget) params.lifetime_budget = lifetime_budget;
        if (bid_strategy) params.bid_strategy = bid_strategy;
        if (bid_amount) params.bid_amount = bid_amount;
        if (promoted_object) params.promoted_object = promoted_object;
        if (destination_type) params.destination_type = destination_type;
        if (adset_schedule) params.adset_schedule = adset_schedule;
        if (pacing_type) params.pacing_type = pacing_type;
        if (attribution_spec) params.attribution_spec = attribution_spec;
        if (frequency_control_specs) params.frequency_control_specs = frequency_control_specs;
        if (start_time) params.start_time = start_time;
        if (end_time) params.end_time = end_time;

        // Dayparting is accepted by the API on daily-budget ad sets but never
        // applied. Surface that instead of letting it fail silently.
        const warnings: string[] = [];
        if (adset_schedule && daily_budget && !lifetime_budget) {
          warnings.push("adset_schedule was sent but this ad set uses a daily_budget; Meta only applies dayparting to lifetime_budget ad sets, so delivery will run all day. Switch to lifetime_budget (with end_time) to enforce the schedule.");
        }
        if (adset_schedule && !pacing_type) {
          warnings.push("adset_schedule was sent without pacing_type; pass pacing_type [\"day_parting\"] so Meta paces spend against the schedule.");
        }

        const { data, rateLimit } = await client.post(`${client.accountPath(account_id)}/adsets`, params);
        const payload = { ...data as object, _rateLimit: rateLimit, ...(warnings.length ? { _warnings: warnings } : {}) };
        return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ─── update_adset ──────────────────────────────────────────
  server.tool(
    "update_adset",
    "Update an existing ad set. Only provided fields will be modified. Use destination_type here to repair an ad set created with destination UNDEFINED, e.g. switching a lead-gen ad set to ON_AD so instant-form creatives can be attached.",
    {
      adset_id: z.string().describe("Ad set ID to update"),
      name: z.string().optional().describe("New ad set name"),
      status: z.string().optional().describe("New status: ACTIVE, PAUSED, DELETED, ARCHIVED"),
      daily_budget: z.string().optional().describe("New daily budget in currency cents"),
      lifetime_budget: z.string().optional().describe("New lifetime budget in currency cents. Required for adset_schedule to take effect, and requires end_time."),
      optimization_goal: z.string().optional().describe(OPTIMIZATION_GOAL_DESC),
      billing_event: z.string().optional().describe(BILLING_EVENT_DESC),
      bid_strategy: z.string().optional().describe(BID_STRATEGY_DESC),
      bid_amount: z.string().optional().describe("New bid amount in currency cents"),
      targeting: z.string().optional().describe(TARGETING_DESC),
      promoted_object: z.string().optional().describe(PROMOTED_OBJECT_DESC),
      destination_type: z.string().optional().describe(DESTINATION_TYPE_DESC),
      adset_schedule: z.string().optional().describe(ADSET_SCHEDULE_DESC),
      pacing_type: z.string().optional().describe(PACING_TYPE_DESC),
      attribution_spec: z.string().optional().describe(ATTRIBUTION_SPEC_DESC + " Note: Meta does not allow changing the attribution window on an ad set that has already delivered."),
      frequency_control_specs: z.string().optional().describe(FREQUENCY_CONTROL_DESC),
      start_time: z.string().optional().describe("New start time (ISO 8601)"),
      end_time: z.string().optional().describe("New end time (ISO 8601)"),
    },
    async ({ adset_id, name, status, daily_budget, lifetime_budget, optimization_goal, billing_event, bid_strategy, bid_amount, targeting, promoted_object, destination_type, adset_schedule, pacing_type, attribution_spec, frequency_control_specs, start_time, end_time }) => {
      try {
        const params: Record<string, unknown> = {};
        if (name) params.name = name;
        if (status) params.status = status;
        if (daily_budget) params.daily_budget = daily_budget;
        if (lifetime_budget) params.lifetime_budget = lifetime_budget;
        if (optimization_goal) params.optimization_goal = optimization_goal;
        if (billing_event) params.billing_event = billing_event;
        if (bid_strategy) params.bid_strategy = bid_strategy;
        if (bid_amount) params.bid_amount = bid_amount;
        if (targeting) params.targeting = targeting;
        if (promoted_object) params.promoted_object = promoted_object;
        if (destination_type) params.destination_type = destination_type;
        if (adset_schedule) params.adset_schedule = adset_schedule;
        if (pacing_type) params.pacing_type = pacing_type;
        if (attribution_spec) params.attribution_spec = attribution_spec;
        if (frequency_control_specs) params.frequency_control_specs = frequency_control_specs;
        if (start_time) params.start_time = start_time;
        if (end_time) params.end_time = end_time;

        if (Object.keys(params).length === 0) {
          return { content: [{ type: "text" as const, text: "Failed: no fields to update were provided." }], isError: true };
        }

        const warnings: string[] = [];
        if (adset_schedule && daily_budget && !lifetime_budget) {
          warnings.push("adset_schedule was sent alongside a daily_budget; Meta only applies dayparting to lifetime_budget ad sets. Switch to lifetime_budget (with end_time) to enforce the schedule.");
        }
        if (adset_schedule && !pacing_type) {
          warnings.push("adset_schedule was sent without pacing_type; pass pacing_type [\"day_parting\"] so Meta paces spend against the schedule.");
        }

        const { data, rateLimit } = await client.post(`/${adset_id}`, params);
        const payload = { ...data as object, _rateLimit: rateLimit, ...(warnings.length ? { _warnings: warnings } : {}) };
        return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ─── delete_adset ──────────────────────────────────────────
  server.tool(
    "delete_adset",
    "Delete an ad set. This action is irreversible.",
    {
      adset_id: z.string().describe("Ad set ID to delete"),
    },
    async ({ adset_id }) => {
      try {
        const { data, rateLimit } = await client.delete(`/${adset_id}`);
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, ...data as object, _rateLimit: rateLimit }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ─── copy_adset ─────────────────────────────────────────────
  server.tool(
    "copy_adset",
    "Copy an existing ad set. Creates a duplicate within the same or different campaign.",
    {
      adset_id: z.string().describe("Source ad set ID to copy"),
      campaign_id: z.string().optional().describe("Target campaign ID. If omitted, copies to same campaign"),
      name: z.string().optional().describe("Name for the copied ad set"),
      status: z.string().optional().default("PAUSED").describe("Status for copied ad set (default PAUSED)"),
      deep_copy: z.boolean().optional().default(true).describe("Copy ads within the ad set (default true)"),
    },
    async ({ adset_id, campaign_id, name, status, deep_copy }) => {
      try {
        const params: Record<string, unknown> = {};
        if (campaign_id) params.campaign_id = campaign_id;
        if (name) params.rename_options = JSON.stringify({ rename_suffix: "", rename_prefix: "", new_name_prefix: name });
        if (status) params.status_option = status;
        if (deep_copy !== undefined) params.deep_copy = deep_copy;
        const { data, rateLimit } = await client.post(`/${adset_id}/copies`, params);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...data as object, _rateLimit: rateLimit }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ─── get_adset_targeting_sentence ──────────────────────────
  server.tool(
    "get_adset_targeting_sentence",
    "Get human-readable targeting description for an ad set. Converts targeting spec into readable sentences.",
    {
      adset_id: z.string().describe("Ad set ID"),
    },
    async ({ adset_id }) => {
      try {
        const { data, rateLimit } = await client.get(`/${adset_id}/targetingsentencelines`);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...data as object, _rateLimit: rateLimit }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ─── get_adset_ads ─────────────────────────────────────────
  server.tool(
    "get_adset_ads",
    "Get all ads belonging to a specific ad set.",
    {
      adset_id: z.string().describe("Ad set ID"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
      limit: z.number().optional().default(25).describe("Number of results (default 25)"),
      after: z.string().optional().describe("Pagination cursor for next page"),
    },
    async ({ adset_id, fields, limit, after }) => {
      try {
        const params: Record<string, unknown> = {};
        if (fields) params.fields = fields;
        if (limit) params.limit = limit;
        if (after) params.after = after;
        const { data, rateLimit } = await client.get(`/${adset_id}/ads`, params);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...data as object, _rateLimit: rateLimit }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ─── get_adset_leads ───────────────────────────────────────
  server.tool(
    "get_adset_leads",
    "Get leads generated by a specific ad set. Requires leads_retrieval permission.",
    {
      adset_id: z.string().describe("Ad set ID"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
      limit: z.number().optional().default(25).describe("Number of results (default 25)"),
      after: z.string().optional().describe("Pagination cursor for next page"),
    },
    async ({ adset_id, fields, limit, after }) => {
      try {
        const params: Record<string, unknown> = {};
        if (fields) params.fields = fields;
        if (limit) params.limit = limit;
        if (after) params.after = after;
        const { data, rateLimit } = await client.get(`/${adset_id}/leads`, params);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...data as object, _rateLimit: rateLimit }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );
}
