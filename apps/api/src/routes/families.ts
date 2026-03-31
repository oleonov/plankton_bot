import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { getPromotionBlockers } from "@plankton/domain";
import { ok, ApiError } from "../errors.js";
import { getActor } from "../auth.js";

interface FamilyOpts {
  controlDb: Database.Database;
  ledgerDb: Database.Database;
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
  effective_mode: string | null;
  derived_mode_reason: string | null;
  updated_at: string;
}

interface FamilyCaps {
  maxOpenValueUsdc: number;
  maxActiveMarkets: number;
  maxDustPositions: number;
}

function toFamilyDto(
  catalog: FamilyCatalogRow,
  state: FamilyStateRow | undefined,
  caps: FamilyCaps | null,
  promotionState?: string | null,
  probeSubstate?: string | null,
) {
  return {
    familyId: catalog.family_id,
    familyKey: catalog.family_key,
    primaryCategory: catalog.primary_category,
    regime: catalog.regime,
    horizon: catalog.horizon,
    cadence: catalog.cadence,
    strategyProfile: catalog.strategy_profile,
    promotionState: promotionState ?? null,
    probeSubstate: probeSubstate ?? null,
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
          effectiveMode: state.effective_mode,
          derivedModeReason: state.derived_mode_reason,
          updatedAt: state.updated_at,
        }
      : null,
    caps,
  };
}

