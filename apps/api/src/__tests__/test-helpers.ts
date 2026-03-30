import { LedgerPool } from "../ledger-pool.js";

/** Creates a LedgerPool that returns null for all profiles (no ledger files on disk). */
export function stubLedgerPool(): LedgerPool {
  return new LedgerPool("/nonexistent/control.db");
}
