import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok, ApiError } from "../errors.js";
import type { MarketMeta } from "../enrich-market.js";
import { buildMarketMetaMap, getMetaOrEmpty } from "../enrich-market.js";

interface PositionOpts {
  db: Database.Database;
}

function toDto(row: Record<string, unknown>, meta: MarketMeta) {
  return {
    positionId: row.position_id,
    tokenId: row.token_id,
    familyId: row.family_id,
    side: row.side,
    size: row.size,
    avgEntryPrice: row.avg_entry_price,
    costBasisUsdc: row.cost_basis_usdc,
    currentValueUsdc: row.current_value_usdc,
    realizedPnl: row.realized_pnl,
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    updatedAt: row.updated_at,
    slug: meta.slug,
    question: meta.question,
    outcome: meta.outcome,
    conditionId: meta.conditionId,
  };
}

interface PositionQuery {
  family_id?: string;
  dust?: string;
  status?: string;
  sort?: string;
}

export const positionRoutes: FastifyPluginAsync<PositionOpts> = async (app, opts) => {
  const getById = opts.db.prepare("SELECT * FROM positions WHERE position_id = ?");

  app.get<{ Querystring: PositionQuery }>("/positions", async (request) => {
    const { family_id, dust, status, sort } = request.query;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (family_id) {
      conditions.push("family_id = ?");
      params.push(family_id);
    }

    if (dust === "true") {
      conditions.push("status = 'dust'");
    } else if (status) {
      const statuses = status.split(",").map((s) => s.trim());
      conditions.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    } else {
      // Default: show open and dust
      conditions.push("status IN ('open','dust')");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderBy = sort === "tail_cost" ? "ORDER BY cost_basis_usdc DESC" : "ORDER BY updated_at DESC";

    const rows = opts.db
      .prepare(`SELECT * FROM positions ${where} ${orderBy}`)
      .all(...params) as Record<string, unknown>[];

    const tokenIds = rows.map((r) => r.token_id as string);
    const metaMap = buildMarketMetaMap(opts.db, tokenIds);

    return ok(rows.map((r) => toDto(r, getMetaOrEmpty(metaMap, r.token_id as string))));
  });

  app.get<{ Params: { positionId: string } }>("/positions/:positionId", async (request) => {
    const row = getById.get(request.params.positionId) as Record<string, unknown> | undefined;
    if (!row) throw new ApiError(404, `position ${request.params.positionId} not found`, "POSITION_NOT_FOUND");
    const metaMap = buildMarketMetaMap(opts.db, [row.token_id as string]);
    return ok(toDto(row, getMetaOrEmpty(metaMap, row.token_id as string)));
  });
};
