import type { TokenId } from "./ids.js";
import type { StaleVerdict } from "./stale-sell.js";

export type ExitLivenessVerdict = "live" | "dead" | "unknown";
export type ExitSubtype = "strike" | "non-strike";
export type ExitAction =
  | "continue_normal"
  | "continue_passive_sit"
  | "floor_close"
  | "hold_resolution";

export interface ExitDecisionContext {
  readonly tokenId: TokenId;
  readonly positionPnLRatio: number;
  readonly livenessVerdict: ExitLivenessVerdict;
  readonly staleVerdict: StaleVerdict;
  readonly positionAgeMs: number;
  readonly ttcResolutionMs: number;
  readonly subtype: ExitSubtype;
  readonly exitPnlPct: number;
  readonly floorIntentState?: { readonly active: boolean; readonly attemptCount: number };
  readonly holdResolutionState?: { readonly active: boolean };
  readonly floorCloseRatioThreshold?: number | null;
  readonly ts: number;
}

export interface ExitActionDecision {
  readonly action: ExitAction;
  readonly reason: string;
  readonly executionParams?: { readonly targetPrice?: number };
  readonly holdResolutionRequest?: {
    readonly tokenId: TokenId;
    readonly expectedResolutionAt: number | null;
    readonly reason: string;
  };
  readonly evidence: Record<string, unknown>;
}

export function decideExitAction(ctx: ExitDecisionContext): ExitActionDecision {
  if (ctx.livenessVerdict === "unknown") {
    return decision(ctx, "continue_normal", "unknown_degrade_normal");
  }
  if (ctx.livenessVerdict === "live") {
    return decision(ctx, "continue_normal", "live_normal");
  }

  if (ctx.staleVerdict.reason === "price_only") {
    return decision(ctx, "continue_passive_sit", "dead_price_only_observability");
  }
  if (ctx.staleVerdict.reason === "none") {
    return decision(ctx, "continue_passive_sit", "dead_passive_sit");
  }

  if (ctx.holdResolutionState?.active === true) {
    return decision(ctx, "hold_resolution", "hold_resolution_active");
  }

  if (isFloorEligible(ctx)) {
    return decision(ctx, "floor_close", "dead_chain_floor_close");
  }

  if (isFloorWouldHaveBeenEligible(ctx)) {
    return decision(ctx, "hold_resolution", "phase_1_floor_disabled");
  }

  return decision(ctx, "hold_resolution", "dead_chain_hold_resolution");
}

export function isFloorEligible(ctx: ExitDecisionContext): boolean {
  if (ctx.staleVerdict.reason !== "chain" && ctx.staleVerdict.reason !== "chain+price") {
    return false;
  }
  return false;
}

function isFloorWouldHaveBeenEligible(ctx: ExitDecisionContext): boolean {
  return (
    ctx.floorCloseRatioThreshold != null &&
    Number.isFinite(ctx.floorCloseRatioThreshold) &&
    ctx.positionPnLRatio <= ctx.floorCloseRatioThreshold
  );
}

function decision(
  ctx: ExitDecisionContext,
  action: ExitAction,
  reason: string,
): ExitActionDecision {
  const holdResolutionRequest =
    action === "hold_resolution"
      ? {
          tokenId: ctx.tokenId,
          expectedResolutionAt: resolveExpectedResolutionAt(ctx),
          reason,
        }
      : undefined;

  return {
    action,
    reason,
    ...(holdResolutionRequest ? { holdResolutionRequest } : {}),
    evidence: {
      tokenId: ctx.tokenId,
      positionPnLRatio: ctx.positionPnLRatio,
      livenessVerdict: ctx.livenessVerdict,
      staleReason: ctx.staleVerdict.reason,
      positionAgeMs: ctx.positionAgeMs,
      ttcResolutionMs: ctx.ttcResolutionMs,
      subtype: ctx.subtype,
      exitPnlPct: ctx.exitPnlPct,
      floorCloseRatioThreshold: ctx.floorCloseRatioThreshold ?? null,
      floorIntentActive: ctx.floorIntentState?.active ?? false,
      floorIntentAttemptCount: ctx.floorIntentState?.attemptCount ?? 0,
      holdResolutionActive: ctx.holdResolutionState?.active ?? false,
      ts: ctx.ts,
    },
  };
}

function resolveExpectedResolutionAt(ctx: ExitDecisionContext): number | null {
  if (!Number.isFinite(ctx.ts) || !Number.isFinite(ctx.ttcResolutionMs)) return null;
  return ctx.ts + ctx.ttcResolutionMs;
}
