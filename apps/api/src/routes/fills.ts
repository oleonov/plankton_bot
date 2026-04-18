import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import type { LedgerPool } from "../ledger-pool.js";
import { ok } from "../errors.js";
import type { MarketMeta } from "../enrich-market.js";
import { buildMarketMetaMap, getMetaOrEmpty } from "../enrich-market.js";
import { resolveActiveLedger } from "./status.js";

interface FillOpts {
  db: Database.Database;
  controlDb?: Database.Database;
  ledgerPool?: LedgerPool;
}

export function toDto(row: Record<string, unknown>, meta: MarketMeta) {
  return {
    fillId: row.fill_id,
    orderId: row.order_id,
    tokenId: row.token_id,
    side: row.side,
    price: row.price,
    size: row.size,
    sizeUsdc: row.size_usdc,
    liquidityRole: row.liquidity_role,
    explicitFeeUsdc: row.fee,
    fee: row.fee,
    filledAt: row.filled_at,
    slug: meta.slug,
    eventSlug: meta.eventSlug,
    question: meta.question,
    outcome: meta.outcome,
    conditionId: meta.conditionId,
    endDate: meta.endDate,
  };
}

interface FillQuery {
  limit?: string;
  cursor?: string;
  since?: string;
  page?: string;
}

export const fillRoutes: FastifyPluginAsync<FillOpts> = async (app, opts) => {
  app.get<{ Querystring: FillQuery }>("/fills", async (request) => {
    const { db } = resolveActiveLedger(opts.db, opts.controlDb, opts.ledgerPool);
    const { cursor, since } = request.query;
    const limit = Math.min(Number(request.query.limit) || 50, 200);
    const page = Math.max(Number(request.query.page) || 1, 1);
    const pageRequested = request.query.page != null;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (since) {
      conditions.push("filled_at >= ?");
      params.push(since);
    }

    if (!pageRequested && cursor) {
      conditions.push("filled_at < ?");
      params.push(cursor);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM fills ${where}`).get(...params) as {
      cnt: number;
    };
    const totalCount = countRow.cnt;

    const offset = pageRequested ? (page - 1) * limit : 0;
    const queryParams = [...params, limit];
    const offsetClause = pageRequested ? " OFFSET ?" : "";
    if (pageRequested) queryParams.push(offset);

    const rows = db
      .prepare(`SELECT * FROM fills ${where} ORDER BY filled_at DESC LIMIT ?${offsetClause}`)
      .all(...queryParams) as Record<string, unknown>[];

    const nextCursor =
      !pageRequested && rows.length === limit ? (rows[rows.length - 1]!.filled_at as string) : null;

    const tokenIds = rows.map((r) => r.token_id as string);
    const metaMap = buildMarketMetaMap(db, tokenIds);

    return ok({
      items: rows.map((r) => toDto(r, getMetaOrEmpty(metaMap, r.token_id as string))),
      nextCursor,
      totalCount,
      page: pageRequested ? page : undefined,
      pageSize: pageRequested ? limit : undefined,
      totalPages: pageRequested ? Math.max(1, Math.ceil(totalCount / limit)) : undefined,
    });
  });
};
