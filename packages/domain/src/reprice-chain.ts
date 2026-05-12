import type { LegState, RepriceChainPolicyConfig } from "./types.js";

// CHANGE C — per-token rolling 24h reprice chain cap per R65 p90 = 13.
// True sliding window: we persist a JSON array of ISO timestamps (one per
// reprice event) and on every check filter out entries older than
// policy.windowMs. This gives an exact 24h rolling cap rather than a
// fixed-window approximation that resets at the 24h boundary.

export const DEFAULT_REPRICE_CHAIN_POLICY: RepriceChainPolicyConfig = {
  enabled: true,
  windowMs: 24 * 60 * 60 * 1000,
  maxChainCount: 13,
};

/**
 * Parse the JSON-serialized timestamp array from leg_state. Tolerates null,
 * malformed JSON, and unexpected shapes by returning an empty list — corrupted
 * persistence must never block a reprice.
 */
function parseEvents(legState: LegState | null | undefined): number[] {
  const raw = legState?.repriceChainEvents24hJson;
  if (raw == null || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const result: number[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "string") continue;
      const ms = Date.parse(entry);
      if (Number.isFinite(ms)) result.push(ms);
    }
    return result;
  } catch {
    return [];
  }
}

function freshEvents(
  legState: LegState | null | undefined,
  nowMs: number,
  policy: RepriceChainPolicyConfig,
): number[] {
  const cutoff = nowMs - policy.windowMs;
  return parseEvents(legState).filter((ms) => ms > cutoff);
}

/**
 * True if maxChainCount events have happened inside the last policy.windowMs.
 * False when (a) policy disabled, (b) no leg state, or (c) the active count is
 * below the cap. Callers append the next event via nextRepriceChainState.
 */
export function shouldBlockRepriceChain(
  legState: LegState | null | undefined,
  nowMs: number,
  policy: RepriceChainPolicyConfig,
): boolean {
  if (!policy.enabled) return false;
  if (!legState) return false;
  return freshEvents(legState, nowMs, policy).length >= policy.maxChainCount;
}

export interface NextRepriceChainState {
  /** Number of events in the active window after appending the new one. */
  count: number;
  /** JSON-serialised array of ISO timestamps to persist. */
  eventsJson: string;
  /** ISO timestamp of the oldest event still inside the window (for telemetry). */
  windowStartIso: string;
}

/**
 * Compute the next persisted state to write after a successful reprice
 * publish: drops events older than windowMs, appends nowMs, returns the
 * JSON-encoded array plus a count for risk-event payloads.
 *
 * Internal cap guard: callers MUST gate via shouldBlockRepriceChain, but if
 * fresh count already meets maxChainCount we refuse to append so the
 * persisted count never exceeds the cap regardless of caller behaviour.
 */
export function nextRepriceChainState(
  legState: LegState | null | undefined,
  nowMs: number,
  policy: RepriceChainPolicyConfig,
): NextRepriceChainState {
  const fresh = freshEvents(legState, nowMs, policy);
  if (fresh.length >= policy.maxChainCount) {
    const isoList = fresh.map((ms) => new Date(ms).toISOString());
    return {
      count: isoList.length,
      eventsJson: JSON.stringify(isoList),
      windowStartIso: isoList[0] ?? new Date(nowMs).toISOString(),
    };
  }
  fresh.push(nowMs);
  const isoList = fresh.map((ms) => new Date(ms).toISOString());
  return {
    count: isoList.length,
    eventsJson: JSON.stringify(isoList),
    windowStartIso: isoList[0]!,
  };
}
