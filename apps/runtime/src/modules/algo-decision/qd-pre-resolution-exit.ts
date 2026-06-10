import {
  deriveState,
  evaluateD8ProfitRatio,
  evaluateD9LossExit,
  type ExecutionPolicy,
  type LegState,
  type NormalizedMarket,
  type Position,
  type QdPreResolutionExitPolicy,
} from "@krabs/domain";
import {
  floorToTick,
  planktonAlignedMarkupCap,
  resolveBidAnchoredSellPrice,
  SELL_PRICE_CEILING,
} from "../../executable-price.js";

/**
 * Sub-Track Q.D — pre-resolution forced exit on cheap longshots (observe-only).
 *
 * Pure projection of what Q.D WOULD do near resolution, mirroring the shape of
 * `packages/domain/src/d9-loss-exit.ts`. The planner wires inputs and records a
 * `track_q_d` side effect; it never places, suppresses, or reprices an order
 * from this result — the shadow is observe-only by construction (spec §7,
 * research_plankton/track_q_d_spec_2026-06-12.md).
 *
 * Both Mode A applicability (`bestBid ≥ avg_entry`, Plankton-strict) and Mode B
 * applicability (imminent-TTC salvage at `bestBid ≥ salvageFloorRatio × avg_entry`)
 * are recorded even while `salvageEnabled` is OFF, so the synthesis can size both
 * modes before either is ever enforced.
 */
export type QdShadowReason =
  | "disabled"
  | "no_position"
  | "wrong_tier"
  | "ttc_unavailable"
  | "ttc_too_far"
  | "d8_or_d9_fired"
  | "has_active_sell"
  | "no_qualifying_bid"
  | "below_entry_hold"
  | "would_fire";

export type QdActivationMode = "mode_a" | "mode_b_salvage" | "not_activated";

export type QdShadowProjection = {
  qdWouldActivate: boolean;
  reason: QdShadowReason;
  activationMode: QdActivationMode;
  avgEntry: number | null;
  ttcMs: number | null;
  shortMarket: boolean;
  withinTtc: boolean;
  imminentTtc: boolean;
  qualifyingBid: boolean;
  bidVsAvgEntry: number | null;
  modeAApplies: boolean;
  modeBApplies: boolean;
  d8Fired: boolean;
  d9Fired: boolean;
  bestBid: number;
  anchorTicks: number;
  bidAnchoredPrice: number;
  f2Cap: number;
  candidatePrice: number;
};

export type QdEvaluationInput = {
  market: NormalizedMarket;
  legState: LegState;
  position: Position | null;
  executionPolicy: ExecutionPolicy | null;
  now: number;
  /** Decoupled D8 trigger price (midPrice in production, per Sub-Track Q.A). */
  d8EvalPrice: number;
  /** Executable D9 trigger price (best bid in production). */
  d9EvalPrice: number;
  hasActiveSell: boolean;
};

const DEFAULT_QD_MODERATE_ANCHOR_TICKS = 4;

function finitePositiveOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function parseEpochMs(value: string | null | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Re-evaluate D8/D9 at the same prices the live planner uses, so the shadow can
 * report the D8/D9 → Q.D precedence (T4) without depending on the planner's
 * control flow. Mirrors `decision-planner.ts` D8 block (decoupled `d8EvalPrice`)
 * and D9 block.
 */
function projectUpstreamFire(input: QdEvaluationInput): { d8Fired: boolean; d9Fired: boolean } {
  const { legState, executionPolicy, now } = input;
  const state = deriveState(legState);
  const base = {
    state,
    cumulativeBuySize: legState.cumulativeBuySize ?? 0,
    cumulativeBuyNotional: legState.cumulativeBuyNotional ?? 0,
  };
  const profitTarget = executionPolicy?.profitTarget;
  const d8Fired = profitTarget
    ? evaluateD8ProfitRatio(
        {
          ...base,
          sellCount: legState.sellCount ?? 0,
          currentPrice: input.d8EvalPrice,
          holdDurationSeconds: (now - new Date(legState.firstTradeAt).getTime()) / 1000,
        },
        profitTarget,
      ).fire
    : false;

  const lossExit = executionPolicy?.lossExit;
  const d9Fired =
    lossExit?.enabled === true
      ? evaluateD9LossExit(
          {
            ...base,
            currentPrice: input.d9EvalPrice,
            publicTradeCount24h: input.market.publicTradeCount24h ?? null,
            daysToResolve:
              parseEpochMs(input.market.endDate) !== null
                ? (parseEpochMs(input.market.endDate)! - now) / 86_400_000
                : null,
          },
          lossExit,
        ).fire
      : false;

  return { d8Fired, d9Fired };
}

function resolveActivation(
  enabled: boolean,
  salvageEnabled: boolean,
  gate: {
    avgEntry: number | null;
    tierCeiling: number;
    ttcMs: number | null;
    withinTtc: boolean;
    d8Fired: boolean;
    d9Fired: boolean;
    hasActiveSell: boolean;
    qualifyingBid: boolean;
    modeAApplies: boolean;
    modeBApplies: boolean;
  },
): { reason: QdShadowReason; qdWouldActivate: boolean; activationMode: QdActivationMode } {
  if (!enabled)
    return { reason: "disabled", qdWouldActivate: false, activationMode: "not_activated" };
  if (gate.avgEntry === null)
    return { reason: "no_position", qdWouldActivate: false, activationMode: "not_activated" };
  if (gate.avgEntry >= gate.tierCeiling)
    return { reason: "wrong_tier", qdWouldActivate: false, activationMode: "not_activated" };
  if (gate.ttcMs === null)
    return { reason: "ttc_unavailable", qdWouldActivate: false, activationMode: "not_activated" };
  if (!gate.withinTtc)
    return { reason: "ttc_too_far", qdWouldActivate: false, activationMode: "not_activated" };
  if (gate.d8Fired || gate.d9Fired)
    return { reason: "d8_or_d9_fired", qdWouldActivate: false, activationMode: "not_activated" };
  if (gate.hasActiveSell)
    return { reason: "has_active_sell", qdWouldActivate: false, activationMode: "not_activated" };
  if (!gate.qualifyingBid)
    return { reason: "no_qualifying_bid", qdWouldActivate: false, activationMode: "not_activated" };
  if (gate.modeAApplies)
    return { reason: "would_fire", qdWouldActivate: true, activationMode: "mode_a" };
  if (salvageEnabled && gate.modeBApplies)
    return { reason: "would_fire", qdWouldActivate: true, activationMode: "mode_b_salvage" };
  return { reason: "below_entry_hold", qdWouldActivate: false, activationMode: "not_activated" };
}

export function evaluateQdPreResolutionExit(input: QdEvaluationInput): QdShadowProjection | null {
  try {
    const { market, position } = input;
    const bestBid = finitePositiveOrNull(market.bestBid);
    const tickSize = finitePositiveOrNull(market.tickSize);
    if (bestBid === null || tickSize === null) return null;

    const qd: QdPreResolutionExitPolicy | undefined = input.executionPolicy?.preResolutionExit;
    const enabled = qd?.enabled === true;
    const ttcThresholdMs = qd?.ttcThresholdMs ?? 2 * 60 * 60_000;
    const tierCeiling = qd?.tierCeiling ?? 0.05;
    const bidFloorAbs = qd?.bidFloorAbs ?? 0.01;
    const salvageEnabled = qd?.salvageEnabled === true;
    const salvageTtcMs = qd?.salvageTtcMs ?? 30 * 60_000;
    const salvageFloorRatio = qd?.salvageFloorRatio ?? 0.5;

    const avgEntry = finitePositiveOrNull(position?.avgEntryPrice);
    const bestAsk =
      typeof market.bestAsk === "number" && Number.isFinite(market.bestAsk) && market.bestAsk > 0
        ? market.bestAsk
        : null;

    const endMs = parseEpochMs(market.endDate);
    const ttcMs = endMs === null ? null : endMs - input.now;
    const createdMs = parseEpochMs(market.gammaCreatedAt);
    const marketLifetime = endMs !== null && createdMs !== null ? endMs - createdMs : null;
    // Short-market fallback (§1.1): on markets whose whole lifetime is shorter
    // than 2× the TTC window, use a 0.25× lifetime fraction so Q.D never fires
    // immediately after entry on intraday markets.
    const shortMarket = marketLifetime !== null && marketLifetime < ttcThresholdMs * 2;
    const effectiveThresholdMs = shortMarket ? 0.25 * marketLifetime : ttcThresholdMs;
    const withinTtc = ttcMs !== null && ttcMs <= effectiveThresholdMs;
    const imminentTtc = ttcMs !== null && ttcMs < salvageTtcMs;

    // Pricing (§1.3): F1 bid-anchored at 4 ticks while there is time, degrading
    // to taker-at-bestBid (0 ticks) at imminent TTC; F2 tier cap always applied.
    const anchorTicks = imminentTtc
      ? 0
      : (input.executionPolicy?.exitBidAnchorTicks ?? DEFAULT_QD_MODERATE_ANCHOR_TICKS);
    const bidAnchoredPrice = resolveBidAnchoredSellPrice(bestBid, bestAsk, tickSize, anchorTicks);
    const f2Cap =
      avgEntry !== null
        ? Math.min(SELL_PRICE_CEILING, avgEntry * planktonAlignedMarkupCap(avgEntry))
        : SELL_PRICE_CEILING;
    const candidatePrice =
      avgEntry !== null && bidAnchoredPrice > f2Cap
        ? floorToTick(f2Cap, tickSize)
        : bidAnchoredPrice;

    const qualifyingBid = bestBid >= bidFloorAbs;
    const bidVsAvgEntry = avgEntry !== null ? bestBid / avgEntry : null;
    const modeAApplies = avgEntry !== null && bestBid >= avgEntry;
    const modeBApplies =
      avgEntry !== null && imminentTtc && bestBid >= salvageFloorRatio * avgEntry;

    const { d8Fired, d9Fired } = projectUpstreamFire(input);

    const activation = resolveActivation(enabled, salvageEnabled, {
      avgEntry,
      tierCeiling,
      ttcMs,
      withinTtc,
      d8Fired,
      d9Fired,
      hasActiveSell: input.hasActiveSell,
      qualifyingBid,
      modeAApplies,
      modeBApplies,
    });

    return {
      qdWouldActivate: activation.qdWouldActivate,
      reason: activation.reason,
      activationMode: activation.activationMode,
      avgEntry,
      ttcMs,
      shortMarket,
      withinTtc,
      imminentTtc,
      qualifyingBid,
      bidVsAvgEntry,
      modeAApplies,
      modeBApplies,
      d8Fired,
      d9Fired,
      bestBid,
      anchorTicks,
      bidAnchoredPrice,
      f2Cap,
      candidatePrice,
    };
  } catch {
    return null;
  }
}
