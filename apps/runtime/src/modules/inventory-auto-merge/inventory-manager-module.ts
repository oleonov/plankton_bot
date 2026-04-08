import type {
  EventBus,
  ExchangeGateway,
  PositionRepository,
  OrderRepository,
  MarketRepository,
  InventoryLotRepository,
  Logger,
} from "@plankton/domain";
import type Database from "better-sqlite3";
import { MergeCandidateService } from "./merge-candidate-service.js";
import { MergeSettler } from "./merge-settler.js";

export interface InventoryManagerDeps {
  bus: EventBus;
  gateway: ExchangeGateway;
  positionRepo: PositionRepository;
  orderRepo: OrderRepository;
  marketRepo: MarketRepository;
  lotRepo: InventoryLotRepository;
  mergeLedgerRepo: MergeLedgerRepository;
  db: Database.Database;
  log: Logger;
  sweepIntervalMs?: number;
}

export class InventoryManagerModule {
  private readonly candidateService: MergeCandidateService;
  private readonly settler: MergeSettler;
  private interval: NodeJS.Timeout | null = null;
  private isSweeping = false;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: InventoryManagerDeps) {
    this.candidateService = new MergeCandidateService(
      deps.positionRepo,
      deps.orderRepo,
      deps.marketRepo,
    );
    this.settler = new MergeSettler(
      deps.positionRepo,
      deps.lotRepo,
      deps.mergeLedgerRepo,
      deps.db,
    );
  }

  public async start(): Promise<void> {
    const intervalMs = this.deps.sweepIntervalMs ?? 5 * 60 * 1000;
    this.interval = setInterval(() => this.sweep(), intervalMs);
    this.deps.log.info({ intervalMs }, "inventory manager started");

    // Debounced reactive hints
    this.deps.bus.subscribe("PositionUpdated", () => this.debouncedSweep());
    this.deps.bus.subscribe("FillReceived", (f) => {
      if (f.fill.side === "buy") this.debouncedSweep();
    });
  }

  public stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  private debouncedSweep(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.sweep(), 5000); // 5s debounce
  }

  public async sweep(): Promise<void> {
    if (this.isSweeping) return;
    this.isSweeping = true;

    try {
      const candidates = this.candidateService.findMergeCandidates();
      if (candidates.length === 0) return;

      this.deps.log.info({ count: candidates.length }, "found mergeable inventory candidates");

      // 1. Execute on-chain merges
      await this.deps.gateway.mergePositions(
        candidates.map((c) => ({
          conditionId: c.conditionId,
          amount: c.mergeAmount,
        })),
      );

      // 2. Apply to ledger
      for (const candidate of candidates) {
        try {
          this.settler.applyMerge(candidate);
          this.deps.log.info(
            {
              conditionId: candidate.conditionId,
              amount: candidate.mergeAmount,
              familyId: candidate.familyId,
            },
            "inventory merge applied to ledger",
          );

          // 3. Notify system of updated positions to trigger exposure recomputation
          // We can just publish PositionUpdated for both sides
          const yesPos = this.deps.positionRepo.findByTokenId(candidate.yesTokenId);
          const noPos = this.deps.positionRepo.findByTokenId(candidate.noTokenId);
          if (yesPos) await this.deps.bus.publish("PositionUpdated", { position: yesPos });
          if (noPos) await this.deps.bus.publish("PositionUpdated", { position: noPos });
        } catch (e) {
          this.deps.log.error(
            { conditionId: candidate.conditionId, err: String(e) },
            "failed to apply merge to ledger",
          );
        }
      }
    } catch (e) {
      this.deps.log.error({ err: String(e) }, "inventory manager sweep failed");
    } finally {
      this.isSweeping = false;
    }
  }
}
