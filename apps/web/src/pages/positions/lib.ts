import type { PositionDTO, PositionPhase } from "../../api/types.ts";

export type GroupBy = "lastAction" | "phase" | "pnl" | "ends";
export type Density = "compact" | "default" | "spacious";
export type PhaseFilter = "all" | PositionPhase;
export type MarketState = "open" | "closed";
export type ResolutionTag = "resolving" | "expired" | null;

export const PHASE_ORDER: PositionPhase[] = ["S2", "S3", "S1", "S0"];

export interface PhaseMeta {
  label: string;
  sub: string;
}

export const PHASE_META: Record<PositionPhase, PhaseMeta> = {
  S0: { label: "Idle", sub: "Closed / pre-entry" },
  S1: { label: "First Entry", sub: "1 buy · fresh" },
  S2: { label: "Accumulating", sub: "avg / stack" },
  S3: { label: "Distributing", sub: "partial sells" },
};

/** PnL for a position — unrealized + realized for open, realized only for closed. */
export function getPositionTotalPnl(p: PositionDTO): number {
  if (p.status === "closed") return p.realizedPnl;
  return p.realizedPnl + ((p.currentValueUsdc ?? 0) - p.costBasisUsdc);
}

/** Derive client-side market-state tag from position status. */
export function deriveMarketState(status: string): MarketState {
  return status === "closed" || status === "dust" ? "closed" : "open";
}

/** Derive resolution tag from server fields + endDate urgency. */
export function deriveResolutionTag(
  resolutionStatus: string | null,
  endDate: string | null,
  now: number = Date.now(),
): ResolutionTag {
  if (resolutionStatus === "detected") return "resolving";
  if (resolutionStatus === "settled") return null;
  if (endDate) {
    const endMs = parseIsoToMs(endDate);
    if (!Number.isNaN(endMs) && endMs < now) return "expired";
  }
  return null;
}

/** Milliseconds until endDate; negative means expired; +∞ when endDate is null. */
export function endsMsFrom(endDate: string | null, now: number = Date.now()): number {
  if (!endDate) return Number.POSITIVE_INFINITY;
  const end = parseIsoToMs(endDate);
  if (Number.isNaN(end)) return Number.POSITIVE_INFINITY;
  return end - now;
}

function parseIsoToMs(iso: string): number {
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(iso)) return new Date(iso).getTime();
  return new Date(iso.replace(" ", "T") + "Z").getTime();
}

const MINUS = "\u2212";

/** Monetary formatter; negative uses U+2212 minus, not hyphen. */
export function fmtMoney(n: number, opts: { showSign?: boolean } = {}): string {
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  const abs = Math.abs(n).toFixed(2);
  const sign = n < 0 ? MINUS : opts.showSign ? "+" : "";
  return `${sign}$${abs}`;
}

/** Percent (relative to basis); always signed. Returns "" when basis is zero/invalid. */
export function fmtPct(pnl: number, basis: number): string {
  if (!basis || !Number.isFinite(basis)) return "";
  const p = (pnl / basis) * 100;
  const sign = p >= 0 ? "+" : MINUS;
  return `${sign}${Math.abs(p).toFixed(1)}%`;
}

/** Compact duration: "5m" / "3h" / "6d". Used for Ends pill + Last-action ago. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(abs / 3_600_000);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(abs / 86_400_000);
  return `${days}d`;
}

/** Longer "Ends" label: "5m left" / "Expired". */
export function fmtEndsLabel(ms: number): string {
  if (!Number.isFinite(ms)) return "No deadline";
  if (ms < 0) return "Expired";
  return `${fmtDuration(ms)} left`;
}

/** Urgency class for the Ends cell. */
export function urgencyClass(ms: number): "" | "hot" | "urgent" | "expired" {
  if (!Number.isFinite(ms)) return "";
  if (ms < 0) return "expired";
  if (ms < 3_600_000) return "hot";
  if (ms < 6 * 3_600_000) return "urgent";
  return "";
}

