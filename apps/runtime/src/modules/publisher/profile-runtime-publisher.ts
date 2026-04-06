import type {
  RuntimeModule,
  ValidationScorecard,
  ProfileId,
  ExchangeGateway,
} from "@plankton/domain";
import {
  createScorecardId,
  createFamilyId,
  computeRecycleScore,
  computeToxicityPenalty,
  evaluateExecutionCanaryGate,
} from "@plankton/domain";
import {
  readFamilyLiveness,
  SqliteValidationScorecardRepository,
  withImmediate,
} from "@plankton/db";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Logger } from "../../logger.js";
import { ValidationMetricsReader } from "./validation-metrics-reader.js";

export interface ProfileRuntimePublisherDeps {
  controlDb: Database.Database;
  ledgerDb: Database.Database;
  profile: string;
  deployedFamilyIds: () => string[];
  getPaused: () => boolean;
  log: Logger;
  intervalMs?: number;
  exchangeGateway?: ExchangeGateway;
  setLiveActiveFamilyAllowlist?: (familyIds: string[] | null) => void;
}

export class ProfileRuntimePublisher implements RuntimeModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotAt: number | null = null;
  private readonly reader: ValidationMetricsReader;
  private readonly deps: ProfileRuntimePublisherDeps & { intervalMs: number };

  constructor(deps: ProfileRuntimePublisherDeps) {
    this.deps = { intervalMs: 60_000, ...deps };
    this.reader = new ValidationMetricsReader(deps.ledgerDb);
  }

  async start(): Promise<void> {
    await this.publish();
    this.timer = setInterval(() => {
      this.publish().catch(() => {});
    }, this.deps.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return { ok: true };
  }

  async publish(): Promise<void> {
    const familyIds = this.deps.deployedFamilyIds();
    const familyLiveness = readFamilyLiveness(this.deps.ledgerDb, familyIds);
    const activeFamilyIds = familyIds.filter(
      (familyId) => familyLiveness.get(familyId)?.liveness === "active",
    );

    this.deps.setLiveActiveFamilyAllowlist?.(activeFamilyIds.length > 0 ? activeFamilyIds : null);

    // Phase 1: Read all data OUTSIDE the transaction (no contention)
    const familyMetrics = this.reader.readFamilyMetrics(familyIds);
    const profileMetrics = this.reader.readProfileMetrics();
    const balanceUsdc = this.computeBalance(profileMetrics.totalExposureUsdc);
    const paused = this.deps.getPaused();
    const lastPreflightStatus = this.readLastPreflightStatus();
    const walletBalanceUsdc = await this.fetchWalletBalance();
    const scorecards = this.buildScorecards(familyIds);

    // Phase 2: Write everything INSIDE a single immediate transaction
    withImmediate(this.deps.controlDb, (db) => {
      const upsertRollup = db.prepare(`
        INSERT INTO family_profile_rollups
          (family_id, profile, open_value_usdc, open_positions, active_markets,
           realized_pnl, tail_cost_usdc, tail_adjusted_pnl, effective_mode, last_trade_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(family_id, profile) DO UPDATE SET
          open_value_usdc   = excluded.open_value_usdc,
          open_positions    = excluded.open_positions,
          active_markets    = excluded.active_markets,
          realized_pnl      = excluded.realized_pnl,
          tail_cost_usdc    = excluded.tail_cost_usdc,
          tail_adjusted_pnl = excluded.tail_adjusted_pnl,
          effective_mode    = excluded.effective_mode,
          last_trade_at     = excluded.last_trade_at,
          updated_at        = excluded.updated_at
      `);

      for (const fm of familyMetrics) {
        upsertRollup.run(
          fm.familyId,
          this.deps.profile,
          fm.openValueUsdc,
          fm.openPositions,
          fm.activeMarkets,
          fm.realizedPnl,
          fm.tailCostUsdc,
          fm.tailAdjustedPnl,
          fm.effectiveMode,
          fm.lastTradeAt,
        );
      }

      db.prepare(
        `INSERT INTO profile_summaries
           (profile_id, paused, last_run_at, open_orders, open_positions,
            total_exposure_usdc, balance_usdc, wallet_balance_usdc, last_preflight_status, updated_at)
         VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(profile_id) DO UPDATE SET
           paused               = excluded.paused,
           last_run_at          = excluded.last_run_at,
           open_orders          = excluded.open_orders,
           open_positions       = excluded.open_positions,
           total_exposure_usdc  = excluded.total_exposure_usdc,
           balance_usdc         = excluded.balance_usdc,
           wallet_balance_usdc  = COALESCE(excluded.wallet_balance_usdc, profile_summaries.wallet_balance_usdc),
           last_preflight_status = excluded.last_preflight_status,
           updated_at           = excluded.updated_at`,
      ).run(
        this.deps.profile,
        paused ? 1 : 0,
        profileMetrics.openOrders,
        profileMetrics.openPositions,
        profileMetrics.totalExposureUsdc,
        balanceUsdc,
        walletBalanceUsdc,
        lastPreflightStatus,
      );

      const txScorecardRepo = new SqliteValidationScorecardRepository(db);
      for (const scorecard of scorecards) {
        try {
          txScorecardRepo.save(scorecard);
        } catch (err: unknown) {
          // (family_id, profile, validated_at) UNIQUE constraint can fire when
          // two publish cycles land within the same millisecond — safe to skip
          const msg = err instanceof Error ? err.message : "";
          if (!msg.includes("UNIQUE constraint failed")) throw err;
        }
      }
    });

    this.writeEquitySnapshotIfDue(walletBalanceUsdc, balanceUsdc, profileMetrics);

    this.deps.log.debug(
      {
        families: familyMetrics.length,
        profile: this.deps.profile,
        activeFamilies: activeFamilyIds.length,
      },
      "profile runtime rollups published",
    );
  }

  private computeBalance(totalExposureUsdc: number): number | null {
    const settingsRow = this.deps.controlDb
      .prepare("SELECT initial_balance_usdc FROM profile_settings WHERE profile_id = ?")
      .get(this.deps.profile) as { initial_balance_usdc: number | null } | undefined;
    const initialBalance = settingsRow?.initial_balance_usdc;
    if (initialBalance == null) return null;
    const realizedPnl = this.reader.readRealizedPnl();
    return initialBalance - totalExposureUsdc + realizedPnl;
  }

  private readLastPreflightStatus(): string | null {
    const row = this.deps.controlDb
      .prepare(
        "SELECT status FROM preflight_reports WHERE profile = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(this.deps.profile) as { status: string } | undefined;
    return row?.status ?? null;
  }

  private async fetchWalletBalance(): Promise<number | null> {
    if (!this.deps.exchangeGateway) return null;
    try {
      const balances = await this.deps.exchangeGateway.getBalances();
      return balances[0]?.available ?? null;
    } catch (err) {
      this.deps.log.warn({ err }, "failed to fetch wallet balance — keeping last known");
      return null;
    }
  }

  private writeEquitySnapshotIfDue(
    walletBalanceUsdc: number | null,
    balanceUsdc: number | null,
    profileMetrics: { totalExposureUsdc: number },
  ): void {
    const now = Date.now();
    if (this.lastSnapshotAt && now - this.lastSnapshotAt < 5 * 60_000) return;

    // Mark-to-market position value (NOT cost basis)
    const positionValue = (
      this.deps.ledgerDb
        .prepare(
          "SELECT COALESCE(SUM(current_value_usdc), 0) as total FROM positions WHERE status = 'open'",
        )
        .get() as { total: number }
    ).total;

    const isLiveLite = this.deps.profile === "live-lite";

    if (isLiveLite && walletBalanceUsdc == null) {
      this.deps.log.debug("skipping equity snapshot — wallet balance unavailable");
      return;
    }
    if (!isLiveLite && balanceUsdc == null) {
      this.deps.log.debug("skipping equity snapshot — balance unavailable");
      return;
    }

    const equity = isLiveLite ? walletBalanceUsdc! + positionValue : balanceUsdc! + positionValue;

    const realizedPnl = this.reader.readRealizedPnl();

    this.deps.ledgerDb
      .prepare(
        `INSERT INTO portfolio_snapshots
          (profile, equity_usdc, wallet_usdc, position_value_usdc,
           realized_pnl_usdc, open_value_usdc, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.deps.profile,
        equity,
        walletBalanceUsdc ?? null,
        positionValue,
        realizedPnl,
        profileMetrics.totalExposureUsdc,
        new Date().toISOString(),
      );
    this.lastSnapshotAt = now;

    // Prune old snapshots
    this.deps.ledgerDb
      .prepare("DELETE FROM portfolio_snapshots WHERE captured_at < datetime('now', '-90 days')")
      .run();
  }

  private buildScorecards(familyIds: string[]): ValidationScorecard[] {
    const profile = this.deps.profile as ProfileId;
    const familyPolicyStmt = this.deps.controlDb.prepare(
      `SELECT primary_category, fee_tier, live_wallet_requirement, requires_post_only_for_live
       FROM family_catalog
       WHERE family_id = ?`,
    );

    return familyIds.map((fid) => {
      const trade = this.reader.readTradeMetrics(fid);
      const executionTelemetry = this.reader.readExecutionTelemetry(fid);
      const toxMetrics = this.reader.readToxicityMetrics(fid);
      const familyPolicy = familyPolicyStmt.get(fid) as
        | {
            primary_category: string;
            fee_tier: string | null;
            live_wallet_requirement: string | null;
            requires_post_only_for_live: number | null;
          }
        | undefined;

      const recycleScore = computeRecycleScore({
        tradeCount: trade.tradeCount,
        distinctMarkets: trade.distinctMarkets,
        tailAdjustedPnl: trade.tailAdjustedPnl,
        repricingExits: trade.repricingExits,
        totalNonSettlementClosed: trade.totalNonSettlementClosed,
      });

      const toxicityPenalty = computeToxicityPenalty({
        dustCount: toxMetrics.dustCount,
        positionCount: toxMetrics.positionCount,
        tailCostUsdc: toxMetrics.tailCostUsdc,
        realizedPnlUsdc: toxMetrics.realizedPnlUsdc,
        reduceOnlyCount: toxMetrics.reduceOnlyCount,
        weeksDeployed: 0, // family_catalog not in ledger DB; acceptable approximation
        staleCount: toxMetrics.staleCount,
        totalOpen: toxMetrics.totalOpen,
      });

      const evidenceScore = Math.max(0, recycleScore - toxicityPenalty);
      const executionCanary = evaluateExecutionCanaryGate({
        primaryCategory: familyPolicy?.primary_category ?? "other",
        feeTier:
          (familyPolicy?.fee_tier as import("@plankton/domain").FeeTier | null | undefined) ?? null,
        liveWalletRequirement:
          (familyPolicy?.live_wallet_requirement as
            | import("@plankton/domain").LiveWalletRequirement
            | null
            | undefined) ?? null,
        requiresPostOnlyForLive:
          familyPolicy?.requires_post_only_for_live == null
            ? null
            : familyPolicy.requires_post_only_for_live === 1,
        executionTelemetry,
      });
      return {
        scorecardId: createScorecardId(`sc-${randomUUID()}`),
        familyId: createFamilyId(fid),
        profile,
        evidenceStatus: trade.tradeCount > 0 ? "partial" : "unknown",
        evidenceScore,
        recurrenceScore: null,
        recycleScore,
        liveViabilityScore: null,
        toxicityPenalty,
        tradeCount: trade.tradeCount,
        marketCount: trade.distinctMarkets,
        realizedPnl: trade.realizedPnl,
        tailAdjustedPnl: trade.tailAdjustedPnl,
        bothSidedEligible: false,
        heavyCampaignEligible: false,
        activeWindowEdgeScore: null,
        summaryJson: JSON.stringify({
          repricingExits: trade.repricingExits,
          executionTelemetry24h: executionTelemetry,
          executionCanary24h: executionCanary,
        }),
        validatedAt: new Date().toISOString(),
      } satisfies ValidationScorecard;
    });
  }
}
