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
  wallet_buy_capacity_exhausted: "wallet_buy_capacity_exhausted",
  wallet_sell_capacity_exhausted: "wallet_sell_capacity_exhausted",
  total_orders_capacity_exhausted: "total_orders_capacity_exhausted",
  per_token_buy_limit: "per_token_buy_limit",
  per_token_sell_limit: "per_token_sell_limit",
  "reserved-token-limit": "reserved_token_limit",
  "pending-reservation-limit": "pending_reservation_limit",
  "exchange-insufficient-balance-or-allowance": "exchange_insufficient_balance_or_allowance",
  "sell-order-already-open": "sell_order_already_open",
  "sell-replace-lock-active": "sell_replace_lock_active",
  "sell-replace-lock-retry": "sell_replace_lock_retry",
  "sell-replace-pending": "sell_replace_pending",
  "sell-residual-below-min-order-size": "sell_residual_below_min_order_size",
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
  // R66 D8 profit-ratio SELL telemetry (signal_emitted side — kept identity).
  d8_profit_ratio_fired: "d8_profit_ratio_fired",
  // R67 dust abandonment lifecycle codes (suppression / recovery / manual reset).
  "dust-abandoned": "dust_abandoned",
  "dust-recovered": "dust_recovered",
  "dust-recovered:manual": "dust_recovered_manual",
  // R65 reprice-chain cap codes (per-token 24h sliding window).
  "reprice-chain-cap": "reprice_chain_cap",
  "sell-replace-chain-cap": "sell_replace_chain_cap",
  // Track Q loop guard codes (token-level SELL circuit breaker on no-op outcomes).
  // Distinct from R65 reprice-chain cap — these count NO-order outcomes, not
  // open-order reprice chains.
  sell_loop_guard: "sell_loop_guard",
  "sell-loop-guard": "sell_loop_guard",
  "post-only-cross-pre-submit": "post_only_cross_pre_submit",
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
