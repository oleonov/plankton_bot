import type Database from "better-sqlite3";
import type {
  ConditionId,
  ExecutionPolicy,
  Fill,
  Position,
  PositionConcentrationPolicy,
  ProfileId,
  TokenId,
} from "@krabs/domain";
import type { Logger } from "./logger.js";
import type { RuntimeMetricWriter } from "./runtime-metric-writer.js";

const OPEN_ORDER_STATUSES = "'pending','open','partially-filled'";
const ACTIVE_POSITION_STATUSES = "'open','dust'";
const WARN_THROTTLE_MS = 5 * 60_000;
const EPSILON_USDC = 1e-9;

export type PositionConcentrationStage = "risk_inventory" | "signal_to_order" | "execution";
export type PositionConcentrationAction = "allow" | "clamp" | "skip";

export interface PositionConcentrationDecision {
  action: PositionConcentrationAction;
  reason: string;
  effectiveNotionalUsdc: number;
  concentrationKey: string | null;
  keyType: "condition" | "token" | null;
  fallbackReason: "fallback_condition_missing" | null;
  metrics: PositionConcentrationMetrics | null;
}

export interface PositionConcentrationMetrics {
  capBankrollUsdc: number;
  bankrollAtFirstBuyUsdc: number;
  currentEffectiveBankrollUsdc: number;
  grossCapUsdc: number;
  remainingCapUsdc: number;
  postHarvestRefillCapUsdc: number | null;
  grossHeadroomUsdc: number;
  remainingHeadroomUsdc: number;
  postHarvestRefillHeadroomUsdc: number | null;
  pendingBuyUsdc: number;
  filledBuyGrossUsdc: number;
  currentRemainingExposureUsdc: number;
}

export interface PositionConcentrationEvaluateInput {
  tokenId: TokenId;
  conditionId: ConditionId | string | null | undefined;
  candidateNotionalUsdc: number;
  minExecutableNotionalUsdc: number;
  policy: ExecutionPolicy["positionConcentration"];
  stage: PositionConcentrationStage;
  signalReason?: string | null;
  decisionRuleId?: string | null;
  strongOverride?: boolean | undefined;
}

export interface PositionConcentrationFillInput {
  fill: Pick<
    Fill,
    "tokenId" | "conditionId" | "side" | "price" | "sizeUsdc" | "filledAt" | "orderId"
  >;
  policy: ExecutionPolicy["positionConcentration"];
  positionBefore: Position | null;
  positionAfter: Position;
}

export interface PositionConcentrationServiceDeps {
  ledgerDb: Database.Database;
  controlDb?: Pick<Database.Database, "prepare"> | undefined;
  profileId?: ProfileId | undefined;
  log: Logger;
  runtimeMetrics?: RuntimeMetricWriter | undefined;
  now?: () => number;
}

export interface ConcentrationKeyInfo {
  concentrationKey: string;
  keyType: "condition" | "token";
  conditionId: string | null;
  tokenId: string;
  fallbackReason: "fallback_condition_missing" | null;
}

interface StateRow {
  concentration_key: string;
  key_type: "condition" | "token";
  condition_id: string | null;
  token_id: string;
  lifecycle_start_at: string;
  bankroll_at_first_buy_usdc: number;
  gross_buy_filled_usdc: number;
  gross_high_water_usdc: number;
  post_harvest_refill_spent_usdc: number;
  last_profitable_sell_at: string | null;
  last_profitable_sell_price: number | null;
  last_pre_sell_avg_entry: number | null;
  profitable_sell_count: number;
  last_buy_at: string | null;
  last_sell_at: string | null;
  archived_at: string | null;
}

interface BankrollSnapshot {
  valueUsdc: number;
  capturedAtMs: number | null;
  source: "portfolio_snapshot" | "profile_summary" | "stable_snapshot";
  fresh: boolean;
}

export class PositionConcentrationService {
  private readonly log: Logger;
  private readonly startedAtMs: number;
  private readonly lastWarnAtByReason = new Map<string, number>();

