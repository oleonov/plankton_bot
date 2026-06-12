import type { RuntimeModule, ExchangeGateway } from "@krabs/domain";
import { withImmediate } from "@krabs/db";
import type Database from "better-sqlite3";
import type { Logger } from "../../logger.js";
import { ValidationMetricsReader } from "./validation-metrics-reader.js";

export interface ProfileRuntimePublisherDeps {
  controlDb: Database.Database;
  ledgerDb: Database.Database;
  profile: string;
  getPaused: () => boolean;
  log: Logger;
  intervalMs?: number;
  exchangeGateway?: ExchangeGateway;
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
    // Phase 1: Read all data OUTSIDE the transaction (no contention)
    const profileMetrics = this.reader.readProfileMetrics();
    const balanceUsdc = this.computeBalance(profileMetrics.totalExposureUsdc);
    const paused = this.deps.getPaused();
    const lastPreflightStatus = this.readLastPreflightStatus();
    const walletBalanceUsdc = await this.fetchWalletBalance();

    // Phase 2: Write everything INSIDE a single immediate transaction
    withImmediate(this.deps.controlDb, (db) => {
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
    });

    this.writeEquitySnapshotIfDue(walletBalanceUsdc, balanceUsdc, profileMetrics);

    this.deps.log.debug({ profile: this.deps.profile }, "profile runtime summary published");
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
          "SELECT COALESCE(SUM(current_value_usdc), 0) as total FROM positions WHERE status IN ('open','dust')",
        )
        .get() as { total: number }
    ).total;
    const liquidationValue = (
      this.deps.ledgerDb
        .prepare(
          `SELECT COALESCE(SUM(COALESCE(liquidation_value_usdc, current_value_usdc)), 0) as total
             FROM positions WHERE status IN ('open','dust')`,
        )
        .get() as { total: number }
    ).total;
    const costBasis = (
      this.deps.ledgerDb
        .prepare(
          "SELECT COALESCE(SUM(cost_basis_usdc), 0) as total FROM positions WHERE status IN ('open','dust')",
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
    const liquidationEquity = isLiveLite
      ? walletBalanceUsdc! + liquidationValue
      : balanceUsdc! + liquidationValue;

    const realizedPnl = this.reader.readRealizedPnl();

    this.deps.ledgerDb
      .prepare(
        `INSERT INTO portfolio_snapshots
          (profile, equity_usdc, wallet_usdc, position_value_usdc,
           liquidation_value_usdc, unrealized_pnl_mid_usdc,
           unrealized_pnl_liquidation_usdc, total_equity_liquidation_usdc,
           realized_pnl_usdc, open_value_usdc, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.deps.profile,
        equity,
        walletBalanceUsdc ?? null,
        positionValue,
        liquidationValue,
        positionValue - costBasis,
        liquidationValue - costBasis,
        liquidationEquity,
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
}
