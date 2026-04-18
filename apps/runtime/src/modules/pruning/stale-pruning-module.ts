/**
 * StalePruningModule — prunes stale cheap positions past maxTailHoldMs.
 *
 * Polling loop (default 10 min):
 *  1. Scan all open/dust positions older than maxTailHoldMs
 *  2. Dust positions are pruned by age alone; open positions require cheap entry price
 *  3. Publish SignalProduced with reason "stale-prune" and side "sell"
 *
 * Phase 6: family-based iteration removed. Pruning config comes from
 * constructor deps rather than family rule bundles.
 */

import type {
  EventBus,
  RuntimeModule,
  PositionRepository,
  MarketRepository,
  Signal,
  ConditionId,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";

export interface StalePruningModuleDeps {
  positionRepo: PositionRepository;
  marketRepo: MarketRepository;
  bus: EventBus;
  log: Logger;
  checkIntervalMs: number;
  /** Positions older than this will be considered stale (default: 69h). */
  maxTailHoldMs?: number;
  /** Only open positions with avgEntryPrice below this are prunable (default: 0.15). */
  maxPrunableEntryPrice?: number;
}

const DEFAULT_MAX_TAIL_HOLD_MS = 69 * 60 * 60 * 1000; // 69h
const DEFAULT_MAX_PRUNABLE_ENTRY_PRICE = 0.15;

let pruneSignalCounter = 0;
function nextPruneSignalId(): string {
  return `prune-${Date.now()}-${++pruneSignalCounter}`;
}

export class StalePruningModule implements RuntimeModule {
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;
  private readonly maxTailHoldMs: number;
  private readonly maxPrunableEntryPrice: number;

  constructor(private readonly deps: StalePruningModuleDeps) {
    this.maxTailHoldMs = deps.maxTailHoldMs ?? DEFAULT_MAX_TAIL_HOLD_MS;
    this.maxPrunableEntryPrice = deps.maxPrunableEntryPrice ?? DEFAULT_MAX_PRUNABLE_ENTRY_PRICE;
  }

  async start(): Promise<void> {
    // No startup fire-and-forget: stale positions are 69+ hours old, waiting
    // for the first interval tick avoids racing the execution pipeline.
    this.intervalHandle = setInterval(() => {
      this.runCheck().catch((err) => this.deps.log.error(err, "stale-prune check failed"));
    }, this.deps.checkIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async runCheck(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      const cutoff = new Date(Date.now() - this.maxTailHoldMs).toISOString();
      const allPositions = this.deps.positionRepo.findAll();
      let pruned = 0;

      const stale = allPositions.filter((p) => {
        if (p.status !== "open" && p.status !== "dust") return false;
        if (p.openedAt >= cutoff) return false;
        // Dust positions are pruned by age alone (recycling dust cleanup).
        // Open positions still require cheap entry price (original stale-tail logic).
        if (p.status !== "dust" && p.avgEntryPrice >= this.maxPrunableEntryPrice) return false;
        // Skip positions on inactive/resolved markets — resolution handles those
        const market = this.deps.marketRepo.findByTokenId(p.tokenId);
        if (market && !market.active) return false;
        return true;
      });

      for (const pos of stale) {
        const market = this.deps.marketRepo.findByTokenId(pos.tokenId);
        if (!market?.conditionId) {
          this.deps.log.warn(
            { tokenId: pos.tokenId, positionId: pos.positionId },
            "stale-prune skipped — no conditionId from market",
          );
          continue;
        }

        const signal: Signal = {
          signalId: nextPruneSignalId(),
          tokenId: pos.tokenId,
          conditionId: market.conditionId as ConditionId,
          side: "sell",
          suggestedPrice: pos.avgEntryPrice,
          suggestedSize: pos.size,
          suggestedSizeUsdc: pos.size * pos.avgEntryPrice,
          reason: "stale-prune",
          strategyTick: Date.now(),
          sequenceInTick: 0,
          decisionRuleId: null,
          generatedAt: new Date().toISOString(),
        };

        await this.deps.bus.publish("SignalProduced", { signal });
        pruned++;

        this.deps.log.info(
          {
            positionId: String(pos.positionId),
            maxTailHoldMs: this.maxTailHoldMs,
          },
          "stale-prune signal emitted",
        );
      }

      if (pruned > 0) {
        this.deps.log.info({ pruned }, "stale-prune scan complete");
      }

      return pruned;
    } finally {
      this.running = false;
    }
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: true,
      detail: `interval=${this.deps.checkIntervalMs}ms`,
    };
  }
}
