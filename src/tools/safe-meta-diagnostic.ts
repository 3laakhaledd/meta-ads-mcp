// Return only allowlisted metadata and fixed descriptions, never raw API text.
export function safeMetaDiagnostic(error: unknown) {
  const text = error instanceof Error ? error.message : "";
  const code = text.match(/(?:^| \| )code=(\d{1,9})(?= \| |$)/)?.[1];
  const subcode = text.match(/(?:^| \| )subcode=(\d{1,9})(?= \| |$)/)?.[1];
  const category = code === "190" ? "authentication" :
    code === "10" || code === "200" ? "permissions" :
    code === "17" || code === "4" || code === "613" ? "rate_limit" :
    code === "100" ? "invalid_parameter" : "unknown";
  return {
    ...(code ? { code: Number(code) } : {}),
    ...(subcode ? { subcode: Number(subcode) } : {}),
    category,
    reason: "Raw API message omitted to protect credentials. Use code, subcode and request stage to diagnose.",
  };
}
