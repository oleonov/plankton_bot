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
  BOUNCE_EXIT_TARGET_RULE_ID,
  isBounceForceExit,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";
import { SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON } from "../../internal-order-reasons.js";
import { isExecutableOrderSize } from "../../min-order-size.js";
import {
  BUY_DUPLICATE_DEDUPED_REASON,
  findNearDuplicateOpenBuy,
} from "../../buy-order-lifecycle.js";
import {
  hasWalletBuyBudget,
  evaluateWalletBuyCapacity,
  evaluatePerTokenOrderCapacity,
  evaluateTotalOrdersCapacity,
  evaluateWalletSellCapacity,
  classifySellCapacitySource,
  normalizeBuyCapacityPolicy,
  normalizeOrderCapacityPolicy,
  normalizeSellCapacityPolicy,
  resolveEffectiveMaxOpenSellOrdersPerToken,
  resolveWalletBuyBudget,
  PER_TOKEN_BUY_LIMIT_REASON,
  PER_TOKEN_SELL_LIMIT_REASON,
  TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON,
  WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
  WALLET_SELL_CAPACITY_EXHAUSTED_REASON,
  type OrderCapacityMetricsSample,
  type SellCapacitySource,
  type WalletBuyBudgetConfig,
} from "../../wallet-buy-budget.js";

const OPEN_ORDER_STATUSES = new Set(["pending", "open", "partially-filled"]);
const NEW_ENTRY_REASONS = new Set<string>([SignalReason.ProbeEntry]);
export const CONDITION_REDEEM_IN_FLIGHT_REASON = "condition_redeem_in_flight";

interface OpenOrderCounts {
  openBuyOrderCount: number;
  openSellOrderCount: number;
  openProfileLadderSellOrderCount: number;
  openNonProfileLadderSellOrderCount: number;
  openOrdersTotal: number;
  perTokenOpenBuyOrderCount: number;
  perTokenOpenSellOrderCount: number;
  perTokenProfileLadderSellOrderCount: number;
  perTokenNonProfileLadderSellOrderCount: number;
}

interface SellCapacityCounts {
  openSellOrderCount: number;
  openProfileLadderSellOrderCount: number;
  openNonProfileLadderSellOrderCount: number;
  openOrdersTotal: number;
  perTokenOpenSellOrderCount: number;
}

function isBuySignal(signal: Signal): boolean {
  return signal.side === "buy";
}

function isOpenOrder(order: Order): boolean {
  return OPEN_ORDER_STATUSES.has(order.status);
}

function getOpenOrderCounts(
  orderRepo: OrderRepository,
  tokenId: TokenId,
  excludeBounceTargetRungsForToken = false,
): OpenOrderCounts {
  // Bounce-exit backstop force-exit (docs/plans/2026-07-16-bounce-exit-
  // ladder-redesign.md, Phase 3 Codex fix): mirrors execution-module.ts's
  // `excludeBounceTargetBeingReplaced`. When the incoming signal IS the
  // backstop, every resting BOUNCE_EXIT_TARGET rung for this token is about
  // to be cancelled by signal-to-order.ts, so it must not count against the
  // backstop's own per-token/wallet SELL capacity check — otherwise N resting
  // rungs at the cap would block the very force-exit meant to replace them.
  const openOrders = orderRepo
    .findOpen()
    .filter(isOpenOrder)
    .filter(
      (order) =>
        !excludeBounceTargetRungsForToken ||
        !(
          order.side === "sell" &&
          order.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID &&
          order.tokenId === tokenId
        ),
    );
  let openBuyOrderCount = 0;
  let openSellOrderCount = 0;
  let perTokenOpenBuyOrderCount = 0;
  let perTokenOpenSellOrderCount = 0;
  let openProfileLadderSellOrderCount = 0;
  let openNonProfileLadderSellOrderCount = 0;
  let perTokenProfileLadderSellOrderCount = 0;
  let perTokenNonProfileLadderSellOrderCount = 0;

  for (const order of openOrders) {
    if (order.side === "buy") {
      openBuyOrderCount += 1;
      if (order.tokenId === tokenId) perTokenOpenBuyOrderCount += 1;
    } else {
      openSellOrderCount += 1;
      if (classifySellCapacitySource(order) === "profile_ladder") {
        openProfileLadderSellOrderCount += 1;
        if (order.tokenId === tokenId) perTokenProfileLadderSellOrderCount += 1;
      } else {
        openNonProfileLadderSellOrderCount += 1;
        if (order.tokenId === tokenId) perTokenNonProfileLadderSellOrderCount += 1;
      }
      if (order.tokenId === tokenId) perTokenOpenSellOrderCount += 1;
    }
  }

  return {
    openBuyOrderCount,
    openSellOrderCount,
    openProfileLadderSellOrderCount,
    openNonProfileLadderSellOrderCount,
    openOrdersTotal: openOrders.length,
    perTokenOpenBuyOrderCount,
    perTokenOpenSellOrderCount,
    perTokenProfileLadderSellOrderCount,
    perTokenNonProfileLadderSellOrderCount,
  };
}