  constructor(private readonly deps: PositionConcentrationServiceDeps) {
    this.log = deps.log.child({ component: "position-concentration" });
    this.startedAtMs = deps.now?.() ?? Date.now();
  }

  evaluateBuy(input: PositionConcentrationEvaluateInput): PositionConcentrationDecision {
    const policy = input.policy;
    if (!policy.enabled) {
      return this.allow("policy_disabled", input, null, null);
    }
    if (!Number.isFinite(input.candidateNotionalUsdc) || input.candidateNotionalUsdc <= 0) {
      return this.allow("invalid_input", input, null, null);
    }

    const key = deriveConcentrationKey(input.tokenId, input.conditionId, policy);
    if (key == null) {
      return this.allow("missing_condition_no_fallback", input, null, null);
    }
    this.recordFallbackIfNeeded(key, input.stage);

    const bankroll = this.resolveBankroll(policy);
    if (bankroll == null) {
      const reason = this.isWithinStartupGrace(policy)
        ? "missing_bankroll_startup_fail_open"
        : "missing_bankroll_fail_open";
      this.recordMissingBankroll(reason, input.stage);
      return this.allow(reason, input, key, null);
    }

    const nowIso = new Date(this.now()).toISOString();
    const state = this.findActiveState(key.concentrationKey);
    const lifecycleStartAt =
      state?.lifecycle_start_at ?? this.resolveLifecycleStartAt(key) ?? nowIso;
    const bankrollAtFirstBuy = state?.bankroll_at_first_buy_usdc ?? bankroll.valueUsdc;
    const capBankroll = Math.min(bankrollAtFirstBuy, bankroll.valueUsdc);
    const pendingBuyUsdc = this.sumPendingBuyResidual(key);
    const filledBuyGrossUsdc =
      state?.gross_buy_filled_usdc ?? this.sumFilledBuyGross(key, lifecycleStartAt);
    const grossHighWaterUsdc = Math.max(
      state?.gross_high_water_usdc ?? 0,
      filledBuyGrossUsdc + pendingBuyUsdc,
    );
    const currentRemainingExposureUsdc = this.sumRemainingExposure(key) + pendingBuyUsdc;
    const postHarvestActive = state?.last_profitable_sell_at != null;
    const caps = computeCaps(policy, capBankroll, input.strongOverride === true);
    const grossHeadroom = caps.grossCapUsdc - grossHighWaterUsdc;
    const remainingHeadroom = caps.remainingCapUsdc - currentRemainingExposureUsdc;
    const postHarvestRefillHeadroom = postHarvestActive
      ? caps.postHarvestRefillCapUsdc - (state?.post_harvest_refill_spent_usdc ?? 0)
      : null;
    const headrooms = [grossHeadroom, remainingHeadroom];
    if (postHarvestRefillHeadroom != null) headrooms.push(postHarvestRefillHeadroom);
    const allowedHeadroom = Math.min(...headrooms);
    const limitingReason = resolveLimitingReason({
      grossHeadroom,
      remainingHeadroom,
      postHarvestRefillHeadroom,
      allowedHeadroom,
    });
    const metrics: PositionConcentrationMetrics = {
      capBankrollUsdc: capBankroll,
      bankrollAtFirstBuyUsdc: bankrollAtFirstBuy,
      currentEffectiveBankrollUsdc: bankroll.valueUsdc,
      grossCapUsdc: caps.grossCapUsdc,
      remainingCapUsdc: caps.remainingCapUsdc,
      postHarvestRefillCapUsdc: postHarvestActive ? caps.postHarvestRefillCapUsdc : null,
      grossHeadroomUsdc: grossHeadroom,
      remainingHeadroomUsdc: remainingHeadroom,
      postHarvestRefillHeadroomUsdc: postHarvestRefillHeadroom,
      pendingBuyUsdc,
      filledBuyGrossUsdc,
      currentRemainingExposureUsdc,
    };

    if (allowedHeadroom <= EPSILON_USDC) {
      return this.skip(limitingReason, input, key, metrics);
    }
    if (input.candidateNotionalUsdc <= allowedHeadroom + EPSILON_USDC) {
      return this.allow("under_caps", input, key, metrics);
    }
    if (!policy.clampBeforeSkip) {
      return this.skip(limitingReason, input, key, metrics);
    }
    const clamped = Math.max(0, allowedHeadroom);
    if (clamped + EPSILON_USDC < input.minExecutableNotionalUsdc) {
      return this.skip("below_min_after_clamp", input, key, metrics);
    }
    return this.clamp(limitingReason, clamped, input, key, metrics);
  }

