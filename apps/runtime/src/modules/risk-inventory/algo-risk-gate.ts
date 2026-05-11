import {
  type RiskGate,
  type Signal,
  type RiskDecision,
  type OrderRepository,
  type PositionRepository,
  type TokenId,
  SignalReason,
  type BuyCapacityPolicy,
  type ExecutionPolicy,
  type MarketRepository,
  type Order,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";
import { SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON } from "../../internal-order-reasons.js";
import { isExecutableOrderSize } from "../../min-order-size.js";
import {
  hasWalletBuyBudget,
  evaluateWalletBuyCapacity,
  evaluatePerTokenOrderCapacity,
  evaluateTotalOrdersCapacity,
  evaluateWalletSellCapacity,
  normalizeBuyCapacityPolicy,
  normalizeOrderCapacityPolicy,
  normalizeSellCapacityPolicy,
  resolveWalletBuyBudget,
  PER_TOKEN_BUY_LIMIT_REASON,
  PER_TOKEN_SELL_LIMIT_REASON,
  TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON,
  WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
  WALLET_SELL_CAPACITY_EXHAUSTED_REASON,
  type OrderCapacityMetricsSample,
  type WalletBuyBudgetConfig,
} from "../../wallet-buy-budget.js";

const OPEN_ORDER_STATUSES = new Set(["pending", "open", "partially-filled"]);
const NEW_ENTRY_REASONS = new Set<string>([SignalReason.ProbeEntry]);
export const CONDITION_REDEEM_IN_FLIGHT_REASON = "condition_redeem_in_flight";

interface OpenOrderCounts {
  openBuyOrderCount: number;
  openSellOrderCount: number;
  openOrdersTotal: number;
  perTokenOpenBuyOrderCount: number;
  perTokenOpenSellOrderCount: number;
}

interface SellCapacityCounts {
  openSellOrderCount: number;
  openOrdersTotal: number;
  perTokenOpenSellOrderCount: number;
}

function isBuySignal(signal: Signal): boolean {
  return signal.side === "buy";
}

function isOpenOrder(order: Order): boolean {
  return OPEN_ORDER_STATUSES.has(order.status);
}

function getOpenOrderCounts(orderRepo: OrderRepository, tokenId: TokenId): OpenOrderCounts {
  const openOrders = orderRepo.findOpen().filter(isOpenOrder);
  let openBuyOrderCount = 0;
  let openSellOrderCount = 0;
  let perTokenOpenBuyOrderCount = 0;
  let perTokenOpenSellOrderCount = 0;

  for (const order of openOrders) {
    if (order.side === "buy") {
      openBuyOrderCount += 1;
      if (order.tokenId === tokenId) perTokenOpenBuyOrderCount += 1;
    } else {
      openSellOrderCount += 1;
      if (order.tokenId === tokenId) perTokenOpenSellOrderCount += 1;
    }
  }

  return {
    openBuyOrderCount,
    openSellOrderCount,
    openOrdersTotal: openOrders.length,
    perTokenOpenBuyOrderCount,
    perTokenOpenSellOrderCount,
  };
}

// SELL repricing is net-neutral: execution cancels the existing token SELL
// before submitting the replacement, but risk-gate runs before that flow.
function getReplacementAwareSellCounts(counts: OpenOrderCounts): SellCapacityCounts {
  if (counts.perTokenOpenSellOrderCount <= 0) {
    return counts;
  }
  return {
    openSellOrderCount: Math.max(0, counts.openSellOrderCount - 1),
    openOrdersTotal: Math.max(0, counts.openOrdersTotal - 1),
    perTokenOpenSellOrderCount: Math.max(0, counts.perTokenOpenSellOrderCount - 1),
  };
}

export class AlgoRiskGateImpl implements RiskGate {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly positionRepo: PositionRepository,
    private readonly log: Logger,
    private readonly resolveMinOrderSize?: (tokenId: TokenId) => number | null,
    private readonly walletBudget?: WalletBuyBudgetConfig,
    private readonly buyCapacityPolicy?: () => BuyCapacityPolicy | undefined,
    private readonly executionPolicy?: () => ExecutionPolicy | undefined,
    private readonly capacityMetricsSink?: (sample: OrderCapacityMetricsSample) => void,
    private readonly marketRepo?: Pick<MarketRepository, "findByTokenId"> | undefined,
    private readonly redeemInFlightGuard?: ((conditionId: string) => boolean) | undefined,
    private readonly redeemInFlightMetricsSink?:
      | ((sample: { side: "buy" | "sell"; conditionId: string }) => void)
      | undefined,
  ) {}

  async evaluate(signal: Signal): Promise<RiskDecision> {
    const passed: string[] = [];
    const rejected: string[] = [];
    const isBuy = isBuySignal(signal);
    const counts = getOpenOrderCounts(this.orderRepo, signal.tokenId);
    const policy = this.executionPolicy?.();
    const buyPolicy = normalizeBuyCapacityPolicy(this.buyCapacityPolicy?.() ?? policy?.buyCapacity);
    const sellPolicy = normalizeSellCapacityPolicy(policy?.sellCapacity);
    const orderPolicy = normalizeOrderCapacityPolicy(policy?.orderCapacity);

    const finish = (approved: boolean, reason: string | null = null): RiskDecision => {
      this.capacityMetricsSink?.({
        source: "risk_gate",
        side: signal.side,
        approved,
        rejectionReason: reason,
        ...counts,
      });
      return this.decision(signal, approved, rejected, passed);
    };

    if (this.isRedeemInFlightBlocked(signal, policy)) {
      const conditionId = this.resolveConditionId(signal);
      this.log.warn(
        { tokenId: String(signal.tokenId), conditionId, side: signal.side },
        "signal rejected — condition redeem in flight",
      );
      this.redeemInFlightMetricsSink?.({ side: signal.side, conditionId });
      rejected.push(CONDITION_REDEEM_IN_FLIGHT_REASON);
      return finish(false, CONDITION_REDEEM_IN_FLIGHT_REASON);
    }

    // Sell signals bypass BUY entry checks, but still respect SELL/total caps.
    if (!isBuy) {
      const sellCounts = getReplacementAwareSellCounts(counts);
      const sellCapacity = evaluateWalletSellCapacity({
        policy: sellPolicy,
        openSellOrderCount: sellCounts.openSellOrderCount,
      });
      if (!sellCapacity.allowed) {
        rejected.push(WALLET_SELL_CAPACITY_EXHAUSTED_REASON);
        return finish(false, WALLET_SELL_CAPACITY_EXHAUSTED_REASON);
      }
      passed.push("wallet_sell_capacity_ok");

      const perTokenSell = evaluatePerTokenOrderCapacity({
        side: "sell",
        maxOpenOrdersPerToken: sellPolicy.maxOpenSellOrdersPerToken,
        openOrdersForToken: sellCounts.perTokenOpenSellOrderCount,
        enabled: sellPolicy.enabled,
      });
      if (!perTokenSell.allowed) {
        rejected.push(PER_TOKEN_SELL_LIMIT_REASON);
        return finish(false, PER_TOKEN_SELL_LIMIT_REASON);
      }
      passed.push("per_token_sell_capacity_ok");

      if (this.isSellResidualBelowMinSize(signal)) {
        rejected.push(SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON);
        return finish(false, SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON);
      }
      passed.push("sell_residual_min_size_ok");

      const totalCapacity = evaluateTotalOrdersCapacity({
        policy: orderPolicy,
        openOrdersTotal: sellCounts.openOrdersTotal,
      });
      if (!totalCapacity.allowed) {
        rejected.push(TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON);
        return finish(false, TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON);
      }
      passed.push("total_order_capacity_ok");
      passed.push("sell_signal_bypass");
      return finish(true);
    }

    // 1. Token-level open-order cap for BUY.
    const perTokenBuy = evaluatePerTokenOrderCapacity({
      side: "buy",
      maxOpenOrdersPerToken: buyPolicy.maxOpenBuyOrdersPerToken,
      openOrdersForToken: counts.perTokenOpenBuyOrderCount,
      enabled: buyPolicy.enabled,
    });
    if (!perTokenBuy.allowed) {
      rejected.push(PER_TOKEN_BUY_LIMIT_REASON);
      return finish(false, PER_TOKEN_BUY_LIMIT_REASON);
    }
    passed.push("per_token_buy_capacity_ok");

    // 1a. Defensive: block probe/spray entries when an open position already
    // exists for this token. If leg_states ever drifts from positions (e.g.
    // after an unexpected restart before the startup seeder was deployed),
    // this catches the double-exposure before it hits the exchange. Scale-in
    // reasons legitimately re-buy on an existing position and pass through.
    if (NEW_ENTRY_REASONS.has(signal.reason)) {
      const existing = this.positionRepo.findByTokenId(signal.tokenId);
      if (existing && existing.status !== "closed") {
        this.log.warn(
          {
            tokenId: String(signal.tokenId),
            signalReason: signal.reason,
            positionStatus: existing.status,
          },
          "entry rejected — open position already exists for token",
        );
        rejected.push("open_position_exists");
        return finish(false, "open_position_exists");
      }
    }
    passed.push("no_open_position_or_scale_in");

    // 2. Min order size
    const minOrderSize = this.resolveMinOrderSize?.(signal.tokenId) ?? null;
    if (minOrderSize != null && !isExecutableOrderSize(signal.suggestedSize, minOrderSize)) {
      rejected.push(`order size ${signal.suggestedSize} below min ${minOrderSize}`);
      return finish(false, "min_order_size");
    }
    passed.push("min_order_size_ok");

    const walletBudget = resolveWalletBuyBudget(
      this.walletBudget ?? {},
      this.orderRepo.sumOpenBuyNotional(),
    );
    const buyCapacity = evaluateWalletBuyCapacity({
      policy: buyPolicy,
      snapshot: walletBudget,
      requiredNotionalUsdc: signal.suggestedSizeUsdc,
      signalReason: signal.reason,
      openBuyOrderCount: counts.openBuyOrderCount,
    });
    if (!buyCapacity.allowed) {
      rejected.push(WALLET_BUY_CAPACITY_EXHAUSTED_REASON);
      return finish(false, WALLET_BUY_CAPACITY_EXHAUSTED_REASON);
    }
    passed.push("wallet_buy_capacity_ok");

    const totalCapacity = evaluateTotalOrdersCapacity({
      policy: orderPolicy,
      openOrdersTotal: counts.openOrdersTotal,
    });
    if (!totalCapacity.allowed) {
      rejected.push(TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON);
      return finish(false, TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON);
    }
    passed.push("total_order_capacity_ok");

    if (!hasWalletBuyBudget(walletBudget, signal.suggestedSizeUsdc)) {
      rejected.push("wallet_buy_budget_exhausted");
      return finish(false, "wallet_buy_budget_exhausted");
    }
    passed.push("wallet_buy_budget_ok");

    return finish(true);
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
      approved,
      rejectionReasons,
      checksPassed,
      decidedAt: new Date().toISOString(),
    };
  }

  private isSellResidualBelowMinSize(signal: Signal): boolean {
    if (signal.side !== "sell") return false;
    const minOrderSize = this.resolveMinOrderSize?.(signal.tokenId) ?? null;
    if (minOrderSize == null || !Number.isFinite(minOrderSize) || minOrderSize <= 0) {
      return false;
    }
    const position = this.positionRepo.findByTokenId(signal.tokenId);
    if (!position || position.status === "closed") return false;
    return position.size + 1e-9 < minOrderSize;
  }

  private isRedeemInFlightBlocked(signal: Signal, policy: ExecutionPolicy | undefined): boolean {
    if (!this.redeemInFlightGuard) return false;
    if (!policy || (policy.raceProtection?.redeemInFlight.enabled ?? true) !== true) return false;
    return this.redeemInFlightGuard(this.resolveConditionId(signal));
  }

  private resolveConditionId(signal: Signal): string {
    return String(
      this.marketRepo?.findByTokenId(signal.tokenId)?.conditionId ?? signal.conditionId,
    );
  }
}
