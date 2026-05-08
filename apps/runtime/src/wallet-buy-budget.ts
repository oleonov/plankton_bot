import {
  DEFAULT_BUY_CAPACITY_POLICY,
  DEFAULT_ORDER_CAPACITY_POLICY,
  DEFAULT_SELL_CAPACITY_POLICY,
  SignalReason,
  type BuyCapacityPolicy,
  type OrderCapacityPolicy,
  type OrderSide,
  type ProfileId,
  type SellCapacityPolicy,
} from "@plankton/domain";

const BUDGET_EPSILON_USDC = 1e-9;
const CAPACITY_EPSILON_USDC = 1e-9;
export const DEFAULT_WALLET_BUFFER_RATIO = 0.03;
export const DEFAULT_MIN_WALLET_BUFFER_USDC = 0.25;
export const WALLET_BUY_CAPACITY_EXHAUSTED_REASON = "wallet_buy_capacity_exhausted";
export const WALLET_SELL_CAPACITY_EXHAUSTED_REASON = "wallet_sell_capacity_exhausted";
export const TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON = "total_orders_capacity_exhausted";
export const PER_TOKEN_BUY_LIMIT_REASON = "per_token_buy_limit";
export const PER_TOKEN_SELL_LIMIT_REASON = "per_token_sell_limit";
const ADD_BUY_SIGNAL_REASONS: ReadonlySet<string> = new Set([
  SignalReason.ConfirmScale,
  SignalReason.ScaleIn,
  SignalReason.HeavyScale,
]);

