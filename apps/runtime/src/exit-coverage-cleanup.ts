import {
  BOUNCE_EXIT_TARGET_RULE_ID,
  S1_LADDER_RULE_ID,
  buildS1LadderId,
  bounceExitTierGain,
  computeHarvestTarget,
  normalizeDistribution,
  type Fill,
  type FillRepository,
  type Order,
  type Position,
  type BounceExitPolicy,
  type BounceRungMetadata,
} from "@krabs/domain";
import {
  SELL_REPLACEMENT_CANCELLED_ORDER_ID_METADATA_KEY,
  isProfileLadderSellOrder,
} from "./modules/profile-ladder-order-helpers.js";

const EPSILON = 1e-9;
const WORKING_STATUSES = new Set(["pending", "open", "partially-filled"]);

export interface S1CoverageCleanupV1 {
  readonly version: 1;
  readonly positionId: string;
  readonly residualSize: number;
  readonly attempt: number;
}

export interface ExitCoverageCleanupCandidate {
  readonly tokenId?: string | undefined;
  readonly conditionId?: string | undefined;
  readonly source?: string | undefined;
  readonly side: string;
  readonly decisionRuleId?: string | null | undefined;
  readonly signalReason?: string | null | undefined;
  readonly positionId?: string | null | undefined;
  readonly size: number;
  readonly price: number;
  readonly orderType?: string | undefined;
  readonly tickSize?: number | undefined;
  readonly postOnly?: boolean | undefined;
  readonly bounceRung?: unknown;
  readonly s1?: unknown;
}

export type ExitCoverageCleanupKind = "bounce" | "s1";

export function hasValidBounceCoverageTransport(
  candidate: Pick<ExitCoverageCleanupCandidate, "orderType" | "postOnly">,
): boolean {
  return candidate.orderType === "GTC" && typeof candidate.postOnly === "boolean";
}

export type ExitCoverageFillReader = Partial<
  Pick<FillRepository, "findByOrderId" | "findByOrderIds">
>;

export function loadExitCoverageFillTotals(
  orders: readonly Order[],
  reader: ExitCoverageFillReader | undefined,
): ReadonlyMap<string, number> | null {
  if (typeof reader?.findByOrderId !== "function") return null;
  const ids = orders.map((order) => String(order.orderId));
  if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) return null;
  try {
    const fills =
      typeof reader.findByOrderIds === "function"
        ? reader.findByOrderIds(orders.map((order) => order.orderId))
        : orders.flatMap((order) => reader.findByOrderId!(order.orderId));
    if (!Array.isArray(fills)) return null;
    const totals = new Map(ids.map((id) => [id, 0]));
    for (const fill of fills) {
      const id = String(fill?.orderId);
      const total = totals.get(id);
      if (total === undefined || !isPositive(fill?.size) || !Number.isFinite(total + fill.size)) {
        return null;
      }
      totals.set(id, total + fill.size);
    }
    return totals;
  } catch {
    return null;
  }
}

