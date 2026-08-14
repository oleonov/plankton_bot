#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { ledgerInstant } from "@krabs/db";
import { parseExecutionPolicyJson, parseInstantMs } from "@krabs/domain";

type Row = Record<string, unknown>;
type Db = Database.Database;
type HighWater = Record<
  | "positions"
  | "orders"
  | "fills"
  | "inventoryLots"
  | "pnlLedger"
  | "settlementLedger"
  | "policyHistory",
  number
>;

type PositionMetric = {
  attemptPositions: number;
  acceptedPositions: number;
  filledPositions: number;
  rows: number;
};

type TerminalMetric = {
  positions: number;
  singleLot: number;
  multiLot: number;
  settledPositions: number;
  heldToZero: number;
  cost: number;
  realizedPnl: number;
  roiPct: number[];
};

type TerminalRows = {
  pnlByFill: Map<string, Row[]>;
  pnlByPosition: Map<string, Row[]>;
  settlementsByPosition: Map<string, Row[]>;
};

export type AnalyzeOptions = {
  ledger: string;
  control: string;
  profile: string;
  releaseSha: string;
  historicalCutoff: string;
  strictCutoff: string;
  highWater?: Partial<HighWater>;
  onHighWaterCaptured?: () => void;
};

export class ProvenanceError extends Error {}

const TARGET = "BOUNCE_EXIT_TARGET";
const BACKSTOP = "BOUNCE_EXIT_BACKSTOP";
const MIGRATION_101 = "101_repair_filled_phantom_orders.sql";
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const ROOT = [
  "schemaVersion",
  "observedAt",
  "digest",
  "source",
  "provenance",
  "policy",
  "cohorts",
  "status",
  "groundingComparison",
] as const;

const GROUNDING = {
  observedBeforeImplementation: true,
  ownerTotalBounce: [18, 18],
  targetRows: 923,
  targetPositions: 17,
  targetFilledPositions: 6,
  terminalPositions: 4,
  rungReachAcceptDirectFill: [
    [17, 17, 6],
    [17, 17, 6],
    [10, 10, 1],
  ],
  rolloverPositions: 6,
  cleanupPositions: 0,
  backstopRowsAcceptFill: [11, 0, 0],
  roiPct: [19.44, 19.44, 19.26, -100],
  strictPositionsTerminal: [0, 0],
};

const positive = (value: unknown, name: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ProvenanceError(`${name} must be positive and finite`);
  }
  return parsed;
};

const finite = (value: unknown, name: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ProvenanceError(`${name} must be finite`);
  return parsed;
};

export function canonicalTimestamp(value: string): string {
  const ms = parseInstantMs(value);
  if (!Number.isFinite(ms)) throw new ProvenanceError(`invalid timestamp: ${value}`);
  return new Date(ms).toISOString();
}

function openReadOnly(path: string): Db {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new ProvenanceError(`database path is not a file: ${path}`);
  }
  return new Database(path, { readonly: true, fileMustExist: true });
}

function requireTables(database: Db, names: string[]): void {
  for (const name of names) {
    const exists = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
    if (!exists) throw new ProvenanceError(`required table missing: ${name}`);
  }
}

function requireIndex(database: Db, table: string, name: string, columns: string[]): void {
  const listed = (database.pragma(`index_list(${table})`) as Row[]).find(
    (row) => row.name === name,
  );
  const actual = (database.pragma(`index_info(${name})`) as Row[]).map((row) => row.name);
  if (
    !listed ||
    (name === "idx_pnl_ledger_fill_unique" && listed.unique !== 1) ||
    JSON.stringify(actual) !== JSON.stringify(columns)
  ) {
    throw new ProvenanceError(`required index missing or invalid: ${name}`);
  }
}

const exact = (database: Db, sql: string, ...args: unknown[]): Row[] =>
  database.prepare(sql).all(...args) as Row[];

const maxRowid = (database: Db, table: string): number =>
  Number(
    (database.prepare(`SELECT COALESCE(MAX(rowid),0) value FROM ${table}`).get() as Row).value,
  );

function parseObject(value: unknown, name: string): Row {
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    return parsed as Row;
  } catch {
    throw new ProvenanceError(`invalid ${name}`);
  }
}

type Rung = {
  ladderId: string;
  index: number;
  covered: number[];
  cleanup: boolean;
  anchor: number;
};

function parseRung(order: Row, rungCount: number): Rung {
  const raw = parseObject(order.metadata_json, "metadata_json").bounceRung;
  if (!raw || Array.isArray(raw) || typeof raw !== "object") {
    throw new ProvenanceError("target order lacks bounceRung");
  }
  const value = raw as Row;
  const ladderId = String(value.ladderId ?? "").trim();
  const index = Number(value.rungIndex);
  const anchor = positive(value.anchorPrice ?? value.firstEntryPrice, "anchor");
  positive(value.fraction, "fraction");
  positive(value.originalPositionSize, "original size");
  const covered = value.rungIndicesCovered ?? [index];
  const validCovered =
    Array.isArray(covered) &&
    covered.every(
      (item) => Number.isInteger(item) && Number(item) >= 0 && Number(item) < rungCount,
    );
  if (
    !ladderId ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= rungCount ||
    !validCovered ||
    new Set(covered).size !== covered.length ||
    !covered.includes(index)
  ) {
    throw new ProvenanceError("invalid bounceRung");
  }
  return {
    ladderId,
    index,
    covered: covered.map(Number),
    cleanup: value.isCleanupRung === true,
    anchor,
  };
}

function selectedPolicyFields(
  value: ReturnType<typeof parseExecutionPolicyJson>["policy"]["bounceExit"],
) {
  return {
    enabled: value.enabled,
    mode: value.mode,
    applyToAllMarkets: value.applyToAllMarkets,
    targetTiers: value.targetTiers,
    ladderFractions: value.ladderFractions,
    ladderStepPct: value.ladderStepPct,
    backstopTtcHours: value.backstopTtcHours,
    microMaxOrderUsdc: value.microMaxOrderUsdc,
  };
}

const policyDefinition = (
  value: ReturnType<typeof parseExecutionPolicyJson>["policy"]["bounceExit"],
): string => JSON.stringify(selectedPolicyFields(value));

