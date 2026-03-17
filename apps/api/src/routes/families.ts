import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok, ApiError } from "../errors.js";

interface FamilyOpts {
  db: Database.Database;
}

interface FamilyCatalogRow {
  family_id: string;
  family_key: string;
  primary_category: string;
  regime: string;
  horizon: string;
  cadence: string;
  strategy_profile: string;
  topic_key: string | null;
  slug_pattern: string | null;
  notes: string | null;
}

interface FamilyStateRow {
  family_id: string;
  runtime_mode: string;
  open_value_usdc: number;
  open_position_count: number;
  open_dust_count: number;
  active_market_count: number;
  current_tail_cost_usdc: number;
  tail_adjusted_pnl_live: number;
  last_entry_ts: string | null;
  last_exit_ts: string | null;
  quarantine_reason: string | null;
  updated_at: string;
}

function toFamilyDto(catalog: FamilyCatalogRow, state: FamilyStateRow | undefined) {
  return {
    familyId: catalog.family_id,
    familyKey: catalog.family_key,
    primaryCategory: catalog.primary_category,
    regime: catalog.regime,
    horizon: catalog.horizon,
    cadence: catalog.cadence,
    strategyProfile: catalog.strategy_profile,
    state: state
      ? {
          runtimeMode: state.runtime_mode,
          openValueUsdc: state.open_value_usdc,
          openPositionCount: state.open_position_count,
          openDustCount: state.open_dust_count,
          activeMarketCount: state.active_market_count,
          currentTailCostUsdc: state.current_tail_cost_usdc,
          tailAdjustedPnlLive: state.tail_adjusted_pnl_live,
          lastEntryTs: state.last_entry_ts,
          lastExitTs: state.last_exit_ts,
          quarantineReason: state.quarantine_reason,
          updatedAt: state.updated_at,
        }
      : null,
  };
}

export const familyRoutes: FastifyPluginAsync<FamilyOpts> = async (app, opts) => {
  const listCatalog = opts.db.prepare("SELECT * FROM family_catalog");
  const listState = opts.db.prepare("SELECT * FROM family_runtime_state");
  const getCatalog = opts.db.prepare("SELECT * FROM family_catalog WHERE family_id = ?");
  const getState = opts.db.prepare("SELECT * FROM family_runtime_state WHERE family_id = ?");
  const getPositions = opts.db.prepare(
    "SELECT * FROM positions WHERE family_id = ? ORDER BY updated_at DESC",
  );
  const getOrders = opts.db.prepare(
    "SELECT * FROM orders WHERE family_id = ? ORDER BY created_at DESC LIMIT 100",
  );

  app.get("/families", async () => {
    const catalogs = listCatalog.all() as FamilyCatalogRow[];
    const states = listState.all() as FamilyStateRow[];
    const stateMap = new Map(states.map((s) => [s.family_id, s]));
    return ok(catalogs.map((c) => toFamilyDto(c, stateMap.get(c.family_id))));
  });

  app.get<{ Params: { familyId: string } }>("/families/:familyId", async (request) => {
    const { familyId } = request.params;
    const catalog = getCatalog.get(familyId) as FamilyCatalogRow | undefined;
    if (!catalog) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");
    const state = getState.get(familyId) as FamilyStateRow | undefined;
    return ok(toFamilyDto(catalog, state));
  });

  app.get<{ Params: { familyId: string } }>("/families/:familyId/positions", async (request) => {
    const { familyId } = request.params;
    const catalog = getCatalog.get(familyId) as FamilyCatalogRow | undefined;
    if (!catalog) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");
    const rows = getPositions.all(familyId) as Record<string, unknown>[];
    return ok(rows.map(toPositionDto));
  });

  app.get<{ Params: { familyId: string } }>("/families/:familyId/orders", async (request) => {
    const { familyId } = request.params;
    const catalog = getCatalog.get(familyId) as FamilyCatalogRow | undefined;
    if (!catalog) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");
    const rows = getOrders.all(familyId) as Record<string, unknown>[];
    return ok(rows.map(toOrderDto));
  });
};

function toPositionDto(row: Record<string, unknown>) {
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
  };
}

function toOrderDto(row: Record<string, unknown>) {
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
  };
}
