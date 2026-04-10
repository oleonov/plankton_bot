/**
 * Signal-to-Order bridge — converts SignalApproved into PlaceOrderRequested.
 *
 * Closes the gap in the end-to-end trading path:
 *   strategy → SignalProduced → risk → SignalApproved → [this bridge] → PlaceOrderRequested → execution
 *
 * Responsibilities:
 *  - Subscribe to SignalApproved
 *  - Look up market metadata (tickSize, negRisk) from the cached market snapshot
 *  - Build a PlaceOrderCommand with deterministic clientOrderId
 *  - Publish PlaceOrderRequested for the execution module
 *
 * Does NOT evaluate risk — that already happened upstream.
 */

import type {
  EventBus,
  FamilyRulesProvider,
  NormalizedMarket,
  RuntimeEventMap,
  PlaceOrderCommand,
} from "@plankton/domain";
import { createCommandId, resolveFamilyLiveTradingPolicy } from "@plankton/domain";
import { buildClientOrderId } from "@plankton/domain/node";
import { randomUUID } from "node:crypto";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";

export interface SignalToOrderBridgeDeps {
  bus: EventBus;
  log: Logger;
  rulesProvider: FamilyRulesProvider;
  liveLiteGuard?: LiveLiteGuard | undefined;
}

export class SignalToOrderBridge {
  private readonly log: Logger;
  private marketCache = new Map<string, NormalizedMarket>();
  private unsubs: Array<() => void> = [];

  constructor(private readonly deps: SignalToOrderBridgeDeps) {
    this.log = deps.log.child({ component: "signal-to-order" });
  }

  subscribe(): void {
    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) => this.handleMarketUpdate(p)),
      this.deps.bus.subscribe("SignalApproved", (p) => this.handleApproved(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    for (const m of payload.markets) {
      this.marketCache.set(String(m.tokenId), m);
    }
  }

  private async handleApproved(payload: RuntimeEventMap["SignalApproved"]): Promise<void> {
    const { signal } = payload;
    const market = this.marketCache.get(String(signal.tokenId));

    if (!market) {
      this.log.warn(
        { signalId: signal.signalId, tokenId: signal.tokenId },
        "approved signal has no cached market — cannot build order command",
      );
      return;
    }

    const clientOrderId = buildClientOrderId({
      familyId: signal.familyId,
      tokenId: signal.tokenId,
      side: signal.side,
      intentEpochMs: signal.strategyTick,
      sequenceInTick: signal.sequenceInTick,
    });

    const executionTerms = this.resolveExecutionTerms(signal, market);
    if (!executionTerms) {
      this.log.warn(
        {
          signalId: signal.signalId,
          familyId: signal.familyId,
          tokenId: signal.tokenId,
          side: signal.side,
          suggestedPrice: signal.suggestedPrice,
          bestBid: market.bestBid,
          bestAsk: market.bestAsk,
        },
        "approved signal skipped — unable to derive maker-safe post-only price",
      );
      return;
    }

    const cmd: PlaceOrderCommand = {
      type: "PlaceOrderCommand",
      commandId: createCommandId(randomUUID()),
      clientOrderId,
      source: signal.reason === "operator" ? "operator" : "strategy",
      tokenId: signal.tokenId,
      side: signal.side,
      size: resolveOrderSize(signal, executionTerms.price),
      price: executionTerms.price,
      ...(executionTerms.postOnly ? { postOnly: true } : {}),
      orderType: "GTC",
      tickSize: market.tickSize,
      negRisk: market.negRisk,
      familyId: signal.familyId,
      sequenceInTick: signal.sequenceInTick,
      signalReason: signal.reason,
    };

    this.log.info(
      { signalId: signal.signalId, clientOrderId: String(clientOrderId), side: signal.side },
      "signal converted to order command",
    );

    await this.deps.bus.publish("PlaceOrderRequested", {
      command: cmd,
      timestamp: Date.now(),
    });
  }

  private resolveExecutionTerms(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
  ): { price: number; postOnly?: boolean } | null {
    if (this.deps.liveLiteGuard?.getWalletMode() !== "relayer") {
      return { price: signal.suggestedPrice };
    }

    const bundle = this.deps.rulesProvider.getRule(signal.familyId);
    if (!bundle) {
      return { price: signal.suggestedPrice };
    }

    const policy = resolveFamilyLiveTradingPolicy(bundle.identity);
    if (!policy.requiresPostOnlyForLive) {
      return { price: signal.suggestedPrice };
    }

    const makerOnlyPrice = resolveMakerOnlyPrice({
      side: signal.side,
      suggestedPrice: signal.suggestedPrice,
      market,
    });
    if (makerOnlyPrice == null) {
      return null;
    }

    return { price: makerOnlyPrice, postOnly: true };
  }
}

function resolveOrderSize(
  signal: RuntimeEventMap["SignalApproved"]["signal"],
  executionPrice: number,
): number {
  if (signal.side !== "buy") return signal.suggestedSize;
  if (!Number.isFinite(executionPrice) || executionPrice <= 0) return signal.suggestedSize;
  return signal.suggestedSizeUsdc / executionPrice;
}

function resolveMakerOnlyPrice(opts: {
  side: "buy" | "sell";
  suggestedPrice: number;
  market: Pick<NormalizedMarket, "bestBid" | "bestAsk" | "tickSize">;
}): number | null {
  const { side, suggestedPrice, market } = opts;
  const { bestBid, bestAsk, tickSize } = market;

  if (side === "buy") {
    const makerCeiling = bestBid ?? (bestAsk != null ? bestAsk - tickSize : null);
    if (makerCeiling == null) return null;
    const price = roundDownToTick(Math.min(suggestedPrice, makerCeiling), tickSize);
    if ((bestAsk != null && price >= bestAsk - 1e-9) || !isValidLimitPrice(price, tickSize)) {
      return null;
    }
    return price;
  }

  const makerFloor = bestAsk ?? (bestBid != null ? bestBid + tickSize : null);
  if (makerFloor == null) return null;
  const price = roundUpToTick(Math.max(suggestedPrice, makerFloor), tickSize);
  if ((bestBid != null && price <= bestBid + 1e-9) || !isValidLimitPrice(price, tickSize)) {
    return null;
  }
  return price;
}

function roundDownToTick(value: number, tickSize: number): number {
  const precision = getTickPrecision(tickSize);
  const units = Math.floor((value + 1e-9) / tickSize);
  return Number((units * tickSize).toFixed(precision));
}

function roundUpToTick(value: number, tickSize: number): number {
  const precision = getTickPrecision(tickSize);
  const units = Math.ceil((value - 1e-9) / tickSize);
  return Number((units * tickSize).toFixed(precision));
}

function getTickPrecision(tickSize: number): number {
  const [, decimals = ""] = tickSize.toString().split(".");
  return decimals.length;
}

function isValidLimitPrice(price: number, tickSize: number): boolean {
  return price >= tickSize - 1e-9 && price <= 1 - tickSize + 1e-9;
}
