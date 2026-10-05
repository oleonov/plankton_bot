import { floorToSecondMs, parseInstantMs, RESOLVED_LOSER_LOCAL_CANCEL_REASON } from "@krabs/domain";
import type {
  ExchangeFill,
  MarketResolution,
  Order,
  Position,
  PositionRepository,
  SettlementLedgerRepository,
} from "@krabs/domain";
import { isStableClobResolutionProof } from "../resolution/resolution-detector.js";
import type { OrderReconcilerDeps } from "./order-reconciler.js";
import { importExchangeFills } from "./fill-reconciler.js";
import {
  applyOrderVerdictInLane,
  inOrderLifecycleLane,
  persistedGrossShares,
  persistTerminalVerdictInLane,
} from "./order-status-resolver.js";

type Evidence = NonNullable<
  ReturnType<NonNullable<SettlementLedgerRepository["findLocalClosureEvidence"]>>
>;
const RECOVERY_MARKERS = [
  "submitUnknownRecoveryV1",
  "startupExitRecoveryBlockV1",
  "exitRecoveryFenceV1",
  "exitRecoveryChildV1",
];
const normalize = (value: string): string => value.trim().toLowerCase();

function ordinaryMetadata(raw: string | null): boolean {
  if (raw === null) return true;
  try {
    const metadata: unknown = JSON.parse(raw);
    return (
      typeof metadata === "object" &&
      metadata !== null &&
      !Array.isArray(metadata) &&
      RECOVERY_MARKERS.every((key) => !Object.hasOwn(metadata, key))
    );
  } catch {
    return false;
  }
}