function auditedPolicy(control: Db, profile: string, cutoff: string, highWater: number) {
  const current = control
    .prepare("SELECT execution_policy_json FROM profile_settings WHERE profile_id=?")
    .get(profile) as Row | undefined;
  const rows = exact(
    control,
    "SELECT id,before_value,after_value,changed_at FROM profile_settings_history WHERE profile_id=? AND field='execution_policy_json' AND id<=? ORDER BY id",
    profile,
    highWater,
  );
  if (!current || !rows.length) throw new ProvenanceError("execution-policy provenance absent");
  const changedAt = rows.map((row) => parseInstantMs(canonicalTimestamp(String(row.changed_at))));
  for (let index = 1; index < rows.length; index++) {
    if (changedAt[index]! < changedAt[index - 1]!) {
      throw new ProvenanceError("policy history timestamps are not monotonic");
    }
  }
  if (rows.at(-1)!.after_value !== current.execution_policy_json) {
    throw new ProvenanceError("current policy does not bind history");
  }
  const parsed = rows.map((row) => parseExecutionPolicyJson(String(row.after_value)));
  const parsedBefore = rows.map((row) => parseExecutionPolicyJson(String(row.before_value)));
  if ([...parsed, ...parsedBefore].some((item) => item.issues.length > 0)) {
    throw new ProvenanceError("policy parser issues");
  }
  const cutoffMs = parseInstantMs(cutoff);
  const selectedIndex = rows.findLastIndex(
    (row) => parseInstantMs(String(row.changed_at)) <= cutoffMs,
  );
  if (selectedIndex < 0) throw new ProvenanceError("policy absent at cutoff");
  const active = parsed[selectedIndex]!.policy.bounceExit;
  if (!active.applyToAllMarkets) {
    throw new ProvenanceError("policy was not applied to all markets at cutoff");
  }
  const bounceExit = selectedPolicyFields(active);
  const effective = JSON.stringify(bounceExit);
  const definition = policyDefinition(active);
  let rawContinuityBreaks = 0;
  for (let index = 1; index < rows.length; index++) {
    const rawBreak = rows[index]!.before_value !== rows[index - 1]!.after_value;
    const semanticBreak =
      policyDefinition(parsedBefore[index]!.policy.bounceExit) !==
      policyDefinition(parsed[index - 1]!.policy.bounceExit);
    if (index > selectedIndex && rawBreak) {
      throw new ProvenanceError("exact policy history is discontinuous after cutoff");
    }
    if (index <= selectedIndex && rawBreak) rawContinuityBreaks++;
    if (index > selectedIndex && semanticBreak) {
      throw new ProvenanceError("semantic policy history is discontinuous after cutoff");
    }
  }
  const drifted = parsed
    .slice(selectedIndex)
    .some((item) => policyDefinition(item.policy.bounceExit) !== definition);
  if (drifted) throw new ProvenanceError("recorded policy drift after cutoff");
  return {
    selectedHistoryId: finite(rows[selectedIndex]!.id, "policy history id"),
    stableHistoryStartId: finite(rows[selectedIndex]!.id, "stable policy history id"),
    historyHighWater: highWater,
    auditedHistoryOnly: true,
    semanticLadderContinuity: true,
    rawContinuityBreaks,
    fingerprint: createHash("sha256").update(effective).digest("hex"),
    bounceExit,
  };
}

function emptyMetric(): PositionMetric {
  return { attemptPositions: 0, acceptedPositions: 0, filledPositions: 0, rows: 0 };
}

function emptyTerminal(): TerminalMetric {
  return {
    positions: 0,
    singleLot: 0,
    multiLot: 0,
    settledPositions: 0,
    heldToZero: 0,
    cost: 0,
    realizedPnl: 0,
    roiPct: [],
  };
}

function accepted(order: Row): boolean {
  return Boolean(String(order.exchange_order_id ?? "").trim());
}

function validatedOrderFills(ledger: Db, order: Row, position: Row, highWater: HighWater): Row[] {
  const fills = exact(
    ledger,
    `SELECT f.rowid,f.fill_id,f.token_id,f.side,f.price,f.size,f.size_usdc,
            o.position_id AS order_position_id,o.token_id AS order_token_id,o.side AS order_side
       FROM fills f INDEXED BY idx_fills_order JOIN orders o ON o.order_id=f.order_id
      WHERE f.order_id=? AND f.rowid<=? AND o.rowid<=?`,
    order.order_id,
    highWater.fills,
    highWater.orders,
  );
  for (const fill of fills) {
    positive(fill.price, "fill price");
    positive(fill.size, "fill size");
    positive(fill.size_usdc, "fill notional");
    if (
      fill.order_position_id !== position.position_id ||
      fill.token_id !== position.token_id ||
      fill.order_token_id !== position.token_id ||
      String(fill.side).toLowerCase() !== "sell" ||
      String(fill.order_side).toLowerCase() !== "sell"
    ) {
      throw new ProvenanceError("exit fill ownership mismatch");
    }
  }
  return fills;
}

function addPositionMetric(
  ledger: Db,
  output: PositionMetric,
  orders: Row[],
  position: Row,
  highWater: HighWater,
): void {
  output.rows += orders.length;
  if (orders.length > 0) output.attemptPositions++;
  if (orders.some(accepted)) output.acceptedPositions++;
  if (orders.some((order) => validatedOrderFills(ledger, order, position, highWater).length > 0)) {
    output.filledPositions++;
  }
}

function validateBuyLot(ledger: Db, lot: Row, position: Row, highWater: HighWater): number {
  positive(lot.size, "lot size");
  positive(lot.entry_price, "lot entry");
  const cost = positive(lot.cost_usdc, "lot cost");
  if (
    lot.position_id !== position.position_id ||
    lot.token_id !== position.token_id ||
    String(lot.side).toLowerCase() !== "buy"
  ) {
    throw new ProvenanceError("lot ownership mismatch");
  }
  const rows = exact(
    ledger,
    `SELECT f.token_id AS fill_token_id,f.side AS fill_side,f.price,f.size,f.size_usdc,
            o.token_id AS order_token_id,o.position_id AS order_position_id,o.side AS order_side
       FROM fills f JOIN orders o ON o.order_id=f.order_id
      WHERE f.fill_id=? AND f.rowid<=? AND o.rowid<=?`,
    lot.fill_id,
    highWater.fills,
    highWater.orders,
  );
  const provenance = rows[0];
  if (
    rows.length !== 1 ||
    provenance!.fill_token_id !== position.token_id ||
    provenance!.order_token_id !== position.token_id ||
    (provenance!.order_position_id !== null &&
      provenance!.order_position_id !== position.position_id) ||
    String(provenance!.fill_side).toLowerCase() !== "buy" ||
    String(provenance!.order_side).toLowerCase() !== "buy"
  ) {
    throw new ProvenanceError("lot lacks exact buy provenance");
  }
  positive(provenance!.price, "buy fill price");
  positive(provenance!.size, "buy fill size");
  positive(provenance!.size_usdc, "buy fill notional");
  return cost;
}

