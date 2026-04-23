/**
 * ResolutionModule — detects resolved markets and settles positions.
 *
 * Polling loop:
 *  1. Find open/dust positions on markets past endDate + grace period
 *  2. Confirm resolution via Gamma API
 *  3. Close positions, record settlement PnL
 *  4. Publish MarketResolved + PositionSettled events
 */

import type Database from "better-sqlite3";
import type {
  EventBus,
  ExchangeGateway,
  RuntimeModule,
  MarketRepository,
  MarketResolutionRepository,
  OrderRepository,
  InventoryLotRepository,
  PositionRepository,
  TokenId,
} from "@plankton/domain";
import { createCommandId } from "@plankton/domain";
import type { GammaResolutionClient } from "@plankton/exchange";
import type {
  ResolutionDetector,
  ResolutionCandidate,
  DetectedResolution,
} from "./resolution-detector.js";
import { inferResolution, parseTokenIds } from "./resolution-detector.js";
import type { PositionSettler } from "./position-settler.js";
import type { Logger } from "../../logger.js";

function normalizeOutcomeLabel(value: string): string {
  return value.trim().toLowerCase();
}

const SETTLEMENT_BALANCE_DUST_THRESHOLD = 1 / 1_000_000;

// Per-conditionId circuit-breaker for the algo-triggered on-chain redeem path.
// Baseline was up to 14 consecutive gateway calls per failing conditionId per
// window (see audit B8/2); this table caps that at 3 attempts before the
// circuit opens fully for an hour.
//
// Back-off grows with failureCount; at count >= 3 the circuit is considered
// open and further gateway calls are suppressed entirely until
// CIRCUIT_OPEN_COOLDOWN_MS has passed since the last failure.
const REDEEM_BACKOFF_MS_BY_COUNT: readonly number[] = [
  0, // count=0 (no prior failure) — no back-off
  60_000, // count=1 — 1 min
  5 * 60_000, // count=2 — 5 min
];
const REDEEM_CIRCUIT_OPEN_COOLDOWN_MS = 60 * 60_000;
const REDEEM_CIRCUIT_OPEN_THRESHOLD = 3;

interface RedeemFailureEntry {
  readonly failedAt: number;
  readonly failureCount: number;
}

export interface ResolutionModuleDeps {
  detector: ResolutionDetector;
  settler: PositionSettler;
  marketRepo: MarketRepository;
  resolutionRepo: MarketResolutionRepository;
  orderRepo: OrderRepository;
  gammaClient: GammaResolutionClient;
  lotRepo: InventoryLotRepository;
  positionRepo: PositionRepository;
  db: Database.Database;
  bus: EventBus;
  log: Logger;
  checkIntervalMs: number;
  graceMinutes: number;
  /**
   * Optional exchange gateway for pre-settlement balance verification.
   * When provided, each candidate's on-chain token balance is checked
   * before settlement. Only candidates with zero balance are settled.
   * When absent, settlement proceeds without balance verification.
   */
  gateway?: ExchangeGateway;
}

export class ResolutionModule implements RuntimeModule {
  private intervalHandle: NodeJS.Timeout | null = null;
  private unsubs: Array<() => void> = [];
  private readonly pendingHintConditionIds = new Set<string>();
  private readonly hintedCancelledOrderIds = new Set<string>();
  private readonly redeemFailures = new Map<string, RedeemFailureEntry>();
  private running = false;
  private wsHintConsumed = 0;

