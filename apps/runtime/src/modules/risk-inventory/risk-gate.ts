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
 *  6. Tail quarantine threshold not exceeded (entry signals only)
 */

import type {
  RiskGate,
  Signal,
  RiskDecision,
  FamilyRulesProvider,
  FamilyStateRepository,
  PositionRepository,
  FamilyId,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";

/** Signal reasons that represent entries (new exposure). */
const ENTRY_REASONS = new Set(["probe-entry", "scale-in"]);

function isEntrySignal(signal: Signal): boolean {
  return signal.side === "buy" && ENTRY_REASONS.has(signal.reason);
}

export class RiskGateImpl implements RiskGate {
  constructor(
    private readonly rulesProvider: FamilyRulesProvider,
    private readonly familyStateRepo: FamilyStateRepository,
    private readonly positionRepo: PositionRepository,
    private readonly log: Logger,
    private readonly liveLiteGuard?: LiveLiteGuard,
  ) {}

  async evaluate(signal: Signal): Promise<RiskDecision> {
    const passed: string[] = [];
    const rejected: string[] = [];

    // Live-lite allowlist check (Layer 2)
    if (this.liveLiteGuard?.isActive && !this.liveLiteGuard.isFamilyAllowed(String(signal.familyId))) {
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

    if (mode === "probe-only" && signal.reason === "scale-in") {
      rejected.push(`family in probe-only mode — scale-in blocked`);
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("runtime_mode_allows");

    // For exit/reduce signals, skip exposure checks — they reduce risk
    if (!isEntrySignal(signal)) {
      passed.push("exit_signal_bypass_exposure_checks");
      return this.decision(signal, true, rejected, passed);
    }

    // Live-lite global caps (Layer 3) — entry signals only
    if (this.liveLiteGuard?.isActive && familyState) {
      if (this.liveLiteGuard.wouldExceedOpenValueCap(familyState.openValueUsdc, signal.suggestedSizeUsdc)) {
        rejected.push("live-lite-open-value-cap-exceeded");
        return this.decision(signal, false, rejected, passed);
      }
      passed.push("live_lite_open_value_ok");

      const existingPos = this.positionRepo.findByTokenId(signal.tokenId);
      const isNewMkt = !existingPos;
      if (isNewMkt && this.liveLiteGuard.wouldExceedActiveMarketsCap(familyState.activeMarketCount, 1)) {
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
      rejected.push(
        `dust positions ${familyState.openDustCount} >= max ${tail.maxDustPositions}`,
      );
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("max_dust_ok");

    // 6. Tail quarantine threshold
    const projectedTailCost = familyState.currentTailCostUsdc + signal.suggestedSizeUsdc;
    if (projectedTailCost > tail.tailQuarantineThresholdUsdc) {
      rejected.push(
        `projected tail cost ${projectedTailCost.toFixed(2)} USDC ` +
        `exceeds quarantine threshold ${tail.tailQuarantineThresholdUsdc} USDC`,
      );
      return this.decision(signal, false, rejected, passed);
    }
    passed.push("tail_threshold_ok");

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
