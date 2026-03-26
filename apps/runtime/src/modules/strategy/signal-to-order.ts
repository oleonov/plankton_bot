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
  NormalizedMarket,
  RuntimeEventMap,
  PlaceOrderCommand,
} from "@plankton/domain";
import { createCommandId } from "@plankton/domain";
import { buildClientOrderId } from "@plankton/domain/node";
import { randomUUID } from "node:crypto";
import type { Logger } from "../../logger.js";

export interface SignalToOrderBridgeDeps {
  bus: EventBus;
  log: Logger;
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
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) =>
        this.handleMarketUpdate(p),
      ),
      this.deps.bus.subscribe("SignalApproved", (p) =>
        this.handleApproved(p),
      ),
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

  private async handleApproved(
    payload: RuntimeEventMap["SignalApproved"],
  ): Promise<void> {
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

    const cmd: PlaceOrderCommand = {
      type: "PlaceOrderCommand",
      commandId: createCommandId(randomUUID()),
      clientOrderId,
      source: signal.reason === "operator" ? "operator" : "strategy",
      tokenId: signal.tokenId,
      side: signal.side,
      size: signal.suggestedSize,
      price: signal.suggestedPrice,
      orderType: "GTC",
      tickSize: market.tickSize,
      negRisk: market.negRisk,
      familyId: signal.familyId,
      sequenceInTick: signal.sequenceInTick,
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
}
