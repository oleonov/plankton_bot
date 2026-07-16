// Two-lane entry model — observe-only shadow projection for first-entry BUY
// candidates. PURE and observational: it never blocks, resizes, reprices, or
// emits an order/signal. For every potential first-entry it recomputes the
// existing R23 dip trigger and a Plankton-derived GATE, then classifies the
// candidate across the two lanes and their union (R23_ONLY / GATE_ONLY / BOTH /
// NEITHER / UNKNOWN) so the runtime can size the research split on live flow.
// See research_plankton/two_lane_entry_shadow_spec_2026-06-30.md.
//
// Fail-quiet by design: a classification-critical input that is unavailable live
// (midPrice, lifespan, proposed notional) yields UNKNOWN rather than a guessed
// lane. `category` is unavailable live but is context-only — it is reported as a
// missing component and never forces UNKNOWN (§2 asymmetry, by design).

import {
  DEFAULT_R23_DIP_TRIGGER_POLICY,
  R23_DIP_TRIGGER_RULE_ID,
  R23_NO_HISTORY_REASON,
  evaluateR23DipTrigger,
  evaluateSize,
  matchRule,
  type AlgoDecisionRule,
  type AlgoSizeRule,
  type ExecutionPolicy,
  type GateEntryPolicy,
  type NormalizedMarket,
  type R23DipTriggerPolicy,
  type TradeDecisionAction,
} from "@krabs/domain";
import {
  classifyDeadMarketScore,
  computeDeadMarketScore,
  deriveSourceGroup,
  type DeadMarketClassification,
  type DeadMarketSourceGroup,
} from "../dead-market-shadow/dead-market-score.js";

export const GATE_RULE_VERSION = "v1_first_entry_2026-06-30";
export const LIVE_FEATURE_SET = "live_v1";

/** GATE thresholds (research clob-covered Plankton, holdout May–Jun). */
export const GATE_MAX_NOTIONAL = 13;
export const GATE_MIN_PRICE = 0.01;
export const GATE_MAX_PRICE = 0.55;
export const GATE_MIN_LIFESPAN_DAYS = 21;

export type TwoLaneClass = "R23_ONLY" | "GATE_ONLY" | "BOTH" | "NEITHER" | "UNKNOWN";

// `none` extends the dead-market source groups for the case where no live rule
// is attached (no R23 fire and no matched decision rule). Bounded label set.
export type TwoLaneSourceGroup = DeadMarketSourceGroup | "none";

export const GATE_COMPONENT_KEYS = [
  "size_le_13",
  "price_gt_0_01",
  "cheap_side_le_055",
  "lifespan_gt_21d",
  "own_token_readd",
  "category_not_blocked",
] as const;

export type GateComponentKey = (typeof GATE_COMPONENT_KEYS)[number];

/** A known component resolves to a boolean; an unavailable one to "unknown". */
export type GateComponentResult = boolean | "unknown";

export type GateComponentLabel = "pass" | "fail" | "unknown";

// Lanes worth a sampled risk event: R23_ONLY is the already-instrumented
// baseline and UNKNOWN carries no lane signal, so both are metrics-only.
export const TWO_LANE_SAMPLED_CLASSES: ReadonlySet<TwoLaneClass> = new Set<TwoLaneClass>([
  "GATE_ONLY",
  "BOTH",
  "NEITHER",
]);

export interface TwoLaneEntryShadowInput {
  market: NormalizedMarket;
  r23MaxMidpoint: number | null;
  executionPolicy: ExecutionPolicy | null;
  buySizeRules: readonly AlgoSizeRule[];
  decisionRules: readonly AlgoDecisionRule[];
  /**
   * Optional override for the GATE lane's price/lifespan thresholds (live
   * experiment, docs/plans/2026-07-15-gate-bounce-live-experiment.md). When
   * omitted, the shadow falls back to the fixed GATE_MIN_PRICE/GATE_MAX_PRICE/
   * GATE_MIN_LIFESPAN_DAYS research constants — byte-for-byte unchanged.
   * GATE_MAX_NOTIONAL has no policy equivalent and is never overridden.
   */
  gateEntryPolicy?: GateEntryPolicy | null;
}

