import Database from "better-sqlite3";
import {
  parseEntryFreshEdgeAttribution,
  type EntryFreshEdgeAttribution,
  type EntryFreshEdgeShadowClass,
} from "@krabs/domain";

const CLASSES: readonly EntryFreshEdgeShadowClass[] = [
  "FRESH_EDGE_UNKNOWN",
  "PLAUSIBLE_DIP",
  "AFTER_PUMP_EXPENSIVE",
  "FALLING_WITHOUT_RECOVERY",
  "RANGE_DATA_UNAVAILABLE",
];
const REQUIRED_COLUMNS = {
  fills: ["fill_id", "order_id", "token_id", "condition_id", "side", "filled_at"],
  orders: [
    "order_id",
    "token_id",
    "condition_id",
    "side",
    "signal_id",
    "decision_rule_id",
    "metadata_json",
  ],
  inventory_lots: ["position_id", "token_id", "fill_id", "side"],
  positions: ["position_id", "token_id", "condition_id", "status", "realized_pnl", "side"],
  settlement_ledger: ["position_id", "token_id", "condition_id"],
} as const;
interface DataRow {
  position_id: string;
  lot_token_id: string;
  lot_side: string;
  fill_id: string;
  fill_order_id: string;
  fill_token_id: string;
  fill_condition_id: string;
  filled_at: string;
  order_id: string | null;
  order_token_id: string | null;
  order_condition_id: string | null;
  order_side: string | null;
  order_signal_id: string | null;
  order_rule_id: string | null;
  order_metadata_json: string | null;
  first_rank: number;
  fill_lot_count: number;
  position_token_id: string | null;
  position_condition_id: string | null;
  position_side: string | null;
  position_status: string | null;
  realized_pnl: number | null;
  settlement_count: number;
  settlement_token_min: string | null;
  settlement_token_max: string | null;
  settlement_condition_min: string | null;
  settlement_condition_max: string | null;
  origin_order_count: number;
  origin_metadata_json: string | null;
}
interface OutcomeRow {
  positionId: string;
  shadowClass: EntryFreshEdgeShadowClass;
  realizedPnl: number;
}
interface Aggregate {
  count: number;
  wins: number;
  flats: number;
  losses: number;
  totalRealizedPnl: number;
}
export interface EntryFreshEdgeOutcomeReport {
  schemaVersion: 1;
  cohortStart: string;
  status: "READOUT_PREMATURE" | "READOUT_READY";
  coverage: {
    attributedTotal: number;
    open: number;
    dust: number;
    closedUnsettled: number;
    settled: number;
    directR23MissingOrInvalid: number;
    outbidUnknownOrigin: number;
    invalidProvenance: number;
  };
  outcomes: { overall: Aggregate; byClass: Record<EntryFreshEdgeShadowClass, Aggregate> };
  exTop1PctAbsPnl: {
    removed: number;
    overall: Aggregate;
    byClass: Record<EntryFreshEdgeShadowClass, Aggregate>;
  };
}
export function canonicalizeCohortStart(raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw)) {
    throw new Error("--cohort-start must be an ISO-8601 UTC instant");
  }
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) throw new Error("--cohort-start is invalid");
  const canonical = new Date(milliseconds).toISOString();
  const [, fractional = ""] = raw.match(/\.(\d{1,3})Z$/) ?? [];
  const normalizedInput = raw.replace(/(?:\.\d{1,3})?Z$/, `.${fractional.padEnd(3, "0")}Z`);
  if (canonical !== normalizedInput) throw new Error("--cohort-start is invalid");
  return canonical;
}
export function analyzeEntryFreshEdgeOutcome(options: {
  ledger: string;
  cohortStart: string;
}): EntryFreshEdgeOutcomeReport {
  const cohortStart = canonicalizeCohortStart(options.cohortStart);
  const db = new Database(options.ledger, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    assertSchema(db);
    return analyzeRows(readSnapshot(db, cohortStart), cohortStart);
  } finally {
    db.close();
  }
}
function assertSchema(db: Database.Database): void {
  const json1 = db.prepare("SELECT json_valid('{}') AS ok").get() as { ok: number };
  if (json1.ok !== 1) throw new Error("ledger SQLite JSON1 is unavailable");
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const columns = new Set(rows.map(({ name }) => name));
    if (rows.length === 0 || required.some((column) => !columns.has(column))) {
      throw new Error(`ledger schema is missing required ${table} columns`);
    }
  }
  const indexes = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name),
  );
  for (const index of ["idx_fills_filled_at", "idx_inventory_lots_position"]) {
    if (!indexes.has(index)) throw new Error(`ledger schema is missing required index ${index}`);
  }
}
function readSnapshot(db: Database.Database, cohortStart: string): DataRow[] {
  return db
    .prepare(
      `WITH recent_positions AS (
         SELECT DISTINCT il.position_id
         FROM fills f JOIN inventory_lots il ON il.fill_id=f.fill_id
         WHERE f.side='buy' AND f.filled_at>=?
       ), ranked AS (
         SELECT il.position_id, il.token_id AS lot_token_id, il.side AS lot_side,
                f.fill_id, f.order_id AS fill_order_id, f.token_id AS fill_token_id,
                f.condition_id AS fill_condition_id, f.filled_at,
                o.order_id, o.token_id AS order_token_id, o.condition_id AS order_condition_id,
                o.side AS order_side, o.signal_id AS order_signal_id,
                o.decision_rule_id AS order_rule_id, o.metadata_json AS order_metadata_json,
                ROW_NUMBER() OVER (PARTITION BY il.position_id ORDER BY f.filled_at,f.fill_id) first_rank,
                COUNT(*) OVER (PARTITION BY f.fill_id) fill_lot_count
         FROM recent_positions rp
         JOIN inventory_lots il ON il.position_id=rp.position_id
         JOIN fills f ON f.fill_id=il.fill_id AND f.side='buy'
         LEFT JOIN orders o ON o.order_id=f.order_id
       )
       SELECT r.*, p.token_id AS position_token_id, p.condition_id AS position_condition_id,
              p.side AS position_side,
              p.status AS position_status, p.realized_pnl,
              (SELECT COUNT(*) FROM settlement_ledger s WHERE s.position_id=r.position_id) settlement_count,
              (SELECT MIN(s.token_id) FROM settlement_ledger s WHERE s.position_id=r.position_id) settlement_token_min,
              (SELECT MAX(s.token_id) FROM settlement_ledger s WHERE s.position_id=r.position_id) settlement_token_max,
              (SELECT MIN(s.condition_id) FROM settlement_ledger s WHERE s.position_id=r.position_id) settlement_condition_min,
              (SELECT MAX(s.condition_id) FROM settlement_ledger s WHERE s.position_id=r.position_id) settlement_condition_max,
              CASE WHEN json_valid(r.order_metadata_json) THEN
                (SELECT COUNT(*) FROM orders origin
                 WHERE origin.side='buy' AND origin.decision_rule_id='R23_DIP_TRIGGER'
                   AND origin.signal_id=json_extract(r.order_metadata_json,'$.entryFreshEdgeAttribution.originSignalId')
                   AND origin.token_id=r.fill_token_id AND origin.condition_id=r.fill_condition_id)
              ELSE 0 END origin_order_count,
              CASE WHEN json_valid(r.order_metadata_json) THEN
                (SELECT MIN(origin.metadata_json) FROM orders origin
                 WHERE origin.side='buy' AND origin.decision_rule_id='R23_DIP_TRIGGER'
                   AND origin.signal_id=json_extract(r.order_metadata_json,'$.entryFreshEdgeAttribution.originSignalId')
                   AND origin.token_id=r.fill_token_id AND origin.condition_id=r.fill_condition_id)
              END origin_metadata_json
       FROM ranked r LEFT JOIN positions p ON p.position_id=r.position_id
       ORDER BY r.position_id,r.first_rank`,
    )
    .all(cohortStart) as DataRow[];
}
function analyzeRows(rows: readonly DataRow[], cohortStart: string): EntryFreshEdgeOutcomeReport {
  const groups = new Map<string, DataRow[]>();
  for (const row of rows)
    groups.set(row.position_id, [...(groups.get(row.position_id) ?? []), row]);
  const coverage = {
    attributedTotal: 0,
    open: 0,
    dust: 0,
    closedUnsettled: 0,
    settled: 0,
    directR23MissingOrInvalid: 0,
    outbidUnknownOrigin: 0,
    invalidProvenance: 0,
  };
  const settled: OutcomeRow[] = [];
  for (const [positionId, cycle] of groups) {
    const first = cycle.find(({ first_rank }) => first_rank === 1);
    if (!first || first.filled_at < cohortStart) continue;
    const attribution = readAttribution(first.order_metadata_json);
    if (first.order_rule_id === "R23_DIP_TRIGGER" && !directProven(first, attribution)) {
      coverage.directR23MissingOrInvalid++;
      continue;
    }
    if (first.order_rule_id === "OUTBID_REPRICE" && !outbidProven(first, attribution)) {
      coverage.outbidUnknownOrigin++;
      continue;
    }
    if (!attribution) continue;
    if (first.order_rule_id !== "R23_DIP_TRIGGER" && first.order_rule_id !== "OUTBID_REPRICE") {
      coverage.invalidProvenance++;
      continue;
    }
    if (!baseRelationsValid(first) || hasConflictingAttribution(cycle, attribution)) {
      coverage.invalidProvenance++;
      continue;
    }
    const bucket = statusBucket(first);
    if (!bucket) {
      coverage.invalidProvenance++;
      continue;
    }
    coverage.attributedTotal++;
    coverage[bucket]++;
    if (bucket === "settled") {
      settled.push({
        positionId,
        shadowClass: attribution.shadowClass,
        realizedPnl: first.realized_pnl!,
      });
    }
  }
  if (
    coverage.attributedTotal !==
    coverage.open + coverage.dust + coverage.closedUnsettled + coverage.settled
  ) {
    throw new Error("attributed cycle partition mismatch");
  }
  const removed = settled.length === 0 ? 0 : Math.ceil(settled.length * 0.01);
  const trimmed = [...settled]
    .sort(
      (a, b) =>
        Math.abs(b.realizedPnl) - Math.abs(a.realizedPnl) ||
        b.realizedPnl - a.realizedPnl ||
        a.positionId.localeCompare(b.positionId),
    )
    .slice(removed);
  return {
    schemaVersion: 1,
    cohortStart,
    status: settled.length < 30 ? "READOUT_PREMATURE" : "READOUT_READY",
    coverage,
    outcomes: aggregateSet(settled),
    exTop1PctAbsPnl: { removed, ...aggregateSet(trimmed) },
  };
}
function readAttribution(raw: string | null): EntryFreshEdgeAttribution | null {
  if (!raw) return null;
  try {
    const metadata = JSON.parse(raw) as Record<string, unknown>;
    return parseEntryFreshEdgeAttribution(metadata.entryFreshEdgeAttribution);
  } catch {
    return null;
  }
}
function directProven(row: DataRow, attribution: EntryFreshEdgeAttribution | null): boolean {
  return !!attribution && row.order_signal_id === attribution.originSignalId;
}
function outbidProven(row: DataRow, attribution: EntryFreshEdgeAttribution | null): boolean {
  if (!attribution || row.origin_order_count !== 1) return false;
  const origin = readAttribution(row.origin_metadata_json);
  return JSON.stringify(origin) === JSON.stringify(attribution);
}
function baseRelationsValid(row: DataRow): boolean {
  return (
    row.fill_lot_count === 1 &&
    row.order_id === row.fill_order_id &&
    row.order_side === "buy" &&
    row.order_token_id === row.fill_token_id &&
    row.order_condition_id === row.fill_condition_id &&
    row.lot_side === "buy" &&
    row.lot_token_id === row.fill_token_id &&
    row.position_side === "buy" &&
    row.position_token_id === row.fill_token_id &&
    row.position_condition_id === row.fill_condition_id &&
    Number.isFinite(row.realized_pnl)
  );
}
function hasConflictingAttribution(
  cycle: readonly DataRow[],
  expected: EntryFreshEdgeAttribution,
): boolean {
  return cycle.some((row) => {
    const parsed = readAttribution(row.order_metadata_json);
    return parsed !== null && JSON.stringify(parsed) !== JSON.stringify(expected);
  });
}
function statusBucket(row: DataRow): "open" | "dust" | "closedUnsettled" | "settled" | null {
  if (row.position_status === "open" || row.position_status === "dust") {
    return row.settlement_count === 0 ? row.position_status : null;
  }
  if (row.position_status !== "closed") return null;
  if (row.settlement_count === 0) return "closedUnsettled";
  const exactSettlement =
    row.settlement_count === 1 &&
    row.settlement_token_min === row.position_token_id &&
    row.settlement_token_max === row.position_token_id &&
    row.settlement_condition_min === row.position_condition_id &&
    row.settlement_condition_max === row.position_condition_id;
  return exactSettlement ? "settled" : null;
}
function aggregateSet(rows: readonly OutcomeRow[]) {
  const byClass = Object.fromEntries(CLASSES.map((name) => [name, aggregate([])])) as Record<
    EntryFreshEdgeShadowClass,
    Aggregate
  >;
  for (const name of CLASSES)
    byClass[name] = aggregate(rows.filter((row) => row.shadowClass === name));
  return { overall: aggregate(rows), byClass };
}
function aggregate(rows: readonly OutcomeRow[]): Aggregate {
  return {
    count: rows.length,
    wins: rows.filter(({ realizedPnl }) => realizedPnl > 0).length,
    flats: rows.filter(({ realizedPnl }) => realizedPnl === 0).length,
    losses: rows.filter(({ realizedPnl }) => realizedPnl < 0).length,
    totalRealizedPnl: rows.reduce((sum, { realizedPnl }) => sum + realizedPnl, 0),
  };
}
function parseArgs(argv: readonly string[]): { ledger: string; cohortStart: string } {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error("expected --ledger and --cohort-start");
    const name = flag.slice(2);
    if (name !== "ledger" && name !== "cohort-start") throw new Error(`unknown flag --${name}`);
    values[name] = value;
  }
  if (!values.ledger || !values["cohort-start"]) {
    throw new Error("--ledger and --cohort-start are required");
  }
  return { ledger: values.ledger, cohortStart: values["cohort-start"] };
}

export function runCli(argv: readonly string[]): string {
  return `${JSON.stringify(analyzeEntryFreshEdgeOutcome(parseArgs(argv)), null, 2)}\n`;
}

if (process.argv[1]?.endsWith("entry-fresh-edge-outcome.ts")) {
  try {
    process.stdout.write(runCli(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`ERROR ${error instanceof Error ? error.message : "analysis failed"}\n`);
    process.exitCode = 1;
  }
}
