import type { SellLoopGuardPolicy } from "./types.js";

// Loop guard — token-level SELL circuit breaker. Counts realized no-op SELL
// outcomes (local post-only-cross skips and exchange/gateway no-order-id
// rejections) per token in a sliding window. After `threshold` counted
// outcomes, the token is blocked for `cooldownMs` and the planner suppresses
// further SELL signal generation. This covers the gap R65 cannot: loops where
// no working order is ever created. See research_plankton/loop_guard_spec_2026-06-11.md.

export const DEFAULT_SELL_LOOP_GUARD_POLICY: SellLoopGuardPolicy = {
  enabled: true,
  windowMs: 6 * 60 * 60_000,
  threshold: 10,
  cooldownMs: 6 * 60 * 60_000,
  countPostOnlyCrossPreSubmit: true,
  countExchangeNoOrderId: true,
};

export type LoopGuardOutcomeKind = "post_only_cross_pre_submit" | "exchange_no_order_id";

const EXCHANGE_NO_ID_MESSAGES = [
  "exchange returned no order id",
  "gateway returned success without order id",
] as const;

export interface SellLoopGuardSnapshot {
  blocked: boolean;
  reasonCode: "sell_loop_guard";
  activeCount: number;
  threshold: number;
  windowMs: number;
  blockedUntilMs: number | null;
  lastOutcome: LoopGuardOutcomeKind | null;
  firstEventAtMs: number | null;
  lastEventAtMs: number | null;
}

/** Per-token in-memory rolling state owned by the guard module. */
export interface TokenLoopBucket {
  events: Array<{ timestampMs: number; outcome: LoopGuardOutcomeKind }>;
  blockedUntilMs: number | null;
}

export interface RecordOutcomeResult {
  /** True only on the event that crossed the threshold (one-time activation). */
  activated: boolean;
}

export function createSellLoopGuardBucket(): TokenLoopBucket {
  return { events: [], blockedUntilMs: null };
}

export function shouldCountSellLoopGuardOutcome(
  outcome: LoopGuardOutcomeKind,
  policy: SellLoopGuardPolicy,
): boolean {
  if (!policy.enabled) return false;
  if (outcome === "post_only_cross_pre_submit") return policy.countPostOnlyCrossPreSubmit;
  if (outcome === "exchange_no_order_id") return policy.countExchangeNoOrderId;
  return false;
}

function pruneExpired(
  events: TokenLoopBucket["events"],
  nowMs: number,
  policy: SellLoopGuardPolicy,
): TokenLoopBucket["events"] {
  const cutoff = nowMs - policy.windowMs;
  return events.filter((e) => e.timestampMs > cutoff);
}

/**
 * Append a counted no-op outcome to the token bucket. Prunes events outside the
 * window first, then records. Returns `activated: true` exactly once, on the
 * event that pushes the active count to `threshold` while not already blocked.
 */
export function recordSellLoopGuardOutcome(
  bucket: TokenLoopBucket,
  outcome: LoopGuardOutcomeKind,
  nowMs: number,
  policy: SellLoopGuardPolicy,
): RecordOutcomeResult {
  if (!shouldCountSellLoopGuardOutcome(outcome, policy)) return { activated: false };
  bucket.events = pruneExpired(bucket.events, nowMs, policy);
  bucket.events.push({ timestampMs: nowMs, outcome });
  if (bucket.events.length >= policy.threshold && bucket.blockedUntilMs == null) {
    bucket.blockedUntilMs = nowMs + policy.cooldownMs;
    return { activated: true };
  }
  return { activated: false };
}

/**
 * Read the current guard state for a token. Prunes expired events and clears an
 * expired cooldown as a side effect (the module owns the bucket). Returns null
 * when the policy is disabled — callers treat null as "not blocked".
 */
export function getSellLoopGuardSnapshot(
  bucket: TokenLoopBucket | undefined,
  nowMs: number,
  policy: SellLoopGuardPolicy,
): SellLoopGuardSnapshot | null {
  if (!policy.enabled) return null;
  if (!bucket) return null;
  bucket.events = pruneExpired(bucket.events, nowMs, policy);
  if (bucket.blockedUntilMs != null && nowMs >= bucket.blockedUntilMs) {
    bucket.blockedUntilMs = null;
  }
  const blocked = bucket.blockedUntilMs != null && nowMs < bucket.blockedUntilMs;
  return {
    blocked,
    reasonCode: "sell_loop_guard",
    activeCount: bucket.events.length,
    threshold: policy.threshold,
    windowMs: policy.windowMs,
    blockedUntilMs: bucket.blockedUntilMs,
    lastOutcome: bucket.events.at(-1)?.outcome ?? null,
    firstEventAtMs: bucket.events[0]?.timestampMs ?? null,
    lastEventAtMs: bucket.events.at(-1)?.timestampMs ?? null,
  };
}

/** Clear all counted events and any active cooldown for a token. */
export function resetSellLoopGuardBucket(bucket: TokenLoopBucket): void {
  bucket.events = [];
  bucket.blockedUntilMs = null;
}

/** Classify a local `OrderSkipped`. Only SELL post-only-cross skips count. */
export function classifySellLoopGuardSkip(args: {
  side: string;
  reasonCode: string;
}): LoopGuardOutcomeKind | null {
  if (args.side !== "sell") return null;
  if (args.reasonCode === "post-only-cross-pre-submit") return "post_only_cross_pre_submit";
  return null;
}

/** Classify an `OrderRejected`. Only SELL no-order-id outcomes count. */
export function classifySellLoopGuardReject(args: {
  side: string;
  reason?: string | null;
  exchangeErrorMessage?: string | null;
}): LoopGuardOutcomeKind | null {
  if (args.side !== "sell") return null;
  const message = [args.reason, args.exchangeErrorMessage].filter(Boolean).join(" | ");
  if (EXCHANGE_NO_ID_MESSAGES.some((m) => message.includes(m))) return "exchange_no_order_id";
  return null;
}