function validateSellPnl(
  ledger: Db,
  position: Row,
  highWater: HighWater,
  terminalRows: TerminalRows,
): number {
  const sells = exact(
    ledger,
    `SELECT f.fill_id,f.token_id AS fill_token_id,f.price,f.size,f.size_usdc,
            o.token_id AS order_token_id,o.side AS order_side
       FROM orders o INDEXED BY idx_orders_position
       JOIN fills f INDEXED BY idx_fills_order ON o.order_id=f.order_id
      WHERE o.position_id=? AND f.rowid<=? AND o.rowid<=? AND lower(f.side)='sell'`,
    position.position_id,
    highWater.fills,
    highWater.orders,
  );
  for (const sell of sells) {
    positive(sell.price, "sell fill price");
    positive(sell.size, "sell fill size");
    positive(sell.size_usdc, "sell fill notional");
    if (
      sell.fill_token_id !== position.token_id ||
      sell.order_token_id !== position.token_id ||
      String(sell.order_side).toLowerCase() !== "sell"
    ) {
      throw new ProvenanceError("sell fill ownership mismatch");
    }
    const pnl = terminalRows.pnlByFill.get(String(sell.fill_id)) ?? [];
    if (pnl.length !== 1 || pnl[0]!.position_id !== position.position_id) {
      throw new ProvenanceError("sell lacks exact pnl provenance");
    }
    finite(pnl[0]!.delta, "pnl delta");
  }
  const pnlRows = terminalRows.pnlByPosition.get(String(position.position_id)) ?? [];
  if (pnlRows.length !== sells.length) {
    throw new ProvenanceError("terminal has non-sell pnl provenance");
  }
  return sells.length;
}

function validatedSettlements(position: Row, terminalRows: TerminalRows): Row[] {
  const settlements = terminalRows.settlementsByPosition.get(String(position.position_id)) ?? [];
  for (const settlement of settlements) {
    if (settlement.token_id !== position.token_id) {
      throw new ProvenanceError("settlement ownership mismatch");
    }
    finite(settlement.settlement_price, "settlement price");
    finite(settlement.delta, "settlement delta");
  }
  return settlements;
}

function requireTerminalAgreement(pnl: Row[], realized: number, settlementDelta: number): void {
  const sum = pnl.reduce((total, row) => total + finite(row.delta, "terminal pnl sum"), 0);
  if (Math.abs(sum + settlementDelta - realized) > 1e-6) {
    throw new ProvenanceError("terminal pnl disagreement");
  }
}

function addTerminalMetric(
  output: TerminalMetric,
  lots: Row[],
  cost: number,
  realized: number,
  sellCount: number,
  settlementCount: number,
): void {
  const roiPct = (realized / cost) * 100;
  output.positions++;
  output.cost += cost;
  output.realizedPnl += realized;
  output.roiPct.push(roiPct);
  if (lots.length === 1) output.singleLot++;
  else output.multiLot++;
  if (settlementCount > 0) output.settledPositions++;
  if (sellCount === 0 && settlementCount > 0 && roiPct <= -99.5) output.heldToZero++;
}

function recordTerminal(
  ledger: Db,
  position: Row,
  highWater: HighWater,
  terminalRows: TerminalRows,
  output: TerminalMetric,
): void {
  const lots = exact(
    ledger,
    "SELECT rowid,* FROM inventory_lots INDEXED BY idx_inventory_lots_position WHERE position_id=? AND rowid<=?",
    position.position_id,
    highWater.inventoryLots,
  );
  if (lots.length === 0) throw new ProvenanceError("closed position lacks lots");
  if (new Set(lots.map((lot) => lot.fill_id)).size !== lots.length) {
    throw new ProvenanceError("duplicate lot fill provenance");
  }
  const cost = lots.reduce((sum, lot) => sum + validateBuyLot(ledger, lot, position, highWater), 0);
  const sellCount = validateSellPnl(ledger, position, highWater, terminalRows);
  const settlements = validatedSettlements(position, terminalRows);
  const settlementDelta = settlements.reduce(
    (sum, settlement) => sum + Number(settlement.delta),
    0,
  );
  const realized = finite(position.realized_pnl, "position realized pnl");
  requireTerminalAgreement(
    terminalRows.pnlByPosition.get(String(position.position_id)) ?? [],
    realized,
    settlementDelta,
  );
  addTerminalMetric(output, lots, cost, realized, sellCount, settlements.length);
}

type ParsedTarget = { order: Row; rung: Rung; fills: Row[] };
type RungStats = Map<number, { reach: Set<string>; accept: Set<string>; fill: Set<string> }>;
type BundleGroups = Map<string, { positionId: string; orders: ParsedTarget[] }>;

function parseTargets(
  ledger: Db,
  position: Row,
  orders: Row[],
  rungCount: number,
  highWater: HighWater,
): ParsedTarget[] {
  return orders
    .filter(
      (order) => order.decision_rule_id === TARGET && String(order.side).toLowerCase() === "sell",
    )
    .map((order) => ({
      order,
      rung: parseRung(order, rungCount),
      fills: validatedOrderFills(ledger, order, position, highWater),
    }));
}

function recordTarget(
  item: ParsedTarget,
  positionId: string,
  stats: RungStats,
  bundles: BundleGroups,
): void {
  const { order, rung, fills } = item;
  if (rung.covered.length > 1) {
    const key = `${positionId}:${rung.ladderId}:${rung.anchor}:${rung.covered.join(",")}`;
    const group = bundles.get(key) ?? { positionId, orders: [] };
    group.orders.push(item);
    bundles.set(key, group);
  }
  for (const index of rung.covered) {
    const current = stats.get(index) ?? {
      reach: new Set<string>(),
      accept: new Set<string>(),
      fill: new Set<string>(),
    };
    current.reach.add(positionId);
    if (accepted(order)) current.accept.add(positionId);
    if (rung.covered.length === 1 && fills.length > 0) current.fill.add(positionId);
    stats.set(index, current);
  }
}

function collectTargetMetrics(
  ledger: Db,
  position: Row,
  orders: Row[],
  rungCount: number,
  highWater: HighWater,
  stats: RungStats,
  bundles: BundleGroups,
  cleanup: PositionMetric,
): { attempted: boolean; filled: boolean; rows: number } {
  const positionId = String(position.position_id);
  const parsed = parseTargets(ledger, position, orders, rungCount, highWater);
  const identities = new Set(parsed.map(({ rung }) => `${rung.ladderId}:${rung.anchor}`));
  if (identities.size > 1) throw new ProvenanceError("multiple ladder ids or anchors");
  addPositionMetric(
    ledger,
    cleanup,
    parsed.filter(({ rung }) => rung.cleanup).map(({ order }) => order),
    position,
    highWater,
  );
  const ordinary = parsed.filter(({ rung }) => !rung.cleanup);
  ordinary.forEach((item) => recordTarget(item, positionId, stats, bundles));
  return {
    attempted: ordinary.length > 0,
    filled: ordinary.some(({ fills }) => fills.length > 0),
    rows: parsed.length,
  };
}

function validateExitOrders(orders: Row[], position: Row): void {
  const exits = orders.filter(
    (order) => order.decision_rule_id === TARGET || order.decision_rule_id === BACKSTOP,
  );
  if (
    exits.some(
      (order) =>
        String(order.side).toLowerCase() !== "sell" || order.token_id !== position.token_id,
    )
  ) {
    throw new ProvenanceError("exit order ownership mismatch");
  }
}