export function matchesExactBounceSupplementalCoverage(input: {
  readonly candidate: ExitCoverageCleanupCandidate;
  readonly position: Position | null;
  readonly orders: readonly Order[];
  readonly policy: BounceExitPolicy | undefined;
  readonly filledSize: (order: Order) => number | null;
}): boolean {
  const { candidate, position, policy } = input;
  const rung = isRecord(candidate.bounceRung) ? candidate.bounceRung : null;
  if (
    !position ||
    position.status !== "open" ||
    position.exitOwner !== "bounce" ||
    !policy ||
    candidate.side !== "sell" ||
    candidate.decisionRuleId !== BOUNCE_EXIT_TARGET_RULE_ID ||
    candidate.signalReason !== "repricing-exit" ||
    candidate.positionId !== position.positionId ||
    candidate.tokenId !== position.tokenId ||
    candidate.conditionId !== position.conditionId ||
    !isPositive(candidate.tickSize) ||
    !rung ||
    rung.isCleanupRung === true ||
    typeof rung.ladderId !== "string" ||
    !Number.isInteger(rung.rungIndex) ||
    !isPositive(rung.anchorPrice) ||
    !isPositive(rung.fraction) ||
    !isPositive(rung.originalPositionSize) ||
    !isPositive(rung.remainingPositionSize) ||
    !isPositive(rung.uncommittedRemainder)
  ) {
    return false;
  }
  const rungIndex = rung.rungIndex as number;
  if (
    rungIndex < 0 ||
    rungIndex >= policy.ladderFractions.length ||
    !sameNumber(rung.fraction, policy.ladderFractions[rungIndex]!) ||
    !sameNumber(candidate.size, rung.originalPositionSize * rung.fraction) ||
    !sameNumber(rung.remainingPositionSize, position.size) ||
    !sameNumber(rung.uncommittedRemainder, candidate.size) ||
    !sameNumber(
      candidate.price,
      bounceTarget(policy, rung.anchorPrice, rungIndex, candidate.tickSize),
    )
  ) {
    return false;
  }

  const working = input.orders.filter(
    (order) =>
      order.side === "sell" &&
      order.tokenId === position.tokenId &&
      WORKING_STATUSES.has(order.status),
  );
  const cleanup = working.filter((order) => bounceRungMetadata(order)?.isCleanupRung === true);
  const ordinary = working.filter((order) => bounceRungMetadata(order)?.isCleanupRung !== true);
  if (
    cleanup.length !== 1 ||
    ordinary.length !== policy.ladderFractions.length - 1 ||
    working.some(
      (order) =>
        order.decisionRuleId !== BOUNCE_EXIT_TARGET_RULE_ID ||
        order.conditionId !== position.conditionId ||
        order.positionId !== position.positionId ||
        !order.exchangeOrderId,
    ) ||
    !matchesBounceLineage(cleanup[0]!, rung, candidate, policy, true)
  ) {
    return false;
  }

  const indices = new Set<number>();
  for (const order of ordinary) {
    const orderRung = bounceRungMetadata(order);
    if (
      !orderRung ||
      orderRung.rungIndex === rungIndex ||
      indices.has(orderRung.rungIndex) ||
      !matchesBounceLineage(order, rung, candidate, policy, false)
    ) {
      return false;
    }
    indices.add(orderRung.rungIndex);
  }
  const remaining = working.reduce((total, order) => {
    const filled = input.filledSize(order);
    return filled == null || filled < 0 || filled > order.size + EPSILON
      ? Number.NaN
      : total + Math.max(0, order.size - filled);
  }, 0);
  return (
    Number.isFinite(remaining) &&
    sameNumber(position.size - remaining, candidate.size) &&
    sameNumber(remaining + candidate.size, position.size)
  );
}

function matchesBounceLineage(
  order: Order,
  candidateRung: Record<string, unknown>,
  candidate: ExitCoverageCleanupCandidate,
  policy: BounceExitPolicy,
  cleanup: boolean,
): boolean {
  const rung = bounceRungMetadata(order);
  if (
    !rung ||
    !hasValidBounceCoverageTransport(order) ||
    rung.ladderId !== candidateRung.ladderId ||
    !sameNumber(rung.anchorPrice, candidateRung.anchorPrice as number) ||
    !sameNumber(rung.originalPositionSize, candidateRung.originalPositionSize as number)
  ) {
    return false;
  }
  if (cleanup) {
    return (
      classifyExitCoverageCleanup(
        { ...order, tickSize: candidate.tickSize, bounceRung: rung },
        policy,
      ) === "bounce" &&
      sameNumber(rung.remainingPositionSize, candidateRung.remainingPositionSize as number)
    );
  }
  const index = rung.rungIndex;
  const fraction = policy.ladderFractions[index];
  return (
    Number.isInteger(index) &&
    fraction !== undefined &&
    rung.isCleanupRung !== true &&
    (!rung.rungIndicesCovered ||
      (rung.rungIndicesCovered.length === 1 && rung.rungIndicesCovered[0] === index)) &&
    sameNumber(rung.fraction, fraction) &&
    sameNumber(order.size, rung.originalPositionSize * fraction) &&
    sameNumber(order.price, bounceTarget(policy, rung.anchorPrice, index, candidate.tickSize!))
  );
}

function bounceTarget(
  policy: BounceExitPolicy,
  anchorPrice: number,
  rungIndex: number,
  tickSize: number,
): number {
  const gain =
    (1 + bounceExitTierGain(policy, anchorPrice)) * Math.pow(1 + policy.ladderStepPct, rungIndex) -
    1;
  return computeHarvestTarget(anchorPrice, gain, tickSize);
}

function bounceRungMetadata(order: Order): BounceRungMetadata | null {
  const value = order.metadata?.bounceRung;
  return isRecord(value) ? (value as unknown as BounceRungMetadata) : null;
}

export interface ExactS1CoverageCleanupState {
  readonly ladderId: string;
  readonly tierIndex: number;
  readonly targetPrice: number;
  readonly residualSize: number;
  readonly attempt: number;
}

