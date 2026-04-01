import type { ClobMarket } from "@plankton/domain";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ClusterMarket {
  conditionId: string;
  slug: string;
  endDate: string | null;
  volume24h?: number;
}

export interface CandidateCluster {
  candidateId: string; // familyKey:regime:horizon
  familyKey: string;
  regime: string;
  horizon: string;
  cadence: string;
  slugPattern: string;
  patternConfidence: "high" | "medium" | "low";
  markets: ClusterMarket[];
}

// ─── Slug normalization ─────────────────────────────────────────────────────

const MONTH_NAMES =
  "january|february|march|april|may|june|july|august|september|october|november|december" +
  "|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec";

/** Temporal suffixes: -on-march-28, -by-end-of-march, -by-march-14-2026 */
const RE_TEMPORAL_SUFFIX = new RegExp(
  `-(on|by)-(?:end-of-)?(?:${MONTH_NAMES})(?:-\\d{1,2})?(?:-\\d{4})?$`,
  "i",
);

/** Trailing dated segment: -march-28, -march-28-2026 */
const RE_TRAILING_DATE = new RegExp(`-(?:${MONTH_NAMES})-\\d{1,2}(?:-\\d{4})?$`, "i");

/** Trailing ISO date: -2026-03-28 */
const RE_TRAILING_ISO = /-\d{4}-\d{2}-\d{2}$/;

/** Trailing week/period references: -week-13, -week13 */
const RE_TRAILING_WEEK = /-week-?\d+$/i;

/** Trailing numbers (e.g., -95000, -100k, -50k) */
const RE_TRAILING_NUMBER = /-\d+k?$/i;

/**
 * Strips trailing variable elements (dates, numbers, temporal suffixes)
 * from a slug to produce a stable family key.
 */
export function normalizeSlug(slug: string): string {
  let result = slug.toLowerCase();

  // Strip temporal suffixes first (most specific)
  result = result.replace(RE_TEMPORAL_SUFFIX, "");
  // Then trailing dated segments
  result = result.replace(RE_TRAILING_DATE, "");
  // ISO dates
  result = result.replace(RE_TRAILING_ISO, "");
  // Week references
  result = result.replace(RE_TRAILING_WEEK, "");
  // Trailing numbers last (least specific)
  result = result.replace(RE_TRAILING_NUMBER, "");

  return result;
}

// ─── Regime inference ───────────────────────────────────────────────────────

const REGIME_RULES: Array<{ keywords: string[]; regime: string }> = [
  { keywords: ["up-or-down", "updown"], regime: "directional-updown" },
  { keywords: ["above", "below", "hit", "reach"], regime: "threshold" },
  { keywords: ["temperature", "weather", "rain"], regime: "weather-range" },
  { keywords: ["successor", "supreme-leader", "naming"], regime: "succession" },
  { keywords: ["strike", "attack", "missile"], regime: "geopolitics" },
  { keywords: ["price", "value", "between"], regime: "price-range" },
];

export function inferRegime(slugs: string[], questions: string[]): string {
  const combined = [...slugs, ...questions].join(" ").toLowerCase();
  for (const rule of REGIME_RULES) {
    if (rule.keywords.some((kw) => combined.includes(kw))) {
      return rule.regime;
    }
  }
  return "generic";
}

// ─── Horizon inference ──────────────────────────────────────────────────────

const MS_PER_HOUR = 3_600_000;

export function inferHorizon(endDates: (string | null)[]): string {
  const valid = endDates
    .filter((d): d is string => d !== null)
    .map((d) => new Date(d).getTime())
    .filter((t) => !isNaN(t));

  if (valid.length === 0) return "ad-hoc";
  if (valid.length === 1) return "deadline";

  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const spreadHours = (max - min) / MS_PER_HOUR;

  if (spreadHours <= 8) return "intraday-4h";
  if (spreadHours <= 72) return "daily";
  if (spreadHours <= 336) return "deadline"; // 14 days
  return "ad-hoc";
}

// ─── Cadence inference ──────────────────────────────────────────────────────

export function inferCadence(endDates: (string | null)[], horizon: string): string {
  if (horizon === "intraday-4h") return "intraday-4h";
  if (horizon === "daily") return "daily-dated";
  if (horizon === "deadline") return "deadline";
  return "ad-hoc";
}

// ─── Slug pattern generation ────────────────────────────────────────────────

export function generateSlugPattern(normalizedSlug: string): string {
  // If the slug already has a trailing wildcard-friendly structure, append *
  // Otherwise append -* for families that had stripped trailing segments
  return `${normalizedSlug}-*`;
}

// ─── Incremental clusterer ───────────────────────────────────────────────────

export class IncrementalClusterer {
  private readonly groups = new Map<
    string,
    { markets: ClusterMarket[]; slugs: string[]; questions: string[]; seenConditions: Set<string> }
  >();

  addBatch(markets: ClobMarket[]): void {
    for (const m of markets) {
      const key = normalizeSlug(m.slug);
      let group = this.groups.get(key);
      if (!group) {
        group = { markets: [], slugs: [], questions: [], seenConditions: new Set() };
        this.groups.set(key, group);
      }
      if (group.seenConditions.has(m.conditionId)) continue;
      group.seenConditions.add(m.conditionId);
      group.markets.push({
        conditionId: m.conditionId,
        slug: m.slug,
        endDate: m.endDate || null,
        ...(m.volume24h != null ? { volume24h: m.volume24h } : {}),
      });
      group.slugs.push(m.slug);
      group.questions.push(m.question);
    }
  }

  finalize(): CandidateCluster[] {
    const clusters: CandidateCluster[] = [];
    for (const [familyKey, group] of this.groups) {
      const endDates = group.markets.map((m) => m.endDate);
      const regime = inferRegime(group.slugs, group.questions);
      const horizon = inferHorizon(endDates);
      const cadence = inferCadence(endDates, horizon);
      const patternConfidence = classifyConfidence(group.markets.length);

      clusters.push({
        candidateId: `${familyKey}:${regime}:${horizon}`,
        familyKey,
        regime,
        horizon,
        cadence,
        slugPattern: generateSlugPattern(familyKey),
        patternConfidence,
        markets: group.markets,
      });
    }
    this.groups.clear();
    return clusters;
  }
}

// ─── Main clustering ────────────────────────────────────────────────────────

export function clusterMarkets(markets: ClobMarket[]): CandidateCluster[] {
  const clusterer = new IncrementalClusterer();
  clusterer.addBatch(markets);
  return clusterer.finalize();
}

function classifyConfidence(count: number): "high" | "medium" | "low" {
  if (count > 5) return "high";
  if (count >= 2) return "medium";
  return "low";
}