export interface TwoLaneEntryShadowProjection {
  title: string;
  price: number | null;
  proposedNotional: number | null;
  lifespanDays: number | null;
  category: null;
  tags: readonly string[];
  sourceGroup: TwoLaneSourceGroup;
  r23Match: boolean;
  gateMatch: boolean;
  laneClass: TwoLaneClass;
  gateComponents: Record<GateComponentKey, GateComponentResult>;
  missingComponents: GateComponentKey[];
  r23Ratio: number | null;
  r23MaxMidpoint: number | null;
  r23NoHistory: boolean;
  deadScore: number;
  deadClassification: DeadMarketClassification;
  scoreVersion: string;
  featureSet: string;
}

type Component = { value: boolean; known: boolean };

const present = (value: boolean): Component => ({ value, known: true });
const unknownComponent: Component = { value: false, known: false };

const TRADE_DECISION_ACTIONS: ReadonlySet<TradeDecisionAction | "HOLD"> = new Set([
  "BUY",
  "SELL",
  "HOLD",
]);

export function gateComponentLabel(result: GateComponentResult): GateComponentLabel {
  if (result === "unknown") return "unknown";
  return result ? "pass" : "fail";
}

function toFiniteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

// lifespanDays mirrors research `created` = gamma createdAt. `createdAt` (DB row)
// is absent on NormalizedMarket — only endDate + gammaCreatedAt are used.
function computeLifespanDays(endDate: string | null, gammaCreatedAt: string | null): number | null {
  if (endDate == null || gammaCreatedAt == null) return null;
  const end = Date.parse(endDate);
  const created = Date.parse(gammaCreatedAt);
  if (!Number.isFinite(end) || !Number.isFinite(created)) return null;
  return (end - created) / 86_400_000;
}

// Pre-placement notional for a first-entry probe (buyCount 0, nthBuy 1). Pure +
// available before any order; null if no size rule matches (FALLBACK missing).
function computeProposedNotional(
  midPrice: number | null,
  buySizeRules: readonly AlgoSizeRule[],
): number | null {
  if (midPrice == null) return null;
  try {
    return evaluateSize(
      "BUY",
      { state: "OTHER", price: midPrice, nthBuy: 1, buyCount: 0 },
      buySizeRules,
    ).sizeUsdc;
  } catch {
    return null;
  }
}

// The shadow recomputes R23 as an always-enabled engine: when the live policy is
// off/absent it falls back to the calibrated default (ratio 0.683 / 24h window),
// so the lane split is measurable independently of the live R23 toggle.
export function resolveShadowR23Policy(
  executionPolicy: ExecutionPolicy | null,
): R23DipTriggerPolicy {
  const live = executionPolicy?.r23DipTrigger;
  return live && live.enabled ? live : DEFAULT_R23_DIP_TRIGGER_POLICY;
}