export function findS1CoverageWorkingSells(orders: readonly Order[], position: Position): Order[] {
  return orders.filter(
    (order) =>
      order.side === "sell" &&
      order.tokenId === position.tokenId &&
      order.conditionId === position.conditionId &&
      order.positionId === position.positionId &&
      WORKING_STATUSES.has(order.status),
  );
}

export function s1CoverageFillLookup(fills: readonly Fill[]) {
  return {
    findByOrderId: (orderId: Order["orderId"]) => fills.filter((fill) => fill.orderId === orderId),
  };
}

export function resolveExactS1CoverageCleanupState(input: {
  readonly position: Position;
  readonly orders: readonly Order[];
  readonly fills: readonly Fill[];
  readonly reservedSellSize: number;
  readonly numTiers: number;
  readonly volumeDistribution: readonly number[];
  readonly nowMs: number;
}): ExactS1CoverageCleanupState | null {
  if (input.position.status !== "open" || !isPositive(input.position.size)) return null;
  const working = findS1CoverageWorkingSells(input.orders, input.position);
  const ordinary = working.filter((order) => order.decisionRuleId === S1_LADDER_RULE_ID);
  if (working.length !== ordinary.length) return null;
  const filled = sumFills(input.fills);
  const ladder =
    resolveExactS1Ladder(ordinary, input.position, input.numTiers) ??
    resolveExactSparseProfileHandoff(ordinary, input, filled);
  if (
    !ladder ||
    !filled ||
    working.some((order) => (filled.get(String(order.orderId)) ?? 0) > order.size + EPSILON)
  ) {
    return null;
  }
  const history = input.orders.filter(
    (order) =>
      order.positionId === input.position.positionId && hasS1CoverageCleanupMarker(order.metadata),
  );
  const attempt = resolveCleanupAttempt(history, filled, ladder, input.position, input.nowMs);
  if (attempt == null || !Number.isFinite(input.reservedSellSize) || input.reservedSellSize < 0) {
    return null;
  }
  return {
    ...ladder,
    residualSize: roundShares(Math.max(0, input.position.size - input.reservedSellSize)),
    attempt,
  };
}

function resolveExactSparseProfileHandoff(
  workingS1: readonly Order[],
  input: {
    readonly position: Position;
    readonly orders: readonly Order[];
    readonly numTiers: number;
    readonly volumeDistribution: readonly number[];
  },
  filled: ReadonlyMap<string, number> | null,
): Omit<ExactS1CoverageCleanupState, "residualSize" | "attempt"> | null {
  const top = resolveExactSparseS1Top(workingS1, input, filled);
  const profile = resolveExactCancelledProfile(input, filled);
  if (
    !top ||
    !profile ||
    top.order.metadata?.[SELL_REPLACEMENT_CANCELLED_ORDER_ID_METADATA_KEY] !==
      String(profile.orderId)
  ) {
    return null;
  }
  return top.ladder;
}

function resolveExactSparseS1Top(
  workingS1: readonly Order[],
  input: {
    readonly position: Position;
    readonly numTiers: number;
    readonly volumeDistribution: readonly number[];
  },
  filled: ReadonlyMap<string, number> | null,
) {
  const top = workingS1[0];
  const parsed = top ? parseOrdinaryS1Order(top, input.position) : null;
  const fractions = normalizeDistribution(input.volumeDistribution, input.numTiers);
  if (
    workingS1.length !== 1 ||
    !top ||
    !parsed ||
    !filled ||
    top.status !== "open" ||
    !top.exchangeOrderId ||
    (filled.get(String(top.orderId)) ?? 0) > EPSILON ||
    parsed.tierIndex !== input.numTiers - 1 ||
    parsed.ladderId !== buildS1LadderId(input.position) ||
    !sameNumber(parsed.positionSizeTotal, input.position.size) ||
    !sameNumber(top.size, roundTierSize(input.position.size * fractions.at(-1)!))
  ) {
    return null;
  }
  return { order: top, ladder: parsed };
}

