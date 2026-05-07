import Database from "better-sqlite3";
import path from "node:path";

type Side = "BUY" | "SELL";
type State = "OTHER" | "S1" | "S2" | "S3";

interface ActivityRow {
  id: number;
  asset: string;
  condition_id: string | null;
  slug: string | null;
  event_slug: string | null;
  side: Side;
  price: number;
  size: number;
  usdc_size: number;
  timestamp: number;
}

interface Leg {
  buyCount: number;
  sellCount: number;
  lastAction: Side | null;
  lastTradeAt: number | null;
}

interface Position {
  shares: number;
  cost: number;
}

interface SizeRule {
  action: Side;
  priority: number;
  ruleId: string;
  state: State | "ANY";
  priceOp?: "<" | ">=";
  priceValue?: number;
  nthBuy?: number;
  buyCountMin?: number;
  buyCountMax?: number;
  sizeUsdc: number;
}

interface DecisionRule {
  priority: number;
  ruleId: string;
  state: State | "ANY";
  priceOp?: "<" | ">=";
  priceValue?: number;
  timeOp?: "<=" | ">";
  timeValue?: number;
  buyCountMin?: number;
  action: Side;
}

const DB_PATH = path.resolve("research_plankton/data/plankton_trades.db");
const ENTRY_PRICE_CEILING = 0.45;
const SEEDED_INCLUDE_PREFIXES = ["bitcoin-", "ethereum-", "elon-musk-"];

const DECISION_RULES: DecisionRule[] = [
  {
    priority: 10,
    ruleId: "D1",
    state: "S2",
    priceOp: "<",
    priceValue: 0.05,
    timeOp: "<=",
    timeValue: 60,
    action: "BUY",
  },
  {
    priority: 20,
    ruleId: "D2",
    state: "S3",
    priceOp: "<",
    priceValue: 0.05,
    timeOp: "<=",
    timeValue: 60,
    action: "SELL",
  },
  { priority: 30, ruleId: "D3", state: "S1", priceOp: "<", priceValue: 0.05, action: "BUY" },
  {
    priority: 50,
    ruleId: "D4",
    state: "S2",
    priceOp: ">=",
    priceValue: 0.2,
    timeOp: ">",
    timeValue: 60,
    action: "SELL",
  },
  { priority: 60, ruleId: "D5", state: "S1", priceOp: ">=", priceValue: 0.2, action: "SELL" },
  { priority: 70, ruleId: "D6", state: "S2", buyCountMin: 4, action: "BUY" },
  { priority: 80, ruleId: "D7", state: "S3", action: "SELL" },
  { priority: 999, ruleId: "FALLBACK", state: "ANY", action: "BUY" },
];

const SIZE_RULES: SizeRule[] = [
  {
    action: "BUY",
    priority: 10,
    ruleId: "B1",
    state: "OTHER",
    priceOp: ">=",
    priceValue: 0.2,
    sizeUsdc: 8.41,
  },
  {
    action: "BUY",
    priority: 20,
    ruleId: "B2",
    state: "S1",
    priceOp: ">=",
    priceValue: 0.2,
    sizeUsdc: 4.29,
  },
  {
    action: "BUY",
    priority: 30,
    ruleId: "B3",
    state: "S3",
    priceOp: "<",
    priceValue: 0.05,
    sizeUsdc: 0.88,
  },
  {
    action: "BUY",
    priority: 40,
    ruleId: "B4",
    state: "S2",
    priceOp: "<",
    priceValue: 0.05,
    sizeUsdc: 0.14,
  },
  { action: "BUY", priority: 50, ruleId: "B5", state: "ANY", nthBuy: 1, sizeUsdc: 0.99 },
  { action: "BUY", priority: 60, ruleId: "B6", state: "ANY", nthBuy: 2, sizeUsdc: 1.04 },
  { action: "BUY", priority: 70, ruleId: "B7", state: "ANY", nthBuy: 3, sizeUsdc: 3.85 },
  { action: "BUY", priority: 999, ruleId: "FALLBACK", state: "ANY", sizeUsdc: 2.73 },
  {
    action: "SELL",
    priority: 10,
    ruleId: "S1",
    state: "S2",
    priceOp: ">=",
    priceValue: 0.2,
    sizeUsdc: 5.81,
  },
  {
    action: "SELL",
    priority: 20,
    ruleId: "S2",
    state: "S1",
    priceOp: ">=",
    priceValue: 0.2,
    sizeUsdc: 5.73,
  },
  {
    action: "SELL",
    priority: 30,
    ruleId: "S3",
    state: "OTHER",
    priceOp: ">=",
    priceValue: 0.2,
    sizeUsdc: 5.0,
  },
  {
    action: "SELL",
    priority: 40,
    ruleId: "S4",
    state: "S2",
    priceOp: "<",
    priceValue: 0.05,
    sizeUsdc: 1.05,
  },
  {
    action: "SELL",
    priority: 50,
    ruleId: "S5",
    state: "S3",
    priceOp: "<",
    priceValue: 0.05,
    sizeUsdc: 0.71,
  },
  {
    action: "SELL",
    priority: 60,
    ruleId: "S6",
    state: "ANY",
    buyCountMin: 1,
    buyCountMax: 1,
    sizeUsdc: 1.54,
  },
  {
    action: "SELL",
    priority: 70,
    ruleId: "S7",
    state: "ANY",
    buyCountMin: 2,
    buyCountMax: 3,
    sizeUsdc: 2.33,
  },
  { action: "SELL", priority: 999, ruleId: "FALLBACK", state: "ANY", sizeUsdc: 2.63 },
];

