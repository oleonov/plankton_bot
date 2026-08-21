import Database from "better-sqlite3";
import { canonicalizeCohortStart } from "./entry-fresh-edge-outcome.js";

const EVENT_TYPE = "quote_motion_shadow_sample";
const CLASSIFICATIONS = [
  "buy-up-opportunity",
  "buy-hold",
  "sell-below-target",
  "sell-at-target",
  "sell-above-target",
  "would-cross",
  "lifecycle-invalid",
  "deadline-expired",
  "policy-revision-unavailable",
  "book-missing",
  "stale-book",
  "malformed-book",
  "self-book-ambiguous",
] as const;
const BUY_ONLY_CLASSIFICATIONS = new Set<Classification>(["buy-up-opportunity", "buy-hold"]);
const SELL_ONLY_CLASSIFICATIONS = new Set<Classification>([
  "sell-below-target",
  "sell-at-target",
  "sell-above-target",
]);
type Classification = (typeof CLASSIFICATIONS)[number];
type Kind = "r23_capture" | "bounce_exit_target";

interface RawRow {
  readonly payload: string;
}

interface Sample {
  readonly orderId: string;
  readonly identity: string;
  readonly kind: Kind;
  readonly classification: Classification;
  readonly currentPrice: number;
  readonly candidatePrice: number | null;
  readonly targetPrice: number | null;
  readonly priceGiveUp: number | null;
  readonly tickSize: number | null;
  readonly lotStatus: "available" | "unavailable" | "inconsistent" | null;
  readonly maxEntryPrice: number | null;
}

interface Distribution {
  readonly count: number;
  readonly min: number | null;
  readonly median: number | null;
  readonly p90: number | null;
  readonly max: number | null;
  readonly mean: number | null;
}

export interface QuoteMotionReadout {
  readonly schemaVersion: 1;
  readonly cohortStart: string;
  readonly status: "NO_SAMPLES" | "DESCRIPTIVE_ONLY";
  readonly aggregateOnly: true;
  readonly coverage: {
    readonly rowsRead: number;
    readonly validSamples: number;
    readonly invalidSamples: number;
    readonly distinctOrders: number;
    readonly buyOrders: number;
    readonly sellOrders: number;
    readonly identityConflictSamples: number;
  };
  readonly classifications: Record<Classification, number>;
  readonly buy: {
    readonly ordersEverUpOpportunity: number;
    readonly upOpportunitySamples: number;
    readonly improvementTicks: Distribution;
    readonly improvementPrice: Distribution;
  };
  readonly sell: {
    readonly ordersEverBelowTarget: number;
    readonly belowTargetSamples: number;
    readonly fifoAvailableSamples: number;
    readonly fifoUnavailableSamples: number;
    readonly fifoInconsistentSamples: number;
    readonly giveUpTicks: Distribution;
    readonly giveUpPctOfTarget: Distribution;
    readonly grossCandidateVsMaxLotPct: Distribution;
  };
}

export function analyzeQuoteMotion(options: {
  ledger: string;
  cohortStart: string;
}): QuoteMotionReadout {
  const cohortStart = canonicalizeCohortStart(options.cohortStart);
  const db = new Database(options.ledger, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    assertSchema(db);
    db.exec("BEGIN");
    const rows = db
      .prepare(
        `SELECT payload FROM risk_events
         WHERE event_type=? AND created_at>=datetime(?) ORDER BY id`,
      )
      .all(EVENT_TYPE, cohortStart) as RawRow[];
    db.exec("COMMIT");
    return aggregate(rows, cohortStart);
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function assertSchema(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(risk_events)").all() as Array<{ name: string }>).map(
      ({ name }) => name,
    ),
  );
  if (["id", "event_type", "payload", "created_at"].some((name) => !columns.has(name))) {
    throw new Error("ledger schema is missing required risk_events columns");
  }
  const index = db
    .prepare("SELECT 1 ok FROM sqlite_master WHERE type='index' AND name='idx_risk_events_type'")
    .get() as { ok: number } | undefined;
  if (index?.ok !== 1) throw new Error("ledger schema is missing idx_risk_events_type");
}

