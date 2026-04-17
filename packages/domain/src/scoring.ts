const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max);

const weightedSum = (components: readonly [number, number][]): number =>
  components.reduce((sum, [value, weight]) => sum + value * weight, 0);

// --- Recurrence Score (0-1) ---

export function computeRecurrenceScore(input: {
  spanDays: number;
  presenceDays: number;
  totalDays: number;
  cadenceStddev: number;
  cadenceMean: number;
  distinctConditions: number;
}): number {
  const observationSpan = clamp(input.spanDays / 30, 0, 1);
  const presenceRatio = input.totalDays > 0 ? input.presenceDays / input.totalDays : 0;
  const cadenceStability =
    input.cadenceMean > 0 ? 1 - clamp(input.cadenceStddev / input.cadenceMean, 0, 2) / 2 : 0;
  const slugDiversity = clamp(input.distinctConditions / 20, 0, 1);

  return weightedSum([
    [observationSpan, 0.25],
    [presenceRatio, 0.3],
    [cadenceStability, 0.2],
    [slugDiversity, 0.25],
  ]);
}

// --- Recycle Score (0-1) ---

export function computeRecycleScore(input: {
  tradeCount: number;
  distinctMarkets: number;
  tailAdjustedPnl: number;
  repricingExits: number;
  totalNonSettlementClosed: number;
}): number {
  const tradeDensity = clamp(input.tradeCount / 100, 0, 1);
  const marketBreadth = clamp(input.distinctMarkets / 10, 0, 1);
  const tailAdjustedPnlSign = input.tailAdjustedPnl > 0 ? 1.0 : 0.0;
  const recycleExitRatio =
    input.totalNonSettlementClosed > 0 ? input.repricingExits / input.totalNonSettlementClosed : 0;

  return weightedSum([
    [tradeDensity, 0.2],
    [marketBreadth, 0.2],
    [tailAdjustedPnlSign, 0.3],
    [recycleExitRatio, 0.3],
  ]);
}

// --- Live Viability Score (0-1) ---

export function computeLiveViabilityScore(input: {
  activeMarketCount: number;
  healthyEndDateFraction: number;
  clusterVolume24h: number;
}): number {
  const activeClusterSize = clamp(input.activeMarketCount / 5, 0, 1);
  const endDateHealth = input.healthyEndDateFraction;
  const volumeSignal = clamp(input.clusterVolume24h / 50_000, 0, 1);

  return weightedSum([
    [activeClusterSize, 0.35],
    [endDateHealth, 0.35],
    [volumeSignal, 0.3],
  ]);
}

// --- Toxicity Penalty (0-1, higher = worse) ---

export function computeToxicityPenalty(input: {
  dustCount: number;
  positionCount: number;
  tailCostUsdc: number;
  realizedPnlUsdc: number;
  reduceOnlyCount: number;
  weeksDeployed: number;
  staleCount: number;
  totalOpen: number;
}): number {
  const dustRatio = input.dustCount / Math.max(input.positionCount + input.dustCount, 1);
  const tailBurden =
    clamp(input.tailCostUsdc / Math.max(Math.abs(input.realizedPnlUsdc), 1), 0, 2) / 2;
  const reduceOnlyFrequency =
    input.weeksDeployed > 0 ? input.reduceOnlyCount / input.weeksDeployed : 0;
  const stalePositionRatio = input.totalOpen > 0 ? input.staleCount / input.totalOpen : 0;

  return weightedSum([
    [dustRatio, 0.3],
    [tailBurden, 0.35],
    [reduceOnlyFrequency, 0.2],
    [stalePositionRatio, 0.15],
  ]);
}
