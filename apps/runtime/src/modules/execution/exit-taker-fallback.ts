import type Database from "better-sqlite3";
import type {
  ExitTakerFallbackPolicy,
  NormalizedMarket,
  PlaceOrderCommand,
  Position,
} from "@krabs/domain";
import { getProfitThresholdByPrice } from "@krabs/domain";

const ATTEMPT_WINDOW_MS = 24 * 60 * 60_000;

export const EXIT_TAKER_FALLBACK_METADATA_KEY = "exitTakerFallback";

export interface ExitTakerFallbackLogRecord {
  ts: number;
  positionId: string;
  tokenId: string;
  profitRatio: number;
  qty: number;
  bestBid: number;
  result: "placed" | "filled" | "failed";
  failureReason?: string | null;
}

export interface ExitTakerFallbackLogRepository {
  countAttempts(positionId: string, sinceTs: number): number;
  insert(record: ExitTakerFallbackLogRecord): void;
}

export interface ExitTakerFallbackMetadata {
  positionId: string;
  profitRatio: number;
  normalD8Threshold: number;
  requiredProfitRatio: number;
  bestBid: number;
  qty: number;
  detectedAt: string;
}

export type ExitTakerFallbackDecision =
  | {
      fire: true;
      positionId: string;
      profitRatio: number;
      normalD8Threshold: number;
      requiredProfitRatio: number;
      bestBid: number;
      qty: number;
      attemptsLast24h: number;
    }
  | {
      fire: false;
      reason:
        | "policy-disabled"
        | "not-live-lite"
        | "not-chain-capped"
        | "missing-position"
        | "invalid-position-size"
        | "invalid-best-bid"
        | "invalid-profit-ratio"
        | "ratio-below-threshold"
        | "attempt-limit";
      positionId: string | null;
      profitRatio: number | null;
      bestBid: number;
      qty: number;
      attemptsLast24h: number;
    };

export interface ExitTakerFallbackContext {
  policy: ExitTakerFallbackPolicy;
  runtimeMode: "simulation" | "paper" | "live-lite" | undefined;
  position: Position | null | undefined;
  market: NormalizedMarket | null | undefined;
  chainCapped: boolean;
  attemptsLast24h: number;
}

