import type { ProfileId } from "@plankton/domain";

const BUDGET_EPSILON_USDC = 1e-9;
export const DEFAULT_WALLET_BUFFER_RATIO = 0.03;
export const DEFAULT_MIN_WALLET_BUFFER_USDC = 0.25;

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