function resolveExactCancelledProfile(
  input: { readonly position: Position; readonly orders: readonly Order[] },
  filled: ReadonlyMap<string, number> | null,
): Order | null {
  if (!filled) return null;
  const profiles = input.orders.filter(
    (order) =>
      order.tokenId === input.position.tokenId &&
      order.conditionId === input.position.conditionId &&
      order.positionId === input.position.positionId &&
      order.status === "cancelled" &&
      order.cancelReason === "sell_timeout_escalation" &&
      order.fillProgressShares === 0 &&
      order.postOnly === true &&
      !!order.exchangeOrderId &&
      sameNumber(order.size, input.position.size) &&
      (filled.get(String(order.orderId)) ?? 0) <= EPSILON &&
      isProfileLadderSellOrder(order),
  );
  return profiles.length === 1 ? profiles[0]! : null;
}

export function classifyExitCoverageCleanup(
  candidate: ExitCoverageCleanupCandidate,
  bounceExit?: BounceExitPolicy,
): ExitCoverageCleanupKind | null {
  if (!isCommonCleanupShape(candidate)) return null;
  if (candidate.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID) {
    return isExactBounceCleanup(candidate, bounceExit) ? "bounce" : null;
  }
  if (candidate.decisionRuleId === S1_LADDER_RULE_ID) {
    return isExactS1Cleanup(candidate) ? "s1" : null;
  }
  return null;
}

export function parseS1CoverageCleanup(value: unknown): S1CoverageCleanupV1 | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== 1 ||
    typeof value.positionId !== "string" ||
    value.positionId.length === 0 ||
    !isPositive(value.residualSize) ||
    !Number.isInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    (value.attempt as number) > 3
  ) {
    return null;
  }
  return value as unknown as S1CoverageCleanupV1;
}

export function hasS1CoverageCleanupMarker(metadata: unknown): boolean {
  if (!isRecord(metadata) || !isRecord(metadata.s1)) return false;
  return "coverageCleanupV1" in metadata.s1;
}

function isCommonCleanupShape(candidate: ExitCoverageCleanupCandidate): boolean {
  return (
    candidate.side === "sell" &&
    candidate.signalReason === "repricing-exit" &&
    candidate.positionId != null &&
    String(candidate.positionId).length > 0 &&
    isPositive(candidate.size) &&
    isPositive(candidate.price) &&
    (candidate.tickSize === undefined || isPositive(candidate.tickSize)) &&
    (candidate.source === undefined || candidate.source === "strategy")
  );
}

function isExactBounceCleanup(
  candidate: ExitCoverageCleanupCandidate,
  policy: BounceExitPolicy | undefined,
): boolean {
  if (!policy || !isPositive(candidate.tickSize) || !isRecord(candidate.bounceRung)) return false;
  const rung = candidate.bounceRung as unknown as BounceRungMetadata;
  const lastIndex = policy.ladderFractions.length - 1;
  if (
    rung.isCleanupRung !== true ||
    typeof rung.ladderId !== "string" ||
    rung.ladderId.length === 0 ||
    rung.rungIndex !== lastIndex ||
    !isPositive(rung.anchorPrice) ||
    !isPositive(rung.fraction) ||
    !isPositive(rung.originalPositionSize) ||
    !isPositive(rung.remainingPositionSize) ||
    !isPositive(rung.uncommittedRemainder) ||
    !sameNumber(rung.uncommittedRemainder, candidate.size) ||
    (rung.uncommittedRemainder ?? 0) > rung.remainingPositionSize + EPSILON
  ) {
    return false;
  }
  const gain =
    (1 + bounceExitTierGain(policy, rung.anchorPrice)) *
      Math.pow(1 + policy.ladderStepPct, lastIndex) -
    1;
  return sameNumber(
    candidate.price,
    computeHarvestTarget(rung.anchorPrice, gain, candidate.tickSize),
  );
}

function isExactS1Cleanup(candidate: ExitCoverageCleanupCandidate): boolean {
  if (candidate.postOnly !== true || !isRecord(candidate.s1)) return false;
  const cleanup = parseS1CoverageCleanup(candidate.s1.coverageCleanupV1);
  return (
    cleanup != null &&
    cleanup.positionId === String(candidate.positionId) &&
    sameNumber(cleanup.residualSize, candidate.size) &&
    typeof candidate.s1.ladderId === "string" &&
    candidate.s1.ladderId.length > 0 &&
    Number.isInteger(candidate.s1.tierIndex) &&
    isPositive(candidate.s1.targetPrice) &&
    sameNumber(candidate.s1.targetPrice, candidate.price) &&
    isPositive(candidate.s1.positionSizeTotal) &&
    candidate.s1.handoffStartedAt === null
  );
}

