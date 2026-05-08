import {
  DEFAULT_BUY_CAPACITY_POLICY,
  SignalReason,
  type BuyCapacityPolicy,
  type ProfileId,
} from "@plankton/domain";

const BUDGET_EPSILON_USDC = 1e-9;
const CAPACITY_EPSILON_USDC = 1e-9;
export const DEFAULT_WALLET_BUFFER_RATIO = 0.03;
export const DEFAULT_MIN_WALLET_BUFFER_USDC = 0.25;
export const WALLET_BUY_CAPACITY_EXHAUSTED_REASON = "wallet_buy_capacity_exhausted";
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
  capacityEnabled: boolean;
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
