import type Database from "better-sqlite3";

export function resolveInitialBalanceUsdc(
  controlDb: Database.Database | undefined,
  profileId: string | null | undefined,
  fallbackInitialBalanceUsdc?: number | null,
): number | null {
  const fallback = fallbackInitialBalanceUsdc ?? null;
  if (!controlDb || !profileId) return fallback;

  try {
    const row = controlDb
      .prepare("SELECT initial_balance_usdc FROM profile_settings WHERE profile_id = ?")
      .get(profileId) as { initial_balance_usdc: number | null } | undefined;

    return row?.initial_balance_usdc ?? fallback;
  } catch {
    return fallback;
  }
}
