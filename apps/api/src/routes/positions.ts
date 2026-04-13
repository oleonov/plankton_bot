import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import type { LedgerPool } from "../ledger-pool.js";
import { ok, ApiError } from "../errors.js";
import type { MarketMeta } from "../enrich-market.js";
import { buildMarketMetaMap, getMetaOrEmpty, buildResolutionMap } from "../enrich-market.js";
import type { ResolutionInfo } from "../enrich-market.js";
import { resolveActiveLedger } from "./status.js";

interface PositionOpts {
  db: Database.Database;
  controlDb?: Database.Database;
  ledgerPool?: LedgerPool;
}

export function toDto(row: Record<string, unknown>, meta: MarketMeta, resInfo?: ResolutionInfo) {
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
    eventSlug: meta.eventSlug,
    question: meta.question,
    outcome: meta.outcome,
    conditionId: meta.conditionId,
    endDate: meta.endDate,
    resolution: resInfo?.resolution ?? null,
    resolutionStatus: resInfo?.resolutionStatus ?? null,
  };
}

interface PositionQuery {
  family_id?: string;
  dust?: string;
  status?: string;
  sort?: string;
  limit?: string;
  cursor?: string;
  page?: string;
}

export const positionRoutes: FastifyPluginAsync<PositionOpts> = async (app, opts) => {
  app.get<{ Querystring: PositionQuery }>("/positions", async (request) => {
    const { db } = resolveActiveLedger(opts.db, opts.controlDb, opts.ledgerPool);
    const { family_id, dust, status, sort, cursor } = request.query;
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
    const page = Math.max(Number(request.query.page) || 1, 1);
    const pageRequested = request.query.page != null;

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
    }
    // No default filter — return all statuses when not specified

    const isTailCostSort = sort === "tail_cost";
    // Keep the default order stable for human browsing. `updated_at` changes
    // on mark-to-market refreshes and fills, which makes rows jump under live SSE.
    const sortCol = isTailCostSort ? "cost_basis_usdc" : "opened_at";
    const orderBy = isTailCostSort
      ? "ORDER BY cost_basis_usdc DESC, position_id DESC"
      : "ORDER BY opened_at DESC, position_id DESC";

    // Compound cursor: "sortValue::positionId" — handles ties
    if (!pageRequested && cursor) {
      const sep = cursor.indexOf("::");
      if (sep > 0) {
        const cursorVal = cursor.slice(0, sep);
        const cursorId = cursor.slice(sep + 2);
        conditions.push(`(${sortCol} < ? OR (${sortCol} = ? AND position_id < ?))`);
        params.push(cursorVal, cursorVal, cursorId);
      } else {
        // Legacy single-value cursor fallback
        conditions.push(`${sortCol} < ?`);
        params.push(cursor);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count without cursor/page filter
    const countConds: string[] = [];
    const countPrms: unknown[] = [];
    if (family_id) {
      countConds.push("family_id = ?");
      countPrms.push(family_id);
    }
    if (dust === "true") {
      countConds.push("status = 'dust'");
    } else if (status) {
      const statuses = status.split(",").map((s) => s.trim());
      countConds.push(`status IN (${statuses.map(() => "?").join(",")})`);
      countPrms.push(...statuses);
    }
    const cw = countConds.length > 0 ? `WHERE ${countConds.join(" AND ")}` : "";
    const totalCount = (
      db.prepare(`SELECT COUNT(*) as cnt FROM positions ${cw}`).get(...countPrms) as {
        cnt: number;
      }
    ).cnt;

    const offset = pageRequested ? (page - 1) * limit : 0;
    const queryParams = [...params, limit];
    const offsetClause = pageRequested ? " OFFSET ?" : "";
    if (pageRequested) queryParams.push(offset);

    const rows = db
      .prepare(`SELECT * FROM positions ${where} ${orderBy} LIMIT ?${offsetClause}`)
      .all(...queryParams) as Record<string, unknown>[];

    const tokenIds = rows.map((r) => r.token_id as string);
    const metaMap = buildMarketMetaMap(db, tokenIds);
    const conditionIds = [...metaMap.values()]
      .map((m) => m.conditionId)
      .filter(Boolean) as string[];
    const resMap = buildResolutionMap(opts.db, conditionIds);

    const lastRow = rows[rows.length - 1];
    const nextCursor =
      !pageRequested && rows.length === limit && lastRow
        ? `${String(lastRow[sortCol])}::${String(lastRow.position_id)}`
        : null;

    return ok({
      items: rows.map((r) => {
        const meta = getMetaOrEmpty(metaMap, r.token_id as string);
        const res = meta.conditionId ? resMap.get(meta.conditionId) : undefined;
        return toDto(r, meta, res);
      }),
      nextCursor,
      totalCount,
      page: pageRequested ? page : undefined,
      pageSize: pageRequested ? limit : undefined,
      totalPages: pageRequested ? Math.max(1, Math.ceil(totalCount / limit)) : undefined,
    });
  });

  app.get<{ Params: { positionId: string } }>("/positions/:positionId", async (request) => {
    const { db } = resolveActiveLedger(opts.db, opts.controlDb, opts.ledgerPool);
    const getById = db.prepare("SELECT * FROM positions WHERE position_id = ?");
    const row = getById.get(request.params.positionId) as Record<string, unknown> | undefined;
    if (!row)
      throw new ApiError(
        404,
        `position ${request.params.positionId} not found`,
        "POSITION_NOT_FOUND",
      );
    const metaMap = buildMarketMetaMap(db, [row.token_id as string]);
    const meta = getMetaOrEmpty(metaMap, row.token_id as string);
    const conditionIds = meta.conditionId ? [meta.conditionId] : [];
    const resMap = buildResolutionMap(db, conditionIds);
    const resInfo = meta.conditionId ? resMap.get(meta.conditionId) : undefined;
    return ok(toDto(row, meta, resInfo));
  });
};