export class SqliteExitTakerFallbackLogRepository implements ExitTakerFallbackLogRepository {
  private lastTs = 0;
  private readonly insertStmt;
  private readonly countStmt;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO exit_taker_fallback_log
        (ts, position_id, token_id, profit_ratio, qty, best_bid, result, failure_reason)
      VALUES
        (@ts, @positionId, @tokenId, @profitRatio, @qty, @bestBid, @result, @failureReason)
    `);
    this.countStmt = db.prepare(`
      SELECT COUNT(*) AS count
       FROM exit_taker_fallback_log
       WHERE position_id = ?
         AND ts >= ?
         AND result = 'placed'
    `);
  }

  countAttempts(positionId: string, sinceTs: number): number {
    const row = this.countStmt.get(positionId, sinceTs) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  insert(record: ExitTakerFallbackLogRecord): void {
    this.insertStmt.run({
      ...record,
      ts: this.nextTs(record.ts),
      failureReason: record.failureReason ?? null,
    });
  }

  private nextTs(ts: number): number {
    const normalized = Number.isFinite(ts) ? Math.max(0, Math.trunc(ts)) : Date.now();
    const next = Math.max(normalized, this.lastTs + 1);
    this.lastTs = next;
    return next;
  }
}

export function exitTakerFallbackAttemptSince(nowMs: number): number {
  return nowMs - ATTEMPT_WINDOW_MS;
}

export function shouldFireTakerFallback(ctx: ExitTakerFallbackContext): ExitTakerFallbackDecision {
  const positionId = ctx.position ? String(ctx.position.positionId) : null;
  const bestBid = ctx.market?.bestBid ?? 0;
  const qty = ctx.position?.size ?? 0;

  if (!ctx.policy.enabled) {
    return skipped("policy-disabled", positionId, null, bestBid, qty, ctx.attemptsLast24h);
  }
  if (ctx.runtimeMode !== "live-lite") {
    return skipped("not-live-lite", positionId, null, bestBid, qty, ctx.attemptsLast24h);
  }
  if (ctx.policy.requireChainCapped && !ctx.chainCapped) {
    return skipped("not-chain-capped", positionId, null, bestBid, qty, ctx.attemptsLast24h);
  }
  if (!ctx.position || ctx.position.status === "closed") {
    return skipped("missing-position", positionId, null, bestBid, qty, ctx.attemptsLast24h);
  }
  if (!Number.isFinite(ctx.position.size) || ctx.position.size <= 0) {
    return skipped("invalid-position-size", positionId, null, bestBid, qty, ctx.attemptsLast24h);
  }
  if (!Number.isFinite(bestBid) || bestBid <= 0 || bestBid > 1) {
    return skipped("invalid-best-bid", positionId, null, 0, qty, ctx.attemptsLast24h);
  }
  if (!Number.isFinite(ctx.position.avgEntryPrice) || ctx.position.avgEntryPrice <= 0) {
    return skipped("invalid-profit-ratio", positionId, null, bestBid, qty, ctx.attemptsLast24h);
  }
  if (ctx.attemptsLast24h >= ctx.policy.maxAttemptsPer24h) {
    return skipped("attempt-limit", positionId, null, bestBid, qty, ctx.attemptsLast24h);
  }

  const normalD8Threshold = getProfitThresholdByPrice(ctx.position.avgEntryPrice);
  const requiredProfitRatio = ctx.policy.profitRatioMultiplier * normalD8Threshold;
  const profitRatio = bestBid / ctx.position.avgEntryPrice;
  if (!Number.isFinite(profitRatio) || profitRatio < 0) {
    return skipped("invalid-profit-ratio", positionId, null, bestBid, qty, ctx.attemptsLast24h);
  }
  if (profitRatio < requiredProfitRatio) {
    return skipped(
      "ratio-below-threshold",
      positionId,
      profitRatio,
      bestBid,
      qty,
      ctx.attemptsLast24h,
    );
  }

  return {
    fire: true,
    positionId: String(ctx.position.positionId),
    profitRatio,
    normalD8Threshold,
    requiredProfitRatio,
    bestBid,
    qty: ctx.position.size,
    attemptsLast24h: ctx.attemptsLast24h,
  };
}

export function buildExitTakerFallbackCommand(
  cmd: PlaceOrderCommand,
  decision: Extract<ExitTakerFallbackDecision, { fire: true }>,
  nowMs: number,
): PlaceOrderCommand {
  const metadata: ExitTakerFallbackMetadata = {
    positionId: decision.positionId,
    profitRatio: decision.profitRatio,
    normalD8Threshold: decision.normalD8Threshold,
    requiredProfitRatio: decision.requiredProfitRatio,
    bestBid: decision.bestBid,
    qty: decision.qty,
    detectedAt: new Date(nowMs).toISOString(),
  };
  return {
    ...cmd,
    price: decision.bestBid,
    size: decision.qty,
    postOnly: false,
    metadata: {
      ...(cmd.metadata ?? {}),
      [EXIT_TAKER_FALLBACK_METADATA_KEY]: metadata,
    },
  };
}

export function readExitTakerFallbackMetadata(
  cmd: PlaceOrderCommand,
): ExitTakerFallbackMetadata | null {
  const raw = cmd.metadata?.[EXIT_TAKER_FALLBACK_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.positionId !== "string") return null;
  if (!isPositiveFinite(obj.profitRatio)) return null;
  if (!isPositiveFinite(obj.bestBid)) return null;
  if (!isPositiveFinite(obj.qty)) return null;
  if (!isPositiveFinite(obj.normalD8Threshold)) return null;
  if (!isPositiveFinite(obj.requiredProfitRatio)) return null;
  if (typeof obj.detectedAt !== "string") return null;
  return {
    positionId: obj.positionId,
    profitRatio: obj.profitRatio,
    normalD8Threshold: obj.normalD8Threshold,
    requiredProfitRatio: obj.requiredProfitRatio,
    bestBid: obj.bestBid,
    qty: obj.qty,
    detectedAt: obj.detectedAt,
  };
}

function skipped(
  reason: Extract<ExitTakerFallbackDecision, { fire: false }>["reason"],
  positionId: string | null,
  profitRatio: number | null,
  bestBid: number,
  qty: number,
  attemptsLast24h: number,
): ExitTakerFallbackDecision {
  return {
    fire: false,
    reason,
    positionId,
    profitRatio,
    bestBid: Number.isFinite(bestBid) && bestBid > 0 ? bestBid : 0,
    qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
    attemptsLast24h,
  };
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
