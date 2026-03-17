import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok, ApiError } from "../errors.js";
import type { MarketMeta } from "../enrich-market.js";
import { buildMarketMetaMap, getMetaOrEmpty } from "../enrich-market.js";

interface OrderOpts {
  db: Database.Database;
}

function toDto(row: Record<string, unknown>, meta: MarketMeta) {
  return {
    orderId: row.order_id,
    clientOrderId: row.client_order_id,
    tokenId: row.token_id,
    familyId: row.family_id,
    side: row.side,
    orderType: row.order_type,
    price: row.price,
    size: row.size,
    sizeUsdc: row.size_usdc,
    status: row.status,
    exchangeOrderId: row.exchange_order_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    slug: meta.slug,
    question: meta.question,
    outcome: meta.outcome,
    conditionId: meta.conditionId,
  };
}

interface OrderQuery {
  status?: string;
  family_id?: string;
  limit?: string;
  cursor?: string;
}

export const orderRoutes: FastifyPluginAsync<OrderOpts> = async (app, opts) => {
  const getById = opts.db.prepare("SELECT * FROM orders WHERE order_id = ?");

  app.get<{ Querystring: OrderQuery }>("/orders", async (request) => {
    const { status, family_id, cursor } = request.query;
    const limit = Math.min(Number(request.query.limit) || 50, 200);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      const statuses = status.split(",").map((s) => s.trim());
      conditions.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }

    if (family_id) {
      conditions.push("family_id = ?");
      params.push(family_id);
    }

    if (cursor) {
      conditions.push("created_at < ?");
      params.push(cursor);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const rows = opts.db
      .prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];

    const nextCursor = rows.length === limit
      ? (rows[rows.length - 1]!.created_at as string)
      : null;

    const tokenIds = rows.map((r) => r.token_id as string);
    const metaMap = buildMarketMetaMap(opts.db, tokenIds);

    return ok({ items: rows.map((r) => toDto(r, getMetaOrEmpty(metaMap, r.token_id as string))), nextCursor });
  });

  app.get<{ Params: { orderId: string } }>("/orders/:orderId", async (request) => {
    const row = getById.get(request.params.orderId) as Record<string, unknown> | undefined;
    if (!row) throw new ApiError(404, `order ${request.params.orderId} not found`, "ORDER_NOT_FOUND");
    const metaMap = buildMarketMetaMap(opts.db, [row.token_id as string]);
    return ok(toDto(row, getMetaOrEmpty(metaMap, row.token_id as string)));
  });
};
