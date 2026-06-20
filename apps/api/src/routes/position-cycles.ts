import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import type { LedgerPool } from "../ledger-pool.js";
import { ok, ApiError } from "../errors.js";
import { resolveActiveLedger } from "./status.js";

const ACTIVE_ORDER_STATUS_SQL = "('pending','open','partially-filled')";
const EPSILON = 0.000001;
const MIN_MONEY_MISMATCH_USD = 0.01;
const RELATIVE_MONEY_MISMATCH = 0.0001;

type Period = "24h" | "7d" | "30d" | "all";
type StatusFilter = "all" | "open" | "closed" | "dust" | "resolution" | "acct_warnings";
type PnlFilter = "all" | "profit" | "loss" | "zero";
type SortKey = "worst_pnl" | "best_pnl" | "newest" | "longest_held" | "dust_value";
type AccountingConfidence = "HIGH" | "MED" | "LOW";

interface PositionCyclesOpts {
  db: Database.Database;
  controlDb?: Database.Database;
  ledgerPool?: LedgerPool;
}

interface PositionCyclesQuery {
  period?: Period;
  status?: StatusFilter;
  pnl?: PnlFilter;
  source?: string;
  band?: string;
  sort?: SortKey;
  page?: string;
  pageSize?: string;
}

interface PositionRow {
  position_id: string;
  token_id: string;
  condition_id: string | null;
  side: string;
  size: number;
  avg_entry_price: number;
  cost_basis_usdc: number;
  current_value_usdc: number | null;
  liquidation_value_usdc: number | null;
  liquidation_price: number | null;
  realized_pnl: number;
  status: string;
  opened_at: string;
  closed_at: string | null;
  updated_at: string;
  slug: string | null;
  question: string | null;
  outcome: string | null;
  end_date: string | null;
  band: string | null;
}

interface FillRow {
  position_id: string;
  fill_id: string;
  order_id: string;
  token_id: string;
  condition_id: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  size_usdc: number;
  fee: number;
  filled_at: string;
  pnl_delta?: number | null;
  decision_rule_id?: string | null;
  signal_reason?: string | null;
  fill_decision_rule_id?: string | null;
}

interface SettlementRow {
  position_id: string;
  settlement_id: string;
  condition_id: string;
  token_id: string;
  resolution: string;
  settlement_price: number;
  size: number;
  delta: number;
  settled_at: string;
}

interface SourceContribution {
  source: string;
  returnedUsd: number;
  pnlUsd: number | null;
  count: number;
}

interface PositionCycleOperation {
  time: string;
  type: "BUY" | "SCALE" | "SELL" | "SETTLE";
  fillId?: string;
  orderId?: string | null;
  price: number | null;
  shares: number;
  usd: number;
  source: string;
  stepPnlUsd: number | null;
}

interface PositionCycle {
  id: string;
  positionId: string;
  tokenId: string;
  conditionId: string | null;
  slug: string | null;
  marketTitle: string | null;
  outcome: string | null;
  status: string;
  openedAt: string;
  closedAt: string | null;
  lastActionAt: string;
  heldDurationMs: number;
  shares: number;
  buyCount: number;
  sellCount: number;
  entrySources: string[];
  exitSources: string[];
  exitSummary: string;
  flags: string[];
  band: string | null;
  investedUsd: number;
  returnedUsd: number;
  sellReturnedUsd: number;
  settlementReturnedUsd: number;
  remainingMarkUsd: number;
  remainingLiquidationUsd: number;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number;
  netPnlUsd: number | null;
  netPnlPct: number | null;
  accountingConfidence: AccountingConfidence;
  accountingReasons: string[];
  sourceBreakdown: {
    entries: SourceContribution[];
    exits: SourceContribution[];
  };
  operations: PositionCycleOperation[];
}

interface CycleBuildContext {
  buysByPosition: Map<string, FillRow[]>;
  sellsByPosition: Map<string, FillRow[]>;
  settlementsByPosition: Map<string, SettlementRow[]>;
  activeSellOrdersByToken: Map<string, number>;
}