  recordFill(input: PositionConcentrationFillInput): void {
    if (!input.policy.enabled) return;
    const key = deriveConcentrationKey(input.fill.tokenId, input.fill.conditionId, input.policy);
    if (key == null) return;
    const existing = this.findActiveState(key.concentrationKey);
    const nowIso = input.fill.filledAt;

    if (input.fill.side === "buy") {
      const bankroll = this.resolveBankroll(input.policy);
      const bankrollAtFirstBuy =
        existing?.bankroll_at_first_buy_usdc ?? bankroll?.valueUsdc ?? input.fill.sizeUsdc;
      const lifecycleStartAt = existing?.lifecycle_start_at ?? nowIso;
      const grossFilled = (existing?.gross_buy_filled_usdc ?? 0) + input.fill.sizeUsdc;
      const pending = this.sumPendingBuyResidual(key);
      const grossHighWater = Math.max(existing?.gross_high_water_usdc ?? 0, grossFilled + pending);
      const refillSpent =
        existing?.last_profitable_sell_at != null
          ? (existing?.post_harvest_refill_spent_usdc ?? 0) + input.fill.sizeUsdc
          : (existing?.post_harvest_refill_spent_usdc ?? 0);
      this.upsertState({
        key,
        lifecycleStartAt,
        bankrollAtFirstBuy,
        grossBuyFilledUsdc: grossFilled,
        grossHighWaterUsdc: grossHighWater,
        postHarvestRefillSpentUsdc: refillSpent,
        lastProfitableSellAt: existing?.last_profitable_sell_at ?? null,
        lastProfitableSellPrice: existing?.last_profitable_sell_price ?? null,
        lastPreSellAvgEntry: existing?.last_pre_sell_avg_entry ?? null,
        profitableSellCount: existing?.profitable_sell_count ?? 0,
        lastBuyAt: nowIso,
        lastSellAt: existing?.last_sell_at ?? null,
        createdAt: existing?.lifecycle_start_at ?? nowIso,
        updatedAt: nowIso,
      });
      return;
    }

    if (existing == null) return;
    const profitable =
      input.positionBefore != null && input.fill.price > input.positionBefore.avgEntryPrice;
    const nextState = {
      key,
      lifecycleStartAt: existing.lifecycle_start_at,
      bankrollAtFirstBuy: existing.bankroll_at_first_buy_usdc,
      grossBuyFilledUsdc: existing.gross_buy_filled_usdc,
      grossHighWaterUsdc: existing.gross_high_water_usdc,
      postHarvestRefillSpentUsdc: existing.post_harvest_refill_spent_usdc,
      lastProfitableSellAt: profitable ? nowIso : existing.last_profitable_sell_at,
      lastProfitableSellPrice: profitable ? input.fill.price : existing.last_profitable_sell_price,
      lastPreSellAvgEntry: profitable
        ? (input.positionBefore?.avgEntryPrice ?? null)
        : existing.last_pre_sell_avg_entry,
      profitableSellCount: existing.profitable_sell_count + (profitable ? 1 : 0),
      lastBuyAt: existing.last_buy_at ?? null,
      lastSellAt: nowIso,
      createdAt: existing.lifecycle_start_at,
      updatedAt: nowIso,
    };
    this.upsertState(nextState);
    if (
      input.positionAfter.status === "closed" &&
      this.sumPendingBuyResidual(key) <= EPSILON_USDC
    ) {
      this.archiveState(key.concentrationKey, nowIso);
      this.deps.runtimeMetrics?.writeCounter(
        "position_concentration_lifecycle_reset_total",
        1,
        JSON.stringify({ reason: "closed_flat", keyType: key.keyType }),
      );
    }
  }

