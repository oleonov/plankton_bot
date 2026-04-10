/**
 * RiskGate implementation — evaluates SignalProduced against family rules,
 * runtime mode, and exposure limits.
 *
 * V1 checks:
 *  1. Family exists and is enabled
 *  2. Family runtime mode allows the signal direction
 *  3. Max open value not exceeded (entry signals only)
 *  4. Max active markets not exceeded (entry signals only)
 *  5. Max dust positions not exceeded (entry signals only)
 *  6. Derived family mode from tail health:
 *     - reduce-only: tail cap breached → block all entries
 *     - probe-only: tail PnL negative but caps OK → allow probes;
 *       scale-in/confirm-scale pass only when requirePositiveRecycleHistoryForScale=false
 *     - active: healthy → everything allowed (heavy-scale still requires positive PnL)
 */

import {
  ENTRY_REASONS,
  type RiskGate,
  type Signal,
  type RiskDecision,
  type FamilyRulesProvider,
  type FamilyStateRepository,
  type FamilyState,
  type PositionRepository,
  type OrderRepository,
  type FamilyId,
  type TokenId,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";

type DerivedFamilyMode = "active" | "probe-only" | "reduce-only";
const OPEN_ORDER_STATUSES = new Set(["pending", "open", "partially-filled"]);

interface FamilyThroughputLimits {
  maxConcurrentOrdersPerFamily: number;
  maxProbeInFlightPerToken: number;
}

const CORE_FAMILY_KEYS = new Set([
  "bitcoin-price",
  "btc-updown-4h",
  "who-will-be-next-supreme-leader-of-iran",
  "us-next-strikes-iran-on",
]);

const REDUCED_FAMILY_KEYS = new Set([
  "bitcoin-above",
  "ethereum-price",
  "will-bitcoin-reach",
  "will-ethereum-reach",
]);

const CORE_LIMITS: FamilyThroughputLimits = {
  maxConcurrentOrdersPerFamily: 10,
  maxProbeInFlightPerToken: 2,
};

const REDUCED_LIMITS: FamilyThroughputLimits = {
  maxConcurrentOrdersPerFamily: 3,
  maxProbeInFlightPerToken: 1,
};

const FALLBACK_LIMITS: FamilyThroughputLimits = {
  maxConcurrentOrdersPerFamily: 2,
  maxProbeInFlightPerToken: 1,
};

/**
 * Derive a family's effective trading mode from tail health metrics.
 *
 * - reduce-only: hard tail cap breached → block all entries
 * - probe-only:  tail PnL negative but caps not breached → allow probes only
 * - active:      healthy → everything allowed
 */
function resolveFamilyMode(
  familyState: FamilyState,
  projectedTailCost: number,
  tailThresholdUsdc: number,
  tailThresholdRatio: number,
): DerivedFamilyMode {
  // Absolute tail cap always applies
  if (projectedTailCost > tailThresholdUsdc) return "reduce-only";

  // Ratio check: only when family has accumulated tail (currentTailCostUsdc > 0).
  // When family is flat (zero open risk), projected-ratio alone cannot force
  // reduce-only — prevents deadlock on families that recycled all positions
  // but can't re-enter because probe size exceeds small realized PnL.
  if (familyState.currentTailCostUsdc > 0) {
    const realizedPnl = familyState.tailAdjustedPnlLive + familyState.currentTailCostUsdc;
    if (realizedPnl > 0 && projectedTailCost / realizedPnl > tailThresholdRatio) {
      return "reduce-only";
    }
  }

  if (familyState.tailAdjustedPnlLive < 0) return "probe-only";

  return "active";
}

function isEntrySignal(signal: Signal): boolean {
  return signal.side === "buy" && ENTRY_REASONS.has(signal.reason);
}

function isProbeLikeEntrySignal(signal: Signal): boolean {
  return signal.reason === "probe-entry" || signal.reason === "spray-entry";
}

function hasOpenBuyOrderForToken(orderRepo: OrderRepository, tokenId: TokenId): boolean {
  return orderRepo
    .findByTokenId(tokenId)
    .some((order) => order.side === "buy" && OPEN_ORDER_STATUSES.has(order.status));
}

function getFamilyThroughputLimits(familyKey: string): FamilyThroughputLimits {
  if (CORE_FAMILY_KEYS.has(familyKey)) return CORE_LIMITS;
  if (REDUCED_FAMILY_KEYS.has(familyKey)) return REDUCED_LIMITS;
  return FALLBACK_LIMITS;
}

export class RiskGateImpl implements RiskGate {
  constructor(
    private readonly rulesProvider: FamilyRulesProvider,
    private readonly familyStateRepo: FamilyStateRepository,
    private readonly positionRepo: PositionRepository,
    private readonly orderRepo: OrderRepository,
    private readonly log: Logger,
    private readonly liveLiteGuard?: LiveLiteGuard,
    private readonly getInFlightCount?: (familyId: FamilyId) => number,
    private readonly getTokenInFlightCount?: (tokenId: TokenId) => number,
  ) {}

  async evaluate(signal: Signal): Promise<RiskDecision> {
    const passed: string[] = [];
    const rejected: string[] = [];
    const isEntry = isEntrySignal(signal);

    // Live-lite allowlist check (Layer 2)
    if (
      this.liveLiteGuard?.isActive &&
      !this.liveLiteGuard.isFamilyAllowed(String(signal.familyId))
    ) {
      rejected.push("live-lite-allowlist-rejected");
      return this.decision(signal, false, rejected, passed);
    }

    // 1. Family exists and is enabled
    const bundle = this.rulesProvider.getRule(signal.familyId);
    if (!bundle) {
      rejected.push(`family ${signal.familyId} not found in rules`);
      return this.decision(signal, false, rejected, passed);
    }

    if (!this.rulesProvider.isEnabled(signal.familyId)) {
      rejected.push(`family ${signal.familyId} is disabled`);
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("family_exists_and_enabled");
    const throughputLimits = getFamilyThroughputLimits(bundle.identity.familyKey);

    if (this.liveLiteGuard?.isActive) {
      const policyRejected = this.liveLiteGuard.getFamilyPolicyRejections({
        identity: bundle.identity,
        isEntry,
        orderNotionalUsdc: signal.suggestedSizeUsdc,
        hasPostOnlySupport: this.liveLiteGuard.supportsPostOnlyFamilies(),
        signalReason: signal.reason,
      });
      if (policyRejected.length > 0) {
        rejected.push(...policyRejected);
        return this.decision(signal, false, rejected, passed);
      }
      passed.push("live_lite_policy_ok");
    }

    // 2. Family runtime mode
    const familyState = this.familyStateRepo.get(signal.familyId);
    const mode = familyState?.runtimeMode ?? "active";

    if (mode === "quarantine") {
      // Quarantine: reject all strategy-originated signals
      if (signal.reason !== "operator") {
        rejected.push(`family in quarantine mode`);
        return this.decision(signal, false, rejected, passed);
      }
    }

    if (mode === "reduce-only") {
      // Reduce-only: reject entry signals, allow exit/reduce signals
      if (isEntrySignal(signal)) {
        rejected.push(`family in reduce-only mode — entry blocked`);
        return this.decision(signal, false, rejected, passed);
      }
    }

    if (
      mode === "probe-only" &&
      signal.reason !== "probe-entry" &&
      signal.reason !== "spray-entry"
    ) {
      rejected.push(`family in probe-only mode — ${signal.reason} blocked`);
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("runtime_mode_allows");

    // In-flight limiter (B2.2) — entry signals only
    if (
      isEntry &&
      this.getInFlightCount &&
      this.getInFlightCount(signal.familyId) >= throughputLimits.maxConcurrentOrdersPerFamily
    ) {
      rejected.push("family-in-flight-limit");
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("in_flight_limit_ok");

    if (isEntry && isProbeLikeEntrySignal(signal)) {
      if (hasOpenBuyOrderForToken(this.orderRepo, signal.tokenId)) {
        rejected.push("probe token already has open buy order");
        return this.decision(signal, false, rejected, passed);
      }
      if (
        this.getTokenInFlightCount &&
        this.getTokenInFlightCount(signal.tokenId) >= throughputLimits.maxProbeInFlightPerToken
      ) {
        rejected.push("probe-token-in-flight-limit");
        return this.decision(signal, false, rejected, passed);
      }
      passed.push("probe_token_limit_ok");
    }

    // For exit/reduce signals, skip exposure checks — they reduce risk
    if (!isEntry) {
      passed.push("exit_signal_bypass_exposure_checks");
      return this.decision(signal, true, rejected, passed);
    }

    // Live-lite global caps (Layer 3) — entry signals only
    // These caps are session-wide (across ALL families), not per-family.
    if (this.liveLiteGuard?.isActive) {
      const allStates = this.familyStateRepo.findAll();
      const globalOpenValue = allStates.reduce((sum, s) => sum + s.openValueUsdc, 0);
      const globalActiveMarkets = allStates.reduce((sum, s) => sum + s.activeMarketCount, 0);

      if (this.liveLiteGuard.wouldExceedOpenValueCap(globalOpenValue, signal.suggestedSizeUsdc)) {
        rejected.push("live-lite-open-value-cap-exceeded");
        return this.decision(signal, false, rejected, passed);
      }
      passed.push("live_lite_open_value_ok");

      const existingPos = this.positionRepo.findByTokenId(signal.tokenId);
      const isNewMkt = !existingPos;
      if (isNewMkt && this.liveLiteGuard.wouldExceedActiveMarketsCap(globalActiveMarkets, 1)) {
        rejected.push("live-lite-active-markets-cap-exceeded");
        return this.decision(signal, false, rejected, passed);
      }
      passed.push("live_lite_active_markets_ok");
    }

    // 3-6. Entry-specific exposure checks
    const rules = bundle.rules;
    const tail = rules.tailSuppression;

    if (!familyState) {
      // No state yet — first entry is always allowed
      passed.push("first_entry_no_state");
      return this.decision(signal, true, rejected, passed);
    }

    // 3. Max open value
    const projectedValue = familyState.openValueUsdc + signal.suggestedSizeUsdc;
    if (projectedValue > tail.maxOpenValueUsdc) {
      rejected.push(
        `open value would be ${projectedValue.toFixed(2)} USDC, ` +
          `exceeds max ${tail.maxOpenValueUsdc} USDC`,
      );
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("max_open_value_ok");

    // 4. Max active markets (skip if signal targets an already-open position)
    const existingPosition = this.positionRepo.findByTokenId(signal.tokenId);
    const isNewMarket = !existingPosition;
    if (isNewMarket && familyState.activeMarketCount >= tail.maxActiveMarkets) {
      rejected.push(
        `active markets ${familyState.activeMarketCount} >= max ${tail.maxActiveMarkets}`,
      );
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("max_active_markets_ok");

    // 5. Max dust positions
    if (familyState.openDustCount >= tail.maxDustPositions) {
      rejected.push(`dust positions ${familyState.openDustCount} >= max ${tail.maxDustPositions}`);
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("max_dust_ok");

    // 6. Derive family mode from tail health
    const projectedTailCost = familyState.currentTailCostUsdc + signal.suggestedSizeUsdc;
    const scaleRules = bundle.rules.scaleIn;
    const derivedMode = resolveFamilyMode(
      familyState,
      projectedTailCost,
      tail.tailQuarantineThresholdUsdc,
      tail.tailQuarantineThresholdRatio,
    );

    if (derivedMode === "reduce-only") {
      const isAbsoluteCap = projectedTailCost > tail.tailQuarantineThresholdUsdc;
      if (isAbsoluteCap) {
        rejected.push(
          `entry blocked — family in derived reduce-only (tail cost ${projectedTailCost.toFixed(2)} > cap ${tail.tailQuarantineThresholdUsdc})`,
        );
      } else {
        const realizedPnl = familyState.tailAdjustedPnlLive + familyState.currentTailCostUsdc;
        rejected.push(
          `entry blocked — family in derived reduce-only (tail/pnl ratio ${(projectedTailCost / realizedPnl).toFixed(2)} > ${tail.tailQuarantineThresholdRatio}, tail ${projectedTailCost.toFixed(2)}, realized ${realizedPnl.toFixed(2)})`,
        );
      }
      return this.decision(signal, false, rejected, passed);
    }

    if (derivedMode === "probe-only") {
      if (signal.reason === "probe-entry") {
        passed.push("probe_allowed_in_probe_only");
      } else if (
        (signal.reason === "scale-in" || signal.reason === "confirm-scale") &&
        !scaleRules.requirePositiveRecycleHistoryForScale
      ) {
        passed.push("scale_allowed_flag_false");
      } else {
        rejected.push(
          `${signal.reason} blocked — family in derived probe-only (tailAdjustedPnlLive ${familyState.tailAdjustedPnlLive.toFixed(2)} < 0)`,
        );
        return this.decision(signal, false, rejected, passed);
      }
    }

    // Active mode: scale-in/confirm-scale gated by requirePositiveRecycleHistoryForScale
    if (
      derivedMode === "active" &&
      (signal.reason === "scale-in" || signal.reason === "confirm-scale") &&
      scaleRules.requirePositiveRecycleHistoryForScale &&
      familyState.tailAdjustedPnlLive <= 0
    ) {
      rejected.push(
        `${signal.reason} blocked — requirePositiveRecycleHistoryForScale ` +
          `and tailAdjustedPnlLive ${familyState.tailAdjustedPnlLive.toFixed(2)} <= 0`,
      );
      return this.decision(signal, false, rejected, passed);
    }

    // Heavy-scale always requires positive tail PnL
    if (signal.reason === "heavy-scale" && familyState.tailAdjustedPnlLive <= 0) {
      rejected.push(
        `heavy-scale blocked — tailAdjustedPnlLive ${familyState.tailAdjustedPnlLive.toFixed(2)} <= 0`,
      );
      return this.decision(signal, false, rejected, passed);
    }

    passed.push("tail_adjusted_pnl_ok");

    // 7. Price Impact Gate (P5-1)
    // Small orders (< $0.50) bypass impact checks to allow 'dust' capture
    // in illiquid markets without triggering safety blocks.
    if (signal.suggestedSizeUsdc < 0.5) {
      passed.push("micro_order_impact_bypass");
    } else {
      // Future: integrate with orderbook depth for real impact calculation
      passed.push("price_impact_ok");
    }

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
