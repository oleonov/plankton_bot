import {
  type RiskGate,
  type Signal,
  type RiskDecision,
  type OrderRepository,
  type TokenId,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";
import { isExecutableOrderSize } from "../../min-order-size.js";

const OPEN_ORDER_STATUSES = new Set(["pending", "open", "partially-filled"]);
const TOKEN_IN_FLIGHT_LIMIT = 1;

function isBuySignal(signal: Signal): boolean {
  return signal.side === "buy";
}

function hasOpenBuyOrderForToken(orderRepo: OrderRepository, tokenId: TokenId): boolean {
  return orderRepo
    .findByTokenId(tokenId)
    .some((order) => order.side === "buy" && OPEN_ORDER_STATUSES.has(order.status));
}

export class AlgoRiskGateImpl implements RiskGate {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly log: Logger,
    private readonly resolveMinOrderSize?: (tokenId: TokenId) => number | null,
    private readonly getTokenInFlightCount?: (tokenId: TokenId) => number,
  ) {}

  async evaluate(signal: Signal): Promise<RiskDecision> {
    const passed: string[] = [];
    const rejected: string[] = [];
    const isBuy = isBuySignal(signal);

    // Sell signals bypass entry checks entirely
    if (!isBuy) {
      passed.push("sell_signal_bypass");
      return this.decision(signal, true, rejected, passed);
    }

    // 1. Token-level open-order dedupe for BUY
    if (hasOpenBuyOrderForToken(this.orderRepo, signal.tokenId)) {
      rejected.push("token already has open buy order");
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("no_open_buy_order");

    // 2. Token-level in-flight limit
    const tokenInFlight = this.getTokenInFlightCount?.(signal.tokenId) ?? 0;
    if (this.getTokenInFlightCount && tokenInFlight >= TOKEN_IN_FLIGHT_LIMIT) {
      this.log.debug(
        { tokenId: signal.tokenId, inFlight: tokenInFlight, limit: TOKEN_IN_FLIGHT_LIMIT },
        "entry rejected by token in-flight limit",
      );
      rejected.push("token-in-flight-limit");
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("token_in_flight_ok");

    // 3. Min order size
    const minOrderSize = this.resolveMinOrderSize?.(signal.tokenId) ?? null;
    if (minOrderSize != null && !isExecutableOrderSize(signal.suggestedSize, minOrderSize)) {
      rejected.push(`order size ${signal.suggestedSize} below min ${minOrderSize}`);
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("min_order_size_ok");

    return this.decision(signal, true, rejected, passed);
  }

  private decision(
    signal: Signal,
    approved: boolean,
    rejectionReasons: string[],
    checksPassed: string[],
  ): RiskDecision {
    return {
      signalId: signal.signalId,
      tokenId: signal.tokenId,
      conditionId: signal.conditionId,
      familyId: signal.familyId,
      approved,
      rejectionReasons,
      checksPassed,
      decidedAt: new Date().toISOString(),
    };
  }
}