export function provesLoser(resolution: MarketResolution, tokenId: string): boolean {
  if (
    resolution.status !== "settled" ||
    !resolution.resolution.trim() ||
    ["unknown", "algo-redeem"].includes(normalize(resolution.resolution))
  )
    return false;
  try {
    const parsed: unknown = JSON.parse(resolution.rawResponse ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const raw = parsed as Record<string, unknown>;
    if (resolution.source === "clob-api") return clobProvesLoser(resolution, tokenId, raw);
    return resolution.source === "gamma-api" && gammaProvesLoser(resolution, tokenId, raw);
  } catch {
    return false;
  }
}

function clobProvesLoser(
  resolution: MarketResolution,
  tokenId: string,
  raw: Record<string, unknown>,
): boolean {
  if (
    !isStableClobResolutionProof(
      resolution.rawResponse,
      resolution.conditionId,
      resolution.resolution,
    )
  )
    return false;
  const tokens = raw.tokens as Array<{ tokenId: string; outcome: string; winner: boolean }>;
  return (
    new Set(tokens.map((t) => normalize(t.outcome))).size === 2 &&
    tokens.some((t) => t.tokenId === tokenId && t.winner === false && !!t.outcome)
  );
}

function gammaProvesLoser(
  resolution: MarketResolution,
  tokenId: string,
  raw: Record<string, unknown>,
): boolean {
  if (
    raw.closed !== true ||
    raw.umaResolutionStatus !== "resolved" ||
    raw.conditionId !== resolution.conditionId
  )
    return false;
  const array = (value: unknown): unknown[] => {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  };
  const ids = array(raw.clobTokenIds),
    outcomes = array(raw.outcomes),
    prices = array(raw.outcomePrices);
  if (
    ![ids, outcomes, prices].every((a) => Array.isArray(a) && a.length === 2) ||
    !ids.every((id) => typeof id === "string" && !!id.trim()) ||
    new Set(ids).size !== 2 ||
    !outcomes.every((o) => typeof o === "string" && !!o.trim())
  )
    return false;
  const labels = (outcomes as string[]).map(normalize);
  const winner = labels.indexOf(normalize(resolution.resolution)),
    loser = ids.indexOf(tokenId);
  return (
    new Set(labels).size === 2 &&
    winner >= 0 &&
    loser >= 0 &&
    winner !== loser &&
    (prices[loser] === 0 || prices[loser] === "0") &&
    (prices[winner] === 1 || prices[winner] === "1") &&
    corroboratesGammaMapping(raw.tokens, ids, labels, winner)
  );
}

function corroboratesGammaMapping(
  tokens: unknown,
  ids: unknown[],
  labels: string[],
  winner: number,
): boolean {
  if (tokens === undefined) return true;
  if (!Array.isArray(tokens) || tokens.length !== 2) return false;
  // A second mapping, when supplied, must corroborate the indexed proof.
  return (
    tokens.every((t: { token_id: string; outcome: string; winner: boolean }) => {
      const i = ids.indexOf(t.token_id);
      return (
        i >= 0 &&
        typeof t.outcome === "string" &&
        normalize(t.outcome) === labels[i] &&
        t.winner === (i === winner)
      );
    }) && new Set(tokens.map((t: { token_id: string }) => t.token_id)).size === 2
  );
}

function recoveryOwned(order: Order, deps: OrderReconcilerDeps): boolean {
  return (
    !!deps.exactNullStartupQuarantine?.isExactNullStartupOrderQuarantined(order) ||
    [
      ...(deps.recoveryContexts ?? []),
      ...(deps.exactNullStartupQuarantine?.getSubmitUnknownRecoveryContexts?.() ?? []),
    ].some((context) => context.order.orderId === order.orderId)
  );
}

export function hasResolvedLoserLocalClosureEvidence(
  order: Order,
  deps: OrderReconcilerDeps,
): boolean {
  return localClosureEvidence(order, deps) !== null;
}

function localClosureEvidence(order: Order, deps: OrderReconcilerDeps): Evidence | null {
  if (
    !deps.fillRepo ||
    !deps.bus ||
    !deps.orderRepo.findLocallyClosedResolvedLosers ||
    !deps.settlementLedgerRepo?.findLocalClosureEvidence ||
    !deps.positionRepo ||
    !deps.marketResolutionRepo ||
    order.side !== "sell" ||
    !["open", "partially-filled"].includes(order.status) ||
    !order.exchangeOrderId?.trim() ||
    !order.positionId ||
    recoveryOwned(order, deps) ||
    !Number.isFinite(parseInstantMs(order.createdAt))
  )
    return null;
  const position = matchingClosedPosition(order, deps.positionRepo);
  if (!position) return null;
  const resolution = deps.marketResolutionRepo.findByConditionId(order.conditionId);
  if (
    !resolution ||
    resolution.conditionId !== order.conditionId ||
    !provesLoser(resolution, order.tokenId)
  )
    return null;
  const evidence = deps.settlementLedgerRepo.findLocalClosureEvidence(order);
  if (!evidence || !ordinaryMetadata(evidence.metadataJson) || evidence.settlements.length !== 1)
    return null;
  return settledAccountingMatches(evidence, order, position, resolution) ? evidence : null;
}

function settledAccountingMatches(
  evidence: Evidence,
  order: Order,
  position: Position,
  resolution: MarketResolution,
): boolean {
  const settlement = evidence.settlements[0]!;
  const inserted = parseInstantMs(settlement.createdAt ?? ""),
    settled = parseInstantMs(settlement.settledAt);
  const secondPrecision = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(settlement.createdAt ?? "");
  if (
    settlement.positionId !== order.positionId ||
    settlement.tokenId !== order.tokenId ||
    settlement.conditionId !== order.conditionId ||
    settlement.settlementPrice !== 0 ||
    normalize(settlement.resolution) !== normalize(resolution.resolution) ||
    !Number.isFinite(inserted) ||
    // SQLite's default records the insertion bucket, not its millisecond instant.
    inserted < (secondPrecision ? floorToSecondMs(settled) : settled) ||
    settled !== parseInstantMs(resolution.resolvedAt) ||
    !Number.isFinite(settled) ||
    parseInstantMs(position.closedAt!) < settled
  )
    return false;
  return evidence.fills.every((fill) => accounted(fill, order, settled, inserted));
}

export function matchingClosedPosition(order: Order, repo: PositionRepository): Position | null {
  const position = repo.findById(order.positionId!);
  if (
    !position ||
    position.tokenId !== order.tokenId ||
    position.conditionId !== order.conditionId ||
    position.status !== "closed" ||
    position.size !== 0 ||
    !position.closedAt ||
    !Number.isFinite(parseInstantMs(position.closedAt)) ||
    !Number.isFinite(parseInstantMs(position.openedAt)) ||
    parseInstantMs(position.openedAt) > parseInstantMs(position.closedAt) ||
    repo.findActiveByTokenId(order.tokenId).length !== 0
  )
    return null;
  return position;
}

function accounted(
  fill: Evidence["fills"][number],
  order: Order,
  settled: number,
  inserted: number,
): boolean {
  const at = parseInstantMs(fill.filledAt);
  return (
    !!fill.fillId &&
    !!fill.orderId &&
    fill.tokenId === order.tokenId &&
    fill.conditionId === order.conditionId &&
    ["buy", "sell"].includes(fill.side) &&
    (fill.orderId !== order.orderId || fill.side === "sell") &&
    fill.reconciled === 1 &&
    Number.isFinite(at) &&
    at <= settled &&
    (fill.orderId !== order.orderId || at >= floorToSecondMs(parseInstantMs(order.createdAt))) &&
    fill.accounting.length === 1 &&
    fill.accounting.every(
      (a) =>
        a.positionId === order.positionId &&
        a.tokenId === order.tokenId &&
        parseInstantMs(a.createdAt) >= at &&
        parseInstantMs(a.createdAt) < inserted,
    )
  );
}

function sameIdentity(left: Order, right: Order): boolean {
  const identity = (o: Order) => [
    o.orderId,
    o.clientOrderId,
    o.exchangeOrderId,
    o.tokenId,
    o.conditionId,
    o.positionId,
    o.side,
    o.orderType,
    o.price,
    o.size,
    o.sizeUsdc,
    o.createdAt,
  ];
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}

export async function closeResolvedLosers(
  candidates: readonly Order[],
  deps: OrderReconcilerDeps,
): Promise<void> {
  const eligible = candidates.filter((order) => {
    const fresh = deps.orderRepo.findById(order.orderId);
    return fresh && sameIdentity(order, fresh) && localClosureEvidence(fresh, deps);
  });
  if (!eligible.length || !deps.gateway.getFillsResult || !deps.gateway.getOrderResult) return;
  const since =
    Math.min(...eligible.map((o) => floorToSecondMs(parseInstantMs(o.createdAt)))) - 1000;
  const history = await deps.gateway.getFillsResult(since);
  if (!history.ok) return;
  await importExchangeFills(history.data, {
    ...deps,
    fillRepo: deps.fillRepo!,
    bus: deps.bus!,
    deferPendingExactFills: true,
    recoveryContexts: [
      ...(deps.recoveryContexts ?? []),
      ...(deps.exactNullStartupQuarantine?.getSubmitUnknownRecoveryContexts?.() ?? []),
    ],
  });
  for (const candidate of eligible) await closeCandidateAfterHistory(candidate, history.data, deps);
}

async function closeCandidateAfterHistory(
  candidate: Order,
  history: ExchangeFill[],
  deps: OrderReconcilerDeps,
): Promise<void> {
  const order = deps.orderRepo.findById(candidate.orderId);
  if (!order || !sameIdentity(candidate, order)) return;
  const evidence = localClosureEvidence(order, deps);
  if (
    !evidence ||
    history.some(
      (fill) =>
        (fill.orderId === order.exchangeOrderId || fill.clientOrderId === order.clientOrderId) &&
        !evidence.fills.some((persisted) => persisted.fillId === fill.fillId),
    )
  )
    return;

  await inOrderLifecycleLane(String(order.orderId), () =>
    confirmLocalClosure(order, evidence, deps),
  );
}

async function confirmLocalClosure(
  order: Order,
  evidence: Evidence,
  deps: OrderReconcilerDeps,
): Promise<void> {
  const exact = await deps.gateway.getOrderResult!(order.exchangeOrderId!);
  if (!exact.ok) return;
  const fresh = deps.orderRepo.findById(order.orderId);
  if (!fresh || !sameIdentity(order, fresh) || recoveryOwned(fresh, deps)) return;
  const args = {
    ...deps,
    fillRepo: deps.fillRepo!,
    orderId: fresh.orderId,
    exchange: exact.data,
    publish: true,
  };
  if (exact.data) {
    await applyOrderVerdictInLane(args);
    return;
  }
  const proof = localClosureEvidence(fresh, deps);
  // Even a newly accounted fill invalidates the lifetime snapshot used for this attempt.
  if (!proof || JSON.stringify(proof.fills) !== JSON.stringify(evidence.fills)) return;
  await persistTerminalVerdictInLane(
    args,
    fresh,
    { status: "cancelled", reason: RESOLVED_LOSER_LOCAL_CANCEL_REASON },
    persistedGrossShares(deps.fillRepo!, fresh),
  );
}