function compare(op: "<" | ">=" | "<=" | ">", actual: number, value: number): boolean {
  if (op === "<") return actual < value;
  if (op === ">=") return actual >= value;
  if (op === "<=") return actual <= value;
  return actual > value;
}

function deriveState(leg: Leg | undefined): State {
  if (!leg) return "OTHER";
  if (leg.sellCount >= 1 && leg.lastAction === "SELL") return "S3";
  if (leg.buyCount >= 2 && leg.lastAction === "BUY") return "S2";
  if (leg.buyCount === 1 && leg.lastAction === "BUY") return "S1";
  return "OTHER";
}

function matchDecision(
  state: State,
  price: number,
  timeSinceLast: number | null,
  buyCount: number,
) {
  for (const rule of DECISION_RULES) {
    if (rule.state !== "ANY" && rule.state !== state) continue;
    if (rule.priceOp && rule.priceValue != null && !compare(rule.priceOp, price, rule.priceValue)) {
      continue;
    }
    if (rule.timeOp && rule.timeValue != null) {
      if (timeSinceLast == null || !compare(rule.timeOp, timeSinceLast, rule.timeValue)) continue;
    }
    if (rule.buyCountMin != null && buyCount < rule.buyCountMin) continue;
    return rule;
  }
  throw new Error("No decision rule matched");
}

function matchSize(action: Side, state: State, price: number, nthBuy: number, buyCount: number) {
  for (const rule of SIZE_RULES) {
    if (rule.action !== action) continue;
    if (rule.state !== "ANY" && rule.state !== state) continue;
    if (rule.priceOp && rule.priceValue != null && !compare(rule.priceOp, price, rule.priceValue)) {
      continue;
    }
    if (rule.nthBuy != null && rule.nthBuy !== nthBuy) continue;
    if (rule.buyCountMin != null && buyCount < rule.buyCountMin) continue;
    if (rule.buyCountMax != null && buyCount > rule.buyCountMax) continue;
    return rule;
  }
  throw new Error(`No size rule matched for ${action}`);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return round(sorted[idx]!);
}

function distribution(values: number[]) {
  return {
    count: values.length,
    p10: percentile(values, 0.1),
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
  };
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function addCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function toObject(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function toRateObject(map: Map<string, number>, denominator: number): Record<string, number> {
  if (denominator <= 0) return {};
  return Object.fromEntries(
    [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, count]) => [key, round(count / denominator)]),
  );
}

function isPrefixEligible(slug: string | null): boolean {
  if (!slug) return false;
  return SEEDED_INCLUDE_PREFIXES.some((prefix) => slug.startsWith(prefix));
}

function applyFill(position: Position, side: Side, shares: number, price: number): number {
  if (side === "BUY") {
    position.shares += shares;
    position.cost += shares * price;
    return 0;
  }
  const sellShares = Math.min(shares, position.shares);
  if (sellShares <= 0) return 0;
  const avgCost = position.shares > 0 ? position.cost / position.shares : 0;
  const realized = sellShares * price - sellShares * avgCost;
  position.shares -= sellShares;
  position.cost -= sellShares * avgCost;
  if (position.shares <= 1e-9) {
    position.shares = 0;
    position.cost = 0;
  }
  return realized;
}

