import type Database from "better-sqlite3";
import { resolveTradingState } from "@krabs/domain";
import { ledgerInstant } from "@krabs/db";
import { normalizeReasonCode } from "./risk-event-codes.js";

const MIN_WINDOW_MS = 10 * 60 * 1000;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

interface ActivityCounts {
  produced: number;
  approved: number;
  rejected: number;
  entryApproved: number;
  exitApproved: number;
  ordersAccepted: number;
  orderNotionalUsdc: number;
  fillsReceived: number;
  fillNotionalUsdc: number;
  rejectionReasons: Map<string, number>;
}

function emptyCounts(): ActivityCounts {
  return {
    produced: 0,
    approved: 0,
    rejected: 0,
    entryApproved: 0,
    exitApproved: 0,
    ordersAccepted: 0,
    orderNotionalUsdc: 0,
    fillsReceived: 0,
    fillNotionalUsdc: 0,
    rejectionReasons: new Map(),
  };
}

function positiveFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function sortedReasons(reasons: ReadonlyMap<string, number>): string {
  return JSON.stringify(Object.fromEntries([...reasons].sort(([a], [b]) => a.localeCompare(b))));
}

export class SignalActivityWindow {
  private counts = emptyCounts();
  private startedAtMs: number;
  private readonly insert: Database.Statement;
  private readonly prune: Database.Statement;

  constructor(db: Database.Database, startedAtMs = Date.now()) {
    this.startedAtMs = startedAtMs;
    this.insert = db.prepare(`
      INSERT INTO trading_state_snapshots
        (trading_state, signals_produced, signals_approved, signals_rejected, captured_at,
         window_version, window_started_at, window_ended_at, orders_accepted,
         order_notional_usdc, fills_received, fill_notional_usdc, rejection_reasons_json)
      VALUES (?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.prune = db.prepare(
      `DELETE FROM trading_state_snapshots
        WHERE ${ledgerInstant("captured_at")} < ${ledgerInstant("?")}`,
    );
  }

  recordSignalProduced(): void {
    this.counts.produced++;
  }

  recordSignalApproved(entry: boolean): void {
    this.counts.approved++;
    if (entry) this.counts.entryApproved++;
    else this.counts.exitApproved++;
  }

  recordSignalRejected(reason: string): void {
    this.counts.rejected++;
    const key = normalizeReasonCode(reason);
    this.counts.rejectionReasons.set(key, (this.counts.rejectionReasons.get(key) ?? 0) + 1);
  }

  recordOrderPlaced(price: number, size: number): void {
    this.counts.ordersAccepted++;
    this.counts.orderNotionalUsdc += positiveFinite(price * size);
  }

  recordFill(sizeUsdc: number): void {
    this.counts.fillsReceived++;
    this.counts.fillNotionalUsdc += positiveFinite(sizeUsdc);
  }

  getStartedAtMs(): number {
    return this.startedAtMs;
  }

  closeIfDue(nowMs: number, paused: boolean): boolean {
    if (nowMs - this.startedAtMs < MIN_WINDOW_MS) return false;
    const startedAt = new Date(this.startedAtMs).toISOString();
    const endedAt = new Date(nowMs).toISOString();
    const state = resolveTradingState({ paused, signalWindow: this.counts });
    this.insert.run(
      state,
      this.counts.produced,
      this.counts.approved,
      this.counts.rejected,
      endedAt,
      startedAt,
      endedAt,
      this.counts.ordersAccepted,
      this.counts.orderNotionalUsdc,
      this.counts.fillsReceived,
      this.counts.fillNotionalUsdc,
      sortedReasons(this.counts.rejectionReasons),
    );
    this.startedAtMs = nowMs;
    this.counts = emptyCounts();
    this.prune.run(new Date(nowMs - RETENTION_MS).toISOString());
    return true;
  }
}
