/**
 * StalePruningModule — prunes cheap stale positions past maxTailHoldHours.
 *
 * Polling loop (default 10 min):
 *  1. For each family with staleTailPruneEnabled and maxTailHoldHours set
 *  2. Find open positions older than maxTailHoldHours
 *  3. Filter to cheap tail positions (avgEntryPrice < minEntryPrice)
 *  4. Publish SignalProduced with reason "stale-prune" and side "sell"
 */

import type {
  EventBus,
  RuntimeModule,
  PositionRepository,
  MarketRepository,
  FamilyRulesProvider,
  Signal,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";

export interface StalePruningModuleDeps {
  positionRepo: PositionRepository;
  marketRepo: MarketRepository;
  rulesProvider: FamilyRulesProvider;
  bus: EventBus;
  log: Logger;
  checkIntervalMs: number;
}

let pruneSignalCounter = 0;
function nextPruneSignalId(): string {
  return `prune-${Date.now()}-${++pruneSignalCounter}`;
}

export class StalePruningModule implements RuntimeModule {
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: StalePruningModuleDeps) {}

  async start(): Promise<void> {
    // No startup fire-and-forget: stale positions are 69+ hours old, waiting
    // for the first interval tick avoids racing the execution pipeline.
    this.intervalHandle = setInterval(() => {
      this.runCheck().catch((err) =>
        this.deps.log.error(err, "stale-prune check failed"),
      );
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
      const families = this.deps.rulesProvider.getAllFamilies();
      let pruned = 0;

      for (const family of families) {
        const bundle = this.deps.rulesProvider.getRule(family.familyId);
        if (!bundle) continue;

        const { tailSuppression, exit, entry } = bundle.rules;
        if (!tailSuppression.staleTailPruneEnabled || exit.maxTailHoldHours == null) continue;

        const maxAgeMs = exit.maxTailHoldHours * 60 * 60 * 1000;
        const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

        const positions = this.deps.positionRepo.findByFamily(family.familyId);
        const stale = positions.filter((p) => {
          if (p.status !== "open" && p.status !== "dust") return false;
          if (p.openedAt >= cutoff) return false;
          if (p.avgEntryPrice >= entry.minEntryPrice) return false;
          // Skip positions on inactive/resolved markets — resolution handles those
          const market = this.deps.marketRepo.findByTokenId(p.tokenId);
          if (market && !market.active) return false;
          return true;
        });

        for (const pos of stale) {
          const signal: Signal = {
            signalId: nextPruneSignalId(),
            familyId: pos.familyId,
            tokenId: pos.tokenId,
            side: "sell",
            suggestedPrice: pos.avgEntryPrice,
            suggestedSize: pos.size,
            suggestedSizeUsdc: pos.size * pos.avgEntryPrice,
            reason: "stale-prune",
            strategyTick: Date.now(),
            sequenceInTick: 0,
            generatedAt: new Date().toISOString(),
          };

          await this.deps.bus.publish("SignalProduced", { signal });
          pruned++;

          this.deps.log.info(
            { positionId: String(pos.positionId), familyId: String(pos.familyId), ageHours: exit.maxTailHoldHours },
            "stale-prune signal emitted",
          );
        }
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