function aggregate(rows: readonly RawRow[], cohortStart: string): QuoteMotionReadout {
  const parsed = rows
    .map((row) => parseSample(row, cohortStart))
    .filter((row): row is Sample => row !== null);
  const identities = new Map<string, Set<string>>();
  for (const row of parsed) {
    const values = identities.get(row.orderId) ?? new Set<string>();
    values.add(row.identity);
    identities.set(row.orderId, values);
  }
  const conflicts = new Set(
    [...identities].filter(([, values]) => values.size !== 1).map(([orderId]) => orderId),
  );
  const valid = parsed.filter((row) => !conflicts.has(row.orderId));
  const buy = valid.filter(({ kind }) => kind === "r23_capture");
  const sell = valid.filter(({ kind }) => kind === "bounce_exit_target");
  const buyOpportunities = buy.filter(
    ({ classification }) => classification === "buy-up-opportunity",
  );
  const belowTarget = sell.filter(({ classification }) => classification === "sell-below-target");
  const classifications = Object.fromEntries(
    CLASSIFICATIONS.map((name) => [
      name,
      valid.filter((row) => row.classification === name).length,
    ]),
  ) as Record<Classification, number>;
  return {
    schemaVersion: 1,
    cohortStart,
    status: valid.length === 0 ? "NO_SAMPLES" : "DESCRIPTIVE_ONLY",
    aggregateOnly: true,
    coverage: {
      rowsRead: rows.length,
      validSamples: valid.length,
      invalidSamples: rows.length - valid.length,
      distinctOrders: distinct(valid.map(({ orderId }) => orderId)),
      buyOrders: distinct(buy.map(({ orderId }) => orderId)),
      sellOrders: distinct(sell.map(({ orderId }) => orderId)),
      identityConflictSamples: parsed.filter((row) => conflicts.has(row.orderId)).length,
    },
    classifications,
    buy: {
      ordersEverUpOpportunity: distinct(buyOpportunities.map(({ orderId }) => orderId)),
      upOpportunitySamples: buyOpportunities.length,
      improvementTicks: distribution(
        buyOpportunities.map((row) => (row.candidatePrice! - row.currentPrice) / row.tickSize!),
      ),
      improvementPrice: distribution(
        buyOpportunities.map((row) => row.candidatePrice! - row.currentPrice),
      ),
    },
    sell: {
      ordersEverBelowTarget: distinct(belowTarget.map(({ orderId }) => orderId)),
      belowTargetSamples: belowTarget.length,
      fifoAvailableSamples: sell.filter(({ lotStatus }) => lotStatus === "available").length,
      fifoUnavailableSamples: sell.filter(({ lotStatus }) => lotStatus === "unavailable").length,
      fifoInconsistentSamples: sell.filter(({ lotStatus }) => lotStatus === "inconsistent").length,
      giveUpTicks: distribution(
        sell.flatMap((row) =>
          row.priceGiveUp == null || row.tickSize == null ? [] : [row.priceGiveUp / row.tickSize],
        ),
      ),
      giveUpPctOfTarget: distribution(
        sell.flatMap((row) =>
          row.priceGiveUp == null || row.targetPrice == null
            ? []
            : [(100 * row.priceGiveUp) / row.targetPrice],
        ),
      ),
      grossCandidateVsMaxLotPct: distribution(
        sell.flatMap((row) =>
          row.candidatePrice == null || row.maxEntryPrice == null
            ? []
            : [100 * (row.candidatePrice / row.maxEntryPrice - 1)],
        ),
      ),
    },
  };
}