  private allow(
    reason: string,
    input: PositionConcentrationEvaluateInput,
    key: ConcentrationKeyInfo | null,
    metrics: PositionConcentrationMetrics | null,
  ): PositionConcentrationDecision {
    this.recordDecision("allow", reason, input, key);
    return {
      action: "allow",
      reason,
      effectiveNotionalUsdc: input.candidateNotionalUsdc,
      concentrationKey: key?.concentrationKey ?? null,
      keyType: key?.keyType ?? null,
      fallbackReason: key?.fallbackReason ?? null,
      metrics,
    };
  }

  private clamp(
    reason: string,
    effectiveNotionalUsdc: number,
    input: PositionConcentrationEvaluateInput,
    key: ConcentrationKeyInfo,
    metrics: PositionConcentrationMetrics,
  ): PositionConcentrationDecision {
    this.recordDecision("clamp", reason, input, key);
    return {
      action: "clamp",
      reason,
      effectiveNotionalUsdc,
      concentrationKey: key.concentrationKey,
      keyType: key.keyType,
      fallbackReason: key.fallbackReason,
      metrics,
    };
  }

  private skip(
    reason: string,
    input: PositionConcentrationEvaluateInput,
    key: ConcentrationKeyInfo,
    metrics: PositionConcentrationMetrics,
  ): PositionConcentrationDecision {
    this.recordDecision("skip", reason, input, key);
    return {
      action: "skip",
      reason,
      effectiveNotionalUsdc: 0,
      concentrationKey: key.concentrationKey,
      keyType: key.keyType,
      fallbackReason: key.fallbackReason,
      metrics,
    };
  }

  private findActiveState(concentrationKey: string): StateRow | null {
    const row = this.deps.ledgerDb
      .prepare(
        `SELECT *
           FROM position_concentration_state
          WHERE concentration_key = ?
            AND archived_at IS NULL
          LIMIT 1`,
      )
      .get(concentrationKey) as StateRow | undefined;
    return row ?? null;
  }

