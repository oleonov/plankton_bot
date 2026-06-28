// Shadow-only "dead market" score for entry/add BUY candidates. This module is
// PURE and observational: it never blocks, resizes, or reprices a live order. It
// reproduces the 6-component, no-lookahead score validated in the Plankton
// research replay so the runtime can collect the same signal live and compare.
//
// Scoring is strictly fail-open: a component whose input is unavailable live
// (missing price/liquidity, or a Plankton/observer feature never ported to the
// runtime) is reported as `unknown` and contributes 0 to the score. It can never
// manufacture a higher (more "dead") score from absence of data.

import { SignalReason } from "@krabs/domain";

export const DEAD_MARKET_COMPONENT_KEYS = [
  "cheapTail",
  "r23OrFallbackSource",
  "planktonNotActive24h",
  "planktonNeverTouched",
  "lowGammaLiquidity",
  "observerDead",
] as const;

export type DeadMarketComponentKey = (typeof DEAD_MARKET_COMPONENT_KEYS)[number];

export type DeadMarketSourceGroup =
  | "r23"
  | "fallback"
  | "scale_in"
  | "ladder"
  | "d1_d3"
  | "other"
  | "unknown";

export type DeadMarketDecisionType = "entry" | "add" | "unknown";

export type DeadMarketClassification =
  | "shadow_allow"
  | "shadow_downweight_candidate"
  | "shadow_block_candidate"
  | "shadow_hard_block_candidate";

/** Inclusive upper bound for the cheap-tail component (research: price <= 0.02). */
export const DEAD_MARKET_CHEAP_TAIL_MAX_PRICE = 0.02;
/** Gamma liquidity below this counts as a "dead" component (research: < 100). */
export const DEAD_MARKET_LOW_LIQUIDITY_THRESHOLD = 100;

export interface DeadMarketScoreInput {
  /** Intended buy price (signal.suggestedPrice). null/non-finite => unknown. */
  selectedPrice: number | null;
  /** Already-derived source group (see deriveSourceGroup). Always known. */
  sourceGroup: DeadMarketSourceGroup;
  /** Gamma market liquidity (market.liquidity). null => unknown. */
  gammaLiquidity: number | null;
  /** Plankton "active in last 24h". null => not available live (unknown). */
  planktonActive24h: boolean | null;
  /** Plankton "ever touched". null => not available live (unknown). */
  planktonEverTouched: boolean | null;
  /** Observer dead-book verdict. null => not available live (unknown). */
  observerDead: boolean | null;
}

export interface DeadMarketScoreResult {
  score: number;
  components: Record<DeadMarketComponentKey, boolean>;
  unknownComponents: DeadMarketComponentKey[];
  classification: DeadMarketClassification;
}

type Component = { value: boolean; known: boolean };

const present = (value: boolean): Component => ({ value, known: true });
const unknown: Component = { value: false, known: false };

function cheapTailComponent(price: number | null): Component {
  if (price == null || !Number.isFinite(price)) return unknown;
  return present(price <= DEAD_MARKET_CHEAP_TAIL_MAX_PRICE);
}

function lowLiquidityComponent(liquidity: number | null): Component {
  if (liquidity == null || !Number.isFinite(liquidity)) return unknown;
  return present(liquidity < DEAD_MARKET_LOW_LIQUIDITY_THRESHOLD);
}

// A null boolean means the feature is not available live; report it as unknown
// (fail-open) rather than guessing false-as-known.
function booleanFeatureComponent(flag: boolean | null, deadWhen: boolean): Component {
  if (flag == null) return unknown;
  return present(flag === deadWhen);
}

export function classifyDeadMarketScore(score: number): DeadMarketClassification {
  if (score >= 4) return "shadow_hard_block_candidate";
  if (score === 3) return "shadow_block_candidate";
  if (score === 2) return "shadow_downweight_candidate";
  return "shadow_allow";
}

export function computeDeadMarketScore(input: DeadMarketScoreInput): DeadMarketScoreResult {
  const evaluated: Record<DeadMarketComponentKey, Component> = {
    cheapTail: cheapTailComponent(input.selectedPrice),
    r23OrFallbackSource: present(input.sourceGroup === "r23" || input.sourceGroup === "fallback"),
    planktonNotActive24h: booleanFeatureComponent(input.planktonActive24h, false),
    planktonNeverTouched: booleanFeatureComponent(input.planktonEverTouched, false),
    lowGammaLiquidity: lowLiquidityComponent(input.gammaLiquidity),
    observerDead: booleanFeatureComponent(input.observerDead, true),
  };

  const components = {} as Record<DeadMarketComponentKey, boolean>;
  const unknownComponents: DeadMarketComponentKey[] = [];
  let score = 0;
  for (const key of DEAD_MARKET_COMPONENT_KEYS) {
    const component = evaluated[key];
    components[key] = component.value;
    if (!component.known) unknownComponents.push(key);
    if (component.value) score += 1;
  }

  return { score, components, unknownComponents, classification: classifyDeadMarketScore(score) };
}

export function deriveSourceGroup(
  decisionRuleId: string | null | undefined,
): DeadMarketSourceGroup {
  if (decisionRuleId == null || decisionRuleId === "") return "unknown";
  if (decisionRuleId === "R23_DIP_TRIGGER") return "r23";
  if (decisionRuleId === "FALLBACK") return "fallback";
  if (decisionRuleId === "EXECUTION_PROFILE_SCALE_IN") return "scale_in";
  if (decisionRuleId.includes("LADDER")) return "ladder";
  if (/^D\d+$/.test(decisionRuleId)) return "d1_d3";
  return "other";
}

// Entry/add is a strategy semantic carried by signal.reason, NOT by the source
// group: a D3/FALLBACK rule firing a scale reason is an ADD even though its
// source group historically read as an "entry". probe-entry is the only entry
// reason; confirm/scale-in/heavy are adds; anything else (exits, operator,
// unrecognized) is unknown so it never gets mislabeled as a fresh entry.
const ADD_REASONS: ReadonlySet<string> = new Set([
  SignalReason.ConfirmScale,
  SignalReason.ScaleIn,
  SignalReason.HeavyScale,
]);

export function deriveDecisionType(reason: string | null | undefined): DeadMarketDecisionType {
  if (reason === SignalReason.ProbeEntry) return "entry";
  if (reason != null && ADD_REASONS.has(reason)) return "add";
  return "unknown";
}
