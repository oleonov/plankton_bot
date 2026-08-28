import {
  PER_TOKEN_BUY_LIMIT_REASON,
  PER_TOKEN_SELL_LIMIT_REASON,
  TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON,
  WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
  WALLET_SELL_CAPACITY_EXHAUSTED_REASON,
} from "./wallet-buy-budget.js";

export const SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON = "sell-residual-below-min-order-size";
export const SELL_RESIDUAL_UNKNOWN_MIN_ORDER_SIZE_REASON = "sell-residual-unknown-min";
export const RESERVED_TOKEN_LIMIT_REASON = "reserved-token-limit";
export const PENDING_WALLET_SYNC_REASON = "pending-wallet-sync";
export const SELL_REPLACE_PENDING_REASON = "sell-replace-pending";
export const SELL_REPLACE_LOCK_ACTIVE_REASON = "sell-replace-lock-active";
export const LIVE_LITE_ACTIVE_MARKETS_CAP_EXCEEDED_REASON = "live-lite-active-markets-cap-exceeded";
export const ENTRY_NOT_SELLABLE_REASON = "entry_not_sellable";
export const OPEN_POSITION_EXISTS_REASON = "open_position_exists";
export const MAKER_CAPTURE_NO_VALID_BID_PLUS_ONE_REASON = "maker-capture-no-valid-bid-plus-one";
export const MAKER_CAPTURE_OPEN_CAP_SATURATED_REASON = "maker-capture-open-cap-saturated";
export const PERMANENT_R23_LINEAGE_ACTIVE_REASON = "permanent-r23-lineage-active";
export const MAKER_MICRO_ORDER_CAP_EXCEEDED_REASON = "maker-micro-order-cap-exceeded";
export const MAKER_MICRO_OPEN_CAP_EXCEEDED_REASON = "maker-micro-open-cap-exceeded";
export const MAKER_MICRO_CUMULATIVE_CAP_UNAVAILABLE_REASON =
  "maker-micro-cumulative-cap-unavailable";
export const MAKER_MICRO_CUMULATIVE_CAP_EXCEEDED_REASON = "maker-micro-cumulative-cap-exceeded";
export const MAKER_MICRO_CONDITION_CAP_EXCEEDED_REASON = "maker-micro-condition-cap-exceeded";
export const MAKER_MICRO_DISTINCT_CONDITION_CAP_EXCEEDED_REASON =
  "maker-micro-distinct-condition-cap-exceeded";
export const MAKER_MICRO_FILLED_CAP_EXCEEDED_REASON = "maker-micro-filled-cap-exceeded";

export const MAKER_MICRO_CAP_REJECTION_REASONS: ReadonlySet<string> = new Set([
  MAKER_MICRO_ORDER_CAP_EXCEEDED_REASON,
  MAKER_MICRO_OPEN_CAP_EXCEEDED_REASON,
  MAKER_MICRO_CUMULATIVE_CAP_UNAVAILABLE_REASON,
  MAKER_MICRO_CUMULATIVE_CAP_EXCEEDED_REASON,
  MAKER_MICRO_CONDITION_CAP_EXCEEDED_REASON,
  MAKER_MICRO_DISTINCT_CONDITION_CAP_EXCEEDED_REASON,
  MAKER_MICRO_FILLED_CAP_EXCEEDED_REASON,
]);

const MAKER_ENTRY_INPUTS_UNCHANGED_REASONS: ReadonlySet<string> = new Set([
  MAKER_CAPTURE_NO_VALID_BID_PLUS_ONE_REASON,
  MAKER_CAPTURE_OPEN_CAP_SATURATED_REASON,
  PERMANENT_R23_LINEAGE_ACTIVE_REASON,
  ...MAKER_MICRO_CAP_REJECTION_REASONS,
]);

export function isMakerEntryInputsUnchangedReason(reason: string): boolean {
  return MAKER_ENTRY_INPUTS_UNCHANGED_REASONS.has(reason);
}

export const DEDUPED_INTERNAL_ORDER_REJECTION_REASONS: ReadonlySet<string> = new Set([
  SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
  SELL_RESIDUAL_UNKNOWN_MIN_ORDER_SIZE_REASON,
  WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
  WALLET_SELL_CAPACITY_EXHAUSTED_REASON,
  TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON,
  PER_TOKEN_BUY_LIMIT_REASON,
  PER_TOKEN_SELL_LIMIT_REASON,
  // Internal-rejection reasons that dominate post-v022 order_rejected volume.
  // `reserved-token-limit` was 99% of order_rejected in the first 40min after
  // v022 ship (≈25k/h), because the SELL clamp / position-closed branches in
  // execution-module fire on every sweep tick for tokens whose reserved sell
  // capacity is exhausted or whose position is already closed. Dedup key is
  // (tokenId, side, reason, decisionRuleId, signalReason), so legitimately
  // distinct scenarios still log; only identical re-rejections within
  // `rejectCooldownMs` (15min default) are collapsed.
  RESERVED_TOKEN_LIMIT_REASON,
  PENDING_WALLET_SYNC_REASON,
  SELL_REPLACE_PENDING_REASON,
  SELL_REPLACE_LOCK_ACTIVE_REASON,
  LIVE_LITE_ACTIVE_MARKETS_CAP_EXCEEDED_REASON,
  ...MAKER_MICRO_CAP_REJECTION_REASONS,
]);