function summarizeBundles(bundleGroups: BundleGroups) {
  const output = {
    positions: 0,
    bundles: bundleGroups.size,
    logicalIndicesCovered: 0,
    rawRows: 0,
    accepted: 0,
    filled: 0,
    fillCount: 0,
    shares: 0,
    proceeds: 0,
  };
  const positions = new Set<string>();
  for (const group of bundleGroups.values()) {
    positions.add(group.positionId);
    output.logicalIndicesCovered += group.orders[0]!.rung.covered.length;
    output.rawRows += group.orders.length;
    if (group.orders.some(({ order }) => accepted(order))) output.accepted++;
    const fills = group.orders.flatMap((item) => item.fills);
    if (fills.length > 0) {
      output.filled++;
      output.fillCount += fills.length;
      output.shares += fills.reduce((sum, fill) => sum + Number(fill.size), 0);
      output.proceeds += fills.reduce((sum, fill) => sum + Number(fill.size_usdc), 0);
    }
  }
  output.positions = positions.size;
  return output;
}

function emptyCohort(positionCount: number, bounceCount: number) {
  return {
    positions: positionCount,
    bounceOwnedPositions: bounceCount,
    bounceEntryLanes: [] as Array<{ entryLane: string; positions: number }>,
    targetRows: 0,
    targetLogicalRungs: 0,
    targetPositions: 0,
    targetFilledPositions: 0,
    targetRungs: [] as Array<{
      rungIndex: number;
      reachedPositions: number;
      acceptedPositions: number;
      filledPositions: number;
    }>,
    rolloverBundles: {
      positions: 0,
      bundles: 0,
      logicalIndicesCovered: 0,
      rawRows: 0,
      accepted: 0,
      filled: 0,
      fillCount: 0,
      shares: 0,
      proceeds: 0,
    },
    cleanup: emptyMetric(),
    backstop: emptyMetric(),
    terminal: emptyTerminal(),
  };
}

function measureBouncePosition(
  ledger: Db,
  position: Row,
  highWater: HighWater,
  terminalRows: TerminalRows,
  rungCount: number,
  output: ReturnType<typeof emptyCohort>,
  lanes: Map<string, number>,
  stats: RungStats,
  bundles: BundleGroups,
): void {
  const lane = String(position.entry_lane ?? "NULL");
  lanes.set(lane, (lanes.get(lane) ?? 0) + 1);
  const orders = exact(
    ledger,
    "SELECT rowid,* FROM orders INDEXED BY idx_orders_position WHERE position_id=? AND rowid<=?",
    position.position_id,
    highWater.orders,
  );
  validateExitOrders(orders, position);
  const target = collectTargetMetrics(
    ledger,
    position,
    orders,
    rungCount,
    highWater,
    stats,
    bundles,
    output.cleanup,
  );
  if (target.attempted) output.targetPositions++;
  if (target.filled) output.targetFilledPositions++;
  output.targetRows += target.rows;
  const backstops = orders.filter((order) => order.decision_rule_id === BACKSTOP);
  addPositionMetric(ledger, output.backstop, backstops, position, highWater);
  if (position.status === "closed") {
    recordTerminal(ledger, position, highWater, terminalRows, output.terminal);
  }
}

function finalizeCohort(
  output: ReturnType<typeof emptyCohort>,
  lanes: Map<string, number>,
  stats: RungStats,
  bundles: BundleGroups,
): void {
  output.bounceEntryLanes = [...lanes]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryLane, positions]) => ({ entryLane, positions }));
  output.targetRungs = [...stats]
    .sort(([left], [right]) => left - right)
    .map(([rungIndex, value]) => ({
      rungIndex,
      reachedPositions: value.reach.size,
      acceptedPositions: value.accept.size,
      filledPositions: value.fill.size,
    }));
  output.targetLogicalRungs = [...stats.values()].reduce((sum, value) => sum + value.reach.size, 0);
  output.rolloverBundles = summarizeBundles(bundles);
  output.terminal.roiPct.sort((left, right) => left - right);
}

function measureCohort(
  ledger: Db,
  cutoff: string,
  highWater: HighWater,
  terminalRows: TerminalRows,
  rungCount: number,
) {
  const allPositions = exact(
    ledger,
    `SELECT rowid,* FROM positions WHERE rowid<=? AND ${ledgerInstant("opened_at")}>=${ledgerInstant("?")}`,
    highWater.positions,
    cutoff,
  );
  const bouncePositions = allPositions.filter((position) => position.exit_owner === "bounce");
  const output = emptyCohort(allPositions.length, bouncePositions.length);
  const lanes = new Map<string, number>();
  const stats: RungStats = new Map();
  const bundles: BundleGroups = new Map();
  for (const position of bouncePositions) {
    measureBouncePosition(
      ledger,
      position,
      highWater,
      terminalRows,
      rungCount,
      output,
      lanes,
      stats,
      bundles,
    );
  }
  finalizeCohort(output, lanes, stats, bundles);
  return output;
}

function captureHighWater(ledger: Db, control: Db): HighWater {
  return {
    positions: maxRowid(ledger, "positions"),
    orders: maxRowid(ledger, "orders"),
    fills: maxRowid(ledger, "fills"),
    inventoryLots: maxRowid(ledger, "inventory_lots"),
    pnlLedger: maxRowid(ledger, "pnl_ledger"),
    settlementLedger: maxRowid(ledger, "settlement_ledger"),
    policyHistory: maxRowid(control, "profile_settings_history"),
  };
}

function groupRows(rows: Row[], key: string): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const value = String(row[key]);
    grouped.set(value, [...(grouped.get(value) ?? []), row]);
  }
  return grouped;
}

function preloadTerminalRows(ledger: Db, highWater: HighWater): TerminalRows {
  const pnl = exact(
    ledger,
    "SELECT fill_id,position_id,delta FROM pnl_ledger WHERE rowid<=?",
    highWater.pnlLedger,
  );
  const settlements = exact(
    ledger,
    "SELECT position_id,token_id,settlement_price,delta FROM settlement_ledger WHERE rowid<=?",
    highWater.settlementLedger,
  );
  return {
    pnlByFill: groupRows(pnl, "fill_id"),
    pnlByPosition: groupRows(pnl, "position_id"),
    settlementsByPosition: groupRows(settlements, "position_id"),
  };
}

function freezeHighWater(
  captured: HighWater,
  requested: Partial<HighWater> | undefined,
): HighWater {
  for (const [key, value] of Object.entries(requested ?? {})) {
    const upper = captured[key as keyof HighWater];
    if (value === undefined || !Number.isInteger(value) || value <= 0 || value > upper) {
      throw new ProvenanceError(`invalid frozen high water: ${key}`);
    }
  }
  return { ...captured, ...requested };
}

function requireMigration101(ledger: Db): void {
  const count = Number(
    (
      ledger
        .prepare("SELECT COUNT(*) value FROM schema_migrations WHERE name=?")
        .get(MIGRATION_101) as Row
    ).value,
  );
  if (count !== 1) throw new ProvenanceError("migration 101 provenance absent");
}