  private upsertState(args: {
    key: ConcentrationKeyInfo;
    lifecycleStartAt: string;
    bankrollAtFirstBuy: number;
    grossBuyFilledUsdc: number;
    grossHighWaterUsdc: number;
    postHarvestRefillSpentUsdc: number;
    lastProfitableSellAt: string | null;
    lastProfitableSellPrice: number | null;
    lastPreSellAvgEntry: number | null;
    profitableSellCount: number;
    lastBuyAt: string | null;
    lastSellAt: string | null;
    createdAt: string;
    updatedAt: string;
  }): void {
    this.deps.ledgerDb
      .prepare(
        `INSERT INTO position_concentration_state
         (concentration_key, key_type, condition_id, token_id, lifecycle_start_at,
          bankroll_at_first_buy_usdc, gross_buy_filled_usdc, gross_high_water_usdc,
          post_harvest_refill_spent_usdc, last_profitable_sell_at, last_profitable_sell_price,
          last_pre_sell_avg_entry, profitable_sell_count, last_buy_at, last_sell_at,
          archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(concentration_key) DO UPDATE SET
           key_type = excluded.key_type,
           condition_id = excluded.condition_id,
           token_id = excluded.token_id,
           lifecycle_start_at = excluded.lifecycle_start_at,
           bankroll_at_first_buy_usdc = excluded.bankroll_at_first_buy_usdc,
           gross_buy_filled_usdc = excluded.gross_buy_filled_usdc,
           gross_high_water_usdc = excluded.gross_high_water_usdc,
           post_harvest_refill_spent_usdc = excluded.post_harvest_refill_spent_usdc,
           last_profitable_sell_at = excluded.last_profitable_sell_at,
           last_profitable_sell_price = excluded.last_profitable_sell_price,
           last_pre_sell_avg_entry = excluded.last_pre_sell_avg_entry,
           profitable_sell_count = excluded.profitable_sell_count,
           last_buy_at = excluded.last_buy_at,
           last_sell_at = excluded.last_sell_at,
           archived_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        args.key.concentrationKey,
        args.key.keyType,
        args.key.conditionId,
        args.key.tokenId,
        args.lifecycleStartAt,
        args.bankrollAtFirstBuy,
        args.grossBuyFilledUsdc,
        args.grossHighWaterUsdc,
        args.postHarvestRefillSpentUsdc,
        args.lastProfitableSellAt,
        args.lastProfitableSellPrice,
        args.lastPreSellAvgEntry,
        args.profitableSellCount,
        args.lastBuyAt,
        args.lastSellAt,
        args.createdAt,
        args.updatedAt,
      );
  }

  private archiveState(concentrationKey: string, archivedAt: string): void {
    this.deps.ledgerDb
      .prepare(
        `UPDATE position_concentration_state
            SET archived_at = ?,
                updated_at = ?
          WHERE concentration_key = ?
            AND archived_at IS NULL`,
      )
      .run(archivedAt, archivedAt, concentrationKey);
  }

  private resolveLifecycleStartAt(key: ConcentrationKeyInfo): string | null {
    const clause = key.keyType === "condition" ? "condition_id = ?" : "token_id = ?";
    const value = key.keyType === "condition" ? key.conditionId : key.tokenId;
    const row = this.deps.ledgerDb
      .prepare(
        `SELECT MIN(opened_at) AS opened_at
           FROM positions
          WHERE ${clause}
            AND status IN (${ACTIVE_POSITION_STATUSES})`,
      )
      .get(value) as { opened_at: string | null } | undefined;
    return row?.opened_at ?? null;
  }

  private sumFilledBuyGross(key: ConcentrationKeyInfo, sinceIso: string): number {
    const clause = key.keyType === "condition" ? "condition_id = ?" : "token_id = ?";
    const value = key.keyType === "condition" ? key.conditionId : key.tokenId;
    const row = this.deps.ledgerDb
      .prepare(
        `SELECT COALESCE(SUM(size_usdc), 0) AS total
           FROM fills
          WHERE ${clause}
            AND side = 'buy'
            AND filled_at >= ?`,
      )
      .get(value, sinceIso) as { total: number } | undefined;
    return finiteNonNegative(row?.total);
  }

  private sumPendingBuyResidual(key: ConcentrationKeyInfo): number {
    const clause = key.keyType === "condition" ? "o.condition_id = ?" : "o.token_id = ?";
    const value = key.keyType === "condition" ? key.conditionId : key.tokenId;
    const row = this.deps.ledgerDb
      .prepare(
        `SELECT COALESCE(SUM(MAX(o.size_usdc - COALESCE(f.filled_usdc, 0), 0)), 0) AS total
           FROM orders o
           LEFT JOIN (
             SELECT order_id, SUM(size_usdc) AS filled_usdc
               FROM fills
              GROUP BY order_id
           ) f ON f.order_id = o.order_id
          WHERE ${clause}
            AND o.side = 'buy'
            AND o.status IN (${OPEN_ORDER_STATUSES})`,
      )
      .get(value) as { total: number } | undefined;
    return finiteNonNegative(row?.total);
  }

  private sumRemainingExposure(key: ConcentrationKeyInfo): number {
    const clause = key.keyType === "condition" ? "condition_id = ?" : "token_id = ?";
    const value = key.keyType === "condition" ? key.conditionId : key.tokenId;
    const row = this.deps.ledgerDb
      .prepare(
        `SELECT COALESCE(SUM(cost_basis_usdc), 0) AS total
           FROM positions
          WHERE ${clause}
            AND status IN (${ACTIVE_POSITION_STATUSES})`,
      )
      .get(value) as { total: number } | undefined;
    return finiteNonNegative(row?.total);
  }

  private resolveBankroll(policy: PositionConcentrationPolicy): BankrollSnapshot | null {
    const now = this.now();
    const portfolio = this.readPortfolioSnapshot();
    if (portfolio && now - portfolio.capturedAtMs! <= policy.portfolioSnapshotMaxAgeMs) {
      return { ...portfolio, fresh: true };
    }
    const summary = this.readProfileSummaryBankroll();
    if (summary && now - summary.capturedAtMs! <= policy.profileSummaryMaxAgeMs) {
      return { ...summary, fresh: true };
    }
    if (portfolio && this.isWithinStartupGrace(policy)) {
      return { ...portfolio, source: "stable_snapshot", fresh: false };
    }
    return portfolio ? { ...portfolio, source: "stable_snapshot", fresh: false } : null;
  }

  private readPortfolioSnapshot(): BankrollSnapshot | null {
    const profile = this.deps.profileId ?? "live-lite";
    const row = this.deps.ledgerDb
      .prepare(
        `SELECT total_equity_liquidation_usdc, equity_usdc, captured_at
           FROM portfolio_snapshots
          WHERE profile = ?
          ORDER BY captured_at DESC
          LIMIT 1`,
      )
      .get(profile) as
      | { total_equity_liquidation_usdc: number | null; equity_usdc: number; captured_at: string }
      | undefined;
    if (!row) return null;
    const value =
      finitePositive(row.total_equity_liquidation_usdc) ?? finitePositive(row.equity_usdc);
    const capturedAtMs = Date.parse(row.captured_at);
    if (value == null || !Number.isFinite(capturedAtMs)) return null;
    return { valueUsdc: value, capturedAtMs, source: "portfolio_snapshot", fresh: false };
  }

  private readProfileSummaryBankroll(): BankrollSnapshot | null {
    const controlDb = this.deps.controlDb;
    if (!controlDb) return null;
    const profile = this.deps.profileId ?? "live-lite";
    const row = controlDb
      .prepare(
        `SELECT wallet_balance_usdc, balance_usdc, updated_at
           FROM profile_summaries
          WHERE profile_id = ?
          LIMIT 1`,
      )
      .get(profile) as
      | { wallet_balance_usdc: number | null; balance_usdc: number | null; updated_at: string }
      | undefined;
    if (!row) return null;
    const wallet = finiteNonNegativeOrNull(row.wallet_balance_usdc ?? row.balance_usdc);
    const capturedAtMs = Date.parse(row.updated_at);
    if (wallet == null || !Number.isFinite(capturedAtMs)) return null;
    return {
      valueUsdc: wallet + this.sumConservativeOpenValue(),
      capturedAtMs,
      source: "profile_summary",
      fresh: false,
    };
  }

  private sumConservativeOpenValue(): number {
    const row = this.deps.ledgerDb
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(liquidation_value_usdc, current_value_usdc, 0)), 0) AS total
           FROM positions
          WHERE status IN (${ACTIVE_POSITION_STATUSES})`,
      )
      .get() as { total: number } | undefined;
    return finiteNonNegative(row?.total);
  }