// SELL repricing is net-neutral: execution cancels the existing token SELL
// before submitting the replacement, but risk-gate runs before that flow.
//
// Bounce-exit ladder rungs are exempt (docs/plans/2026-07-16-bounce-exit-
// ladder-redesign.md, Phase 3 Codex fix): a new BOUNCE_EXIT_TARGET rung
// coexists alongside up to `ladderFractions.length - 1` other resting
// rungs — it never replaces one — so no discount applies here; capacity is
// enforced as a strict ceiling via resolveEffectiveMaxOpenSellOrdersPerToken
// instead, consistent with execution-module.ts's own undiscounted model.
// The BOUNCE_EXIT_BACKSTOP force-exit is handled separately and earlier, in
// `getOpenOrderCounts`, which already excludes every resting rung the
// backstop is about to replace before this function ever runs — so it needs
// no discount here either.
function getReplacementAwareSellCounts(
  counts: OpenOrderCounts,
  source: SellCapacitySource,
  decisionRuleId: string | null,
): SellCapacityCounts {
  if (
    decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID ||
    isBounceForceExit({ side: "sell", decisionRuleId })
  ) {
    return counts;
  }
  if (counts.perTokenOpenSellOrderCount <= 0) {
    return counts;
  }
  const profileReplacement =
    source === "profile_ladder" && counts.perTokenProfileLadderSellOrderCount > 0;
  const nonProfileReplacement =
    source !== "profile_ladder" && counts.perTokenNonProfileLadderSellOrderCount > 0;
  if (!profileReplacement && !nonProfileReplacement) return counts;
  return {
    openSellOrderCount: Math.max(0, counts.openSellOrderCount - 1),
    openProfileLadderSellOrderCount: profileReplacement
      ? Math.max(0, counts.openProfileLadderSellOrderCount - 1)
      : counts.openProfileLadderSellOrderCount,
    openNonProfileLadderSellOrderCount: nonProfileReplacement
      ? Math.max(0, counts.openNonProfileLadderSellOrderCount - 1)
      : counts.openNonProfileLadderSellOrderCount,
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
    private readonly profileOwnedOpenPositionCount?: (() => number) | undefined,
  ) {}

  async evaluate(signal: Signal): Promise<RiskDecision> {
    const passed: string[] = [];
    const rejected: string[] = [];
    const isBuy = isBuySignal(signal);
    const isBounceBackstopSignal = isBounceForceExit({
      side: signal.side,
      decisionRuleId: signal.decisionRuleId ?? null,
    });
    const counts = getOpenOrderCounts(this.orderRepo, signal.tokenId, isBounceBackstopSignal);
    const policy = this.executionPolicy?.();
    const buyPolicy = normalizeBuyCapacityPolicy(this.buyCapacityPolicy?.() ?? policy?.buyCapacity);
    const sellPolicy = normalizeSellCapacityPolicy(policy?.sellCapacity);
    const orderPolicy = normalizeOrderCapacityPolicy(policy?.orderCapacity);
    const sellCapacitySource = classifySellCapacitySource(signal);

    const finish = (
      approved: boolean,
      reason: string | null = null,
      sellCapacity?: ReturnType<typeof evaluateWalletSellCapacity>,
    ): RiskDecision => {
      this.capacityMetricsSink?.({
        source: "risk_gate",
        side: signal.side,
        approved,
        rejectionReason: reason,
        sellCapacitySource: signal.side === "sell" ? sellCapacitySource : undefined,
        sellCapacityRejectReason: sellCapacity?.rejectionDetail ?? null,
        sellCapacityMode: sellCapacity?.mode,
        profileOwnedOpenPositionCount: sellCapacity?.dynamic?.profileOwnedOpenPositionCount,
        profileLadderCapRaw: sellCapacity?.dynamic?.profileLadderCapRaw,
        effectiveProfileLadderCap: sellCapacity?.dynamic?.effectiveProfileLadderCap,
        nonLadderReserve: sellCapacity?.dynamic?.nonLadderReserve,
        dynamicGlobalCap: sellCapacity?.dynamic?.dynamicGlobalCap,
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
    //
    // The BOUNCE_EXIT_BACKSTOP force-exit is the one exception (docs/plans/
    // 2026-07-16-bounce-exit-ladder-redesign.md, final Codex fix): the plan
    // requires it to bypass every bot-bookkeeping cap/capacity check — wallet
    // sell capacity, per-token sell capacity, total order capacity — and keep
    // ONLY exchange-feasibility checks (the residual-below-exchange-min-size
    // check just below is NOT skipped: an actually-unsellable dust residual is
    // still unsellable no matter which rule requested the SELL). Without this,
    // N resting rungs (or an unrelated token) already at the cap would block
    // the very force-exit meant to guarantee the position exits, orphaning the
    // residual. `isBounceBackstopSignal` is computed once above from the same
    // `isBounceForceExit` helper used everywhere else this bypass applies.
    if (!isBuy) {
      const sellCounts = getReplacementAwareSellCounts(
        counts,
        sellCapacitySource,
        signal.decisionRuleId ?? null,
      );
      const sellCapacity = evaluateWalletSellCapacity({
        policy: sellPolicy,
        source: sellCapacitySource,
        openSellOrderCount: sellCounts.openSellOrderCount,
        openProfileLadderSellOrderCount: sellCounts.openProfileLadderSellOrderCount,
        openNonProfileLadderSellOrderCount: sellCounts.openNonProfileLadderSellOrderCount,
        profileOwnedOpenPositionCount: this.profileOwnedOpenPositionCount?.() ?? 0,
      });
      if (!sellCapacity.allowed && !isBounceBackstopSignal) {
        rejected.push(WALLET_SELL_CAPACITY_EXHAUSTED_REASON);
        return finish(false, WALLET_SELL_CAPACITY_EXHAUSTED_REASON, sellCapacity);
      }
      passed.push("wallet_sell_capacity_ok");

      const perTokenSell = evaluatePerTokenOrderCapacity({
        side: "sell",
        maxOpenOrdersPerToken: resolveEffectiveMaxOpenSellOrdersPerToken({
          decisionRuleId: signal.decisionRuleId ?? null,
          sellPolicy,
          bounceLadderRungCount: policy?.bounceExit.ladderFractions.length,
        }),
        openOrdersForToken: sellCounts.perTokenOpenSellOrderCount,
        enabled: sellPolicy.enabled,
      });
      if (!perTokenSell.allowed && !isBounceBackstopSignal) {
        rejected.push(PER_TOKEN_SELL_LIMIT_REASON);
        return finish(false, PER_TOKEN_SELL_LIMIT_REASON, sellCapacity);
      }
      passed.push("per_token_sell_capacity_ok");

      if (this.isSellResidualBelowMinSize(signal)) {
        rejected.push(SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON);
        return finish(false, SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON, sellCapacity);
      }
      passed.push("sell_residual_min_size_ok");

      const totalCapacity = evaluateTotalOrdersCapacity({
        policy: orderPolicy,
        openOrdersTotal: sellCounts.openOrdersTotal,
      });
      if (!totalCapacity.allowed && !isBounceBackstopSignal) {
        rejected.push(TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON);
        return finish(false, TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON, sellCapacity);
      }
      passed.push("total_order_capacity_ok");
      passed.push("sell_signal_bypass");
      return finish(true, null, sellCapacity);
    }

    const duplicateBuy = findNearDuplicateOpenBuy(
      this.orderRepo.findOpen(),
      {
        tokenId: signal.tokenId,
        price: signal.suggestedPrice,
        reason: signal.reason,
        decisionRuleId: signal.decisionRuleId,
      },
      this.marketRepo?.findByTokenId(signal.tokenId)?.tickSize ?? null,
    );
    if (duplicateBuy) {
      this.log.debug(
        {
          tokenId: String(signal.tokenId),
          signalReason: signal.reason,
          decisionRuleId: signal.decisionRuleId,
          existingOrderId: String(duplicateBuy.orderId),
          existingPrice: duplicateBuy.price,
          requestedPrice: signal.suggestedPrice,
        },
        "buy signal rejected — duplicate open BUY already resting",
      );
      rejected.push(BUY_DUPLICATE_DEDUPED_REASON);
      return finish(false, BUY_DUPLICATE_DEDUPED_REASON);
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
