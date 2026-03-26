/**
 * Scanner — v1 strategy profile implementation.
 *
 * Evaluates NormalizedMarket snapshots against family rules to produce
 * Signal objects for probe-entry, scale-in stages, and repricing-exit.
 *
 * Signal generation rules (from validated rulebook):
 *  - Probe entry: price in [minEntryPrice, maxEntryPrice], family enabled,
 *    no existing position for this token, session window active
 *  - Scale-in stages (buyCount-based):
 *    - confirm-scale (buyCount=1): second buy, confirms the probe
 *    - scale-in (buyCount 2..defaultMax-1): normal scaling
 *    - heavy-scale (buyCount >= defaultMax, < heavyMax): heavy campaign, gated by allowHeavyCampaigns
 *  - Repricing exit: open position with ROI in target band [low, high]
 *
 * Does NOT evaluate risk limits — that is the risk gate's job.
 * Does NOT place orders — signals flow through the bus.
 */

import type {
  NormalizedMarket,
  FamilyRulesProvider,
  FamilyRuleBundle,
  PositionRepository,
  FamilyStateRepository,
  FamilyState,
  Signal,
  Position,
  FamilyId,
  FamilyEvidence,
  TokenId,
  SignalReason,
  ScaleInRules,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";

/** Context needed by the scanner to produce signals. */
export interface ScannerDeps {
  rulesProvider: FamilyRulesProvider;
  positionRepo: PositionRepository;
  familyStateRepo: FamilyStateRepository;
  log: Logger;
}

/** Tracks buy count per position for scale-in limiting. */
export interface BuyTracker {
  getBuyCount(positionId: string): number;
  incrementBuyCount(positionId: string): void;
  removeBuyCount(positionId: string): void;
}

export function createBuyTracker(): BuyTracker {
  const counts = new Map<string, number>();
  return {
    getBuyCount(positionId: string): number {
      return counts.get(positionId) ?? 0;
    },
    incrementBuyCount(positionId: string): void {
      counts.set(positionId, (counts.get(positionId) ?? 0) + 1);
    },
    removeBuyCount(positionId: string): void {
      counts.delete(positionId);
    },
  };
}

/**
 * Session-scoped counters for P1-6 knobs:
 * - probeCountPerMarket: how many times we've probed a given tokenId (across position lifecycle)
 * - newMarketsThisSession: count of distinct new markets entered since session start
 */
export interface SessionTracker {
  getProbeCount(tokenId: string): number;
  incrementProbeCount(tokenId: string): void;
  getNewMarketCount(familyId: string): number;
  isKnownMarket(familyId: string, tokenId: string): boolean;
  recordNewMarket(familyId: string, tokenId: string): void;
}

export function createSessionTracker(): SessionTracker {
  const probeCounts = new Map<string, number>();
  /** Set of tokenIds per family that had a new entry this session. */
  const newMarkets = new Map<string, Set<string>>();
  return {
    getProbeCount(tokenId: string): number {
      return probeCounts.get(tokenId) ?? 0;
    },
    incrementProbeCount(tokenId: string): void {
      probeCounts.set(tokenId, (probeCounts.get(tokenId) ?? 0) + 1);
    },
    getNewMarketCount(familyId: string): number {
      return newMarkets.get(familyId)?.size ?? 0;
    },
    isKnownMarket(familyId: string, tokenId: string): boolean {
      return newMarkets.get(familyId)?.has(tokenId) ?? false;
    },
    recordNewMarket(familyId: string, tokenId: string): void {
      let set = newMarkets.get(familyId);
      if (!set) {
        set = new Set();
        newMarkets.set(familyId, set);
      }
      set.add(tokenId);
    },
  };
}

/**
 * Check if the current UTC time falls within any of the given time windows.
 * Compares hours AND minutes so that "00:00-23:59" covers the full day.
 * Returns true if no windows are configured (permissive default).
 */
function isInTimeWindow(
  windows: Array<{ start: string; end: string }>,
  nowMinutes: number,
): boolean {
  if (windows.length === 0) return true;

  for (const w of windows) {
    const startMin = parseHHMM(w.start);
    const endMin = parseHHMM(w.end);

    if (startMin <= endMin) {
      if (nowMinutes >= startMin && nowMinutes <= endMin) return true;
    } else {
      // Overnight window: e.g. 22:00 - 06:00
      if (nowMinutes >= startMin || nowMinutes <= endMin) return true;
    }
  }
  return false;
}

/**
 * Determine whether the scanner is in reduced mode based on full session config.
 *
 * sessionMode:
 *  - "active-window": reduced outside active windows
 *  - "reduced" / "always-reduced": always reduced
 *
 * reducedWindowsUtc: explicit reduced windows — if current time is inside one,
 * reduced mode applies even if inside the active window.
 *
 * Weekend + weekendMode="reduced" also forces reduced mode.
 */
function isReducedMode(
  session: { activeWindowsUtc: Array<{ start: string; end: string }>; reducedWindowsUtc: Array<{ start: string; end: string }>; weekendMode: string; },
  sessionMode: string,
  nowMinutes: number,
  weekend: boolean,
): boolean {
  // Always-reduced session modes
  if (sessionMode === "reduced" || sessionMode === "always-reduced") return true;

  // Weekend reduced
  if (weekend && session.weekendMode === "reduced") return true;

  // Outside active window
  const inActive = isInTimeWindow(session.activeWindowsUtc, nowMinutes);
  if (!inActive) return true;

  // Inside an explicit reduced window overrides active window
  if (session.reducedWindowsUtc.length > 0 && isInTimeWindow(session.reducedWindowsUtc, nowMinutes)) {
    return true;
  }

  return false;
}

function parseHHMM(hhmm: string): number {
  const parts = hhmm.split(":");
  return parseInt(parts[0] ?? "0", 10) * 60 + parseInt(parts[1] ?? "0", 10);
}

let signalCounter = 0;

function nextSignalId(): string {
  return `sig-${Date.now()}-${++signalCounter}`;
}

/** Check if a UTC day-of-week (0=Sun, 6=Sat) is a weekend day. */
function isWeekend(dayOfWeek: number): boolean {
  return dayOfWeek === 0 || dayOfWeek === 6;
}

/**
 * Evidence-aware size multiplier (P0-3).
 *
 * Adjusts base size (probe or add) based on family evidence and runtime health:
 *  - probe-only promotion → 0.6x (smaller probes for unproven families)
 *  - negative tailAdjustedPnlLive → 0.75x (family under stress)
 *  - weak/unknown evidence → 0.8x
 *  - heavy campaign eligible + strong evidence → 1.25x (conviction sizing)
 *
 * Multipliers stack multiplicatively, then clamp to [0.5, 1.5].
 */
function evidenceSizeMultiplier(
  evidence: FamilyEvidence,
  familyState: FamilyState | null,
): number {
  let mult = 1.0;

  // Promotion state: unproven families get smaller sizes
  if (evidence.promotionState === "probe-only") {
    mult *= 0.6;
  } else if (evidence.promotionState === "restricted" || evidence.promotionState === "reduce-only") {
    mult *= 0.5;
  }

  // Evidence quality: weak/unknown → smaller
  if (evidence.evidenceStatus === "weak" || evidence.evidenceStatus === "unknown") {
    mult *= 0.8;
  }

  // Runtime health: negative tail-adjusted PnL → reduce sizing
  if (familyState && familyState.tailAdjustedPnlLive < 0) {
    mult *= 0.75;
  }

  // Conviction: heavy campaign eligible + strong evidence → upsize
  if (evidence.heavyCampaignEligible && evidence.evidenceScore > 100) {
    mult *= 1.25;
  }

  return Math.max(0.5, Math.min(1.5, mult));
}

/**
 * Scan a batch of normalized markets and produce signals.
 * Pure function of market state + rules + positions — no side effects.
 *
 * Markets are sorted by family priorityRank (lower = higher priority)
 * so that higher-ranked families get signal slots first when intra-tick
 * dedup is active.
 */
export function scan(
  markets: readonly NormalizedMarket[],
  deps: ScannerDeps,
  buyTracker: BuyTracker,
  tickTs: number,
  sessionTracker?: SessionTracker,
): Signal[] {
  const signals: Signal[] = [];
  const d = new Date(tickTs);
  const nowMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const dayOfWeek = d.getUTCDay();
  const weekend = isWeekend(dayOfWeek);

  // Sort markets by composite family score (P1-1: higher-ranked families first)
  const sorted = sortByFamilyPriority(markets, deps.rulesProvider, deps.familyStateRepo);

  // Track sequence per family+token+side within this tick
  const seqMap = new Map<string, number>();
  function nextSeq(familyId: FamilyId, tokenId: TokenId, side: string): number {
    const key = `${familyId}|${tokenId}|${side}`;
    const n = seqMap.get(key) ?? 0;
    seqMap.set(key, n + 1);
    return n;
  }

  // Intra-tick entry dedup: when cooldown is configured, allow at most one
  // entry signal per family per scan cycle. Without this, a batch of N
  // markets in the same family would emit N probe-entries before any fill
  // updates lastEntryTs.
  const familyEntryEmitted = new Set<string>();

  for (const market of sorted) {
    // Only consider markets assigned to a family
    if (!market.familyId) continue;
    if (!market.active) continue;

    const bundle = deps.rulesProvider.getRule(market.familyId);
    if (!bundle) continue;
    if (!deps.rulesProvider.isEnabled(market.familyId)) continue;

    // Check universe action
    if (bundle.rules.universe.action !== "trade") continue;

    const midPrice = market.midPrice;
    if (midPrice === null) continue;

    const existingPosition = deps.positionRepo.findByTokenId(market.tokenId);

    // ─── Repricing exit ──────────────────────────────────────
    // Exits fire regardless of weekend/window policy — they reduce risk.
    let exitEmitted = false;
    if (existingPosition && existingPosition.status === "open") {
      const exitSignal = evaluateExit(
        market, bundle, existingPosition, midPrice, tickTs, nextSeq,
      );
      if (exitSignal) {
        signals.push(exitSignal);
        exitEmitted = true;
      }
    }

    // ─── Resolution buffer guard ────────────────────────────────
    // Block new entries when endDate is within resolutionBufferMinutes
    // unless resolutionHoldingAllowed is true.
    if (market.endDate && !bundle.rules.exit.resolutionHoldingAllowed) {
      const endMs = new Date(market.endDate).getTime();
      const bufferMs = bundle.rules.exit.resolutionBufferMinutes * 60_000;
      if (!isNaN(endMs) && tickTs > endMs - bufferMs) {
        continue; // too close to resolution — skip entry/scale-in
      }
    }

    // ─── Weekend policy (P1-3) ────────────────────────────────
    // Applies to entry/scale-in signals only. Exits always pass through.
    if (weekend) {
      const weekendMode = bundle.rules.session.weekendMode;
      if (!bundle.rules.universe.allowWeekends || weekendMode === "disabled") {
        // Weekend entries fully blocked
        continue;
      }
      // weekendMode === "reduced" handled below alongside active window
    }

    // ─── Entry / Scale-in (session window gated) ─────────────
    const reduced = isReducedMode(
      bundle.rules.session,
      bundle.rules.universe.sessionMode,
      nowMinutes,
      weekend,
    );

    // Fetch family state once (used for cooldown + evidence sizing)
    const familyState = deps.familyStateRepo.get(market.familyId);
    const sizeMult = evidenceSizeMultiplier(bundle.evidence, familyState);

    // Entry cooldown check (per-family) — skip entry/scale-in if cooldown not elapsed
    const cooldownSec = bundle.rules.entry.entryCooldownSeconds;
    if (cooldownSec) {
      // Cross-tick: check persisted lastEntryTs
      if (familyState?.lastEntryTs) {
        const elapsed = (tickTs - new Date(familyState.lastEntryTs).getTime()) / 1000;
        if (elapsed < cooldownSec) continue;
      }
      // Intra-tick: only one entry per family per scan cycle
      const fKey = String(market.familyId);
      if (familyEntryEmitted.has(fKey)) continue;
    }

    if (existingPosition && existingPosition.status === "open") {
      // Skip scale-in if we already emitted an exit for this token —
      // exit means "sell everything", a concurrent buy is contradictory
      // and would create opposing orders on the same token.
      if (!exitEmitted) {
        // Reduced mode: only probes allowed, no scale-in/confirm/heavy
        if (!reduced) {
          const scaleSignal = evaluateScaleIn(
            market, bundle, existingPosition, midPrice, tickTs, nextSeq,
            buyTracker, sizeMult,
          );
          if (scaleSignal) {
            signals.push(scaleSignal);
            if (cooldownSec) familyEntryEmitted.add(String(market.familyId));
          }
        }
      }
    } else if (!existingPosition) {
      // P1-6: max probe count per market — skip if already probed this token enough times
      const maxProbes = bundle.rules.entry.maxProbeCountPerMarket;
      if (sessionTracker && maxProbes !== null) {
        if (sessionTracker.getProbeCount(String(market.tokenId)) >= maxProbes) continue;
      }

      // P1-6: max new markets per session — skip if adding a genuinely new market would exceed limit
      const maxNew = bundle.rules.entry.maxNewMarketsPerSession;
      if (sessionTracker && maxNew !== null) {
        const isNew = !sessionTracker.isKnownMarket(String(market.familyId), String(market.tokenId));
        if (isNew && sessionTracker.getNewMarketCount(String(market.familyId)) >= maxNew) continue;
      }

      // ─── Two-sided overlay (P1-5) ────────────────────────────
      // NO-outcome markets with two-sided enabled go through the two-sided
      // entry path instead of the standard probe path.
      const isTwoSidedCandidate = market.outcome === "NO" &&
        bundle.rules.twoSided.allowTwoSided &&
        bundle.rules.twoSided.twoSidedMode !== "disabled";

      if (isTwoSidedCandidate && !reduced) {
        const twoSidedSignal = evaluateTwoSidedEntry(
          market, bundle, midPrice, tickTs, nextSeq, sizeMult,
        );
        if (twoSidedSignal) {
          signals.push(twoSidedSignal);
          if (cooldownSec) familyEntryEmitted.add(String(market.familyId));
        }
      } else {
        // Probe entry — allowed in reduced mode (probes are low-risk)
        const probeSignal = evaluateProbeEntry(
          market, bundle, midPrice, tickTs, nextSeq, sizeMult,
          !!(familyState && familyState.tailAdjustedPnlLive < 0),
        );
        if (probeSignal) {
          signals.push(probeSignal);
          if (cooldownSec) familyEntryEmitted.add(String(market.familyId));
        }
      }
    }
  }

  return signals;
}

/**
 * Compute composite family score for ranking (P1-1).
 *
 * Lower score = higher priority. Combines:
 *  - priorityRank (config-driven, integer 0-999) — always dominant
 *  - sub-rank tiebreaker in (-0.5, +0.5) from evidence, recycle quality, tail burden
 *
 * The tiebreaker is clamped to (-0.5, +0.5) so it can never override a
 * 1-point difference in priorityRank.
 */
function familyCompositeScore(
  bundle: FamilyRuleBundle,
  familyStateRepo: FamilyStateRepository,
): number {
  const base = bundle.rules.universe.priorityRank;
  const evidence = bundle.evidence;
  const state = familyStateRepo.get(bundle.rules.familyId);

  // Evidence score: higher is better → subtract (capped at 0.15)
  const evidenceBonus = Math.min(evidence.evidenceScore / 1000, 0.15);

  // Tail-adjusted PnL: positive is better → subtract (capped at 0.15)
  const tailPnl = state?.tailAdjustedPnlLive ?? 0;
  const recycleBonus = tailPnl > 0 ? Math.min(tailPnl / 1000, 0.15) : 0;

  // Tail burden: higher cost is worse → add (capped at 0.15)
  const tailCost = state?.currentTailCostUsdc ?? 0;
  const tailPenalty = Math.min(tailCost / 500, 0.15);

  const tiebreaker = -evidenceBonus - recycleBonus + tailPenalty;
  return base + Math.max(-0.49, Math.min(0.49, tiebreaker));
}

/**
 * Sort markets by composite family score (P1-1).
 * Lower score = higher priority. Markets without a family or bundle sort last.
 */
function sortByFamilyPriority(
  markets: readonly NormalizedMarket[],
  rulesProvider: FamilyRulesProvider,
  familyStateRepo: FamilyStateRepository,
): NormalizedMarket[] {
  const scoreCache = new Map<string, number>();
  function getScore(familyId: FamilyId): number {
    const key = String(familyId);
    let s = scoreCache.get(key);
    if (s === undefined) {
      const bundle = rulesProvider.getRule(familyId);
      s = bundle ? familyCompositeScore(bundle, familyStateRepo) : 999;
      scoreCache.set(key, s);
    }
    return s;
  }

  return [...markets].sort((a, b) => {
    const ra = a.familyId ? getScore(a.familyId) : 999;
    const rb = b.familyId ? getScore(b.familyId) : 999;
    return ra - rb;
  });
}

function evaluateProbeEntry(
  market: NormalizedMarket,
  bundle: FamilyRuleBundle,
  midPrice: number,
  tickTs: number,
  nextSeq: (f: FamilyId, t: TokenId, s: string) => number,
  sizeMult: number = 1.0,
  tailPnlNegative: boolean = false,
): Signal | null {
  const entry = bundle.rules.entry;

  // Entry mode must allow entries
  if (entry.entryMode === "disabled") return null;

  // Price band check
  if (midPrice < entry.minEntryPrice || midPrice > entry.maxEntryPrice) return null;

  // High-price one-shot gate
  if (midPrice >= entry.highPriceThreshold && !entry.allowHighPriceOneShot) return null;

  // Proven family gate for above-threshold prices
  if (midPrice > entry.requireProvenFamilyAbovePrice) {
    if (bundle.evidence.evidenceStatus !== "confirmed") return null;
  }

  // Size: probeSizeUsdc adjusted by evidence multiplier + probe haircut, capped by max notional
  const probeHaircut = tailPnlNegative ? 0.5 : 1.0;
  const suggestedSizeUsdc = Math.min(entry.probeSizeUsdc * sizeMult * probeHaircut, entry.maxInitialNotionalUsdc);
  const suggestedSize = suggestedSizeUsdc / midPrice;

  return {
    signalId: nextSignalId(),
    familyId: market.familyId!,
    tokenId: market.tokenId,
    side: "buy",
    suggestedPrice: midPrice,
    suggestedSize,
    suggestedSizeUsdc,
    reason: "probe-entry",
    strategyTick: tickTs,
    sequenceInTick: nextSeq(market.familyId!, market.tokenId, "buy"),
    generatedAt: new Date(tickTs).toISOString(),
  };
}

function evaluateScaleIn(
  market: NormalizedMarket,
  bundle: FamilyRuleBundle,
  position: Position,
  midPrice: number,
  tickTs: number,
  nextSeq: (f: FamilyId, t: TokenId, s: string) => number,
  buyTracker: BuyTracker,
  sizeMult: number = 1.0,
): Signal | null {
  const scale = bundle.rules.scaleIn;
  const entry = bundle.rules.entry;

  // Scale mode check
  if (scale.scaleMode === "disabled") return null;

  // Price still in entry band
  if (midPrice < entry.minEntryPrice || midPrice > entry.maxEntryPrice) return null;

  // Determine stage from buy count
  const buyCount = buyTracker.getBuyCount(String(position.positionId));
  const reason = resolveScaleStage(buyCount, scale);
  if (!reason) return null;

  // Size: addSizeUsdc adjusted by evidence multiplier, capped by max notional
  const suggestedSizeUsdc = Math.min(entry.addSizeUsdc * sizeMult, entry.maxInitialNotionalUsdc);
  const suggestedSize = suggestedSizeUsdc / midPrice;

  return {
    signalId: nextSignalId(),
    familyId: market.familyId!,
    tokenId: market.tokenId,
    side: "buy",
    suggestedPrice: midPrice,
    suggestedSize,
    suggestedSizeUsdc,
    reason,
    strategyTick: tickTs,
    sequenceInTick: nextSeq(market.familyId!, market.tokenId, "buy"),
    generatedAt: new Date(tickTs).toISOString(),
  };
}

/** Map buy count to scale stage reason. Returns null if no more buys allowed. */
function resolveScaleStage(
  buyCount: number,
  scale: ScaleInRules,
): SignalReason | null {
  if (buyCount === 1) return "confirm-scale";
  if (buyCount < scale.defaultMaxBuysPerLeg) return "scale-in";
  if (scale.allowHeavyCampaigns && buyCount < scale.heavyMaxBuysPerLeg) return "heavy-scale";
  return null;
}

function evaluateExit(
  market: NormalizedMarket,
  bundle: FamilyRuleBundle,
  position: Position,
  midPrice: number,
  tickTs: number,
  nextSeq: (f: FamilyId, t: TokenId, s: string) => number,
): Signal | null {
  const exit = bundle.rules.exit;

  // Exit mode check
  if (exit.exitMode === "disabled") return null;

  // ROI calculation
  if (position.avgEntryPrice <= 0) return null;
  const roi = (midPrice - position.avgEntryPrice) / position.avgEntryPrice;

  // Target ROI band check — config stores percentages (e.g. 20.0 = 20%),
  // convert to fractions for comparison against computed ROI.
  const lowBand = (exit.targetRoiBandLow ?? 20) / 100;
  const highBand = (exit.targetRoiBandHigh ?? 50) / 100;

  // Fast recycle: tighter exit band for young positions (< 1 hour old)
  let effectiveLowBand = lowBand;
  if (exit.preferFastRecycle) {
    const positionAgeMs = tickTs - new Date(position.openedAt).getTime();
    if (positionAgeMs < 60 * 60 * 1000) {
      effectiveLowBand = lowBand * 0.5;
    }
  }

  // Below any exit threshold — no exit
  const mediumHoldBand = effectiveLowBand * 0.5;
  if (roi < mediumHoldBand) return null;

  // Runner extension: above high band, hold the position
  if (roi > highBand && exit.allowRunnerExtension) return null;

  // Medium-hold partial exit: ROI between mediumHoldBand and effectiveLowBand
  // Sell 50% of position to reduce exposure while holding a runner portion.
  if (roi < effectiveLowBand) {
    const partialSize = position.size * 0.5;
    if (partialSize < 0.001) return null; // too small to split meaningfully

    return {
      signalId: nextSignalId(),
      familyId: market.familyId!,
      tokenId: market.tokenId,
      side: "sell",
      suggestedPrice: midPrice,
      suggestedSize: partialSize,
      suggestedSizeUsdc: partialSize * midPrice,
      reason: "medium-hold-exit",
      strategyTick: tickTs,
      sequenceInTick: nextSeq(market.familyId!, market.tokenId, "sell"),
      generatedAt: new Date(tickTs).toISOString(),
    };
  }

  // Full position repricing exit: ROI in [effectiveLowBand, highBand]
  return {
    signalId: nextSignalId(),
    familyId: market.familyId!,
    tokenId: market.tokenId,
    side: "sell",
    suggestedPrice: midPrice,
    suggestedSize: position.size,
    suggestedSizeUsdc: position.size * midPrice,
    reason: "repricing-exit",
    strategyTick: tickTs,
    sequenceInTick: nextSeq(market.familyId!, market.tokenId, "sell"),
    generatedAt: new Date(tickTs).toISOString(),
  };
}

/**
 * Two-sided entry evaluation (P1-5).
 *
 * Only fires for NO-outcome markets in families where:
 *  - allowTwoSided is true
 *  - twoSidedMode is "selective" or "active"
 *  - evidence meets minActivityForTwoSided threshold
 *  - NO-side price is in entry band (buying NO tokens as a hedge/complement)
 *
 * In "selective" mode, only bothSidedEligible families are allowed.
 * In "active" mode, any family with allowTwoSided can trade both sides.
 */
function evaluateTwoSidedEntry(
  market: NormalizedMarket,
  bundle: FamilyRuleBundle,
  midPrice: number,
  tickTs: number,
  nextSeq: (f: FamilyId, t: TokenId, s: string) => number,
  sizeMult: number = 1.0,
): Signal | null {
  const ts = bundle.rules.twoSided;
  if (!ts.allowTwoSided) return null;
  if (ts.twoSidedMode === "disabled") return null;

  // Only for NO-outcome markets
  if (market.outcome !== "NO") return null;

  // Selective mode requires evidence of both-sided eligibility
  if (ts.twoSidedMode === "selective" && !bundle.evidence.bothSidedEligible) return null;

  // Activity threshold gate
  if (ts.minActivityForTwoSided !== null && bundle.evidence.localTradeCount < ts.minActivityForTwoSided) {
    return null;
  }

  const entry = bundle.rules.entry;
  // NO-side price band check — same entry band as YES side
  if (midPrice < entry.minEntryPrice || midPrice > entry.maxEntryPrice) return null;

  // Size: use probe size with evidence multiplier
  const suggestedSizeUsdc = Math.min(entry.probeSizeUsdc * sizeMult, entry.maxInitialNotionalUsdc);
  const suggestedSize = suggestedSizeUsdc / midPrice;

  return {
    signalId: nextSignalId(),
    familyId: market.familyId!,
    tokenId: market.tokenId,
    side: "buy",
    suggestedPrice: midPrice,
    suggestedSize,
    suggestedSizeUsdc,
    reason: "two-sided-entry",
    strategyTick: tickTs,
    sequenceInTick: nextSeq(market.familyId!, market.tokenId, "buy"),
    generatedAt: new Date(tickTs).toISOString(),
  };
}