const db = new Database(DB_PATH, { readonly: true });
const rows = db
  .prepare(
    `SELECT id, asset, condition_id, slug, event_slug, side, price, size, usdc_size, timestamp
       FROM activity
      WHERE type = 'TRADE'
        AND side IN ('BUY', 'SELL')
        AND asset IS NOT NULL
        AND price IS NOT NULL
        AND size IS NOT NULL
        AND usdc_size IS NOT NULL
        AND trade_date >= '2026-02-01'
        AND trade_date < '2026-05-01'
      ORDER BY timestamp ASC, id ASC`,
  )
  .all() as ActivityRow[];

const clobHistoryOverlap = db
  .prepare(
    `WITH traded AS (
       SELECT DISTINCT asset FROM activity
        WHERE type = 'TRADE' AND side = 'BUY' AND asset IS NOT NULL
     ),
     priced AS (
       SELECT DISTINCT token_id AS asset FROM analysis_clob_price_history
     )
     SELECT
       (SELECT COUNT(*) FROM traded) AS traded_assets,
       (SELECT COUNT(*) FROM traded JOIN priced USING(asset)) AS priced_assets`,
  )
  .get() as { traded_assets: number; priced_assets: number };

const eventMarketCounts = db
  .prepare(
    `SELECT event_slug, COUNT(DISTINCT condition_id) AS market_count
       FROM analysis_market_summary
      WHERE event_slug IS NOT NULL
      GROUP BY event_slug`,
  )
  .all() as Array<{ event_slug: string; market_count: number }>;

const historyRows = db
  .prepare(
    `SELECT token_id AS asset, point_ts, price
       FROM analysis_clob_price_history
      ORDER BY token_id ASC, point_ts ASC`,
  )
  .all() as Array<{ asset: string; point_ts: number; price: number }>;
db.close();

const history = new Map<string, Array<{ ts: number; price: number }>>();
for (const row of historyRows) {
  const list = history.get(row.asset) ?? [];
  list.push({ ts: row.point_ts, price: row.price });
  history.set(row.asset, list);
}

function nearestHistoryPrice(asset: string, ts: number): number | null {
  const list = history.get(asset);
  if (!list || list.length === 0) return null;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (list[mid]!.ts <= ts) lo = mid + 1;
    else hi = mid - 1;
  }
  const idx = Math.max(0, Math.min(list.length - 1, hi));
  return list[idx]?.price ?? null;
}

const eventMarketCountBySlug = new Map(
  eventMarketCounts.map((row) => [row.event_slug, row.market_count]),
);
const observedLegs = new Map<string, Leg>();
const observedPositions = new Map<string, Position>();
const predictedPositions = new Map<string, Position>();
const decisionCounts = new Map<string, number>();
const sizeRuleCounts = new Map<string, number>();
const acceptedCounts = new Map<string, number>();
const suppressionCounts = new Map<string, number>();
const sizeErrorPct: number[] = [];
const sizeErrorUsdc: number[] = [];
const priceErrorAbs: number[] = [];
const eligibleAssets = new Set<string>();
let eligibleRows = 0;
let prefixEligibleRows = 0;
let singleMarketEligibleRows = 0;
let sideMatchedRows = 0;
let observedRealizedPnl = 0;
let predictedRealizedPnl = 0;

