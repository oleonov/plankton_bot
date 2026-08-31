export type ExchangeRejectionReason =
  | "rejection_balance_insufficient"
  | "rejection_min_size"
  | "rejection_post_only_cross"
  | "rejection_invalid_tick"
  | "rejection_trading_disabled"
  | "rejection_missing_order_id"
  | "rejection_unknown"
  | "rejection_no_payload";

export function classifyExchangeRejectionReason(payload: unknown): ExchangeRejectionReason {
  if (isExactTradingDisabledRejection(payload)) return "rejection_trading_disabled";
  const text = getExchangeRejectionPayloadText(payload);
  if (text == null) return "rejection_no_payload";

  const lower = text.toLowerCase();
  if (
    lower.includes("missing-order-id") ||
    lower.includes("success without order id") ||
    lower.includes("returned no order id")
  ) {
    return "rejection_missing_order_id";
  }

  // If a future payload contains multiple known strings, keep this deterministic
  // precedence: account-level rejects, then size rejects, then maker-only rejects.
  if (lower.includes("not enough balance") || lower.includes("not enough allowance")) {
    return "rejection_balance_insufficient";
  }
  if (lower.includes("size") && lower.includes("lower than the minimum")) {
    return "rejection_min_size";
  }
  if (lower.includes("below minimum") || lower.includes("min order size")) {
    return "rejection_min_size";
  }
  if (lower.includes("invalid post-only") || lower.includes("order crosses book")) {
    return "rejection_post_only_cross";
  }
  if (lower.includes("invalid tick size") || lower.includes("minimum for the market is")) {
    return "rejection_invalid_tick";
  }

  return "rejection_unknown";
}

export function getExchangeRejectionPayloadText(payload: unknown): string | null {
  if (payload == null) return null;
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof payload === "number" || typeof payload === "boolean" || typeof payload === "bigint") {
    return String(payload);
  }
  if (typeof payload !== "object") return null;

  const parts: string[] = [];
  collectPayloadStrings(payload, parts);
  const text = parts.join(" ").trim();
  return text.length > 0 ? text : null;
}

function isExactTradingDisabledRejection(payload: unknown): boolean {
  if (payload instanceof Error) return false;
  const root = asRecord(payload);
  if (root == null) return false;
  const details = asRecord(root["errorDetails"]);
  const candidates = [root, asRecord(root["responseBody"]), asRecord(details?.["responseBody"])];
  return candidates.some((candidate) => {
    if (candidate?.["status"] !== 503) return false;
    return [candidate["error"], candidate["message"]].some(
      (value) => typeof value === "string" && value.trim().toLowerCase() === "trading is disabled",
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function collectPayloadStrings(value: unknown, parts: string[], depth = 0): void {
  // Cap recursion at a depth deeper than observed CLOB error envelopes, so an
  // unexpected cyclic-looking object shape cannot make logging expensive.
  if (value == null || depth > 6) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) parts.push(trimmed);
    return;
  }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectPayloadStrings(item, parts, depth + 1);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectPayloadStrings(item, parts, depth + 1);
  }
}