  private isWithinStartupGrace(policy: PositionConcentrationPolicy): boolean {
    return this.now() - this.startedAtMs <= policy.startupGraceMs;
  }

  private recordDecision(
    action: PositionConcentrationAction,
    reason: string,
    input: PositionConcentrationEvaluateInput,
    key: ConcentrationKeyInfo | null,
  ): void {
    this.deps.runtimeMetrics?.writeCounter(
      "position_concentration_decision_total",
      1,
      JSON.stringify({
        action,
        reason: bounded(reason),
        stage: input.stage,
        keyType: key?.keyType ?? "unknown",
        source: bounded(input.signalReason ?? "unknown"),
        rule: bounded(input.decisionRuleId ?? "unknown"),
      }),
    );
  }

  private recordFallbackIfNeeded(
    key: ConcentrationKeyInfo,
    stage: PositionConcentrationStage,
  ): void {
    if (key.fallbackReason == null) return;
    this.deps.runtimeMetrics?.writeCounter(
      "position_concentration_condition_key_fallback_total",
      1,
      JSON.stringify({ reason: key.fallbackReason, stage }),
    );
  }

  private recordMissingBankroll(reason: string, stage: PositionConcentrationStage): void {
    this.deps.runtimeMetrics?.writeCounter(
      "position_concentration_missing_bankroll_total",
      1,
      JSON.stringify({ reason, stage }),
    );
    this.throttledWarn(reason, { reason, stage }, "position concentration bankroll unavailable");
  }