function requireMeasurementSchema(ledger: Db, control: Db): void {
  requireTables(ledger, [
    "positions",
    "orders",
    "fills",
    "inventory_lots",
    "pnl_ledger",
    "settlement_ledger",
    "schema_migrations",
  ]);
  requireTables(control, ["profile_settings", "profile_settings_history"]);
  requireIndex(ledger, "orders", "idx_orders_position", ["position_id"]);
  requireIndex(ledger, "fills", "idx_fills_order", ["order_id"]);
  requireIndex(ledger, "inventory_lots", "idx_inventory_lots_position", ["position_id"]);
  requireIndex(ledger, "pnl_ledger", "idx_pnl_ledger_fill_unique", ["fill_id"]);
  requireIndex(control, "profile_settings_history", "idx_profile_settings_history_field_ts", [
    "profile_id",
    "field",
    "changed_at",
    "id",
  ]);
}

function measureBody(
  options: AnalyzeOptions,
  ledger: Db,
  control: Db,
  historicalCutoff: string,
  strictCutoff: string,
) {
  const observedAt = String(
    (ledger.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') now").get() as Row).now,
  );
  const highWater = freezeHighWater(captureHighWater(ledger, control), options.highWater);
  options.onHighWaterCaptured?.();
  requireMigration101(ledger);
  const policy = auditedPolicy(control, options.profile, historicalCutoff, highWater.policyHistory);
  const rungCount = policy.bounceExit.ladderFractions.length;
  const terminalRows = preloadTerminalRows(ledger, highWater);
  const cohorts = {
    allMarketsHistorical: measureCohort(
      ledger,
      historicalCutoff,
      highWater,
      terminalRows,
      rungCount,
    ),
    post137bStrict: measureCohort(ledger, strictCutoff, highWater, terminalRows, rungCount),
  };
  const body = {
    schemaVersion: 1,
    source: {
      releaseSha: options.releaseSha,
      migration101Applied: true,
      historicalCutoff,
      strictCutoff,
      highWater,
      rowidBoundsAreNotHistoricalReproduction: true,
    },
    provenance: {
      readOnly: true,
      explicitTransactions: true,
      auditedHistoryOnly: true,
      rawIdentifiersExcluded: true,
      observerAugustCoverage: "none",
    },
    policy,
    cohorts,
    status:
      cohorts.post137bStrict.terminal.positions === 0
        ? "MEASURABLE_READOUT_PREMATURE"
        : "REQUIRES_FRESH_ASSESSMENT",
    groundingComparison: GROUNDING,
  };
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { observedAt, digest, ...body };
}

function inReadTransactions<T>(ledger: Db, control: Db, operation: () => T): T {
  ledger.exec("BEGIN");
  control.exec("BEGIN");
  try {
    const result = operation();
    ledger.exec("COMMIT");
    control.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      ledger.exec("ROLLBACK");
      control.exec("ROLLBACK");
    } catch (rollbackError) {
      void rollbackError;
    }
    throw error;
  }
}

export function analyze(options: AnalyzeOptions) {
  const historicalCutoff = canonicalTimestamp(options.historicalCutoff);
  const strictCutoff = canonicalTimestamp(options.strictCutoff);
  if (!SHA_PATTERN.test(options.releaseSha)) {
    throw new ProvenanceError("release SHA must be a lowercase 40-character git hash");
  }
  const ledger = openReadOnly(options.ledger);
  const control = openReadOnly(options.control);
  try {
    requireMeasurementSchema(ledger, control);
    return inReadTransactions(ledger, control, () =>
      measureBody(options, ledger, control, historicalCutoff, strictCutoff),
    );
  } finally {
    ledger.close();
    control.close();
  }
}

const OBJECT_KEYS: Record<string, string> = {
  snapshot: ROOT.join("|"),
  "snapshot.source":
    "releaseSha|migration101Applied|historicalCutoff|strictCutoff|highWater|rowidBoundsAreNotHistoricalReproduction",
  "snapshot.source.highWater":
    "positions|orders|fills|inventoryLots|pnlLedger|settlementLedger|policyHistory",
  "snapshot.provenance":
    "readOnly|explicitTransactions|auditedHistoryOnly|rawIdentifiersExcluded|observerAugustCoverage",
  "snapshot.policy":
    "selectedHistoryId|stableHistoryStartId|historyHighWater|auditedHistoryOnly|semanticLadderContinuity|rawContinuityBreaks|fingerprint|bounceExit",
  "snapshot.policy.bounceExit":
    "enabled|mode|applyToAllMarkets|targetTiers|ladderFractions|ladderStepPct|backstopTtcHours|microMaxOrderUsdc",
  "snapshot.policy.bounceExit.targetTiers[]": "maxPrice|gainPct",
  "snapshot.cohorts": "allMarketsHistorical|post137bStrict",
  "snapshot.cohorts.*":
    "positions|bounceOwnedPositions|bounceEntryLanes|targetRows|targetLogicalRungs|targetPositions|targetFilledPositions|targetRungs|rolloverBundles|cleanup|backstop|terminal",
  "snapshot.cohorts.*.bounceEntryLanes[]": "entryLane|positions",
  "snapshot.cohorts.*.targetRungs[]":
    "rungIndex|reachedPositions|acceptedPositions|filledPositions",
  "snapshot.cohorts.*.rolloverBundles":
    "positions|bundles|logicalIndicesCovered|rawRows|accepted|filled|fillCount|shares|proceeds",
  "snapshot.cohorts.*.cleanup": "attemptPositions|acceptedPositions|filledPositions|rows",
  "snapshot.cohorts.*.backstop": "attemptPositions|acceptedPositions|filledPositions|rows",
  "snapshot.cohorts.*.terminal":
    "positions|singleLot|multiLot|settledPositions|heldToZero|cost|realizedPnl|roiPct",
  "snapshot.groundingComparison":
    "observedBeforeImplementation|ownerTotalBounce|targetRows|targetPositions|targetFilledPositions|terminalPositions|rungReachAcceptDirectFill|rolloverPositions|cleanupPositions|backstopRowsAcceptFill|roiPct|strictPositionsTerminal",
};

