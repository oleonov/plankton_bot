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
import type { ResolutionDetector, ResolutionCandidate } from "./resolution-detector.js";
import { inferResolution, parseTokenIds } from "./resolution-detector.js";
import type { PositionSettler } from "./position-settler.js";
import type { Logger } from "../../logger.js";

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
  private running = false;

  constructor(private readonly deps: ResolutionModuleDeps) {}

  async start(): Promise<void> {
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
  }

  /** Exposed for testing. */
  async runCheck(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      const resolutions = await this.deps.detector.detect(this.deps.graceMinutes);
      let totalSettled = 0;

      for (const resolution of resolutions) {
        // Check if this is a retry (resolution already exists as "detected")
        const isRetry = !!this.deps.resolutionRepo.findByConditionId(resolution.conditionId);

        // Persist resolution record (only on first detection; ON CONFLICT DO NOTHING)
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

        // On first pass: deactivate markets and cancel open orders.
        // On retry: skip — already done on first detection.
        if (!isRetry) {
          for (const candidate of resolution.candidates) {
            this.deps.marketRepo.deactivate(candidate.tokenId);
            await this.cancelOpenOrders(candidate.tokenId);
          }
        }

        // Skip settlement when resolution is unknown.
        // Detection + deactivation + order cancellation still happen above.
        // Status stays "detected" — needs manual review.
        if (resolution.resolution === "unknown") {
          this.deps.log.warn(
            { conditionId: resolution.conditionId, source: resolution.source },
            "resolution unknown — requires manual review",
          );

          if (!isRetry) {
            await this.deps.bus.publish("MarketResolved", {
              conditionId: resolution.conditionId,
              tokenIds: resolution.candidates.map((c) => c.tokenId),
              resolution: resolution.resolution,
              resolvedAt: resolution.resolvedAt,
              source: resolution.source,
              timestamp: Date.now(),
            });
          }
          continue;
        }

        // Filter candidates to only families with autoSettleResolvedMarkets enabled
        let eligibleCandidates = resolution.candidates.filter((c) => {
          const bundle = this.deps.rulesProvider.getRule(c.familyId);
          if (!bundle) return true; // unknown family → settle by default
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

        // If no candidates are eligible for settlement, mark as settled
        // (nothing to retry — autoSettle is disabled for all families).
        if (eligibleCandidates.length === 0) {
          this.deps.resolutionRepo.markSettled(resolution.conditionId);

          if (!isRetry) {
            await this.deps.bus.publish("MarketResolved", {
              conditionId: resolution.conditionId,
              tokenIds: resolution.candidates.map((c) => c.tokenId),
              resolution: resolution.resolution,
              resolvedAt: resolution.resolvedAt,
              source: resolution.source,
              timestamp: Date.now(),
            });
          }
          continue;
        }

        // Pre-settlement balance verification: when a gateway is provided,
        // check that each candidate's on-chain token balance is 0 (shares
        // already redeemed/sold) before allowing ledger settlement.
        const preFilterCount = eligibleCandidates.length;
        if (this.deps.gateway && eligibleCandidates.length > 0) {
          eligibleCandidates = await this.filterByZeroBalance(
            eligibleCandidates,
            resolution.conditionId,
          );
        }
        const allVerified = !this.deps.gateway || eligibleCandidates.length === preFilterCount;

        const settleable = { ...resolution, candidates: eligibleCandidates };

        // Settle positions
        const settled =
          settleable.candidates.length > 0 ? this.deps.settler.settle(settleable) : [];
        totalSettled += settled.length;

        // Mark settled when all candidates passed balance verification and were settled
        if (allVerified && settled.length === eligibleCandidates.length) {
          this.deps.resolutionRepo.markSettled(resolution.conditionId);
        }

        // Publish events (EventBus.publish is async — must await)
        if (!isRetry) {
          await this.deps.bus.publish("MarketResolved", {
            conditionId: resolution.conditionId,
            tokenIds: resolution.candidates.map((c) => c.tokenId),
            resolution: resolution.resolution,
            resolvedAt: resolution.resolvedAt,
            source: resolution.source,
            timestamp: Date.now(),
          });
        }

        for (const s of settled) {
          await this.deps.bus.publish("PositionSettled", s);
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

      // Recompute family state for affected families.
      // FamilyExposureChanged is an OUTPUT event — not a trigger.
      // We call the calculator directly.
      const affectedFamilies = new Set<FamilyId>(
        resolutions.flatMap((r) => r.candidates.map((c) => c.familyId)),
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
    }
  }

  /**
   * Filter candidates to only those with zero on-chain token balance.
   * This ensures we only settle positions whose shares have been fully
   * redeemed or sold, preventing premature ledger settlement.
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
      if (balance === 0) {
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

  /** Publish CancelOrderRequested for open/partially-filled/pending orders on a resolved token. */
  private async cancelOpenOrders(tokenId: TokenId): Promise<void> {
    const orders = this.deps.orderRepo.findByTokenId(tokenId);
    const active = orders.filter(
      (o) => o.status === "open" || o.status === "partially-filled" || o.status === "pending",
    );
    for (const order of active) {
      // Pending orders without an exchange-assigned ID cannot be cancelled
      // on the exchange — just deactivate them locally.
      if (order.status === "pending" && !order.exchangeOrderId) {
        this.deps.orderRepo.updateStatus(order.orderId, "cancelled");
        this.deps.log.info(
          { orderId: String(order.orderId), tokenId: String(tokenId) },
          "locally cancelled pending order without exchange ID on resolved market",
        );
        continue;
      }
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
      const winnerTokenId =
        inferred.winnerIndex >= 0 && clobTokenIds[inferred.winnerIndex]
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
              : market.outcome === resolution;
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

            affectedFamilies.add(pos.familyId);

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
