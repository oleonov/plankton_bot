/**
 * Maps raw risk-gate rejection strings to canonical reason codes.
 * Used for deduplication and DB persistence of risk events.
 *
 * Static reasons are matched exactly. Dynamic reasons (containing numbers,
 * family IDs) are matched by prefix.
 */

const STATIC_CODES: Record<string, string> = {
  "live-lite-open-value-cap-exceeded": "live_lite_open_value_cap",
  "live-lite-active-markets-cap-exceeded": "live_lite_active_markets_cap",
  "live-lite-allowlist-rejected": "live_lite_allowlist",
  "live-post-only-required": "live_post_only_required",
  "live-min-order-usdc-rejected": "live_min_order_usdc",
  "live-eoa-fee-enabled-family-rejected": "live_eoa_fee_enabled_family",
  "live-relayer-required-family-rejected": "live_relayer_required_family",
  "reserved-usdc-limit": "reserved_usdc_limit",
  "reserved-token-limit": "reserved_token_limit",
  "pending-reservation-limit": "pending_reservation_limit",
  "exchange-insufficient-balance-or-allowance": "exchange_insufficient_balance_or_allowance",
  "sell-order-already-open": "sell_order_already_open",
  "sell-replace-lock-active": "sell_replace_lock_active",
  "sell-replace-lock-retry": "sell_replace_lock_retry",
  "sell-replace-pending": "sell_replace_pending",
  // BUY-side admission guard codes. Reason strings already arrive in canonical
  // snake_case form (see packages/domain/src/market-selection.ts +
  // signal-to-order.ts:evaluateBuyAdmission), so the mapping is identity —
  // listed here so they don't fall through to `unknown_rejection` and break
  // /status counters, SQL audits, and per-code cooldowns.
  resolution_tracker_unavailable: "resolution_tracker_unavailable",
  market_resolved: "market_resolved",
  market_ended: "market_ended",
  market_inactive: "market_inactive",
  market_not_tradable: "market_not_tradable",
  market_not_alive: "market_not_alive",
};

const PREFIX_CODES: [string, string][] = [
  ["open value would be", "max_open_value"],
  ["active markets", "max_active_markets"],
  ["dust positions", "max_dust_positions"],
  ["probe token already has open buy order", "probe_token_open_buy_order"],
  ["not found in rules", "family_not_found"],
  ["is disabled", "deployment_disabled"],
];

export function normalizeReasonCode(rawReason: string): string {
  const reasons = rawReason
    .split(";")
    .map((reason) => reason.trim())
    .filter((reason) => reason.length > 0);

  for (const reason of reasons.length > 0 ? reasons : [rawReason]) {
    const staticMatch = STATIC_CODES[reason];
    if (staticMatch) return staticMatch;

    for (const [prefix, code] of PREFIX_CODES) {
      if (reason.includes(prefix)) return code;
    }
  }

  return "unknown_rejection";
}