function parseSample(row: RawRow, cohortStart: string): Sample | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload);
  } catch {
    return null;
  }
  if (!record(raw) || raw.version !== 1 || !text(raw.orderId) || !text(raw.tokenId)) return null;
  const sampledAt = canonicalInstant(raw.sampledAt);
  if (sampledAt === null || sampledAt < Date.parse(cohortStart)) return null;
  if (
    !text(raw.conditionId) ||
    !text(raw.cohortId) ||
    !CLASSIFICATIONS.includes(raw.classification as Classification)
  )
    return null;
  const currentPrice = raw.currentPrice as number;
  const candidatePrice = raw.candidatePrice as number | null;
  const priceGiveUp = raw.priceGiveUp as number | null;
  const kind = raw.kind;
  if (kind !== "r23_capture" && kind !== "bounce_exit_target") return null;
  if (
    (kind === "r23_capture" && raw.side !== "buy") ||
    (kind === "bounce_exit_target" && raw.side !== "sell")
  )
    return null;
  const tickSize = raw.tickSize as number | null;
  if (
    kind === "r23_capture" &&
    SELL_ONLY_CLASSIFICATIONS.has(raw.classification as Classification)
  ) {
    return null;
  }
  if (
    kind === "bounce_exit_target" &&
    BUY_ONLY_CLASSIFICATIONS.has(raw.classification as Classification)
  ) {
    return null;
  }
  if (
    !positive(raw.currentPrice) ||
    !nullablePositive(raw.candidatePrice) ||
    !nullableNumber(raw.priceGiveUp)
  )
    return null;
  if (
    !nullablePositive(raw.tickSize) ||
    !record(raw.origin) ||
    raw.origin.version !== 1 ||
    raw.origin.kind !== kind ||
    raw.origin.cohortId !== raw.cohortId
  )
    return null;
  const targetPrice = kind === "bounce_exit_target" ? raw.origin.originalTargetPrice : null;
  if (kind === "bounce_exit_target" && !positive(targetPrice)) return null;
  if (kind === "r23_capture") {
    if (candidatePrice !== null && candidatePrice <= currentPrice) return null;
    if (raw.classification === "buy-hold" && candidatePrice !== null) return null;
    if (
      raw.classification === "buy-up-opportunity" &&
      (!positive(candidatePrice) || !positive(tickSize))
    )
      return null;
  }
  const lot = raw.lotFacts;
  const lotStatus = kind === "bounce_exit_target" && record(lot) ? lot.status : null;
  if (
    kind === "bounce_exit_target" &&
    !["available", "unavailable", "inconsistent"].includes(String(lotStatus))
  )
    return null;
  const pricedSellClassification =
    kind === "bounce_exit_target" &&
    (SELL_ONLY_CLASSIFICATIONS.has(raw.classification as Classification) ||
      raw.classification === "would-cross");
  if (
    pricedSellClassification &&
    (!positive(candidatePrice) ||
      !positive(tickSize) ||
      typeof priceGiveUp !== "number" ||
      !Number.isFinite(priceGiveUp))
  )
    return null;
  if (
    pricedSellClassification &&
    Math.abs((targetPrice as number) - (candidatePrice as number) - (priceGiveUp as number)) > 1e-8
  )
    return null;
  if (
    kind === "bounce_exit_target" &&
    SELL_ONLY_CLASSIFICATIONS.has(raw.classification as Classification)
  ) {
    const delta = (candidatePrice as number) - (targetPrice as number);
    const tolerance = Math.max(1e-9, (tickSize as number) * 1e-6);
    if (
      (raw.classification === "sell-below-target" && delta >= -tolerance) ||
      (raw.classification === "sell-at-target" && Math.abs(delta) > tolerance) ||
      (raw.classification === "sell-above-target" && delta <= tolerance)
    )
      return null;
  }
  if (lotStatus === "available" && !validAvailableLots(lot)) return null;
  const maxEntryPrice =
    lotStatus === "available" && record(lot) && positive(lot.maxEntryPrice)
      ? lot.maxEntryPrice
      : null;
  return {
    orderId: raw.orderId,
    identity: JSON.stringify([
      raw.tokenId,
      raw.conditionId,
      raw.cohortId,
      kind,
      raw.side,
      targetPrice,
    ]),
    kind,
    classification: raw.classification as Classification,
    currentPrice,
    candidatePrice,
    targetPrice: targetPrice as number | null,
    priceGiveUp,
    tickSize,
    lotStatus: lotStatus as Sample["lotStatus"],
    maxEntryPrice,
  };
}

function distribution(values: readonly number[]): Distribution {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0)
    return { count: 0, min: null, median: null, p90: null, max: null, mean: null };
  return {
    count: sorted.length,
    min: round(sorted[0]!),
    median: round(quantile(sorted, 0.5)),
    p90: round(quantile(sorted, 0.9)),
    max: round(sorted.at(-1)!),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

function quantile(sorted: readonly number[], p: number): number {
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[Math.min(lower + 1, sorted.length - 1)]! * weight;
}
function distinct(values: readonly string[]): number {
  return new Set(values).size;
}
function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function nullablePositive(value: unknown): boolean {
  return value === null || positive(value);
}
function nullableNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}
function validAvailableLots(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    Number.isSafeInteger(value.count) &&
    Number(value.count) > 0 &&
    positive(value.remainingSize) &&
    positive(value.remainingCostUsdc) &&
    positive(value.maxEntryPrice) &&
    positive(value.avgEntryPrice)
  );
}
function canonicalInstant(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}

function parseArgs(argv: readonly string[]): { ledger: string; cohortStart: string } {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value)
      throw new Error("--ledger and --cohort-start are required");
    const name = flag.slice(2);
    if (name !== "ledger" && name !== "cohort-start") throw new Error(`unknown flag --${name}`);
    values[name] = value;
  }
  if (!values.ledger || !values["cohort-start"])
    throw new Error("--ledger and --cohort-start are required");
  return { ledger: values.ledger, cohortStart: values["cohort-start"] };
}

export function runCli(argv: readonly string[]): string {
  return `${JSON.stringify(analyzeQuoteMotion(parseArgs(argv)), null, 2)}\n`;
}

if (process.argv[1]?.endsWith("quote-motion-readout.ts")) {
  try {
    process.stdout.write(runCli(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`ERROR ${error instanceof Error ? error.message : "analysis failed"}\n`);
    process.exitCode = 1;
  }
}
