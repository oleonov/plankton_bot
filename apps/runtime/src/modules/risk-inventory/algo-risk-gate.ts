import {
  type RiskGate,
  type Signal,
  type RiskDecision,
  type FamilyStateRepository,
  type OrderRepository,
  type FamilyId,
  type TokenId,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import { isExecutableOrderSize } from "../../min-order-size.js";

const OPEN_ORDER_STATUSES = new Set(["pending", "open", "partially-filled"]);
const FAMILY_IN_FLIGHT_LIMIT = 8;
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
    private readonly familyStateRepo: FamilyStateRepository,
    private readonly orderRepo: OrderRepository,
    private readonly log: Logger,
    private readonly liveLiteGuard?: LiveLiteGuard,
    private readonly resolveMinOrderSize?: (tokenId: TokenId) => number | null,
    private readonly getInFlightCount?: (familyId: FamilyId) => number,
    private readonly getTokenInFlightCount?: (tokenId: TokenId) => number,
  ) {}

  async evaluate(signal: Signal): Promise<RiskDecision> {
    const passed: string[] = [];
    const rejected: string[] = [];
    const isBuy = isBuySignal(signal);

    // 1. Live-lite allowlist
    if (
      this.liveLiteGuard?.isActive &&
      !this.liveLiteGuard.isFamilyAllowed(String(signal.familyId))
    ) {
      rejected.push("live-lite-allowlist-rejected");
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("live_lite_allowlist_ok");

    // 2. Family runtime mode
    const familyState = this.familyStateRepo.get(signal.familyId);
    const mode = familyState?.runtimeMode ?? "active";

    if (mode === "quarantine" && signal.reason !== "operator") {
      rejected.push("family in quarantine mode");
      return this.decision(signal, false, rejected, passed);
    }

    if (mode === "reduce-only" && isBuy) {
      rejected.push("family in reduce-only mode — entry blocked");
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("runtime_mode_allows");

    // Checks 3-6 apply only to buy (entry) signals
    if (!isBuy) {
      passed.push("sell_signal_bypass");
      return this.decision(signal, true, rejected, passed);
    }

    // 3. Token-level open-order dedupe for BUY
    if (hasOpenBuyOrderForToken(this.orderRepo, signal.tokenId)) {
      rejected.push("token already has open buy order");
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("no_open_buy_order");

    // 4. Family-level in-flight limit
    const familyInFlight = this.getInFlightCount?.(signal.familyId) ?? 0;
    if (this.getInFlightCount && familyInFlight >= FAMILY_IN_FLIGHT_LIMIT) {
      this.log.debug(
        { familyId: signal.familyId, inFlight: familyInFlight, limit: FAMILY_IN_FLIGHT_LIMIT },
        "entry rejected by family in-flight limit",
      );
      rejected.push("family-in-flight-limit");
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("family_in_flight_ok");

    // 5. Token-level in-flight limit
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

    // 6. Min order size
    const minOrderSize = this.resolveMinOrderSize?.(signal.tokenId) ?? null;
    if (minOrderSize != null && !isExecutableOrderSize(signal.suggestedSize, minOrderSize)) {
      rejected.push(
        `order size ${signal.suggestedSize} below min ${minOrderSize}`,
      );
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
      familyId: signal.familyId,
      approved,
      rejectionReasons,
      checksPassed,
      decidedAt: new Date().toISOString(),
    };
  }
}