const STRING_LEAVES = new Set(
  "snapshot.observedAt|snapshot.digest|snapshot.source.releaseSha|snapshot.source.historicalCutoff|snapshot.source.strictCutoff|snapshot.provenance.observerAugustCoverage|snapshot.policy.fingerprint|snapshot.policy.bounceExit.mode|snapshot.cohorts.*.bounceEntryLanes[].entryLane|snapshot.status".split(
    "|",
  ),
);
const BOOLEAN_LEAVES = new Set(
  "snapshot.source.migration101Applied|snapshot.source.rowidBoundsAreNotHistoricalReproduction|snapshot.provenance.readOnly|snapshot.provenance.explicitTransactions|snapshot.provenance.auditedHistoryOnly|snapshot.provenance.rawIdentifiersExcluded|snapshot.policy.auditedHistoryOnly|snapshot.policy.semanticLadderContinuity|snapshot.policy.bounceExit.enabled|snapshot.policy.bounceExit.applyToAllMarkets|snapshot.groundingComparison.observedBeforeImplementation".split(
    "|",
  ),
);
const ARRAY_PATHS = new Set(
  "snapshot.policy.bounceExit.targetTiers|snapshot.policy.bounceExit.ladderFractions|snapshot.cohorts.*.bounceEntryLanes|snapshot.cohorts.*.targetRungs|snapshot.cohorts.*.terminal.roiPct|snapshot.groundingComparison.ownerTotalBounce|snapshot.groundingComparison.rungReachAcceptDirectFill|snapshot.groundingComparison.rungReachAcceptDirectFill[]|snapshot.groundingComparison.backstopRowsAcceptFill|snapshot.groundingComparison.roiPct|snapshot.groundingComparison.strictPositionsTerminal".split(
    "|",
  ),
);
const COUNT_KEYS = new Set(
  "schemaVersion|positions|orders|fills|inventoryLots|pnlLedger|settlementLedger|policyHistory|selectedHistoryId|stableHistoryStartId|historyHighWater|rawContinuityBreaks|targetRows|targetLogicalRungs|targetPositions|targetFilledPositions|rungIndex|reachedPositions|acceptedPositions|filledPositions|logicalIndicesCovered|bundles|rawRows|accepted|filled|fillCount|attemptPositions|rows|singleLot|multiLot|settledPositions|heldToZero".split(
    "|",
  ),
);

const schemaPath = (path: string): string =>
  path.replace(/snapshot\.cohorts\.(allMarketsHistorical|post137bStrict)/, "snapshot.cohorts.*");

function allowed(value: unknown, path = "snapshot"): void {
  const normalized = schemaPath(path);
  if (Array.isArray(value)) {
    if (!ARRAY_PATHS.has(normalized)) throw new ProvenanceError(`${path} must not be array`);
    value.forEach((item) => allowed(item, `${path}[]`));
    return;
  }
  if (value && typeof value === "object") {
    const expected = OBJECT_KEYS[normalized]?.split("|");
    if (!expected) throw new ProvenanceError(`${path} has no public schema`);
    const actual = Object.keys(value);
    if (actual.length !== expected.length || expected.some((key) => !(key in (value as Row)))) {
      throw new ProvenanceError(`${path} has non-public fields`);
    }
    expected.forEach((key) => allowed((value as Row)[key], `${path}.${key}`));
    return;
  }
  if (ARRAY_PATHS.has(normalized)) throw new ProvenanceError(`${path} must be array`);
  const expectedType = STRING_LEAVES.has(normalized)
    ? "string"
    : BOOLEAN_LEAVES.has(normalized)
      ? "boolean"
      : "number";
  if (typeof value !== expectedType || (expectedType === "number" && !Number.isFinite(value))) {
    throw new ProvenanceError(`${path} must be ${expectedType}`);
  }
  const key = path.split(".").at(-1)!.replace("[]", "");
  if (expectedType === "number" && COUNT_KEYS.has(key) && !isCount(value)) {
    throw new ProvenanceError(`${path} must be a nonnegative integer`);
  }
}

const requireSemantic = (condition: boolean, message: string): void => {
  if (!condition) throw new ProvenanceError(`invalid snapshot semantics: ${message}`);
};

const isCount = (value: unknown): boolean => Number.isInteger(value) && Number(value) >= 0;

function validateMetric(value: Row, ownerCount: number): void {
  const {
    attemptPositions: attempt,
    acceptedPositions: accepted,
    filledPositions: filled,
    rows,
  } = value;
  requireSemantic(
    Number(filled) <= Number(accepted) &&
      Number(accepted) <= Number(attempt) &&
      Number(attempt) <= ownerCount &&
      Number(attempt) <= Number(rows),
    "metric relationships",
  );
}

function validateTerminal(value: Row, ownerCount: number): void {
  const positions = Number(value.positions);
  requireSemantic(
    positions <= ownerCount &&
      Number(value.singleLot) + Number(value.multiLot) === positions &&
      Number(value.heldToZero) <= Number(value.settledPositions) &&
      Number(value.settledPositions) <= positions &&
      (value.roiPct as unknown[]).length === positions &&
      Number(value.cost) >= 0 &&
      (positions === 0 || Number(value.cost) > 0),
    "terminal relationships",
  );
}

function validateCohort(value: Row, rungCount: number): void {
  const owners = Number(value.bounceOwnedPositions);
  requireSemantic(owners <= Number(value.positions), "cohort ownership");
  const lanes = value.bounceEntryLanes as Row[];
  requireSemantic(
    lanes.every((row) => ["GATE", "R23", "NULL"].includes(String(row.entryLane))) &&
      lanes.every((row) => isCount(row.positions)) &&
      new Set(lanes.map((row) => row.entryLane)).size === lanes.length &&
      lanes.reduce((sum, row) => sum + Number(row.positions), 0) === owners,
    "entry lanes",
  );
  const rungs = value.targetRungs as Row[];
  requireSemantic(
    rungs.every(
      (row) =>
        Number(row.rungIndex) < rungCount &&
        Number(row.filledPositions) <= Number(row.acceptedPositions) &&
        Number(row.acceptedPositions) <= Number(row.reachedPositions) &&
        Number(row.reachedPositions) <= owners,
    ) &&
      new Set(rungs.map((row) => row.rungIndex)).size === rungs.length &&
      Number(value.targetLogicalRungs) ===
        rungs.reduce((sum, row) => sum + Number(row.reachedPositions), 0) &&
      Number(value.targetFilledPositions) <= Number(value.targetPositions) &&
      Number(value.targetPositions) <=
        Math.min(owners, Number(value.targetRows), Number(value.targetLogicalRungs)),
    "target rungs",
  );
  const rollover = value.rolloverBundles as Row;
  const bundles = Number(rollover.bundles);
  requireSemantic(
    Number(rollover.positions) <= Math.min(bundles, owners) &&
      bundles <= Number(rollover.rawRows) &&
      Number(rollover.filled) <= Number(rollover.accepted) &&
      Number(rollover.accepted) <= bundles &&
      Number(rollover.fillCount) >= Number(rollover.filled) &&
      Number(rollover.logicalIndicesCovered) >= bundles * 2 &&
      Number(rollover.logicalIndicesCovered) <= bundles * rungCount &&
      Number(rollover.shares) >= 0 &&
      Number(rollover.proceeds) >= 0,
    "rollover relationships",
  );
  validateMetric(value.cleanup as Row, owners);
  validateMetric(value.backstop as Row, owners);
  validateTerminal(value.terminal as Row, owners);
}

