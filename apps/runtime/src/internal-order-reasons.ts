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
]);
