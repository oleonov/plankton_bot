import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok } from "../errors.js";
import type { MarketMeta } from "../enrich-market.js";
import { buildMarketMetaMap, getMetaOrEmpty } from "../enrich-market.js";

interface FillOpts {
  db: Database.Database;
}

export function toDto(row: Record<string, unknown>, meta: MarketMeta) {
  return {
    fillId: row.fill_id,
    orderId: row.order_id,
    tokenId: row.token_id,
    familyId: row.family_id,
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
  family_id?: string;
  limit?: string;
  cursor?: string;
  since?: string;
}

export const fillRoutes: FastifyPluginAsync<FillOpts> = async (app, opts) => {
  app.get<{ Querystring: FillQuery }>("/fills", async (request) => {
    const { family_id, cursor, since } = request.query;
    const limit = Math.min(Number(request.query.limit) || 50, 200);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (family_id) {
      conditions.push("family_id = ?");
      params.push(family_id);
    }

    if (since) {
      conditions.push("filled_at >= ?");
      params.push(since);
    }

    if (cursor) {
      conditions.push("filled_at < ?");
      params.push(cursor);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const rows = opts.db
      .prepare(`SELECT * FROM fills ${where} ORDER BY filled_at DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];

    const nextCursor = rows.length === limit ? (rows[rows.length - 1]!.filled_at as string) : null;

    const tokenIds = rows.map((r) => r.token_id as string);
    const metaMap = buildMarketMetaMap(opts.db, tokenIds);

    return ok({
      items: rows.map((r) => toDto(r, getMetaOrEmpty(metaMap, r.token_id as string))),
      nextCursor,
    });
  });
};