export const positionCycleRoutes: FastifyPluginAsync<PositionCyclesOpts> = async (app, opts) => {
  app.get<{ Querystring: PositionCyclesQuery }>("/pnl/position-cycles", async (request) => {
    const { db } = resolveActiveLedger(opts.db, opts.controlDb, opts.ledgerPool);
    const allCycles = buildPositionCycles(db);
    const period = parsePeriod(request.query.period);
    const status = parseStatus(request.query.status);
    const pnl = parsePnlFilter(request.query.pnl);
    const sort = parseSort(request.query.sort);
    const page = Math.max(Number(request.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(request.query.pageSize) || 25, 1), 100);

    const periodCycles = applyPeriod(allCycles, period);
    const filtered = applyFilters(periodCycles, {
      status,
      pnl,
      source: request.query.source ?? "all",
      band: request.query.band ?? "all",
    });
    const sorted = sortCycles(filtered, sort);
    const totalCount = sorted.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * pageSize;
    const cycles = sorted.slice(start, start + pageSize);
    const warnings = periodCycles.filter((cycle) => cycle.status === "UNKNOWN_ACCT");

    return ok({
      summary: buildSummary(periodCycles),
      accountingWarnings: warnings,
      cycles,
      pagination: {
        page: safePage,
        pageSize,
        totalCount,
        totalPages,
      },
    });
  });

  app.get<{ Params: { positionId: string } }>(
    "/pnl/position-cycles/:positionId",
    async (request) => {
      const { db } = resolveActiveLedger(opts.db, opts.controlDb, opts.ledgerPool);
      const cycle = buildPositionCycles(db).find(
        (item) => item.positionId === request.params.positionId,
      );
      if (!cycle) {
        throw new ApiError(
          404,
          `position cycle ${request.params.positionId} not found`,
          "POSITION_CYCLE_NOT_FOUND",
        );
      }
      return ok(cycle);
    },
  );
};

export function buildPositionCycles(db: Database.Database): PositionCycle[] {
  const positions = db
    .prepare(
      `SELECT p.*, m.slug, m.question, m.outcome, m.end_date, pls.band
         FROM positions p
         LEFT JOIN markets m ON m.token_id = p.token_id
         LEFT JOIN profile_ladder_state pls ON pls.token_id = p.token_id`,
    )
    .all() as PositionRow[];
  const context: CycleBuildContext = {
    buysByPosition: groupByPosition(loadBuyRows(db)),
    sellsByPosition: groupByPosition(loadSellRows(db)),
    settlementsByPosition: groupByPosition(loadSettlementRows(db)),
    activeSellOrdersByToken: loadActiveSellOrdersByToken(db),
  };
  return positions.map((position) => buildCycle(position, context));
}

function loadBuyRows(db: Database.Database): FillRow[] {
  return db
    .prepare(
      `SELECT il.position_id, f.fill_id, f.order_id, f.token_id, f.condition_id, f.side,
              f.price, f.size, f.size_usdc, f.fee, f.filled_at,
              o.decision_rule_id, o.signal_reason, f.decision_rule_id AS fill_decision_rule_id
         FROM inventory_lots il
         JOIN fills f ON f.fill_id = il.fill_id
         LEFT JOIN orders o ON o.order_id = f.order_id
        ORDER BY datetime(replace(substr(f.filled_at, 1, 19), 'T', ' ')), f.fill_id`,
    )
    .all() as FillRow[];
}

function loadSellRows(db: Database.Database): FillRow[] {
  return db
    .prepare(
      `SELECT pl.position_id, f.fill_id, f.order_id, f.token_id, f.condition_id, f.side,
              f.price, f.size, f.size_usdc, f.fee, f.filled_at, pl.delta AS pnl_delta,
              o.decision_rule_id, o.signal_reason, f.decision_rule_id AS fill_decision_rule_id
         FROM pnl_ledger pl
         JOIN fills f ON f.fill_id = pl.fill_id
         LEFT JOIN orders o ON o.order_id = f.order_id
        ORDER BY datetime(replace(substr(f.filled_at, 1, 19), 'T', ' ')), f.fill_id`,
    )
    .all() as FillRow[];
}

