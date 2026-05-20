export type V4SelectionCategory =
  | "crypto-btc"
  | "crypto-eth"
  | "crypto-sol"
  | "crypto-xrp"
  | "entertainment"
  | "esports"
  | "geopolitics"
  | "other"
  | "politics"
  | "price-binary"
  | "stocks"
  | "weather";

export const HOT_CATS_40: readonly V4SelectionCategory[] = [
  "crypto-btc",
  "crypto-eth",
  "crypto-sol",
  "crypto-xrp",
  "entertainment",
  "esports",
  "geopolitics",
  "other",
  "politics",
  "price-binary",
  "stocks",
  "weather",
];

const HOT_CATS_40_SET = new Set<V4SelectionCategory>(HOT_CATS_40);
const ORDERBOOK_PROXY_MAX_SPREAD = 0.1;

export interface V4SelectionInput {
  slug: string;
  eventSlug: string | null;
  question?: string | null;
  liquidity?: number | null;
  volume24h?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  primaryCategory?: V4SelectionCategory | null;
}

export interface V4SelectionResult {
  admit: boolean;
  category: V4SelectionCategory | null;
  reason:
    | "admit"
    | "category_not_hot"
    | "liquidity_too_low"
    | "volume24h_too_low"
    | "missing_data"
    | "orderbook_proxy_unavailable";
}

export type V4AdmissionRejectReason =
  | "rejected_category_not_in_hot_cats"
  | "rejected_liquidity_below_100"
  | "rejected_volume_below_5"
  | "rejected_no_orderbook_proxy"
  | "rejected_missing_data"
  | "rejected_other_combination";

export interface V4AdmissionTelemetrySnapshot {
  readonly evaluatedTotal: number;
  readonly admitCountTotal: number;
  readonly rejectCountTotal: number;
  readonly admitRate: number;
  readonly seenCountByCategory: Record<V4SelectionCategory, number>;
  readonly admitCountByCategory: Record<V4SelectionCategory, number>;
  readonly admitRateByCategory: Record<V4SelectionCategory, number>;
  readonly rejectCountByReason: Record<V4AdmissionRejectReason, number>;
  readonly capturedAt: string | null;
}

export function evaluateV4Selection(input: V4SelectionInput): V4SelectionResult {
  const category =
    input.primaryCategory ?? deriveV4SelectionCategory(input.slug, input.eventSlug, input.question);
  if (category == null || !HOT_CATS_40_SET.has(category)) {
    return { admit: false, category, reason: "category_not_hot" };
  }

  const hasPopulatedPath =
    input.liquidity != null &&
    input.liquidity >= 100 &&
    input.volume24h != null &&
    input.volume24h >= 5;
  if (hasPopulatedPath || hasOrderbookProxy(input.bestBid, input.bestAsk)) {
    return { admit: true, category, reason: "admit" };
  }

  if (input.liquidity == null) {
    return { admit: false, category, reason: "orderbook_proxy_unavailable" };
  }
  if (input.liquidity < 100) return { admit: false, category, reason: "liquidity_too_low" };
  if (input.volume24h == null) return { admit: false, category, reason: "missing_data" };
  if (input.volume24h < 5) return { admit: false, category, reason: "volume24h_too_low" };
  return { admit: false, category, reason: "missing_data" };
}

export function createV4AdmissionTelemetrySnapshot(
  capturedAt: string | null = null,
): V4AdmissionTelemetrySnapshot {
  return {
    evaluatedTotal: 0,
    admitCountTotal: 0,
    rejectCountTotal: 0,
    admitRate: 0,
    seenCountByCategory: zeroCategoryCounts(),
    admitCountByCategory: zeroCategoryCounts(),
    admitRateByCategory: zeroCategoryCounts(),
    rejectCountByReason: zeroRejectReasonCounts(),
    capturedAt,
  };
}