/** "12m ago" / "1h ago" relative to now. Empty string when ts is null/invalid. */
export function fmtAgo(ts: string | null, now: number = Date.now()): string {
  if (!ts) return "";
  const ms = parseIsoToMs(ts);
  if (Number.isNaN(ms)) return "";
  const diff = Math.max(0, now - ms);
  return `${fmtDuration(diff)} ago`;
}

/** Approximate last-action recency bucket from a `lastActionAt` timestamp. */
export function lastActionMinutes(ts: string | null, now: number = Date.now()): number {
  if (!ts) return Number.POSITIVE_INFINITY;
  const ms = parseIsoToMs(ts);
  if (Number.isNaN(ms)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - ms) / 60_000);
}

export function outcomeKind(outcome: string | null): "yes" | "no" | "neutral" {
  if (!outcome) return "neutral";
  const o = outcome.toLowerCase();
  if (o === "yes" || o === "up") return "yes";
  if (o === "no" || o === "down") return "no";
  return "neutral";
}

export interface GroupBucket {
  key: string;
  items: PositionDTO[];
}

export function groupPositions(rows: PositionDTO[], groupBy: GroupBy): GroupBucket[] {
  const list = rows.slice();
  const now = Date.now();

  if (groupBy === "lastAction") {
    list.sort((a, b) => lastActionMinutes(a.lastActionAt, now) - lastActionMinutes(b.lastActionAt, now));
    return bucketize(list, [
      { key: "Active now", test: (m) => m < 15 },
      { key: "Recent (last hour)", test: (m) => m >= 15 && m < 60 },
      { key: "Today", test: (m) => m >= 60 && m < 24 * 60 },
      { key: "Older", test: (m) => m >= 24 * 60 },
    ], (p) => lastActionMinutes(p.lastActionAt, now));
  }

  if (groupBy === "phase") {
    return PHASE_ORDER
      .map((phase) => ({
        key: `${PHASE_META[phase].label} (${phase})`,
        items: list.filter((p) => p.phase === phase),
      }))
      .filter((g) => g.items.length > 0);
  }

  if (groupBy === "pnl") {
    list.sort((a, b) => getPositionTotalPnl(b) - getPositionTotalPnl(a));
    const gains = list.filter((p) => getPositionTotalPnl(p) > 0);
    const rest = list.filter((p) => getPositionTotalPnl(p) <= 0);
    const out: GroupBucket[] = [];
    if (gains.length) out.push({ key: "Gains", items: gains });
    if (rest.length) out.push({ key: "Flat / Losses", items: rest });
    return out;
  }

  // ends
  list.sort((a, b) => endsMsFrom(a.endDate, now) - endsMsFrom(b.endDate, now));
  return bucketize(list, [
    { key: "Expired", test: (m) => m < 0 },
    { key: "Closing < 1h", test: (m) => m >= 0 && m < 3_600_000 },
    { key: "Closing today", test: (m) => m >= 3_600_000 && m < 24 * 3_600_000 },
    { key: "Later", test: (m) => m >= 24 * 3_600_000 },
  ], (p) => endsMsFrom(p.endDate, now));
}

function bucketize(
  list: PositionDTO[],
  buckets: Array<{ key: string; test: (metric: number) => boolean }>,
  metricFn: (p: PositionDTO) => number,
): GroupBucket[] {
  const out: GroupBucket[] = buckets.map((b) => ({ key: b.key, items: [] as PositionDTO[] }));
  for (const p of list) {
    const m = metricFn(p);
    const idx = buckets.findIndex((b) => b.test(m));
    if (idx >= 0) out[idx]!.items.push(p);
  }
  return out.filter((b) => b.items.length > 0);
}

export function matchesSearch(p: PositionDTO, query: string): boolean {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [p.question ?? "", p.positionId, p.slug ?? "", p.outcome ?? ""]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function countsByPhase(rows: PositionDTO[]): Record<PhaseFilter, number> {
  const c: Record<PhaseFilter, number> = { all: rows.length, S0: 0, S1: 0, S2: 0, S3: 0 };
  for (const p of rows) c[p.phase]++;
  return c;
}