function loadSettlementRows(db: Database.Database): SettlementRow[] {
  return db
    .prepare(
      `SELECT position_id, settlement_id, condition_id, token_id, resolution, settlement_price,
              size, delta, settled_at
         FROM settlement_ledger
        ORDER BY datetime(replace(substr(settled_at, 1, 19), 'T', ' ')), settlement_id`,
    )
    .all() as SettlementRow[];
}

function loadActiveSellOrdersByToken(db: Database.Database): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT token_id, COUNT(*) AS count
         FROM orders
        WHERE side = 'sell' AND status IN ${ACTIVE_ORDER_STATUS_SQL}
        GROUP BY token_id`,
    )
    .all() as Array<{ token_id: string; count: number }>;
  return new Map(rows.map((row) => [row.token_id, row.count]));
}

function groupByPosition<T extends { position_id: string }>(rows: T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const current = result.get(row.position_id) ?? [];
    current.push(row);
    result.set(row.position_id, current);
  }
  return result;
}

function buildCycle(position: PositionRow, context: CycleBuildContext): PositionCycle {
  const positionId = position.position_id;
  const buys = context.buysByPosition.get(positionId) ?? [];
  const sells = context.sellsByPosition.get(positionId) ?? [];
  const settlements = context.settlementsByPosition.get(positionId) ?? [];
  const entrySources = uniqueSorted(buys.map(sourceForFill));
  const sellSources = uniqueSorted(sells.map(sourceForFill));
  const hasSettlement = settlements.length > 0;
  const exitSources = uniqueSorted([...sellSources, ...(hasSettlement ? ["settlement"] : [])]);

  const investedUsd = sum(buys.map((row) => row.size_usdc));
  const sellReturnedUsd = sum(sells.map((row) => row.size_usdc));
  const settlementReturnedUsd = sum(settlements.map((row) => row.settlement_price * row.size));
  const returnedUsd = sellReturnedUsd + settlementReturnedUsd;
  const sellPnl = sum(sells.map((row) => row.pnl_delta ?? 0));
  const settlementPnl = sum(settlements.map((row) => row.delta));
  const ledgerRealizedPnl = sellPnl + settlementPnl;
  const remainingMarkUsd = isOpenLike(position.status)
    ? numberOrZero(position.current_value_usdc)
    : 0;
  const remainingLiquidationUsd = isOpenLike(position.status)
    ? numberOrZero(position.liquidation_value_usdc ?? position.current_value_usdc)
    : 0;
  const unrealizedPnlUsd = isOpenLike(position.status)
    ? remainingMarkUsd - numberOrZero(position.cost_basis_usdc)
    : 0;

  const accountingReasons = accountingIssues(position, {
    investedUsd,
    returnedUsd,
    ledgerRealizedPnl,
  });
  const unknownAccounting = accountingReasons.some((reason) =>
    ["ledger_mismatch", "incomplete_cost_basis"].includes(reason),
  );
  const realizedPnlUsd = unknownAccounting ? null : roundMoney(ledgerRealizedPnl);
  const netPnlUsd = unknownAccounting ? null : roundMoney(ledgerRealizedPnl + unrealizedPnlUsd);
  const netPnlPct =
    netPnlUsd == null || investedUsd <= EPSILON
      ? null
      : roundMoney((netPnlUsd / investedUsd) * 100);
  const accountingConfidence = resolveAccountingConfidence(
    unknownAccounting,
    hasSettlement,
    position.status,
  );
  const operations = buildOperations(buys, sells, settlements, unknownAccounting);
  const lastActionAt = latestTimestamp([
    position.opened_at,
    position.closed_at,
    ...operations.map((operation) => operation.time),
  ]);
  const heldDurationMs = Math.max(
    0,
    parseTimestamp(position.closed_at ?? lastActionAt) - parseTimestamp(position.opened_at),
  );
  const status = resolveLifecycleStatus(
    position.status,
    netPnlUsd,
    ledgerRealizedPnl,
    hasSettlement,
    unknownAccounting,
  );
  const flags = resolveFlags(position, {
    status,
    accountingReasons,
    remainingMarkUsd,
    remainingLiquidationUsd,
    hasActiveSell: (context.activeSellOrdersByToken.get(position.token_id) ?? 0) > 0,
  });

  return {
    id: positionId,
    positionId,
    tokenId: position.token_id,
    conditionId: position.condition_id ?? null,
    slug: position.slug ?? null,
    marketTitle: position.question ?? null,
    outcome: position.outcome ?? null,
    status,
    openedAt: position.opened_at,
    closedAt: position.closed_at ?? null,
    lastActionAt,
    heldDurationMs,
    shares: numberOrZero(position.size),
    buyCount: buys.length,
    sellCount: sells.length,
    entrySources,
    exitSources,
    exitSummary: buildExitSummary(position.status, exitSources),
    flags,
    band: position.band ?? null,
    investedUsd: roundMoney(investedUsd),
    returnedUsd: roundMoney(returnedUsd),
    sellReturnedUsd: roundMoney(sellReturnedUsd),
    settlementReturnedUsd: roundMoney(settlementReturnedUsd),
    remainingMarkUsd: roundMoney(remainingMarkUsd),
    remainingLiquidationUsd: roundMoney(remainingLiquidationUsd),
    realizedPnlUsd,
    unrealizedPnlUsd: roundMoney(unrealizedPnlUsd),
    netPnlUsd,
    netPnlPct,
    accountingConfidence,
    accountingReasons,
    sourceBreakdown: {
      entries: buildEntryBreakdown(buys),
      exits: buildExitBreakdown(sells, settlements, unknownAccounting),
    },
    operations,
  };
}

function accountingIssues(
  position: PositionRow,
  values: { investedUsd: number; returnedUsd: number; ledgerRealizedPnl: number },
): string[] {
  const reasons: string[] = [];
  if (isMaterialMoneyMismatch(numberOrZero(position.realized_pnl), values.ledgerRealizedPnl)) {
    reasons.push("ledger_mismatch");
  }
  const hasMoney =
    values.investedUsd > EPSILON ||
    values.returnedUsd > EPSILON ||
    position.cost_basis_usdc > EPSILON;
  if (values.investedUsd <= EPSILON && hasMoney) {
    reasons.push("incomplete_cost_basis");
  }
  if (isOpenLike(position.status)) reasons.push("open_remainder");
  return uniqueSorted(reasons);
}

function resolveAccountingConfidence(
  unknownAccounting: boolean,
  hasSettlement: boolean,
  positionStatus: string,
): AccountingConfidence {
  if (unknownAccounting) return "LOW";
  if (hasSettlement || isOpenLike(positionStatus)) return "MED";
  return "HIGH";
}

function resolveLifecycleStatus(
  positionStatus: string,
  netPnlUsd: number | null,
  ledgerRealizedPnl: number,
  hasSettlement: boolean,
  unknownAccounting: boolean,
): string {
  if (unknownAccounting) return "UNKNOWN_ACCT";
  if (positionStatus === "dust") return "DUST_OPEN";
  if (positionStatus === "closed") {
    if (hasSettlement && ledgerRealizedPnl < -EPSILON) return "HELD_TO_LOSING_RESOLUTION";
    return ledgerRealizedPnl >= 0 ? "CLOSED_PROFIT" : "CLOSED_LOSS";
  }
  return numberOrZero(netPnlUsd) >= 0 ? "OPEN_PROFIT" : "OPEN_LOSS";
}

function resolveFlags(
  position: PositionRow,
  input: {
    status: string;
    accountingReasons: string[];
    remainingMarkUsd: number;
    remainingLiquidationUsd: number;
    hasActiveSell: boolean;
  },
): string[] {
  const flags: string[] = [];
  if (input.status === "UNKNOWN_ACCT") flags.push("acct_mismatch");
  if (input.accountingReasons.includes("incomplete_cost_basis")) flags.push("incomplete_basis");
  if (position.status === "dust") flags.push("dust");
  if (input.status === "HELD_TO_LOSING_RESOLUTION") flags.push("resolution");
  if (isOpenLike(position.status) && !input.hasActiveSell) flags.push("no_live_exit");
  if (
    isOpenLike(position.status) &&
    input.remainingMarkUsd > EPSILON &&
    input.remainingLiquidationUsd / input.remainingMarkUsd < 0.6
  ) {
    flags.push("low_liq");
  }
  return uniqueSorted(flags);
}

function buildOperations(
  buys: FillRow[],
  sells: FillRow[],
  settlements: SettlementRow[],
  unknownAccounting: boolean,
): PositionCycleOperation[] {
  const buyOps = buys.map((row, index) => ({
    time: row.filled_at,
    type: index === 0 ? ("BUY" as const) : ("SCALE" as const),
    fillId: row.fill_id,
    orderId: row.order_id,
    price: row.price,
    shares: row.size,
    usd: -row.size_usdc,
    source: sourceForFill(row),
    stepPnlUsd: null,
  }));
  const sellOps = sells.map((row) => ({
    time: row.filled_at,
    type: "SELL" as const,
    fillId: row.fill_id,
    orderId: row.order_id,
    price: row.price,
    shares: row.size,
    usd: row.size_usdc,
    source: sourceForFill(row),
    stepPnlUsd: unknownAccounting ? null : roundMoney(row.pnl_delta ?? 0),
  }));
  const settlementOps = settlements.map((row) => ({
    time: row.settled_at,
    type: "SETTLE" as const,
    fillId: row.settlement_id,
    orderId: null,
    price: row.settlement_price,
    shares: row.size,
    usd: row.settlement_price * row.size,
    source: "settlement",
    stepPnlUsd: unknownAccounting ? null : roundMoney(row.delta),
  }));
  return [...buyOps, ...sellOps, ...settlementOps].sort(
    (left, right) => parseTimestamp(left.time) - parseTimestamp(right.time),
  );
}

function buildEntryBreakdown(buys: FillRow[]): SourceContribution[] {
  const bySource = new Map<string, SourceContribution>();
  for (const buy of buys) {
    const source = sourceForFill(buy);
    const current = bySource.get(source) ?? { source, returnedUsd: 0, pnlUsd: null, count: 0 };
    current.returnedUsd += buy.size_usdc;
    current.count += 1;
    bySource.set(source, current);
  }
  return [...bySource.values()].map((item) => ({
    ...item,
    returnedUsd: roundMoney(item.returnedUsd),
  }));
}

function buildExitBreakdown(
  sells: FillRow[],
  settlements: SettlementRow[],
  unknownAccounting: boolean,
): SourceContribution[] {
  const bySource = new Map<string, SourceContribution>();
  for (const sell of sells) {
    const source = sourceForFill(sell);
    const current = bySource.get(source) ?? { source, returnedUsd: 0, pnlUsd: 0, count: 0 };
    current.returnedUsd += sell.size_usdc;
    current.pnlUsd = unknownAccounting
      ? null
      : numberOrZero(current.pnlUsd) + numberOrZero(sell.pnl_delta);
    current.count += 1;
    bySource.set(source, current);
  }
  if (settlements.length > 0) {
    const current = bySource.get("settlement") ?? {
      source: "settlement",
      returnedUsd: 0,
      pnlUsd: 0,
      count: 0,
    };
    current.returnedUsd += sum(settlements.map((row) => row.settlement_price * row.size));
    current.pnlUsd = unknownAccounting
      ? null
      : numberOrZero(current.pnlUsd) + sum(settlements.map((row) => row.delta));
    current.count += settlements.length;
    bySource.set("settlement", current);
  }
  return [...bySource.values()].map((item) => ({
    source: item.source,
    returnedUsd: roundMoney(item.returnedUsd),
    pnlUsd: item.pnlUsd == null ? null : roundMoney(item.pnlUsd),
    count: item.count,
  }));
}

function buildExitSummary(positionStatus: string, exitSources: string[]): string {
  if (exitSources.length > 0) return `closed by ${exitSources.join(" + ")}`;
  return isOpenLike(positionStatus) ? "open" : "closed";
}

function buildSummary(cycles: PositionCycle[]) {
  const known = cycles.filter((cycle) => cycle.netPnlUsd != null);
  const closed = known.filter((cycle) =>
    ["CLOSED_PROFIT", "CLOSED_LOSS", "HELD_TO_LOSING_RESOLUTION"].includes(cycle.status),
  );
  const open = known.filter((cycle) =>
    ["OPEN_PROFIT", "OPEN_LOSS", "DUST_OPEN"].includes(cycle.status),
  );
  const dust = cycles.filter(
    (cycle) =>
      cycle.status === "DUST_OPEN" ||
      cycle.flags.includes("dust") ||
      cycle.flags.includes("no_live_exit"),
  );
  return {
    closedRealizedPnlUsd: roundMoney(sum(closed.map((cycle) => cycle.realizedPnlUsd ?? 0))),
    closedCycleCount: closed.length,
    openNetPnlUsd: roundMoney(sum(open.map((cycle) => cycle.netPnlUsd ?? 0))),
    openMarkUsd: roundMoney(sum(open.map((cycle) => cycle.remainingMarkUsd))),
    openLiquidationUsd: roundMoney(sum(open.map((cycle) => cycle.remainingLiquidationUsd))),
    winners: known.filter((cycle) => numberOrZero(cycle.netPnlUsd) > EPSILON).length,
    losers: known.filter((cycle) => numberOrZero(cycle.netPnlUsd) < -EPSILON).length,
    dustCount: dust.length,
    dustLiquidationUsd: roundMoney(sum(dust.map((cycle) => cycle.remainingLiquidationUsd))),
    accountingWarningCount: cycles.filter((cycle) => cycle.status === "UNKNOWN_ACCT").length,
  };
}

function applyPeriod(cycles: PositionCycle[], period: Period): PositionCycle[] {
  const hours = periodHours(period);
  if (hours == null) return cycles;
  const cutoff = Date.now() - hours * 3_600_000;
  return cycles.filter((cycle) => parseTimestamp(cycle.lastActionAt) >= cutoff);
}

function applyFilters(
  cycles: PositionCycle[],
  filters: { status: StatusFilter; pnl: PnlFilter; source: string; band: string },
): PositionCycle[] {
  return cycles.filter((cycle) => {
    if (!matchesStatus(cycle, filters.status)) return false;
    if (!matchesPnl(cycle, filters.pnl)) return false;
    if (!matchesSource(cycle, filters.source)) return false;
    if (filters.band !== "all" && cycle.band !== filters.band) return false;
    return true;
  });
}

function matchesStatus(cycle: PositionCycle, status: StatusFilter): boolean {
  if (status === "all") return true;
  if (status === "acct_warnings") return cycle.status === "UNKNOWN_ACCT";
  if (status === "open") return ["OPEN_PROFIT", "OPEN_LOSS", "DUST_OPEN"].includes(cycle.status);
  if (status === "closed")
    return ["CLOSED_PROFIT", "CLOSED_LOSS", "HELD_TO_LOSING_RESOLUTION"].includes(cycle.status);
  if (status === "dust") return cycle.status === "DUST_OPEN" || cycle.flags.includes("dust");
  return cycle.status === "HELD_TO_LOSING_RESOLUTION" || cycle.exitSources.includes("settlement");
}

function matchesPnl(cycle: PositionCycle, pnl: PnlFilter): boolean {
  if (pnl === "all") return true;
  if (cycle.netPnlUsd == null) return false;
  if (pnl === "profit") return cycle.netPnlUsd > EPSILON;
  if (pnl === "loss") return cycle.netPnlUsd < -EPSILON;
  return Math.abs(cycle.netPnlUsd) <= EPSILON;
}

function matchesSource(cycle: PositionCycle, source: string): boolean {
  if (!source || source === "all") return true;
  const accepted = sourceAliases(source);
  return [...cycle.entrySources, ...cycle.exitSources].some((item) => accepted.has(item));
}

function sortCycles(cycles: PositionCycle[], sort: SortKey): PositionCycle[] {
  return [...cycles].sort((left, right) => {
    if (sort === "newest")
      return parseTimestamp(right.lastActionAt) - parseTimestamp(left.lastActionAt);
    if (sort === "longest_held") return right.heldDurationMs - left.heldDurationMs;
    if (sort === "dust_value") return right.remainingLiquidationUsd - left.remainingLiquidationUsd;
    return comparePnl(left, right, sort);
  });
}

function comparePnl(left: PositionCycle, right: PositionCycle, sort: SortKey): number {
  const leftUnknown = left.netPnlUsd == null;
  const rightUnknown = right.netPnlUsd == null;
  if (leftUnknown !== rightUnknown) return leftUnknown ? 1 : -1;
  if (leftUnknown && rightUnknown)
    return parseTimestamp(right.lastActionAt) - parseTimestamp(left.lastActionAt);
  const direction = sort === "best_pnl" ? -1 : 1;
  return direction * (numberOrZero(left.netPnlUsd) - numberOrZero(right.netPnlUsd));
}

function parsePeriod(value: Period | undefined): Period {
  return value && ["24h", "7d", "30d", "all"].includes(value) ? value : "24h";
}

function parseStatus(value: StatusFilter | undefined): StatusFilter {
  return value && ["all", "open", "closed", "dust", "resolution", "acct_warnings"].includes(value)
    ? value
    : "all";
}

function parsePnlFilter(value: PnlFilter | undefined): PnlFilter {
  return value && ["all", "profit", "loss", "zero"].includes(value) ? value : "all";
}

function parseSort(value: SortKey | undefined): SortKey {
  return value && ["worst_pnl", "best_pnl", "newest", "longest_held", "dust_value"].includes(value)
    ? value
    : "worst_pnl";
}

function periodHours(period: Period): number | null {
  if (period === "24h") return 24;
  if (period === "7d") return 7 * 24;
  if (period === "30d") return 30 * 24;
  return null;
}

function sourceAliases(source: string): Set<string> {
  const normalized = source.toLowerCase();
  const aliases: Record<string, string[]> = {
    profileladder: ["PROFILE_LADDER", "ProfileLadder"],
    d8: ["D8", "D8_PROFIT_RATIO"],
    r23: ["R23", "R23_DIP_TRIGGER"],
    "scale-in": ["scale-in", "heavy-scale", "EXECUTION_PROFILE_SCALE_IN"],
    settlement: ["settlement"],
  };
  return new Set(aliases[normalized] ?? [source]);
}

function sourceForFill(row: FillRow): string {
  return row.decision_rule_id ?? row.fill_decision_rule_id ?? row.signal_reason ?? "unknown";
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function latestTimestamp(values: Array<string | null | undefined>): string {
  const safe = values.filter((value): value is string => Boolean(value));
  if (safe.length === 0) return new Date(0).toISOString();
  return safe.sort((left, right) => parseTimestamp(right) - parseTimestamp(left))[0]!;
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const fallback = Date.parse(normalized);
  return Number.isFinite(fallback) ? fallback : 0;
}

function isOpenLike(status: string): boolean {
  return status === "open" || status === "dust";
}

function numberOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + numberOrZero(value), 0);
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function isMaterialMoneyMismatch(positionRealizedPnl: number, ledgerRealizedPnl: number): boolean {
  const threshold = Math.max(
    MIN_MONEY_MISMATCH_USD,
    RELATIVE_MONEY_MISMATCH * Math.abs(ledgerRealizedPnl),
  );
  return Math.abs(positionRealizedPnl - ledgerRealizedPnl) > threshold;
}