function validatePolicy(value: Row, historyHighWater: number): number {
  const bounce = value.bounceExit as Row;
  requireSemantic(
    value.auditedHistoryOnly === true &&
      value.semanticLadderContinuity === true &&
      value.selectedHistoryId === value.stableHistoryStartId &&
      Number.isInteger(value.selectedHistoryId) &&
      Number(value.selectedHistoryId) > 0 &&
      value.historyHighWater === historyHighWater &&
      Number(value.selectedHistoryId) <= historyHighWater &&
      isCount(value.rawContinuityBreaks),
    "policy provenance",
  );
  const parsed = parseExecutionPolicyJson(JSON.stringify({ bounceExit: bounce }));
  requireSemantic(
    parsed.issues.length === 0 &&
      JSON.stringify(selectedPolicyFields(parsed.policy.bounceExit)) === JSON.stringify(bounce) &&
      bounce.enabled === true &&
      bounce.mode === "micro_live" &&
      bounce.applyToAllMarkets === true,
    "policy values",
  );
  const fingerprint = createHash("sha256").update(JSON.stringify(bounce)).digest("hex");
  requireSemantic(value.fingerprint === fingerprint, "policy fingerprint");
  return (bounce.ladderFractions as number[]).length;
}

function fieldsLe(subset: Row, superset: Row, fields: string): boolean {
  return fields.split("|").every((field) => Number(subset[field]) <= Number(superset[field]));
}

function keyedLe(subset: Row[], superset: Row[], key: string, fields: string): boolean {
  const indexed = new Map(superset.map((row) => [row[key], row]));
  return subset.every((row) => fieldsLe(row, indexed.get(row[key]) ?? {}, fields));
}

function validateCrossCohort(historical: Row, strict: Row, fillHighWater: number): void {
  const metrics = "attemptPositions|acceptedPositions|filledPositions|rows";
  const root =
    "positions|bounceOwnedPositions|targetRows|targetLogicalRungs|targetPositions|targetFilledPositions";
  const rungs = "reachedPositions|acceptedPositions|filledPositions";
  const rollovers = "positions|bundles|logicalIndicesCovered|rawRows|accepted|filled|fillCount";
  const nestedLe = (field: string, fields: string) =>
    fieldsLe(strict[field] as Row, historical[field] as Row, fields);
  requireSemantic(
    fieldsLe(strict, historical, root) &&
      keyedLe(
        strict.bounceEntryLanes as Row[],
        historical.bounceEntryLanes as Row[],
        "entryLane",
        "positions",
      ) &&
      keyedLe(strict.targetRungs as Row[], historical.targetRungs as Row[], "rungIndex", rungs) &&
      nestedLe("rolloverBundles", rollovers) &&
      nestedLe("cleanup", metrics) &&
      nestedLe("backstop", metrics) &&
      nestedLe("terminal", "positions|singleLot|multiLot|settledPositions|heldToZero"),
    "strict cohort subset",
  );
  const direct = (historical.targetRungs as Row[]).reduce(
    (sum, row) => sum + Number(row.filledPositions),
    0,
  );
  const rollover = historical.rolloverBundles as Row;
  const requiredRows =
    direct +
    Number(rollover.fillCount) +
    Number((historical.cleanup as Row).filledPositions) +
    Number((historical.backstop as Row).filledPositions);
  requireSemantic(
    requiredRows <= fillHighWater &&
      Number(historical.targetFilledPositions) <= direct + Number(rollover.filled),
    "fill high-water",
  );
}

export function validateSnapshot(value: unknown): asserts value is Row {
  allowed(value);
  const snapshot = value as Row;
  if (
    snapshot.schemaVersion !== 1 ||
    !DIGEST_PATTERN.test(String(snapshot.digest)) ||
    !SHA_PATTERN.test(String((snapshot.source as Row).releaseSha))
  ) {
    throw new ProvenanceError("invalid snapshot envelope");
  }
  const source = snapshot.source as Row;
  const provenance = snapshot.provenance as Row;
  const highWater = source.highWater as Row;
  requireSemantic(
    source.migration101Applied === true &&
      source.rowidBoundsAreNotHistoricalReproduction === true &&
      Object.values(highWater).every(isCount) &&
      provenance.readOnly === true &&
      provenance.explicitTransactions === true &&
      provenance.auditedHistoryOnly === true &&
      provenance.rawIdentifiersExcluded === true &&
      provenance.observerAugustCoverage === "none",
    "source provenance",
  );
  for (const timestamp of [snapshot.observedAt, source.historicalCutoff, source.strictCutoff]) {
    requireSemantic(canonicalTimestamp(String(timestamp)) === timestamp, "canonical timestamp");
  }
  requireSemantic(
    parseInstantMs(String(source.historicalCutoff)) <=
      parseInstantMs(String(source.strictCutoff)) &&
      parseInstantMs(String(source.strictCutoff)) <= parseInstantMs(String(snapshot.observedAt)),
    "cutoff ordering",
  );
  const rungCount = validatePolicy(snapshot.policy as Row, Number(highWater.policyHistory));
  const cohorts = snapshot.cohorts as Row;
  validateCohort(cohorts.allMarketsHistorical as Row, rungCount);
  validateCohort(cohorts.post137bStrict as Row, rungCount);
  const strictTerminal = ((cohorts.post137bStrict as Row).terminal as Row).positions;
  requireSemantic(
    snapshot.status ===
      (strictTerminal === 0 ? "MEASURABLE_READOUT_PREMATURE" : "REQUIRES_FRESH_ASSESSMENT") &&
      JSON.stringify(snapshot.groundingComparison) === JSON.stringify(GROUNDING),
    "status or grounding",
  );
  const historical = cohorts.allMarketsHistorical as Row;
  validateCrossCohort(historical, cohorts.post137bStrict as Row, Number(highWater.fills));
  requireSemantic(
    Number(historical.positions) <= Number(highWater.positions) &&
      Number(historical.targetRows) + Number((historical.backstop as Row).rows) <=
        Number(highWater.orders) &&
      Number((historical.terminal as Row).positions) <= Number(highWater.inventoryLots),
    "high-water relationships",
  );
  const { observedAt: _observedAt, digest, ...payload } = snapshot;
  const actual = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  if (actual !== digest) throw new ProvenanceError("snapshot digest mismatch");
}

const printable = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : String(value);

function renderCohortDetails(name: string, cohort: Row): string {
  const terminal = cohort.terminal as Row;
  const rollover = cohort.rolloverBundles as Row;
  const cleanup = cohort.cleanup as Row;
  const backstop = cohort.backstop as Row;
  const lanes = (cohort.bounceEntryLanes as Row[])
    .map((row) => `${row.entryLane}=${row.positions}`)
    .join(", ");
  const rungs = (cohort.targetRungs as Row[])
    .map(
      (row) =>
        `${row.rungIndex}:${row.reachedPositions}/${row.acceptedPositions}/${row.filledPositions}`,
    )
    .join(", ");
  return [
    `- ${name} entry lanes: ${lanes || "none"}; ${cohort.targetRows} raw target rows dedupe to ${cohort.targetLogicalRungs} position/rung observations.`,
    `- ${name} direct rung reach/accept/fill: ${rungs || "none"}.`,
    `- ${name} rollover: ${rollover.positions} positions / ${rollover.bundles} logical bundles covering ${rollover.logicalIndicesCovered} indices / ${rollover.rawRows} rows; accepted ${rollover.accepted}, filled ${rollover.filled}, ${printable(rollover.shares)} shares, $${printable(rollover.proceeds)} proceeds.`,
    `- ${name} cleanup: ${cleanup.attemptPositions} attempted positions, ${cleanup.acceptedPositions} accepted, ${cleanup.filledPositions} filled (${cleanup.rows} rows).`,
    `- ${name} backstop: ${backstop.attemptPositions} attempted positions, ${backstop.acceptedPositions} accepted, ${backstop.filledPositions} filled (${backstop.rows} rows).`,
    `- ${name} terminal: ${terminal.positions}; cost $${printable(terminal.cost)}, realized PnL $${printable(terminal.realizedPnl)}, single/multi-lot ${terminal.singleLot}/${terminal.multiLot}, settled ${terminal.settledPositions}, held-to-zero ${terminal.heldToZero}; ROI [${(terminal.roiPct as number[]).map((item) => `${printable(item)}%`).join(", ")}].`,
  ].join("\n");
}