export function evaluateTwoLaneEntryShadow(
  input: TwoLaneEntryShadowInput,
): TwoLaneEntryShadowProjection {
  const { market } = input;
  const midPrice = toFiniteOrNull(market.midPrice);
  const lifespanDays = computeLifespanDays(market.endDate, market.gammaCreatedAt);
  const proposedNotional = computeProposedNotional(midPrice, input.buySizeRules);

  // GATE_MAX_NOTIONAL has no GateEntryPolicy equivalent and is never overridden.
  const gateMinPrice = input.gateEntryPolicy?.minPrice ?? GATE_MIN_PRICE;
  const gateMaxPrice = input.gateEntryPolicy?.maxPrice ?? GATE_MAX_PRICE;
  const gateMinLifespanDays = input.gateEntryPolicy?.minLifespanDays ?? GATE_MIN_LIFESPAN_DAYS;

  const r23 = evaluateR23DipTrigger(
    { state: "OTHER", currentMidpoint: midPrice ?? 0, maxMidpointInWindow: input.r23MaxMidpoint },
    resolveShadowR23Policy(input.executionPolicy),
  );
  const r23Match = r23.fire;
  const r23NoHistory = r23.reason === R23_NO_HISTORY_REASON;

  // own_token_readd is structurally unreachable on first-entry (re-add by
  // definition holds the token already) — recorded as a known-false, inert
  // component, never participating in gateMatch. category is unavailable live.
  const evaluated: Record<GateComponentKey, Component> = {
    size_le_13:
      proposedNotional == null ? unknownComponent : present(proposedNotional <= GATE_MAX_NOTIONAL),
    price_gt_0_01: midPrice == null ? unknownComponent : present(midPrice > gateMinPrice),
    cheap_side_le_055: midPrice == null ? unknownComponent : present(midPrice <= gateMaxPrice),
    lifespan_gt_21d:
      lifespanDays == null ? unknownComponent : present(lifespanDays > gateMinLifespanDays),
    own_token_readd: present(false),
    category_not_blocked: unknownComponent,
  };

  const gateComponents = {} as Record<GateComponentKey, GateComponentResult>;
  const missingComponents: GateComponentKey[] = [];
  for (const key of GATE_COMPONENT_KEYS) {
    const component = evaluated[key];
    gateComponents[key] = component.known ? component.value : "unknown";
    if (!component.known) missingComponents.push(key);
  }

  // GATE (first-entry projection) = size≤$13 AND midPrice>0.01 AND midPrice≤0.55
  // AND lifespan>21d. own_token_readd and category are NOT requirements (§1.1).
  const gateInputs = [
    evaluated.size_le_13,
    evaluated.price_gt_0_01,
    evaluated.cheap_side_le_055,
    evaluated.lifespan_gt_21d,
  ];
  const gateDeterminable = gateInputs.every((c) => c.known);
  const gateMatch = gateDeterminable && gateInputs.every((c) => c.value);

  const liveDecisionRuleId = r23Match
    ? R23_DIP_TRIGGER_RULE_ID
    : (matchRule(
        {
          state: "OTHER",
          price: midPrice ?? 0,
          timeSinceLastSeconds: null,
          buyCount: 0,
          holdDurationSeconds: null,
        },
        input.decisionRules,
        TRADE_DECISION_ACTIONS,
      )?.ruleId ?? null);
  const deadSourceGroup: DeadMarketSourceGroup = deriveSourceGroup(liveDecisionRuleId);
  const sourceGroup: TwoLaneSourceGroup = liveDecisionRuleId == null ? "none" : deadSourceGroup;

  const dead = computeDeadMarketScore({
    selectedPrice: midPrice,
    sourceGroup: deadSourceGroup,
    gammaLiquidity: toFiniteOrNull(market.liquidity),
    planktonActive24h: null,
    planktonEverTouched: null,
    observerDead: null,
  });

  const laneClass = classifyLane({ midPrice, gateDeterminable, r23Match, gateMatch });

  return {
    title: market.question,
    price: midPrice,
    proposedNotional,
    lifespanDays,
    category: null,
    tags: market.tags ? [...market.tags] : [],
    sourceGroup,
    r23Match,
    gateMatch,
    laneClass,
    gateComponents,
    missingComponents,
    r23Ratio: r23.ratio,
    r23MaxMidpoint: r23.maxMidpoint,
    r23NoHistory,
    deadScore: dead.score,
    deadClassification: classifyDeadMarketScore(dead.score),
    scoreVersion: GATE_RULE_VERSION,
    featureSet: LIVE_FEATURE_SET,
  };
}

function classifyLane(args: {
  midPrice: number | null;
  gateDeterminable: boolean;
  r23Match: boolean;
  gateMatch: boolean;
}): TwoLaneClass {
  // Both lanes require a price; an undeterminable gate (missing lifespan or
  // notional) is also unclassifiable. category is intentionally excluded.
  if (args.midPrice == null) return "UNKNOWN";
  if (!args.gateDeterminable) return "UNKNOWN";
  if (args.r23Match && args.gateMatch) return "BOTH";
  if (args.r23Match) return "R23_ONLY";
  if (args.gateMatch) return "GATE_ONLY";
  return "NEITHER";
}
