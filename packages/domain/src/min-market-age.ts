/**
 * Step 0 §P3 — Min-age gate before first BUY.
 *
 * Enforces spec §1.7 R1 (`06:423`): no first-BUY for a market younger than
 * `thresholdSeconds` (canonical default 2,504 s). The threshold is sourced
 * from `ExecutionPolicy.entryMinMarketAgeSeconds`; threshold = 0 is a full
 * bypass (including unknown / unparseable createdAt) used by the simulation
 * profile and as an emergency kill-switch.
 *
 * Pure function — no I/O, no logging. Intended call site:
 *   `apps/runtime/src/modules/algo-decision/algo-decision-module.ts`
 *   on the `legState == null` branch only. SELL / REDEEM / continuation
 *   MUST NOT be gated by this helper.
 */

export type MinMarketAgeReasonCode = "market_too_young" | "market_age_unknown";

export type MinMarketAgeResult = { ok: true } | { ok: false; reasonCode: MinMarketAgeReasonCode };

export interface MinMarketAgeArgs {
  /** ISO-8601 timestamp from Gamma (`Market.gammaCreatedAt`). */
  readonly gammaCreatedAt: string | null;
  /** Threshold in seconds. <= 0 ⇒ full bypass. */
  readonly thresholdSeconds: number;
  /** `Date.now()` at the call site (passed in for deterministic tests). */
  readonly nowMs: number;
}

export function evaluateMinMarketAge(args: MinMarketAgeArgs): MinMarketAgeResult {
  // Bypass before any parsing — `Date.parse("")` is NaN and we must not
  // fail-closed on null when the gate is intentionally disabled.
  if (args.thresholdSeconds <= 0) return { ok: true };

  if (args.gammaCreatedAt == null) {
    return { ok: false, reasonCode: "market_age_unknown" };
  }
  const createdMs = Date.parse(args.gammaCreatedAt);
  if (!Number.isFinite(createdMs)) {
    return { ok: false, reasonCode: "market_age_unknown" };
  }
  const ageSec = (args.nowMs - createdMs) / 1000;
  if (ageSec < args.thresholdSeconds) {
    return { ok: false, reasonCode: "market_too_young" };
  }
  return { ok: true };
}
