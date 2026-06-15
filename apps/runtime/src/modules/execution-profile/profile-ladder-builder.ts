import type {
  LadderBuilderInput,
  LadderBuilderOutput,
  LadderRung,
  ProfileLadderBand,
} from "@krabs/domain";

export function computeProfileLadder(input: LadderBuilderInput): LadderBuilderOutput {
  if (!input.config.enabled) {
    return { ok: false, reason: "sell_ladder_disabled", band: null };
  }

  if (!hasValidCoreInputs(input)) {
    return { ok: false, reason: "invalid_input", band: null };
  }
  if (!isPositiveFinite(input.tickSize)) {
    return { ok: false, reason: "invalid_tick_size", band: null };
  }
  const band = resolveBand(input);
  if (band == null) {
    return { ok: false, reason: "invalid_input", band: null };
  }
  const bandConfig = input.config.bands[band];
  if (!bandConfig.enabled) {
    return { ok: false, reason: "band_disabled", band };
  }
  if (!isValidBbo(input.bestBid, input.bestAsk)) {
    return { ok: false, reason: "invalid_bbo", band };
  }
  if (!isPositiveFinite(input.minOrderSize)) {
    return { ok: false, reason: "invalid_input", band };
  }

  const activeRungCount = resolveActiveRungCount(input, band);
  const sizing = normalizeActiveSizing(bandConfig.sizingVector, activeRungCount);
  const modeAdjustment = input.config.modeAdjustments[input.mode];
  const rungs = sizing.map((sizingFraction, index): LadderRung => {
    const multiplier = bandConfig.multipliers[index]!;
    const price = ceilToTick(input.avgEntryPrice * multiplier * modeAdjustment, input.tickSize);
    const sizeShares = roundQuantity(input.positionSizeShares * sizingFraction);
    return {
      rungIndex: index,
      price,
      sizeShares,
      notionalUsd: roundCents(price * sizeShares),
      multiplier,
      sizingFraction,
      lifecycle: "planned",
      orderId: null,
      filledSizeShares: 0,
    };
  });

  if (rungs.some((rung) => rung.sizeShares + 1e-9 < input.minOrderSize)) {
    return { ok: false, reason: "below_min_order_size", band };
  }

  return {
    ok: true,
    ladderId: buildProfileLadderId(input, band),
    band,
    activeRungCount,
    rungs,
  };
}

function hasValidCoreInputs(input: LadderBuilderInput): boolean {
  return (
    isPositiveFinite(input.avgEntryPrice) &&
    isPositiveFinite(input.costBasisUsd) &&
    isPositiveFinite(input.positionSizeShares)
  );
}

function resolveBand(input: LadderBuilderInput): ProfileLadderBand | null {
  const avgEntry = input.avgEntryPrice;
  for (const band of ["cheap", "medium_low", "medium_high", "expensive"] as const) {
    const config = input.config.bands[band];
    const aboveLow = config.minAvgEntry == null || avgEntry >= config.minAvgEntry;
    const belowHigh = config.maxAvgEntry == null || avgEntry < config.maxAvgEntry;
    if (aboveLow && belowHigh) return band;
  }
  return null;
}

function resolveActiveRungCount(input: LadderBuilderInput, band: ProfileLadderBand): number {
  const costBasis = input.costBasisUsd;
  if (costBasis < 5) return 1;
  if (costBasis < 15) return 2;

  const bandConfig = input.config.bands[band];
  if (bandConfig.allowFourthRung && costBasis >= bandConfig.fourthRungMinCostUsd) {
    return 4;
  }
  return 3;
}

function normalizeActiveSizing(raw: readonly number[], count: number): number[] {
  const active = raw.slice(0, Math.min(4, Math.max(1, count)));
  const sum = active.reduce((acc, value) => acc + value, 0);
  return active.map((value) => roundRatio(value / sum));
}

function isValidBbo(bestBid: number | null, bestAsk: number | null): boolean {
  return isPositiveFinite(bestBid) && isPositiveFinite(bestAsk) && bestBid < bestAsk;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function ceilToTick(value: number, tick: number): number {
  return normalizePrice(Math.ceil((value - 1e-12) / tick) * tick);
}

function normalizePrice(value: number): number {
  return Number(value.toFixed(6));
}

function roundQuantity(value: number): number {
  return Number(value.toFixed(6));
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundRatio(value: number): number {
  return Number(value.toFixed(10));
}

function buildProfileLadderId(input: LadderBuilderInput, band: ProfileLadderBand): string {
  return stableHash(
    `profile-ladder|${String(input.tokenId)}|${input.openedAt}|${band}|${input.avgEntryPrice.toFixed(6)}`,
  );
}

function stableHash(raw: string): string {
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index++) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `profile_ladder_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
