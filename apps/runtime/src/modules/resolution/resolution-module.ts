/**
 * ResolutionModule — detects resolved markets and settles positions.
 *
 * Polling loop:
 *  1. Find open/dust positions on markets past endDate + grace period
 *  2. Confirm resolution via Gamma API
 *  3. Close positions, record settlement PnL
 *  4. Recompute family state (direct call, not event-triggered)
 *  5. Publish MarketResolved + PositionSettled events
 */

import type Database from "better-sqlite3";
import type {
  EventBus,
  ExchangeGateway,
  RuntimeModule,
  MarketRepository,
  MarketResolutionRepository,
  OrderRepository,
  FamilyRulesProvider,
  InventoryLotRepository,
  PositionRepository,
  FamilyId,
  TokenId,
} from "@plankton/domain";
import { createCommandId } from "@plankton/domain";
import type { GammaResolutionClient } from "@plankton/exchange";
import type { FamilyExposureCalculator } from "../risk-inventory/family-exposure.js";
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

export interface ResolutionModuleDeps {
  detector: ResolutionDetector;
  settler: PositionSettler;
  marketRepo: MarketRepository;
  resolutionRepo: MarketResolutionRepository;
  orderRepo: OrderRepository;
  rulesProvider: FamilyRulesProvider;
  exposureCalculator: FamilyExposureCalculator;
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
        if (payload.conditionIds.length === 0) return;
        this.deps.log.info(
          { conditionIds: payload.conditionIds },
          "algo-triggered redeem requested",
        );
        try {
          if (this.deps.gateway) {
            await this.deps.gateway.redeemPositions([...payload.conditionIds]);
            this.deps.log.info(
              { conditionIds: payload.conditionIds },
              "algo-triggered redeem executed",
            );
          }
        } catch (err) {
          this.deps.log.error(
            { err, conditionIds: payload.conditionIds },
            "algo-triggered redeem failed",
          );
        }
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

  getHintMetricsSnapshot(): { readonly resolutionWsHintsConsumed: number } {
    return {
      resolutionWsHintsConsumed: this.wsHintConsumed,
    };
  }

  /** Exposed for testing. */
  async runCheck(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      const resolutions = await this.deps.detector.detect(this.deps.graceMinutes);
      const totalSettled = await this.processDetectedResolutions(resolutions);

      // Recompute family state for affected families.
      // FamilyExposureChanged is an OUTPUT event — not a trigger.
      // We call the calculator directly.
      const affectedFamilies = new Set<FamilyId>(
        resolutions
          .flatMap((r) => r.candidates.map((c) => c.familyId))
          .filter((f): f is FamilyId => f != null),
      );
      for (const familyId of affectedFamilies) {
        const updated = this.deps.exposureCalculator.recompute(familyId, false);
        await this.deps.bus.publish("FamilyExposureChanged", {
          familyId,
          totalExposureUsdc: updated.openValueUsdc,
          openPositionCount: updated.openPositionCount,
          familyState: updated,
          timestamp: Date.now(),
        });
      }

      return totalSettled;
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

      let eligibleCandidates = resolution.candidates.filter((c) => {
        if (!c.familyId) return true;
        const bundle = this.deps.rulesProvider.getRule(c.familyId);
        if (!bundle) return true;
        return bundle.rules.tailSuppression.autoSettleResolvedMarkets;
      });

      if (eligibleCandidates.length < resolution.candidates.length) {
        this.deps.log.info(
          {
            conditionId: resolution.conditionId,
            skipped: resolution.candidates.length - eligibleCandidates.length,
          },
          "skipped settlement for families with autoSettleResolvedMarkets=false",
        );
      }

      if (eligibleCandidates.length === 0) {
        this.deps.resolutionRepo.markSettled(resolution.conditionId);

        if (!isRetry) {
          const shouldRedeem = resolution.candidates.some((c) => {
            if (!c.familyId) return true;
            const bundle = this.deps.rulesProvider.getRule(c.familyId);
            return !bundle || bundle.rules.tailSuppression.autoSettleResolvedMarkets;
          });

          if (this.deps.gateway && shouldRedeem) {
            await this.deps.gateway.redeemPositions([resolution.conditionId]);
          }

          await this.publishMarketResolved(resolution);
        }
        continue;
      }

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
          familyId: order.familyId,
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
      const affectedFamilies = new Set<FamilyId>();

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
          const allFamilyPositions = this.deps.positionRepo.findByFamily(
            market.familyId as FamilyId,
          );
          const closedWithLots = allFamilyPositions.filter((p) => {
            if (String(p.tokenId) !== String(market.tokenId)) return false;
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
                   (settlement_id, condition_id, position_id, token_id, family_id,
                    resolution, settlement_price, size, delta, settled_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                settlementId,
                mr.conditionId,
                String(pos.positionId),
                String(market.tokenId),
                String(pos.familyId),
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

            if (pos.familyId) affectedFamilies.add(pos.familyId);

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

      // Recompute family state OUTSIDE transaction (reads, not writes)
      for (const fid of affectedFamilies) {
        this.deps.exposureCalculator.recompute(fid, false);
      }

      this.deps.log.info(
        { conditionId: mr.conditionId, resolution, families: affectedFamilies.size },
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