export const familyRoutes: FastifyPluginAsync<FamilyOpts> = async (app, opts) => {
  const { controlDb, ledgerDb } = opts;

  // Control DB: catalog, rules, evidence
  const listCatalog = controlDb.prepare("SELECT * FROM family_catalog");
  const listCaps = controlDb.prepare(
    "SELECT family_id, max_open_value_usdc, max_active_markets, max_dust_positions FROM family_rules",
  );
  const getCatalog = controlDb.prepare("SELECT * FROM family_catalog WHERE family_id = ?");
  const getCaps = controlDb.prepare(
    "SELECT family_id, max_open_value_usdc, max_active_markets, max_dust_positions FROM family_rules WHERE family_id = ?",
  );

  // Ledger DB: runtime state, positions, orders
  const listState = ledgerDb.prepare("SELECT * FROM family_runtime_state");
  const getState = ledgerDb.prepare("SELECT * FROM family_runtime_state WHERE family_id = ?");
  const getPositions = ledgerDb.prepare(
    "SELECT * FROM positions WHERE family_id = ? ORDER BY updated_at DESC",
  );
  const getOrders = ledgerDb.prepare(
    "SELECT * FROM orders WHERE family_id = ? ORDER BY created_at DESC LIMIT 100",
  );

  function toCaps(row: {
    max_open_value_usdc: number;
    max_active_markets: number;
    max_dust_positions: number;
  }): FamilyCaps {
    return {
      maxOpenValueUsdc: row.max_open_value_usdc,
      maxActiveMarkets: row.max_active_markets,
      maxDustPositions: row.max_dust_positions,
    };
  }

  const listEvidence = controlDb.prepare(
    "SELECT family_id, promotion_state, probe_substate FROM family_evidence",
  );

  app.get("/families", async () => {
    const catalogs = listCatalog.all() as FamilyCatalogRow[];
    const states = listState.all() as FamilyStateRow[];
    const stateMap = new Map(states.map((s) => [s.family_id, s]));
    const capsRows = listCaps.all() as Array<{
      family_id: string;
      max_open_value_usdc: number;
      max_active_markets: number;
      max_dust_positions: number;
    }>;
    const capsMap = new Map(capsRows.map((r) => [r.family_id, toCaps(r)]));
    const evidenceRows = listEvidence.all() as Array<{
      family_id: string;
      promotion_state: string | null;
      probe_substate: string | null;
    }>;
    const promoMap = new Map(evidenceRows.map((r) => [r.family_id, r.promotion_state]));
    const substateMap = new Map(evidenceRows.map((r) => [r.family_id, r.probe_substate]));
    return ok(
      catalogs.map((c) =>
        toFamilyDto(
          c,
          stateMap.get(c.family_id),
          capsMap.get(c.family_id) ?? null,
          promoMap.get(c.family_id),
          substateMap.get(c.family_id),
        ),
      ),
    );
  });

  app.get<{ Params: { familyId: string } }>("/families/:familyId", async (request) => {
    const { familyId } = request.params;
    const catalog = getCatalog.get(familyId) as FamilyCatalogRow | undefined;
    if (!catalog) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");
    const state = getState.get(familyId) as FamilyStateRow | undefined;
    const capsRow = getCaps.get(familyId) as
      | {
          family_id: string;
          max_open_value_usdc: number;
          max_active_markets: number;
          max_dust_positions: number;
        }
      | undefined;
    return ok(toFamilyDto(catalog, state, capsRow ? toCaps(capsRow) : null));
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

  // ── GET /families/:familyId/evidence ───────────────────────────────────
  app.get<{ Params: { familyId: string } }>(
    "/families/:familyId/evidence",
    async (request) => {
      const { familyId } = request.params;
      const catalog = getCatalog.get(familyId) as FamilyCatalogRow | undefined;
      if (!catalog) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");
      const row = controlDb
        .prepare("SELECT * FROM family_evidence WHERE family_id = ?")
        .get(familyId) as Record<string, unknown> | undefined;
      if (!row) return ok(null);

      const repricingExitCount = (row.repricing_exit_count as number) ?? 0;
      const blockers = getPromotionBlockers({
        repricingExits: repricingExitCount,
        distinctMarkets: (row.local_market_count as number) ?? 0,
        tradeCount: (row.local_trade_count as number) ?? 0,
        recycleScore: (row.recycle_score as number) ?? 0,
        toxicity: (row.toxicity_penalty as number) ?? 0,
        tailAdjustedPnl: (row.tail_adjusted_pnl as number) ?? 0,
      });

      return ok({
        familyId: row.family_id,
        evidenceStatus: row.evidence_status,
        evidenceScore: row.evidence_score,
        promotionState: row.promotion_state,
        localTradeCount: row.local_trade_count,
        localMarketCount: row.local_market_count,
        localRealizedPnlFifo: row.local_realized_pnl_fifo,
        openTailCostUsdc: row.open_tail_cost_usdc,
        tailAdjustedPnl: row.tail_adjusted_pnl,
        remoteClosedRealizedPnl: row.remote_closed_realized_pnl ?? null,
        openPositionCount: row.open_position_count ?? null,
        openDustCount: row.open_dust_count ?? null,
        bothSidedEligible: Boolean(row.both_sided_eligible),
        heavyCampaignEligible: Boolean(row.heavy_campaign_eligible),
        activeWindowEdgeScore: row.active_window_edge_score ?? null,
        recurrenceScore: row.recurrence_score ?? null,
        recycleScore: row.recycle_score ?? null,
        liveViabilityScore: row.live_viability_score ?? null,
        toxicityPenalty: row.toxicity_penalty ?? null,
        lastValidatedAt: row.last_validated_at ?? null,
        probeSubstate: (row.probe_substate as string) ?? null,
        repricingExitCount,
        promotionBlockers: blockers,
      });
    },
  );

  // ── GET /families/recent-demotions ─────────────────────────────────────
  app.get("/families/recent-demotions", async () => {
    const rows = controlDb
      .prepare(
        `SELECT * FROM state_transitions
         WHERE entity_type = 'family'
           AND trigger_type = 'system'
           AND to_state IN ('reduce-only', 'quarantine')
           AND created_at > datetime('now', '-1 hour')
         ORDER BY created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return ok(
      rows.map((r) => ({
        id: r.id,
        entityType: r.entity_type,
        entityId: r.entity_id,
        fromState: r.from_state,
        toState: r.to_state,
        triggerType: r.trigger_type,
        initiator: r.initiator,
        reason: r.reason,
        scoresSnapshot: r.scores_snapshot,
        createdAt: r.created_at,
      })),
    );
  });

  // ── GET /families/:familyId/transitions ────────────────────────────────
  app.get<{ Params: { familyId: string } }>(
    "/families/:familyId/transitions",
    async (request) => {
      const { familyId } = request.params;
      const catalog = getCatalog.get(familyId) as FamilyCatalogRow | undefined;
      if (!catalog) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");
      const rows = controlDb
        .prepare(
          `SELECT * FROM state_transitions
           WHERE entity_type = 'family' AND entity_id = ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(familyId) as Array<Record<string, unknown>>;
      return ok(
        rows.map((r) => ({
          id: r.id,
          entityType: r.entity_type,
          entityId: r.entity_id,
          fromState: r.from_state,
          toState: r.to_state,
          triggerType: r.trigger_type,
          initiator: r.initiator,
          reason: r.reason,
          scoresSnapshot: r.scores_snapshot,
          createdAt: r.created_at,
        })),
      );
    },
  );

  // ── GET /families/:familyId/scorecards ─────────────────────────────────
  app.get<{ Params: { familyId: string } }>(
    "/families/:familyId/scorecards",
    async (request) => {
      const { familyId } = request.params;
      const catalog = getCatalog.get(familyId) as FamilyCatalogRow | undefined;
      if (!catalog) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");
      const rows = controlDb
        .prepare(
          "SELECT * FROM family_validation_scorecards WHERE family_id = ? ORDER BY validated_at DESC LIMIT 50",
        )
        .all(familyId);
      return ok(rows);
    },
  );

  // ── GET /families/:familyId/deployments ──────────────────────────────
  app.get<{ Params: { familyId: string } }>(
    "/families/:familyId/deployments",
    async (request) => {
      const { familyId } = request.params;
      const catalog = getCatalog.get(familyId) as FamilyCatalogRow | undefined;
      if (!catalog) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");
      const rows = controlDb
        .prepare(
          `SELECT fd.*, p.display_name as profile_name
           FROM family_deployments fd
           JOIN profiles p ON fd.profile = p.profile_id
           WHERE fd.family_id = ?
           ORDER BY p.profile_id`,
        )
        .all(familyId);
      return ok(rows);
    },
  );

  // ── GET /families/:familyId/rollups ──────────────────────────────────
  app.get<{ Params: { familyId: string } }>(
    "/families/:familyId/rollups",
    async (request) => {
      const { familyId } = request.params;
      const catalog = getCatalog.get(familyId) as FamilyCatalogRow | undefined;
      if (!catalog) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");
      const rows = controlDb
        .prepare("SELECT * FROM family_profile_rollups WHERE family_id = ? ORDER BY profile")
        .all(familyId);
      return ok(rows);
    },
  );

  // ── GET /families/:familyId/audit ────────────────────────────────────
  app.get<{ Params: { familyId: string } }>(
    "/families/:familyId/audit",
    async (request) => {
      const { familyId } = request.params;
      const catalog = getCatalog.get(familyId) as FamilyCatalogRow | undefined;
      if (!catalog) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");
      const rows = controlDb
        .prepare(
          "SELECT * FROM state_transitions WHERE entity_id = ? ORDER BY created_at DESC LIMIT 100",
        )
        .all(familyId);
      return ok(rows);
    },
  );

  // ── GET /families/:familyId/rules-snapshots ──────────────────────────
  app.get<{ Params: { familyId: string } }>(
    "/families/:familyId/rules-snapshots",
    async (request) => {
      const { familyId } = request.params;
      const catalog = getCatalog.get(familyId) as FamilyCatalogRow | undefined;
      if (!catalog) throw new ApiError(404, `family ${familyId} not found`, "FAMILY_NOT_FOUND");
      const rows = controlDb
        .prepare(
          "SELECT * FROM family_rules_snapshot WHERE family_id = ? ORDER BY captured_at DESC LIMIT 50",
        )
        .all(familyId);
      return ok(rows);
    },
  );

  // ── GET /families/proposals ────────────────────────────────────────────
  app.get("/families/proposals", async () => {
    const rows = controlDb
      .prepare(
        "SELECT * FROM promotion_proposals WHERE status = 'pending' ORDER BY created_at ASC",
      )
      .all() as Array<Record<string, unknown>>;
    return ok(rows.map(toProposalDto));
  });

  // ── POST /families/proposals/:proposalId/dismiss ───────────────────────
  app.post<{ Params: { proposalId: string }; Body: { reason?: string } }>(
    "/families/proposals/:proposalId/dismiss",
    async (request) => {
      const id = Number(request.params.proposalId);
      const row = controlDb
        .prepare("SELECT * FROM promotion_proposals WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;
      if (!row) throw new ApiError(404, `proposal ${id} not found`, "PROPOSAL_NOT_FOUND");
      if (row.status !== "pending") {
        throw new ApiError(
          409,
          `proposal status is '${row.status}', expected 'pending'`,
          "INVALID_STATUS",
        );
      }
      controlDb
        .prepare(
          `UPDATE promotion_proposals
           SET status = 'dismissed', resolved_at = datetime('now'), resolved_by = ?
           WHERE id = ?`,
        )
        .run(getActor(request), id);
      return ok({ proposalId: id, status: "dismissed" });
    },
  );
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

function toProposalDto(row: Record<string, unknown>) {
  return {
    id: row.id,
    familyId: row.family_id,
    currentState: row.current_state,
    proposedState: row.proposed_state,
    reason: row.reason,
    scoresSnapshot: row.scores_snapshot,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
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