function resolveExactS1Ladder(
  orders: readonly Order[],
  position: Position,
  numTiers: number,
): Omit<ExactS1CoverageCleanupState, "residualSize" | "attempt"> | null {
  if (
    orders.length !== numTiers ||
    orders.some((order) => hasS1CoverageCleanupMarker(order.metadata))
  ) {
    return null;
  }
  const tiers = orders.map((order) => parseOrdinaryS1Order(order, position));
  if (tiers.some((tier) => tier == null)) return null;
  const exact = tiers as Array<{
    ladderId: string;
    tierIndex: number;
    targetPrice: number;
    positionSizeTotal: number;
  }>;
  const first = exact[0]!;
  if (
    exact.some(
      (tier) =>
        tier.ladderId !== first.ladderId ||
        !sameNumber(tier.positionSizeTotal, first.positionSizeTotal),
    ) ||
    !sameNumber(
      orders.reduce((total, order) => total + order.size, 0),
      first.positionSizeTotal,
    )
  ) {
    return null;
  }
  exact.sort((left, right) => left.tierIndex - right.tierIndex);
  if (
    exact.some((tier, index) => tier.tierIndex !== index) ||
    exact.some((tier, index) => index > 0 && tier.targetPrice <= exact[index - 1]!.targetPrice)
  ) {
    return null;
  }
  const top = exact.at(-1)!;
  return { ladderId: top.ladderId, tierIndex: top.tierIndex, targetPrice: top.targetPrice };
}

function parseOrdinaryS1Order(order: Order, position: Position) {
  const s1 = isRecord(order.metadata?.s1) ? order.metadata.s1 : null;
  if (
    !s1 ||
    order.signalReason !== "repricing-exit" ||
    order.postOnly !== true ||
    order.positionId !== position.positionId ||
    order.conditionId !== position.conditionId ||
    s1.handoffStartedAt !== null ||
    typeof s1.ladderId !== "string" ||
    s1.ladderId.length === 0 ||
    !Number.isInteger(s1.tierIndex) ||
    !isPositive(s1.targetPrice) ||
    !sameNumber(s1.targetPrice, order.price) ||
    !isPositive(s1.positionSizeTotal)
  ) {
    return null;
  }
  return {
    ladderId: s1.ladderId,
    tierIndex: s1.tierIndex as number,
    targetPrice: s1.targetPrice,
    positionSizeTotal: s1.positionSizeTotal,
  };
}

function resolveCleanupAttempt(
  history: readonly Order[],
  filled: ReadonlyMap<string, number>,
  ladder: { ladderId: string; tierIndex: number; targetPrice: number },
  position: Position,
  nowMs: number,
): number | null {
  if (history.length === 0) return 1;
  const attempts = history.map((order) => {
    const s1 = isRecord(order.metadata?.s1) ? order.metadata.s1 : null;
    const cleanup = parseS1CoverageCleanup(s1?.coverageCleanupV1);
    if (
      classifyExitCoverageCleanup({ ...order, s1: order.metadata?.s1 }) !== "s1" ||
      !cleanup ||
      order.tokenId !== position.tokenId ||
      order.conditionId !== position.conditionId ||
      cleanup.positionId !== position.positionId ||
      s1?.ladderId !== ladder.ladderId ||
      s1.tierIndex !== ladder.tierIndex ||
      !sameNumber(s1.targetPrice as number, ladder.targetPrice) ||
      (filled.get(String(order.orderId)) ?? 0) > EPSILON ||
      (order.status !== "cancelled" && order.status !== "rejected")
    ) {
      return null;
    }
    return { attempt: cleanup.attempt, updatedAt: Date.parse(order.updatedAt) };
  });
  if (attempts.some((attempt) => attempt == null)) return null;
  const exact = attempts as Array<{ attempt: number; updatedAt: number }>;
  exact.sort((left, right) => left.attempt - right.attempt);
  if (exact.some((attempt, index) => attempt.attempt !== index + 1)) return null;
  const latest = exact.at(-1)!;
  return latest.attempt < 3 &&
    Number.isFinite(latest.updatedAt) &&
    nowMs - latest.updatedAt >= 60_000
    ? latest.attempt + 1
    : null;
}

function sumFills(fills: readonly Fill[]): Map<string, number> | null {
  const totals = new Map<string, number>();
  for (const fill of fills) {
    if (!isPositive(fill.size)) return null;
    const id = String(fill.orderId);
    totals.set(id, (totals.get(id) ?? 0) + fill.size);
  }
  return totals;
}

function roundShares(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function roundTierSize(value: number): number {
  return Math.floor((value + 1e-12) * 1_000_000) / 1_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}