  private throttledWarn(reason: string, fields: Record<string, unknown>, message: string): void {
    const now = this.now();
    const last = this.lastWarnAtByReason.get(reason) ?? 0;
    if (now - last < WARN_THROTTLE_MS) return;
    this.lastWarnAtByReason.set(reason, now);
    this.log.warn(fields, message);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

export function deriveConcentrationKey(
  tokenId: TokenId,
  conditionId: ConditionId | string | null | undefined,
  policy: Pick<PositionConcentrationPolicy, "conditionKeyFallbackToToken">,
): ConcentrationKeyInfo | null {
  const token = String(tokenId);
  const condition = typeof conditionId === "string" ? conditionId.trim() : "";
  if (condition.length > 0) {
    return {
      concentrationKey: `condition:${condition}`,
      keyType: "condition",
      conditionId: condition,
      tokenId: token,
      fallbackReason: null,
    };
  }
  if (!policy.conditionKeyFallbackToToken) return null;
  return {
    concentrationKey: `token:${token}`,
    keyType: "token",
    conditionId: null,
    tokenId: token,
    fallbackReason: "fallback_condition_missing",
  };
}

function computeCaps(
  policy: PositionConcentrationPolicy,
  capBankroll: number,
  strongOverride: boolean,
): {
  grossCapUsdc: number;
  remainingCapUsdc: number;
  postHarvestRefillCapUsdc: number;
} {
  const normalGross = Math.max(policy.minGrossCapUsd, policy.grossPct * capBankroll);
  const exceptionalGross = Math.max(
    policy.minExceptionalGrossCapUsd,
    policy.exceptionalGrossPct * capBankroll,
  );
  return {
    grossCapUsdc: strongOverride ? exceptionalGross : normalGross,
    remainingCapUsdc: Math.max(policy.minRemainingCapUsd, policy.remainingPct * capBankroll),
    postHarvestRefillCapUsdc: Math.max(
      policy.minPostHarvestRefillCapUsd,
      policy.postHarvestRefillPct * capBankroll,
    ),
  };
}

function resolveLimitingReason(args: {
  grossHeadroom: number;
  remainingHeadroom: number;
  postHarvestRefillHeadroom: number | null;
  allowedHeadroom: number;
}): string {
  if (args.grossHeadroom <= args.allowedHeadroom + EPSILON_USDC) return "gross_cap";
  if (args.remainingHeadroom <= args.allowedHeadroom + EPSILON_USDC) return "remaining_cap";
  if (
    args.postHarvestRefillHeadroom != null &&
    args.postHarvestRefillHeadroom <= args.allowedHeadroom + EPSILON_USDC
  ) {
    return "post_harvest_refill_cap";
  }
  return "under_caps";
}

function finitePositive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteNonNegativeOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteNonNegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function bounded(value: string): string {
  if (value.trim().length === 0) return "unknown";
  return value.length <= 64 ? value : "other";
}