export interface WalletBudgetControlDb {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

export interface WalletBuyBudgetConfig {
  controlDb?: WalletBudgetControlDb | undefined;
  activeProfile?: ProfileId | undefined;
  walletBufferPct?: number | undefined;
  walletBufferMinUsdc?: number | undefined;
}

export interface WalletBuyBudgetSnapshot {
  walletBalanceUsdc: number;
  reservedBuyUsdc: number;
  walletBufferUsdc: number;
  freeUsdcForNewOrders: number;
}

export type BuyCapacityKind = "new-entry" | "add-buy";

export interface WalletBuyCapacityDecision {
  allowed: boolean;
  reason: typeof WALLET_BUY_CAPACITY_EXHAUSTED_REASON | null;
  kind: BuyCapacityKind;
  requiredHeadroomUsdc: number;
  availableAfterOrderUsdc: number | null;
  openBuyOrderCount: number;
  maxOpenBuyOrders: number;
  maxOpenBuyOrdersPerToken: number;
  capacityEnabled: boolean;
}

export interface WalletSellCapacityDecision {
  allowed: boolean;
  reason: typeof WALLET_SELL_CAPACITY_EXHAUSTED_REASON | null;
  openSellOrderCount: number;
  maxOpenSellOrders: number;
  maxOpenSellOrdersPerToken: number;
  capacityEnabled: boolean;
}

export interface TotalOrdersCapacityDecision {
  allowed: boolean;
  reason: typeof TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON | null;
  openOrdersTotal: number;
  maxOpenOrdersTotal: number;
  capacityEnabled: boolean;
}

export interface PerTokenOrderCapacityDecision {
  allowed: boolean;
  reason: typeof PER_TOKEN_BUY_LIMIT_REASON | typeof PER_TOKEN_SELL_LIMIT_REASON | null;
  side: OrderSide;
  openOrdersForToken: number;
  maxOpenOrdersPerToken: number;
  capacityEnabled: boolean;
}

export interface OrderCapacityMetricsSample {
  source: "risk_gate" | "execution";
  side: OrderSide;
  approved: boolean;
  rejectionReason: string | null;
  openBuyOrderCount: number;
  openSellOrderCount: number;
  openOrdersTotal: number;
  perTokenOpenBuyOrderCount: number;
  perTokenOpenSellOrderCount: number;
}

export function readWalletBalanceUsdc(
  controlDb: WalletBudgetControlDb | undefined,
  activeProfile: ProfileId | undefined,
): number | null {
  if (!controlDb || !activeProfile) return null;
  const walletRow = controlDb
    .prepare("SELECT wallet_balance_usdc FROM profile_summaries WHERE profile_id = ?")
    .get(activeProfile) as { wallet_balance_usdc: number | null } | undefined;
  return walletRow?.wallet_balance_usdc ?? null;
}

export function getWalletBufferUsdc(
  walletBalanceUsdc: number,
  walletBufferPct = DEFAULT_WALLET_BUFFER_RATIO,
  walletBufferMinUsdc = DEFAULT_MIN_WALLET_BUFFER_USDC,
): number {
  return Math.max(walletBufferMinUsdc, walletBalanceUsdc * walletBufferPct);
}

export function resolveWalletBuyBudget(
  config: WalletBuyBudgetConfig,
  reservedBuyUsdc: number,
): WalletBuyBudgetSnapshot | null {
  const walletBalanceUsdc = readWalletBalanceUsdc(config.controlDb, config.activeProfile);
  if (walletBalanceUsdc == null) return null;

  const walletBufferUsdc = getWalletBufferUsdc(
    walletBalanceUsdc,
    config.walletBufferPct,
    config.walletBufferMinUsdc,
  );

  return {
    walletBalanceUsdc,
    reservedBuyUsdc,
    walletBufferUsdc,
    freeUsdcForNewOrders: walletBalanceUsdc - reservedBuyUsdc - walletBufferUsdc,
  };
}

export function hasWalletBuyBudget(
  snapshot: WalletBuyBudgetSnapshot | null,
  requiredNotionalUsdc: number,
): boolean {
  if (snapshot == null) return true;
  return snapshot.freeUsdcForNewOrders + BUDGET_EPSILON_USDC >= requiredNotionalUsdc;
}

export function classifyBuyCapacityKind(signalReason: string | null | undefined): BuyCapacityKind {
  return signalReason != null && ADD_BUY_SIGNAL_REASONS.has(signalReason) ? "add-buy" : "new-entry";
}

export function evaluateWalletBuyCapacity(args: {
  policy: BuyCapacityPolicy | null | undefined;
  snapshot: WalletBuyBudgetSnapshot | null;
  requiredNotionalUsdc: number;
  signalReason: string | null | undefined;
  openBuyOrderCount: number;
}): WalletBuyCapacityDecision {
  const policy = normalizeBuyCapacityPolicy(args.policy);
  const kind = classifyBuyCapacityKind(args.signalReason);
  const requiredHeadroomUsdc =
    kind === "new-entry" ? policy.minNewEntryWalletHeadroomUsdc : policy.minAddWalletHeadroomUsdc;
  const base = {
    kind,
    requiredHeadroomUsdc,
    openBuyOrderCount: args.openBuyOrderCount,
    maxOpenBuyOrders: policy.maxOpenBuyOrders,
    maxOpenBuyOrdersPerToken: policy.maxOpenBuyOrdersPerToken,
    capacityEnabled: policy.enabled,
  };

  if (!policy.enabled) {
    return { ...base, allowed: true, reason: null, availableAfterOrderUsdc: null };
  }

  if (policy.maxOpenBuyOrders > 0 && args.openBuyOrderCount >= policy.maxOpenBuyOrders) {
    return {
      ...base,
      allowed: false,
      reason: WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
      availableAfterOrderUsdc: null,
    };
  }

  if (args.snapshot == null) {
    return { ...base, allowed: true, reason: null, availableAfterOrderUsdc: null };
  }

  const availableAfterOrderUsdc =
    args.snapshot.walletBalanceUsdc -
    args.snapshot.reservedBuyUsdc -
    args.snapshot.walletBufferUsdc -
    args.requiredNotionalUsdc;
  const allowed = availableAfterOrderUsdc > requiredHeadroomUsdc + CAPACITY_EPSILON_USDC;
  return {
    ...base,
    allowed,
    reason: allowed ? null : WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
    availableAfterOrderUsdc,
  };
}

export function normalizeBuyCapacityPolicy(
  policy: BuyCapacityPolicy | null | undefined,
): BuyCapacityPolicy {
  if (policy == null) {
    return { ...DEFAULT_BUY_CAPACITY_POLICY, enabled: false };
  }
  return {
    ...DEFAULT_BUY_CAPACITY_POLICY,
    ...policy,
  };
}

export function evaluateWalletSellCapacity(args: {
  policy: SellCapacityPolicy | null | undefined;
  openSellOrderCount: number;
}): WalletSellCapacityDecision {
  const policy = normalizeSellCapacityPolicy(args.policy);
  const base = {
    openSellOrderCount: args.openSellOrderCount,
    maxOpenSellOrders: policy.maxOpenSellOrders,
    maxOpenSellOrdersPerToken: policy.maxOpenSellOrdersPerToken,
    capacityEnabled: policy.enabled,
  };

  if (
    policy.enabled &&
    policy.maxOpenSellOrders > 0 &&
    args.openSellOrderCount >= policy.maxOpenSellOrders
  ) {
    return { ...base, allowed: false, reason: WALLET_SELL_CAPACITY_EXHAUSTED_REASON };
  }
  return { ...base, allowed: true, reason: null };
}

export function evaluateTotalOrdersCapacity(args: {
  policy: OrderCapacityPolicy | null | undefined;
  openOrdersTotal: number;
}): TotalOrdersCapacityDecision {
  const policy = normalizeOrderCapacityPolicy(args.policy);
  const base = {
    openOrdersTotal: args.openOrdersTotal,
    maxOpenOrdersTotal: policy.maxOpenOrdersTotal,
    capacityEnabled: policy.enabled,
  };

  if (
    policy.enabled &&
    policy.maxOpenOrdersTotal > 0 &&
    args.openOrdersTotal >= policy.maxOpenOrdersTotal
  ) {
    return { ...base, allowed: false, reason: TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON };
  }
  return { ...base, allowed: true, reason: null };
}

export function evaluatePerTokenOrderCapacity(args: {
  side: OrderSide;
  maxOpenOrdersPerToken: number;
  openOrdersForToken: number;
  enabled?: boolean | undefined;
}): PerTokenOrderCapacityDecision {
  const enabled = args.enabled ?? true;
  const reason = args.side === "buy" ? PER_TOKEN_BUY_LIMIT_REASON : PER_TOKEN_SELL_LIMIT_REASON;
  const base = {
    side: args.side,
    openOrdersForToken: args.openOrdersForToken,
    maxOpenOrdersPerToken: args.maxOpenOrdersPerToken,
    capacityEnabled: enabled,
  };

  if (
    enabled &&
    args.maxOpenOrdersPerToken > 0 &&
    args.openOrdersForToken >= args.maxOpenOrdersPerToken
  ) {
    return { ...base, allowed: false, reason };
  }
  return { ...base, allowed: true, reason: null };
}

export function normalizeSellCapacityPolicy(
  policy: SellCapacityPolicy | null | undefined,
): SellCapacityPolicy {
  if (policy == null) {
    return { ...DEFAULT_SELL_CAPACITY_POLICY, enabled: false };
  }
  return {
    ...DEFAULT_SELL_CAPACITY_POLICY,
    ...policy,
  };
}

export function normalizeOrderCapacityPolicy(
  policy: OrderCapacityPolicy | null | undefined,
): OrderCapacityPolicy {
  if (policy == null) {
    return { ...DEFAULT_ORDER_CAPACITY_POLICY, enabled: false };
  }
  return {
    ...DEFAULT_ORDER_CAPACITY_POLICY,
    ...policy,
  };
}
