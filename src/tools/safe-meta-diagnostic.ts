// Only fixed labels and numeric metadata leave this function; no raw API text.
export function safeMetaDiagnostic(error: unknown) {
  const text = error instanceof Error ? error.message : "";
  const code = text.match(/(?:^| \| )code=(\d{1,9})(?= \| |$)/)?.[1];
  const subcode = text.match(/(?:^| \| )subcode=(\d{1,9})(?= \| |$)/)?.[1];
  const category = code === "190" ? "authentication" :
    code === "10" || code === "200" ? "permissions" :
    code === "17" || code === "4" || code === "613" ? "rate_limit" :
    code === "100" ? "invalid_parameter" : "unknown";
  // These are clues present in Meta's message, not inferred diagnoses.
  const patterns: Array<[string, RegExp]> = [
    ["bid_strategy", /bid[_ -]?strateg/i],
    ["bid_amount", /bid[_ -]?(?:amount|cap)|minimum bid/i],
    ["optimization_goal", /optimization[_ -]?goal|performance goal/i],
    ["campaign_objective", /campaign[_ -]?objective|objective/i],
    ["destination_type", /destination[_ -]?type|destination/i],
    ["promoted_object", /promoted[_ -]?object/i],
    ["pixel", /pixel/i],
    ["attribution_spec", /attribution/i],
    ["budget", /budget/i],
    ["schedule", /schedule|day.?part|pacing/i],
    ["targeting", /targeting|audience/i],
    ["page", /page[_ -]?id|facebook page/i],
    ["account", /ad account/i],
    ["required", /required|must (?:provide|specify)|missing/i],
    ["incompatible", /not supported|incompatible|not allowed|cannot be used/i],
    ["deprecated", /deprecated|no longer supported/i],
  ];
  const hints = patterns.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  return {
    ...(code ? { code: Number(code) } : {}),
    ...(subcode ? { subcode: Number(subcode) } : {}),
    category,
    hints,
    reason: "Hints identify fixed terms present in the API message, not a confirmed cause. Raw text is withheld.",
  };
}