  constructor(private readonly deps: ResolutionModuleDeps) {}

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("MarketResolvedHint", async (hint) => {
        await this.handleMarketResolvedHint(hint);
      }),
    );
    this.unsubs.push(
      this.deps.bus.subscribe("RedeemRequested", async (payload) => {
        await this.handleAlgoRedeem(payload.conditionIds);
      }),
    );
    // Run once at startup (non-blocking)
    this.runCheck().catch((err) => this.deps.log.error(err, "startup resolution check failed"));
    this.recoverUnresolved().catch((err) => this.deps.log.error(err, "resolution recovery failed"));

    this.intervalHandle = setInterval(() => {
      this.runCheck().catch((err) => this.deps.log.error(err, "resolution check failed"));
    }, this.deps.checkIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
  }

  private async handleAlgoRedeem(conditionIds: readonly string[]): Promise<void> {
    if (conditionIds.length === 0) return;
    this.deps.log.info({ conditionIds }, "algo-triggered redeem requested");

    let settleableConditionIds = [...conditionIds];

    if (this.deps.gateway) {
      const now = Date.now();
      const { gatewayTargets, suppressed } = this.partitionRedeemTargets(conditionIds, now);

      if (suppressed.length > 0) {
        this.deps.log.warn(
          { conditionIds: suppressed, cooldownMs: REDEEM_CIRCUIT_OPEN_COOLDOWN_MS },
          "algo_redeem_circuit_open",
        );
      }

      // Phase 3.B: drop already-redeemed conditions before calling the gateway.
      // The root-cause of many `algo-triggered on-chain redeem failed` events
      // is a prior tx that already drained the balance; re-submitting triggers
      // a revert. Drift detector (Phase 3.A) is the primary safety net for
      // any missed case.
      const { targetsNeedingRedeem, alreadyRedeemed } =
        await this.filterAlreadyRedeemed(gatewayTargets);
      const successfullyRedeemed: string[] = [];

      // Invoke the gateway one conditionId at a time. The underlying
      // settlementExecute is a single relayer call per request, so wrapping a
      // multi-condition batch in one try/catch would record a failure against
      // every id in the batch when only one actually reverted — poisoning the
      // per-conditionId circuit for innocent markets. Submitting per condition
      // keeps success/failure strictly scoped to its own id.
      for (const conditionId of targetsNeedingRedeem) {
        try {
          await this.deps.gateway.redeemPositions([conditionId]);
          this.deps.log.info(
            { conditionIds: [conditionId] },
            "algo-triggered on-chain redeem submitted",
          );
          this.redeemFailures.delete(conditionId);
          successfullyRedeemed.push(conditionId);
        } catch (err) {
          this.recordRedeemFailure([conditionId], Date.now());
          this.deps.log.error(
            { err, conditionIds: [conditionId] },
            "algo-triggered on-chain redeem failed",
          );
        }
      }

      settleableConditionIds = [...alreadyRedeemed, ...successfullyRedeemed];

      const skippedLocalSettlement = conditionIds.filter(
        (conditionId) => !settleableConditionIds.includes(conditionId),
      );
      if (skippedLocalSettlement.length > 0) {
        this.deps.log.warn(
          { conditionIds: skippedLocalSettlement },
          "algo-triggered redeem skipped local settlement until on-chain redeem succeeds",
        );
      }
    }

    // Cancel any open orders on tokens we're about to settle so they don't
    // fill after the leg terminates. Mirrors cancelOpenOrders in the normal
    // resolution path.
    for (const conditionId of conditionIds) {
      const markets = this.deps.marketRepo.findByConditionId(conditionId);
      for (const market of markets) {
        await this.cancelOpenOrders(market.tokenId);
      }
    }

    // settlement_ledger.condition_id FK references market_resolutions. On the
    // normal resolution path the row is written by processDetectedResolutions;
    // on the algo-redeem path there is no Gamma-detected resolution, so we
    // must upsert a row marked source="algo" before settleAlgoRedeem or the
    // FK will reject the settlement write. ON CONFLICT DO NOTHING preserves
    // any pre-existing row written by a later market resolution.
    if (settleableConditionIds.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    for (const conditionId of settleableConditionIds) {
      this.deps.resolutionRepo.save({
        conditionId,
        resolution: "algo-redeem",
        resolvedAt: now,
        detectedAt: now,
        source: "algo",
        rawResponse: null,
        status: "detected",
      });
    }

    const settled = this.deps.settler.settleAlgoRedeem(settleableConditionIds);
    for (const s of settled) {
      await this.deps.bus.publish("PositionSettled", s);
    }

    if (settled.length > 0) {
      this.deps.log.info(
        { conditionIds: settleableConditionIds, settledCount: settled.length },
        "algo-triggered redeem settled local positions",
      );
    }
  }

  getHintMetricsSnapshot(): { readonly resolutionWsHintsConsumed: number } {
    return {
      resolutionWsHintsConsumed: this.wsHintConsumed,
    };
  }

  /**
   * Phase 3.B — skip conditions whose outcome-token balances are already zero
   * on-chain. A previous redeem succeeded (or there was nothing to redeem);
   * re-submitting would revert and trip the circuit. On balance-check error,
   * fall through to the gateway so the circuit still records real failures.
   */
  private async filterAlreadyRedeemed(
    conditionIds: readonly string[],
  ): Promise<{ targetsNeedingRedeem: string[]; alreadyRedeemed: string[] }> {
    if (conditionIds.length === 0) {
      return { targetsNeedingRedeem: [], alreadyRedeemed: [] };
    }
    const gateway = this.deps.gateway!;
    const needsRedeem: string[] = [];
    const alreadyRedeemed: string[] = [];
    for (const conditionId of conditionIds) {
      const markets = this.deps.marketRepo.findByConditionId(conditionId);
      if (markets.length === 0) {
        needsRedeem.push(conditionId);
        continue;
      }
      let allZero = true;
      for (const market of markets) {
        try {
          const balance = await gateway.getOutcomeTokenBalance(market.tokenId);
          if (balance !== 0n) {
            allZero = false;
            break;
          }
        } catch (err) {
          this.deps.log.warn(
            { conditionId, tokenId: String(market.tokenId), err },
            "algo_redeem_precheck_failed",
          );
          allZero = false;
          break;
        }
      }
      if (allZero) {
        this.deps.log.info({ conditionId }, "algo_redeem_skipped_already_redeemed");
        this.redeemFailures.delete(conditionId);
        alreadyRedeemed.push(conditionId);
      } else {
        needsRedeem.push(conditionId);
      }
    }
    return { targetsNeedingRedeem: needsRedeem, alreadyRedeemed };
  }

  private partitionRedeemTargets(
    conditionIds: readonly string[],
    now: number,
  ): { gatewayTargets: string[]; suppressed: string[] } {
    const gatewayTargets: string[] = [];
    const suppressed: string[] = [];
    for (const conditionId of conditionIds) {
      if (this.isRedeemCircuitOpen(conditionId, now)) suppressed.push(conditionId);
      else gatewayTargets.push(conditionId);
    }
    return { gatewayTargets, suppressed };
  }

  private isRedeemCircuitOpen(conditionId: string, now: number): boolean {
    const entry = this.redeemFailures.get(conditionId);
    if (!entry) return false;
    const sinceFailure = now - entry.failedAt;
    if (entry.failureCount >= REDEEM_CIRCUIT_OPEN_THRESHOLD) {
      return sinceFailure < REDEEM_CIRCUIT_OPEN_COOLDOWN_MS;
    }
    const backoff = REDEEM_BACKOFF_MS_BY_COUNT[entry.failureCount] ?? 0;
    return sinceFailure < backoff;
  }

  private recordRedeemFailure(conditionIds: readonly string[], now: number): void {
    for (const conditionId of conditionIds) {
      const prev = this.redeemFailures.get(conditionId);
      this.redeemFailures.set(conditionId, {
        failedAt: now,
        failureCount: (prev?.failureCount ?? 0) + 1,
      });
    }
  }

  /** Exposed for testing. */
  async runCheck(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      const resolutions = await this.deps.detector.detect(this.deps.graceMinutes);
      return await this.processDetectedResolutions(resolutions);
    } finally {
      this.running = false;
      void this.flushPendingHintConditions();
    }
  }

  private async handleMarketResolvedHint(
    hint: import("@plankton/domain").RuntimeEventMap["MarketResolvedHint"],
  ): Promise<void> {
    this.wsHintConsumed++;
    for (const tokenId of hint.tokenIds) {
      await this.cancelOpenOrders(tokenId, {
        rememberCancelledOrderIds: this.hintedCancelledOrderIds,
      });
    }
    this.pendingHintConditionIds.add(hint.conditionId);
    if (!this.running) {
      await this.flushPendingHintConditions();
    }
  }

  private async flushPendingHintConditions(): Promise<void> {
    if (this.running || this.pendingHintConditionIds.size === 0) return;
    this.running = true;
    try {
      const conditionIds = [...this.pendingHintConditionIds];
      this.pendingHintConditionIds.clear();
      const resolutions: DetectedResolution[] = [];
      for (const conditionId of conditionIds) {
        const detected = await this.deps.detector.detectCondition(conditionId);
        if (detected) {
          resolutions.push(detected);
        }
      }
      await this.processDetectedResolutions(resolutions);
    } finally {
      this.hintedCancelledOrderIds.clear();
      this.running = false;
      if (this.pendingHintConditionIds.size > 0) {
        void this.flushPendingHintConditions();
      }
    }
  }

  private async processDetectedResolutions(
    resolutions: readonly DetectedResolution[],
  ): Promise<number> {
    let totalSettled = 0;

    for (const resolution of resolutions) {
      const isRetry = !!this.deps.resolutionRepo.findByConditionId(resolution.conditionId);

      if (!isRetry) {
        this.deps.resolutionRepo.save({
          conditionId: resolution.conditionId,
          resolution: resolution.resolution,
          resolvedAt: resolution.resolvedAt,
          detectedAt: new Date().toISOString(),
          source: resolution.source,
          rawResponse: resolution.rawResponse,
          status: "detected",
        });
      }

      if (!isRetry) {
        for (const candidate of resolution.candidates) {
          this.deps.marketRepo.deactivate(candidate.tokenId);
          await this.cancelOpenOrders(candidate.tokenId, {
            skipOrderIds: this.hintedCancelledOrderIds,
          });
        }
      }

      if (resolution.resolution === "unknown") {
        this.deps.log.warn(
          { conditionId: resolution.conditionId, source: resolution.source },
          "resolution unknown — requires manual review",
        );

        if (!isRetry) {
          await this.publishMarketResolved(resolution);
        }
        continue;
      }

      let eligibleCandidates: ResolutionCandidate[] = [...resolution.candidates];

      const preFilterCount = eligibleCandidates.length;
      if (this.deps.gateway && eligibleCandidates.length > 0) {
        await this.deps.gateway.redeemPositions([resolution.conditionId]);

        if (this.deps.gateway.hasPendingRedeemSubmission?.(resolution.conditionId) ?? false) {
          this.deps.log.info(
            { conditionId: resolution.conditionId },
            "redeem submitted — deferring settlement verification until relayer confirms",
          );
          if (!isRetry) {
            await this.publishMarketResolved(resolution);
          }
          continue;
        }

        eligibleCandidates = await this.filterByZeroBalance(
          eligibleCandidates,
          resolution.conditionId,
        );
      }
      const allVerified = !this.deps.gateway || eligibleCandidates.length === preFilterCount;

      const settleable = { ...resolution, candidates: eligibleCandidates };
      const settled = settleable.candidates.length > 0 ? this.deps.settler.settle(settleable) : [];
      totalSettled += settled.length;

      if (allVerified && settled.length === eligibleCandidates.length) {
        this.deps.resolutionRepo.markSettled(resolution.conditionId);
      }

      if (!isRetry) {
        await this.publishMarketResolved(resolution);
      }

      for (const settledPosition of settled) {
        await this.deps.bus.publish("PositionSettled", settledPosition);
      }

      this.deps.log.info(
        {
          conditionId: resolution.conditionId,
          resolution: resolution.resolution,
          settledCount: settled.length,
        },
        `resolved market — settled ${settled.length} positions`,
      );
    }

    return totalSettled;
  }

  /**
   * Filter candidates to only those with near-zero on-chain token balance.
   * This ensures we only settle positions whose shares have been fully
   * redeemed or sold, while tolerating atomic-unit dust after settlement.
   */
  private async filterByZeroBalance(
    candidates: ResolutionCandidate[],
    conditionId: string,
  ): Promise<ResolutionCandidate[]> {
    const gateway = this.deps.gateway!;
    const settled: ResolutionCandidate[] = [];

    for (const candidate of candidates) {
      let balance: number;
      try {
        balance = await gateway.getPositionBalance(candidate.tokenId);
      } catch (err) {
        this.deps.log.warn(
          { tokenId: String(candidate.tokenId), conditionId, err },
          "skipping settlement — balance check failed",
        );
        continue;
      }
      if (balance <= SETTLEMENT_BALANCE_DUST_THRESHOLD) {
        settled.push(candidate);
      } else {
        this.deps.log.warn(
          { tokenId: String(candidate.tokenId), conditionId, balance },
          "skipping settlement — on-chain token balance is non-zero",
        );
      }
    }

    return settled;
  }

  private async publishMarketResolved(resolution: DetectedResolution): Promise<void> {
    await this.deps.bus.publish("MarketResolved", {
      conditionId: resolution.conditionId,
      tokenIds: resolution.candidates.map((c) => c.tokenId),
      resolution: resolution.resolution,
      resolvedAt: resolution.resolvedAt,
      source: resolution.source,
      timestamp: Date.now(),
    });
  }

  /** Publish CancelOrderRequested for open/partially-filled/pending orders on a resolved token. */
  private async cancelOpenOrders(
    tokenId: TokenId,
    opts?: Readonly<{
      skipOrderIds?: ReadonlySet<string>;
      rememberCancelledOrderIds?: Set<string>;
    }>,
  ): Promise<void> {
    const orders = this.deps.orderRepo.findByTokenId(tokenId);
    const active = orders.filter(
      (o) => o.status === "open" || o.status === "partially-filled" || o.status === "pending",
    );
    for (const order of active) {
      if (opts?.skipOrderIds?.has(String(order.orderId))) {
        continue;
      }
      // Pending orders without an exchange-assigned ID cannot be cancelled
      // on the exchange — just deactivate them locally.
      if (order.status === "pending" && !order.exchangeOrderId) {
        this.deps.orderRepo.updateStatus(order.orderId, "cancelled");
        opts?.rememberCancelledOrderIds?.add(String(order.orderId));
        this.deps.log.info(
          { orderId: String(order.orderId), tokenId: String(tokenId) },
          "locally cancelled pending order without exchange ID on resolved market",
        );
        continue;
      }
      opts?.rememberCancelledOrderIds?.add(String(order.orderId));
      await this.deps.bus.publish("CancelOrderRequested", {
        command: {
          type: "CancelOrderCommand" as const,
          commandId: createCommandId(`res-cancel-${String(order.orderId)}`),
          orderId: order.orderId,
          reason: "market_resolved" as const,
        },
        timestamp: Date.now(),
      });
      this.deps.log.info(
        { orderId: String(order.orderId), tokenId: String(tokenId) },
        "requested cancel for order on resolved market",
      );
    }
  }

  /** Re-resolve market_resolutions stuck in detected/unknown status. */
  private async recoverUnresolved(): Promise<number> {
    const allResolutions = this.deps.resolutionRepo.findAll();
    const unresolved = allResolutions.filter(
      (r) => r.status === "detected" && r.resolution === "unknown",
    );
    if (unresolved.length === 0) return 0;

    this.deps.log.info(
      { count: unresolved.length },
      "attempting recovery of unresolved conditions",
    );
    let recovered = 0;

    for (const mr of unresolved) {
      const markets = this.deps.marketRepo.findByConditionId(mr.conditionId);
      if (markets.length === 0) continue;

      const slug = markets[0]!.slug;
      let info;
      try {
        info = await this.deps.gammaClient.getMarketBySlug(slug);
      } catch (err) {
        this.deps.log.warn(
          { conditionId: mr.conditionId, err },
          "recovery Gamma lookup failed — skipping",
        );
        continue;
      }
      if (!info?.closed) continue;

      const inferred = inferResolution(info.umaResolutionStatus, info.rawPayload);
      if (inferred === "unknown") continue;

      const resolution = inferred.outcome;
      const clobTokenIds = parseTokenIds(info.rawPayload);
      const winnerTokenId = inferred.winnerTokenId
        ? inferred.winnerTokenId
        : inferred.winnerIndex >= 0 && clobTokenIds[inferred.winnerIndex]
          ? clobTokenIds[inferred.winnerIndex]!
          : null;

      const resolvedAt = info.closedTime ?? new Date().toISOString();

      // Wrap ALL writes in a single transaction for atomicity
      const runSettlement = this.deps.db.transaction(() => {
        this.deps.resolutionRepo.updateResolution(
          mr.conditionId,
          resolution,
          resolvedAt,
          "gamma-api",
        );

        for (const market of markets) {
          // Find closed positions with orphaned lots for this token
          const allPositions = this.deps.positionRepo
            .findAll()
            .filter((p) => String(p.tokenId) === String(market.tokenId));
          const closedWithLots = allPositions.filter((p) => {
            if (p.status !== "closed") return false;
            const lots = this.deps.lotRepo.findOpen(p.positionId);
            return lots.length > 0;
          });

          for (const pos of closedWithLots) {
            const openLots = this.deps.lotRepo.findOpen(pos.positionId);
            const remainingSize = openLots.reduce((sum, l) => sum + l.remainingSize, 0);
            const isWinner = winnerTokenId
              ? String(market.tokenId) === winnerTokenId
              : normalizeOutcomeLabel(market.outcome) === normalizeOutcomeLabel(resolution);
            const settlementPrice = isWinner ? 1.0 : 0.0;
            const settlementPnl = (settlementPrice - pos.avgEntryPrice) * remainingSize;

            this.deps.lotRepo.settleAll(pos.positionId);

            const settlementId = `recovery-${mr.conditionId}-${String(market.tokenId)}`;
            this.deps.db
              .prepare(
                `INSERT OR IGNORE INTO settlement_ledger
                   (settlement_id, condition_id, position_id, token_id,
                    resolution, settlement_price, size, delta, settled_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                settlementId,
                mr.conditionId,
                String(pos.positionId),
                String(market.tokenId),
                resolution,
                settlementPrice,
                remainingSize,
                settlementPnl,
                resolvedAt,
              );

            this.deps.positionRepo.save({
              ...pos,
              size: 0,
              realizedPnl: pos.realizedPnl + settlementPnl,
              currentValueUsdc: 0,
              closedAt: resolvedAt,
              updatedAt: new Date().toISOString(),
            });

            this.deps.log.info(
              {
                positionId: String(pos.positionId),
                resolution,
                settlementPnl: settlementPnl.toFixed(4),
              },
              "recovery: settled orphaned closed position",
            );
          }
        }
      });
      runSettlement();

      this.deps.log.info(
        { conditionId: mr.conditionId, resolution },
        "recovered unresolved condition",
      );
      recovered++;
    }

    return recovered;
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: true,
      detail: `interval=${this.deps.checkIntervalMs}ms grace=${this.deps.graceMinutes}min`,
    };
  }
}