for (const row of rows) {
  const selectionSlug = row.event_slug ?? row.slug;
  const prefixEligible = isPrefixEligible(selectionSlug);
  const singleMarketEligible =
    row.event_slug != null && eventMarketCountBySlug.get(row.event_slug) === 1;
  const marketEligible = prefixEligible || singleMarketEligible;
  if (marketEligible) {
    eligibleRows += 1;
    eligibleAssets.add(row.asset);
    if (prefixEligible) prefixEligibleRows += 1;
    if (singleMarketEligible) singleMarketEligibleRows += 1;
  }

  const leg = observedLegs.get(row.asset);
  const state = deriveState(leg);
  const buyCount = leg?.buyCount ?? 0;
  const nthBuy = buyCount + 1;
  const timeSinceLast = leg?.lastTradeAt != null ? row.timestamp - leg.lastTradeAt : null;
  const decision = matchDecision(state, row.price, timeSinceLast, buyCount);
  const d6Suppressed =
    decision.action === "BUY" && decision.ruleId !== "D1" && state === "S2" && buyCount >= 4;
  const capSuppressed = decision.action === "BUY" && row.price > ENTRY_PRICE_CEILING;
  const accepted = !d6Suppressed && !capSuppressed && decision.action === row.side;
  if (decision.action === row.side) sideMatchedRows += 1;
  addCount(decisionCounts, decision.ruleId);
  if (d6Suppressed) addCount(suppressionCounts, "d6-suppressed");
  if (capSuppressed) addCount(suppressionCounts, "price-above-entry-ceiling");

  const observedPosition = observedPositions.get(row.asset) ?? { shares: 0, cost: 0 };
  observedRealizedPnl += applyFill(observedPosition, row.side, row.size, row.price);
  observedPositions.set(row.asset, observedPosition);

  if (accepted) {
    const sizeRule = matchSize(decision.action, state, row.price, nthBuy, buyCount);
    addCount(sizeRuleCounts, sizeRule.ruleId);
    addCount(acceptedCounts, decision.action);
    sizeErrorUsdc.push(sizeRule.sizeUsdc - row.usdc_size);
    if (row.usdc_size > 0) sizeErrorPct.push((sizeRule.sizeUsdc - row.usdc_size) / row.usdc_size);

    const predictedPosition = predictedPositions.get(row.asset) ?? { shares: 0, cost: 0 };
    const predictedShares = sizeRule.sizeUsdc / row.price;
    predictedRealizedPnl += applyFill(
      predictedPosition,
      decision.action,
      predictedShares,
      row.price,
    );
    predictedPositions.set(row.asset, predictedPosition);
  }

  const refPrice = nearestHistoryPrice(row.asset, row.timestamp);
  if (refPrice != null) priceErrorAbs.push(Math.abs(row.price - refPrice));

  const nextLeg = leg ?? { buyCount: 0, sellCount: 0, lastAction: null, lastTradeAt: null };
  if (row.side === "BUY") nextLeg.buyCount += 1;
  else nextLeg.sellCount += 1;
  nextLeg.lastAction = row.side;
  nextLeg.lastTradeAt = row.timestamp;
  observedLegs.set(row.asset, nextLeg);
}

const predictedOpenCost = [...predictedPositions.values()].reduce((sum, p) => sum + p.cost, 0);
const observedOpenCost = [...observedPositions.values()].reduce((sum, p) => sum + p.cost, 0);

const report = {
  dataset: {
    dbPath: DB_PATH,
    trades: rows.length,
    start: rows[0]?.timestamp ?? null,
    end: rows.at(-1)?.timestamp ?? null,
  },
  marketOverlap: {
    eligibleTradeRows: eligibleRows,
    totalTradeRows: rows.length,
    tradeRowPct: round(eligibleRows / rows.length),
    eligibleAssets: eligibleAssets.size,
    totalAssets: clobHistoryOverlap.traded_assets,
    assetPct: round(eligibleAssets.size / clobHistoryOverlap.traded_assets),
    prefixEligibleRows,
    singleMarketEligibleRows,
  },
  clobHistoryOverlap: {
    tradedAssets: clobHistoryOverlap.traded_assets,
    assetsWithClobHistory: clobHistoryOverlap.priced_assets,
    pct: round(clobHistoryOverlap.priced_assets / clobHistoryOverlap.traded_assets),
  },
  perRule: {
    decisionCounts: toObject(decisionCounts),
    decisionRates: toRateObject(decisionCounts, rows.length),
    sizeRuleCounts: toObject(sizeRuleCounts),
    sizeRuleRatesAccepted: toRateObject(sizeRuleCounts, sizeErrorUsdc.length),
    acceptedCounts: toObject(acceptedCounts),
    acceptedRate: round(sizeErrorUsdc.length / rows.length),
    sideMatchRateBeforeSuppressions: round(sideMatchedRows / rows.length),
    suppressionCounts: toObject(suppressionCounts),
    suppressionRates: toRateObject(suppressionCounts, rows.length),
  },
  sizeError: {
    signedUsdc: distribution(sizeErrorUsdc),
    signedPct: distribution(sizeErrorPct),
  },
  priceErrorAbs: distribution(priceErrorAbs),
  copyFillPnl: {
    observedRealizedPnl: round(observedRealizedPnl),
    observedOpenCost: round(observedOpenCost),
    predictedRealizedPnl: round(predictedRealizedPnl),
    predictedOpenCost: round(predictedOpenCost),
  },
};

console.log(JSON.stringify(report, null, 2));
