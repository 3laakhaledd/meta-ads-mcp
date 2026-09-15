import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

export function sanitize(value, secrets = []) {
  if (Array.isArray(value)) return value.map(v => sanitize(v, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([k]) => !/token|secret|authorization|paging/i.test(k))
    .map(([k, v]) => [k, sanitize(v, secrets)]));
  if (typeof value !== "string") return value;
  let text = value;
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[REDACTED]");
  return text.replace(/https?:\/\/[^\s"'<>]+/g, "[URL REDACTED]")
    .replace(/\bEAA[A-Za-z0-9_-]{12,}\b/g, "[TOKEN REDACTED]");
}

export function audit(plan, snapshot) {
  const gaps = [];
  const add = (scope, issue) => gaps.push({ scope, issue });
  let total = 0;
  for (const expected of plan.campaigns) {
    total += expected.budget;
    const campaign = snapshot.campaigns.find(c => c.id === expected.id);
    if (!campaign) { add(expected.name, "Campaign unavailable"); continue; }
    if (campaign.status !== "PAUSED") add(expected.name, "Campaign is not paused");
    if (Number(campaign.lifetime_budget) !== expected.budget || Number(campaign.daily_budget || 0))
      add(expected.name, "Lifetime CBO budget mismatch");
    for (const wanted of expected.sets) {
      const sets = campaign.sets.filter(s => s.name === wanted.name);
      if (sets.length !== 1) { add(wanted.name, "Missing or duplicate replacement ad set"); continue; }
      const set = sets[0];
      if (set.status !== "PAUSED") add(wanted.name, "Ad set is not paused");
      if (Date.parse(set.end_time) !== Date.parse(expected.end)) add(wanted.name, "Cutoff mismatch");
      const slots = set.adset_schedule || [];
      const coverage = new Set(slots.flatMap(s =>
        s.start_minute === 960 && s.end_minute === 1440 && s.timezone_type === "ADVERTISER" ? s.days : []));
      if (coverage.size !== 7 || slots.some(s => s.start_minute !== 960 || s.end_minute !== 1440 ||
        s.timezone_type !== "ADVERTISER")) add(wanted.name, "Evening schedule not verified");
      if (wanted.messaging && !(set.attribution_spec?.length === 1 &&
        set.attribution_spec[0].event_type === "CLICK_THROUGH" &&
        set.attribution_spec[0].window_days === 1)) add(wanted.name, "One-day messaging attribution missing");
      if (wanted.warm) {
        const ids = (set.targeting?.custom_audiences || []).map(a => a.id);
        if (!ids.length || ids.includes(plan.placeholderAudience)) add(wanted.name, "Warm audience missing or still placeholder");
        add(wanted.name, "Verify audience source videos, platform coverage and delivery eligibility");
      }
      const ads = set.ads || [];
      if (ads.length !== wanted.ads.length) add(wanted.name, "Ad count differs from migration manifest");
      if (wanted.ads.length < 2) add(wanted.name, "Second approved creative still needed");
      for (const name of wanted.ads) {
        const matches = ads.filter(a => a.name === name);
        if (matches.length !== 1) { add(name, "Missing or duplicate ad"); continue; }
        const ad = matches[0];
        if (ad.status !== "PAUSED") add(name, "Ad is not paused");
        if (ad.issues_info?.length) add(name, "Meta delivery issues reported");
        const spec = ad.creative?.object_story_spec || {};
        const data = spec.video_data || spec.link_data || {};
        if (!(data.title || data.name) || !data.message || !(data.link_description || data.description))
          add(name, "Headline, primary text or description missing");
        if (!(data.video_id || data.image_hash || data.picture)) add(name, "Media missing");
        if (!spec.instagram_user_id) add(name, "Instagram identity needs preview verification");
        const cta = data.call_to_action || {};
        if (cta.type !== (wanted.messaging ? "MESSAGE_PAGE" : "SIGN_UP")) add(name, "CTA mismatch");
        if (!wanted.messaging && (cta.value?.link || data.link) !== plan.form) add(name, "Wrong registration destination");
        if (/النهاردة|بكرة|فاضل يومين/.test(data.message)) add(name, "Relative-date copy requires date-specific flight or revised approval");
      }
    }
  }
  if (total !== 700000) add("budget", "Campaign budgets do not total EGP 7000");
  if (snapshot.account?.timezone_name !== "Africa/Cairo") add("account", "Confirm advertiser timezone before scheduling");
  if (snapshot.account?.account_status !== 1) add("account", "Account not confirmed active");
  add("tracking", "A real successful form submission must be observed in Meta Test Events; never manufacture events");
  add("funding", "Verify billing eligibility separately; balance is not necessarily prepaid credit");
  return { ready: false, gaps, note: "Read-only audit. Manual evidence gates deliberately remain open." };
}

async function main() {
  const token = process.env.META_ADS_ACCESS_TOKEN;
  if (!token) throw new Error("Set META_ADS_ACCESS_TOKEN in the environment, not in files.");
  const plan = JSON.parse(await readFile(new URL("./migration-plan.json", import.meta.url), "utf8"));
  const version = process.env.META_API_VERSION || "v26.0";
  if (!/^v\d+\.\d+$/.test(version)) throw new Error("Invalid API version");
  async function get(path, fields, after) {
    const url = new URL(`https://graph.facebook.com/${version}/${path}`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(JSON.stringify(sanitize(body.error || { status: res.status }, [token])));
    return body;
  }
  async function list(path, fields) {
    const rows = []; const seen = new Set(); let after;
    do {
      const page = await get(path, fields, after); rows.push(...(page.data || []));
      after = page.paging?.next ? page.paging?.cursors?.after : undefined;
      if (page.paging?.next && !after) throw new Error("Incomplete pagination");
      if (after && seen.has(after)) throw new Error("Repeated pagination cursor");
      if (after) seen.add(after);
    } while (after);
    return rows;
  }
  const snapshot = { account: await get(plan.account, "account_status,timezone_name"), campaigns: [] };
  for (const expected of plan.campaigns) {
    const c = await get(expected.id, "id,name,status,daily_budget,lifetime_budget");
    c.sets = await list(`${c.id}/adsets`, "id,name,status,start_time,end_time,adset_schedule,attribution_spec,targeting");
    for (const s of c.sets) s.ads = await list(`${s.id}/ads`, "id,name,status,issues_info,creative{object_story_spec}");
    snapshot.campaigns.push(c);
  }
  const report = audit(plan, snapshot);
  await writeFile("preflight-report.json", JSON.stringify(sanitize(report, [token]), null, 2));
  console.log(`Read-only audit finished: ${report.gaps.length} gaps. See preflight-report.json.`);
  process.exitCode = report.ready ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(sanitize(error.message, [process.env.META_ADS_ACCESS_TOKEN])); process.exitCode = 1; });