export function recordV4AdmissionTelemetry(
  snapshot: V4AdmissionTelemetrySnapshot,
  result: V4SelectionResult,
): V4AdmissionTelemetrySnapshot {
  const seenCountByCategory = { ...snapshot.seenCountByCategory };
  const admitCountByCategory = { ...snapshot.admitCountByCategory };
  const admitRateByCategory = { ...snapshot.admitRateByCategory };
  const rejectCountByReason = { ...snapshot.rejectCountByReason };
  const evaluatedTotal = snapshot.evaluatedTotal + 1;
  let admitCountTotal = snapshot.admitCountTotal;
  let rejectCountTotal = snapshot.rejectCountTotal;

  if (result.category != null) {
    seenCountByCategory[result.category] += 1;
  }

  if (result.admit) {
    admitCountTotal += 1;
    if (result.category != null) {
      admitCountByCategory[result.category] += 1;
    }
  } else {
    rejectCountTotal += 1;
    rejectCountByReason[toTelemetryRejectReason(result)] += 1;
  }

  for (const category of HOT_CATS_40) {
    const seen = seenCountByCategory[category];
    admitRateByCategory[category] = seen > 0 ? admitCountByCategory[category] / seen : 0;
  }

  return {
    evaluatedTotal,
    admitCountTotal,
    rejectCountTotal,
    admitRate: evaluatedTotal > 0 ? admitCountTotal / evaluatedTotal : 0,
    seenCountByCategory,
    admitCountByCategory,
    admitRateByCategory,
    rejectCountByReason,
    capturedAt: snapshot.capturedAt,
  };
}

export function deriveV4SelectionCategory(
  slug: string,
  eventSlug: string | null,
  question?: string | null,
): V4SelectionCategory | null {
  const text = `${slug} ${eventSlug ?? ""} ${question ?? ""}`.toLowerCase();
  if (matches(text, ["bitcoin", "btc", "satoshi"])) return "crypto-btc";
  if (matches(text, ["ethereum", "ether", " eth ", "eth-"])) return "crypto-eth";
  if (matches(text, ["solana", " sol ", "sol-"])) return "crypto-sol";
  if (matches(text, ["xrp", "ripple"])) return "crypto-xrp";
  if (matches(text, ["esports", "league-of-legends", "lol-", "cs2", "dota", "valorant", "iem-"])) {
    return "esports";
  }
  if (
    matches(text, ["movie", "oscars", "grammy", "album", "billboard", "box-office", "celebrity"])
  ) {
    return "entertainment";
  }
  if (
    matches(text, [
      "ukraine",
      "russia",
      "putin",
      "israel",
      "iran",
      "gaza",
      "china",
      "taiwan",
      "nato",
      "war",
      "ceasefire",
      "tariff",
    ])
  ) {
    return "geopolitics";
  }
  if (
    matches(text, [
      "election",
      "president",
      "senate",
      "governor",
      "mayor",
      "nominee",
      "congress",
      "trump",
      "biden",
    ])
  ) {
    return "politics";
  }
  if (matches(text, ["temperature", "weather", "rain", "snow", "hurricane", "tornado"])) {
    return "weather";
  }
  if (
    matches(text, [
      "stock",
      "nasdaq",
      "dow-jones",
      "sp500",
      "s&p",
      "earnings",
      "tesla",
      "nvidia",
      "apple",
      "microsoft",
    ])
  ) {
    return "stocks";
  }
  if (isPriceBinary(text)) return "price-binary";
  return null;
}

function matches(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function isPriceBinary(text: string): boolean {
  if (/(above|below|over|under|between|hit|reach|touch)-?\$?\d/.test(text)) return true;
  return /\$[\d,.]+/.test(text);
}

function toTelemetryRejectReason(result: V4SelectionResult): V4AdmissionRejectReason {
  switch (result.reason) {
    case "category_not_hot":
      return "rejected_category_not_in_hot_cats";
    case "liquidity_too_low":
      return "rejected_liquidity_below_100";
    case "volume24h_too_low":
      return "rejected_volume_below_5";
    case "orderbook_proxy_unavailable":
      return "rejected_no_orderbook_proxy";
    case "missing_data":
      return "rejected_missing_data";
    case "admit":
      return "rejected_other_combination";
  }
}

function hasOrderbookProxy(
  bestBid: number | null | undefined,
  bestAsk: number | null | undefined,
): boolean {
  if (bestBid == null || bestAsk == null) return false;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return false;
  const spread = bestAsk - bestBid;
  return spread >= 0 && spread < ORDERBOOK_PROXY_MAX_SPREAD;
}

function zeroCategoryCounts(): Record<V4SelectionCategory, number> {
  return Object.fromEntries(HOT_CATS_40.map((category) => [category, 0])) as Record<
    V4SelectionCategory,
    number
  >;
}

function zeroRejectReasonCounts(): Record<V4AdmissionRejectReason, number> {
  return {
    rejected_category_not_in_hot_cats: 0,
    rejected_liquidity_below_100: 0,
    rejected_volume_below_5: 0,
    rejected_no_orderbook_proxy: 0,
    rejected_missing_data: 0,
    rejected_other_combination: 0,
  };
}