export function renderSnapshot(value: unknown): string {
  validateSnapshot(value);
  const snapshot = value;
  const source = snapshot.source as Row;
  const provenance = snapshot.provenance as Row;
  const measuredPolicy = (snapshot.policy as Row).bounceExit as Row;
  const cohorts = snapshot.cohorts as Row;
  const historical = cohorts.allMarketsHistorical as Row;
  const strict = cohorts.post137bStrict as Row;
  const tiers = (measuredPolicy.targetTiers as Row[])
    .map((tier) => `max price ${tier.maxPrice}: +${Number(tier.gainPct) * 100}%`)
    .join("; ");
  const grounding = snapshot.groundingComparison as Row;
  return `# Bounce-exit realization — 2026-08-14

Status: **${snapshot.status}**

Observed at ${snapshot.observedAt}; release \`${source.releaseSha}\`; migration 101 applied: ${source.migration101Applied}. Snapshot digest: \`${snapshot.digest}\`.

Cutoffs: all-markets ${source.historicalCutoff}; strict post-#137b ${source.strictCutoff}. High waters: \`${JSON.stringify(source.highWater)}\`.

Sources: production \`ledger-live-lite.db\` and \`control.db\`, both opened read-only. The report contains no position, token, order, fill, or policy-actor identifiers.

## Audited policy

Mode \`${measuredPolicy.mode}\`, enabled=${measuredPolicy.enabled}, applyToAllMarkets=${measuredPolicy.applyToAllMarkets}. Target tiers: ${tiers}. Fractions ${(measuredPolicy.ladderFractions as number[]).join("/")}; ladder step ${Number(measuredPolicy.ladderStepPct) * 100}%; backstop TTC ${measuredPolicy.backstopTtcHours}h; micro cap $${measuredPolicy.microMaxOrderUsdc}. Policy history is append-only audit evidence, not complete change-data capture. Stable measured-policy provenance starts at history id ${(snapshot.policy as Row).stableHistoryStartId}; ${(snapshot.policy as Row).rawContinuityBreaks} older/raw-format continuity breaks are disclosed rather than treated as current policy evidence.

## Cohorts

${renderCohortDetails("All-markets", historical)}
${strict.positions === 0 ? "- Post-#137b: 0 positions; no entry, target, rollover, cleanup, backstop, or terminal evidence." : renderCohortDetails("Post-#137b", strict)}

## Grounding comparison

The pre-implementation read-only census remains a separate comparison, not substituted for this snapshot: ${grounding.ownerTotalBounce} total/bounce-owned, ${grounding.targetRows} raw target rows, ${grounding.targetPositions} target positions, ${grounding.targetFilledPositions} with target fills, ${grounding.terminalPositions} terminal, ${grounding.rolloverPositions} rollover positions, and strict positions/terminal ${grounding.strictPositionsTerminal}. Its terminal ROI values were ${(grounding.roiPct as number[]).join(", ")} percent.

## Interpretation and limitations

- Verdict: **${snapshot.status}**. The mechanism is measurable, but the strict cohort has too little terminal evidence for a profitability decision.
- Next rerun: when strict post-#137b terminal > 0, or on 2026-08-28, whichever comes first.
- This is a point-in-time, read-only pair of explicit SQLite transactions. Rowid bounds exclude later inserts; they cannot reproduce rows mutated after observation.
- Direct rung fill credit is given only to one-rung orders. Rollover bundle execution is reported separately because a multi-rung order cannot be causally allocated to an individual rung.
- Cleanup orders are reported separately and never credited as ordinary ladder execution.
- Backstop rows prove attempt, exchange acceptance, and fill separately. They do not persist TTC mode, trigger reason, or eligibility provenance.
- Multi-lot ROI is an economic cycle result, not a causal estimate for a specific rung.
- The Observer shards have no August overlap (${provenance.observerAugustCoverage}); this report makes no queue-position or order-book inference.
- Byte-exact continuity after the selected cutoff and current binding are checked. Earlier gaps are counted explicitly; an unrecorded mutation reverted before the next audited write remains unknowable.
`;
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1]) {
      throw new ProvenanceError("invalid arguments");
    }
    parsed[argv[index]!.slice(2)] = argv[index + 1]!;
  }
  return parsed;
}

export function runCli(argv: string[]): string {
  const args = parseArgs(argv);
  const snapshotFile = args["validate-snapshot"] ?? args["render-snapshot"];
  if (snapshotFile) {
    if (args["validate-snapshot"] && args["render-snapshot"]) {
      throw new ProvenanceError("choose one snapshot mode");
    }
    const snapshot: unknown = JSON.parse(readFileSync(snapshotFile, "utf8"));
    if (args["validate-snapshot"]) {
      validateSnapshot(snapshot);
      return `SNAPSHOT_VALID schemaVersion=1 digest=${String(snapshot.digest)}\n`;
    }
    return renderSnapshot(snapshot);
  }
  for (const name of [
    "ledger",
    "control",
    "profile",
    "release-sha",
    "historical-cutoff",
    "strict-cutoff",
  ]) {
    if (!args[name]) throw new ProvenanceError(`--${name} is required`);
  }
  const highWater: Partial<HighWater> = {};
  const flags: Record<keyof HighWater, string> = {
    positions: "positions-high-water",
    orders: "orders-high-water",
    fills: "fills-high-water",
    inventoryLots: "inventory-lots-high-water",
    pnlLedger: "pnl-ledger-high-water",
    settlementLedger: "settlement-ledger-high-water",
    policyHistory: "policy-history-high-water",
  };
  for (const [key, flag] of Object.entries(flags) as Array<[keyof HighWater, string]>) {
    if (args[flag]) highWater[key] = Number(args[flag]);
  }
  const snapshot = analyze({
    ledger: args.ledger!,
    control: args.control!,
    profile: args.profile!,
    releaseSha: args["release-sha"]!,
    historicalCutoff: args["historical-cutoff"]!,
    strictCutoff: args["strict-cutoff"]!,
    highWater,
  });
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

if (process.argv[1] === "-" || process.argv[1]?.endsWith("bounce-exit-realization.ts")) {
  process.stdout.write(runCli(process.argv.slice(2)));
}
