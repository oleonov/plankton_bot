import type { LegState, AlgoDecisionRule, AlgoSizeRule } from "./types.js";
import type { SignalReason } from "./enums.js";

// ─── State derivation ─────────────────────────────────────────────────────────

export type AlgoState = "OTHER" | "S1" | "S2" | "S3";

export function deriveState(legState: LegState | null): AlgoState {
  if (!legState) return "OTHER";
  if (legState.sellCount >= 1 && legState.lastAction === "SELL") return "S3";
  if (legState.buyCount >= 2 && legState.lastAction === "BUY") return "S2";
  if (legState.buyCount === 1 && legState.lastAction === "BUY") return "S1";
  return "OTHER";
}

// ─── Rule evaluation ──────────────────────────────────────────────────────────

export interface EvalContext {
  state: AlgoState;
  price: number;
  timeSinceLastSeconds: number | null;
  buyCount: number;
  holdDurationSeconds: number | null;
}

function compareOp(op: string, actual: number, threshold: number): boolean {
  switch (op) {
    case "<": return actual < threshold;
    case "<=": return actual <= threshold;
    case ">": return actual > threshold;
    case ">=": return actual >= threshold;
    default: return false;
  }
}

export function matchRule(
  ctx: EvalContext,
  rules: readonly AlgoDecisionRule[],
  allowedActions: ReadonlySet<string>,
): { action: string; ruleId: string } | null {
  for (const rule of rules) {
    if (!allowedActions.has(rule.action)) continue;
    if (rule.stateCondition !== "ANY" && rule.stateCondition !== ctx.state) continue;
    if (rule.priceOperator != null && rule.priceValue != null) {
      if (!compareOp(rule.priceOperator, ctx.price, rule.priceValue)) continue;
    }
    if (rule.timeSinceLastOperator != null) {
      if (ctx.timeSinceLastSeconds === null) continue;
      if (!compareOp(rule.timeSinceLastOperator, ctx.timeSinceLastSeconds, rule.timeSinceLastSeconds!)) continue;
    }
    if (rule.holdDurationOperator != null) {
      if (ctx.holdDurationSeconds === null) continue;
      if (!compareOp(rule.holdDurationOperator, ctx.holdDurationSeconds, rule.holdDurationSeconds!)) continue;
    }
    if (rule.buyCountMin != null && ctx.buyCount < rule.buyCountMin) continue;
    if (rule.buyCountMax != null && ctx.buyCount > rule.buyCountMax) continue;
    return { action: rule.action, ruleId: rule.ruleId };
  }
  return null;
}

const BUY_SELL = new Set(["BUY", "SELL"]);
const REDEEM_SET = new Set(["REDEEM"]);

export function evaluateDecision(
  ctx: EvalContext,
  rules: readonly AlgoDecisionRule[],
): { action: "BUY" | "SELL"; ruleId: string } {
  const result = matchRule(ctx, rules, BUY_SELL);
  if (!result) throw new Error("FALLBACK rule missing — no BUY/SELL match");
  return result as { action: "BUY" | "SELL"; ruleId: string };
}

export function evaluateRedeem(
  ctx: EvalContext,
  rules: readonly AlgoDecisionRule[],
): { action: "REDEEM"; ruleId: string } | null {
  return matchRule(ctx, rules, REDEEM_SET) as { action: "REDEEM"; ruleId: string } | null;
}

// ─── Size evaluation ──────────────────────────────────────────────────────────

export interface SizeContext {
  state: AlgoState;
  price: number;
  nthBuy: number;
  buyCount: number;
}

export function evaluateSize(
  action: "BUY" | "SELL",
  ctx: SizeContext,
  rules: readonly AlgoSizeRule[],
): { sizeUsdc: number; ruleId: string } {
  for (const rule of rules) {
    if (rule.actionType !== action) continue;
    if (rule.stateCondition !== "ANY" && rule.stateCondition !== ctx.state) continue;
    if (rule.priceOperator != null && rule.priceValue != null) {
      if (!compareOp(rule.priceOperator, ctx.price, rule.priceValue)) continue;
    }
    if (rule.nthBuy != null && rule.nthBuy !== ctx.nthBuy) continue;
    if (rule.buyCountMin != null && ctx.buyCount < rule.buyCountMin) continue;
    if (rule.buyCountMax != null && ctx.buyCount > rule.buyCountMax) continue;
    return { sizeUsdc: rule.sizeUsdc, ruleId: rule.ruleId };
  }
  throw new Error(`No size rule matched for ${action} — FALLBACK rule missing`);
}

// ─── Signal reason resolution ─────────────────────────────────────────────────

export function resolveSignalReason(side: "buy" | "sell", buyCount: number): SignalReason {
  if (side === "sell") return "repricing-exit";
  if (buyCount === 0) return "probe-entry";
  if (buyCount === 1) return "confirm-scale";
  if (buyCount <= 3) return "scale-in";
  return "heavy-scale";
}
