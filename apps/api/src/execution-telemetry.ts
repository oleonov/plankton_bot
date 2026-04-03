import type Database from "better-sqlite3";
import type { ExecutionTelemetrySnapshot } from "@plankton/domain";

export function emptyExecutionTelemetry(): ExecutionTelemetrySnapshot {
  return {
    totalFills: 0,
    volumeUsdc: 0,
    makerFills: 0,
    takerFills: 0,
    unknownFills: 0,
    makerRatio: null,
    takerRatio: null,
    explicitFeesUsdc: 0,
    feeLeakageRatio: null,
    lastFillAt: null,
  };
}

function buildWhere(sinceIso?: string): { where: string; params: unknown[] } {
  if (!sinceIso) return { where: "", params: [] };
  return { where: "WHERE filled_at >= ?", params: [sinceIso] };
}

function toExecutionTelemetry(row: {
  total_fills: number;
  volume_usdc: number;
  maker_fills: number;
  taker_fills: number;
  unknown_fills: number;
  explicit_fees_usdc: number;
  last_fill_at: string | null;
}): ExecutionTelemetrySnapshot {
  const totalFills = row.total_fills ?? 0;
  const volumeUsdc = row.volume_usdc ?? 0;
  const makerFills = row.maker_fills ?? 0;
  const takerFills = row.taker_fills ?? 0;
  const unknownFills = row.unknown_fills ?? 0;
  const explicitFeesUsdc = row.explicit_fees_usdc ?? 0;

  return {
    totalFills,
    volumeUsdc,
    makerFills,
    takerFills,
    unknownFills,
    makerRatio: totalFills > 0 ? makerFills / totalFills : null,
    takerRatio: totalFills > 0 ? takerFills / totalFills : null,
    explicitFeesUsdc,
    feeLeakageRatio: volumeUsdc > 0 ? explicitFeesUsdc / volumeUsdc : null,
    lastFillAt: row.last_fill_at ?? null,
  };
}

export function computeExecutionTelemetry(
  db: Database.Database,
  options: { sinceIso?: string } = {},
): ExecutionTelemetrySnapshot {
  const { where, params } = buildWhere(options.sinceIso);
  const row = db
    .prepare(
      `SELECT
         COUNT(*) as total_fills,
         COALESCE(SUM(size_usdc), 0) as volume_usdc,
         COALESCE(SUM(CASE WHEN liquidity_role = 'maker' THEN 1 ELSE 0 END), 0) as maker_fills,
         COALESCE(SUM(CASE WHEN liquidity_role = 'taker' THEN 1 ELSE 0 END), 0) as taker_fills,
         COALESCE(SUM(CASE WHEN liquidity_role = 'unknown' THEN 1 ELSE 0 END), 0) as unknown_fills,
         COALESCE(SUM(fee), 0) as explicit_fees_usdc,
         MAX(filled_at) as last_fill_at
       FROM fills
       ${where}`,
    )
    .get(...params) as {
    total_fills: number;
    volume_usdc: number;
    maker_fills: number;
    taker_fills: number;
    unknown_fills: number;
    explicit_fees_usdc: number;
    last_fill_at: string | null;
  };

  return toExecutionTelemetry(row);
}

export function computeExecutionTelemetryByFamily(
  db: Database.Database,
  options: { sinceIso?: string } = {},
): Map<string, ExecutionTelemetrySnapshot> {
  const { where, params } = buildWhere(options.sinceIso);
  const rows = db
    .prepare(
      `SELECT
         family_id,
         COUNT(*) as total_fills,
         COALESCE(SUM(size_usdc), 0) as volume_usdc,
         COALESCE(SUM(CASE WHEN liquidity_role = 'maker' THEN 1 ELSE 0 END), 0) as maker_fills,
         COALESCE(SUM(CASE WHEN liquidity_role = 'taker' THEN 1 ELSE 0 END), 0) as taker_fills,
         COALESCE(SUM(CASE WHEN liquidity_role = 'unknown' THEN 1 ELSE 0 END), 0) as unknown_fills,
         COALESCE(SUM(fee), 0) as explicit_fees_usdc,
         MAX(filled_at) as last_fill_at
       FROM fills
       ${where}
       GROUP BY family_id`,
    )
    .all(...params) as Array<{
    family_id: string;
    total_fills: number;
    volume_usdc: number;
    maker_fills: number;
    taker_fills: number;
    unknown_fills: number;
    explicit_fees_usdc: number;
    last_fill_at: string | null;
  }>;

  return new Map(rows.map((row) => [row.family_id, toExecutionTelemetry(row)]));
}

export function computeExecutionTelemetryForFamily(
  db: Database.Database,
  familyId: string,
  options: { sinceIso?: string } = {},
): ExecutionTelemetrySnapshot {
  return computeExecutionTelemetryByFamily(db, options).get(familyId) ?? emptyExecutionTelemetry();
}
