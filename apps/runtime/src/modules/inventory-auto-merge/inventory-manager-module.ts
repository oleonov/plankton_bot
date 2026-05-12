import type {
  EventBus,
  ExchangeGateway,
  PositionRepository,
  OrderRepository,
  MarketRepository,
  InventoryLotRepository,
  MergeLedgerRepository,
  RuntimeControl,
  RuntimeModule,
} from "@krabs/domain";
import type Database from "better-sqlite3";
import type { Logger } from "../../logger.js";
import { MergeCandidateService } from "./merge-candidate-service.js";
import { MergeSettler } from "./merge-settler.js";

export interface InventoryManagerDeps {
  bus: EventBus;
  gateway: ExchangeGateway;
  positionRepo: PositionRepository;
  orderRepo: OrderRepository;
  marketRepo: MarketRepository;
  fillRepo: import("@krabs/domain").FillRepository;
  lotRepo: InventoryLotRepository;
  mergeLedgerRepo: MergeLedgerRepository;
  db: Database.Database;
  log: Logger;
  sweepIntervalMs?: number | null | undefined;
  /**
   * Optional pause gate. When the runtime is paused, periodic and
   * debounced merge sweeps are skipped so the bot does not submit on-chain
   * merges or write merge ledger rows.
   */
  runtimeControl?: RuntimeControl;
}

export class InventoryManagerModule implements RuntimeModule {
  private readonly candidateService: MergeCandidateService;
  private readonly settler: MergeSettler;
  private interval: NodeJS.Timeout | null = null;
  private isSweeping = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private unsubs: Array<() => void> = [];

  constructor(private readonly deps: InventoryManagerDeps) {
    this.candidateService = new MergeCandidateService(
      deps.positionRepo,
      deps.orderRepo,
      deps.marketRepo,
      deps.fillRepo,
    );
    this.settler = new MergeSettler(deps.positionRepo, deps.lotRepo, deps.mergeLedgerRepo, deps.db);
  }

  public async start(): Promise<void> {
    const intervalMs = this.deps.sweepIntervalMs ?? 5 * 60 * 1000;
    this.interval = setInterval(() => void this.sweep(), intervalMs);
    this.deps.log.info({ intervalMs }, "inventory manager started");

    // Debounced reactive hints
    this.unsubs.push(
      this.deps.bus.subscribe("PositionUpdated", async () => {
        this.debouncedSweep();
      }),
    );
    this.unsubs.push(
      this.deps.bus.subscribe("FillReceived", async (payload) => {
        if (payload.side === "buy") {
          this.debouncedSweep();
        }
      }),
    );
  }

  public async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  public async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return {
      ok: true,
      detail: `last_sweep_active=${this.isSweeping}`,
    };
  }

  private debouncedSweep(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.sweep(), 5000); // 5s debounce
  }

  public async sweep(): Promise<void> {
    if (this.isSweeping) return;
    if (this.deps.runtimeControl?.isPaused()) {
      this.deps.log.debug("inventory manager sweep skipped while runtime is paused");
      return;
    }
    this.isSweeping = true;

    try {
      const candidates = this.candidateService.findMergeCandidates();
      if (candidates.length === 0) return;
      if (this.deps.runtimeControl?.isPaused()) {
        this.deps.log.debug(
          { count: candidates.length },
          "inventory manager merge aborted after pause flip pre-on-chain",
        );
        return;
      }

      this.deps.log.info({ count: candidates.length }, "found mergeable inventory candidates");

      // 1. Execute on-chain merges. Once this resolves the merge is irrevocable,
      // so the ledger MUST follow to stay consistent with on-chain state —
      // skipping the ledger application after pause would leak inventory and
      // cause permanent drift. We pause-check before the on-chain write.
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
