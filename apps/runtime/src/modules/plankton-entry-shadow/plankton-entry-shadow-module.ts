import { Worker } from "node:worker_threads";
import type { EventBus, RuntimeEventMap, RuntimeModule, TokenId } from "@krabs/domain";
import type { Logger } from "../../logger.js";
import type { ShadowObservation, ShadowTarget } from "./plankton-entry-shadow-worker.js";

const PLANKTON_WALLET = "0x4ffe49ba2a4cae123536a8af4fda48faeb609f71";
const POLL_MS = 60_000;
const RETENTION_MS = 14 * 24 * 60 * 60_000;
const STOP_TIMEOUT_MS = 2_000;
const RESTART_BACKOFF_MS = 1_000;

type WorkerPort = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (value: unknown) => void): unknown;
  on(event: "error", listener: (value: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
};

export type AlgoShadowOutcome =
  | "paused"
  | "overlap"
  | "not_selected"
  | "market_cache_missing"
  | "unchanged_position"
  | "active_market_cap"
  | "rejection_cooldown"
  | "preplanner_error"
  | "planner_result";

export interface PlanktonEntryShadowDeps {
  bus: EventBus;
  dbPath: string;
  log: Logger;
  scanIntervalMs: number;
  marketDataPollIntervalMs: number;
  strategyScanIntervalMs: number;
  workerFactory?: (() => WorkerPort) | undefined;
}

export class PlanktonEntryShadowModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly targets = new Map<string, ShadowTarget>();
  private readonly targetKeysByToken = new Map<string, Set<string>>();
  private readonly trackedStateByTarget = new Map<string, boolean>();
  private trackedTokenIds = new Set<string>();
  private trackedSnapshotAt: number | null = null;
  private readonly unsubs: Array<() => void> = [];
  private worker: WorkerPort | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private resolveStopped: (() => void) | null = null;
  private stopping = false;
  private source = "starting";
  private cursor: number | null = null;

  constructor(private readonly deps: PlanktonEntryShadowDeps) {
    this.log = deps.log.child({ module: "plankton-entry-shadow" });
  }
  async start(): Promise<void> {
    if (this.unsubs.length > 0) return;
    this.stopping = false;
    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", async (event) => this.onNormalized(event)),
      this.deps.bus.subscribe("SignalProduced", async (event) => this.onSignal(event)),
    );
    this.startWorker();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    for (const unsub of this.unsubs.splice(0)) unsub();
    const worker = this.worker;
    this.targets.clear();
    this.targetKeysByToken.clear();
    this.trackedStateByTarget.clear();
    this.trackedTokenIds.clear();
    this.trackedSnapshotAt = null;
    if (!worker) return;
    const stoppedAck = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
      this.resolveStopped = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    try {
      worker.postMessage({ type: "shutdown" });
    } catch {
      this.worker = null;
      await worker.terminate();
      return;
    }
    await stoppedAck;
    this.resolveStopped = null;
    if (this.worker === worker) this.worker = null;
    await worker.terminate();
  }
  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: true,
      detail: `source=${this.source} targets=${this.targets.size} cursor=${this.cursor ?? "none"}`,
    };
  }
  isTarget(tokenId: string): boolean {
    return (this.targetKeysByToken.get(String(tokenId))?.size ?? 0) > 0;
  }

  scanStarted(scanId: string, observedAt: number): void {
    this.post({ type: "scan_started", scanId, observedAt });
  }
  scannerEvaluation(scanId: string, facts: Record<string, unknown>): void {
    const targets = this.exactTargets(facts["tokenId"], {
      conditionId: facts["conditionId"],
      outcome: facts["outcome"],
      outcomeIndex: facts["outcomeIndex"],
    });
    for (const target of targets)
      this.post({
        type: "scan_evaluation",
        scanId,
        observation: {
          ...target,
          stage: "scanner",
          result: String(facts["finalStatus"] ?? "unknown").toLowerCase(),
          observedAt: Number(facts["observedAt"]),
          payload: { ...facts, observedAt: null },
        } satisfies ShadowObservation,
      });
  }
  scanCompleted(scanId: string, observedAt: number): void {
    this.post({ type: "scan_completed", scanId, observedAt });
  }

  scanFailed(scanId: string, observedAt: number): void {
    this.post({ type: "scan_failed", scanId, observedAt });
  }
  observeAlgo(
    tokenId: TokenId,
    outcome: AlgoShadowOutcome,
    payload: Record<string, unknown>,
  ): void {
    const result =
      outcome === "planner_result" && payload["type"] === "signal" && payload["side"] === "buy"
        ? "planner_buy"
        : outcome;
    for (const target of this.exactTargets(tokenId))
      this.observe({ ...target, stage: "algo", result, observedAt: Date.now(), payload });
  }
  observeTrackedMarkets(activeTokenIds: readonly string[], observedAt: number): void {
    this.trackedTokenIds = new Set(activeTokenIds.map(String));
    this.trackedSnapshotAt = observedAt;
    for (const target of this.targets.values()) this.observeTrackedState(target, observedAt);
  }
  private startWorker(): void {
    if (this.worker || this.stopping) return;
    let worker: WorkerPort;
    try {
      worker =
        this.deps.workerFactory?.() ??
        new Worker(new URL("./plankton-entry-shadow-worker.js", import.meta.url), {
          workerData: {
            dbPath: this.deps.dbPath,
            wallet: PLANKTON_WALLET,
            pollMs: POLL_MS,
            retentionMs: RETENTION_MS,
            timeouts: {
              scannerMs: this.deps.scanIntervalMs,
              trackingMs: this.deps.marketDataPollIntervalMs,
              algoMs: this.deps.strategyScanIntervalMs,
            },
          },
        });
    } catch (error) {
      this.scheduleWorkerRestart("worker_start_failed", error);
      return;
    }
    this.worker = worker;
    this.source = "starting";
    worker.on("message", (message) => {
      if (this.worker === worker) this.onWorkerMessage(message);
    });
    worker.on("error", (error) => this.handleWorkerFailure(worker, "worker_error", error));
    worker.on("exit", (code) => this.handleWorkerFailure(worker, `worker_exit_${code}`));
  }
  private handleWorkerFailure(worker: WorkerPort, source: string, error?: unknown): void {
    if (this.stopping || this.worker !== worker) return;
    this.worker = null;
    this.scheduleWorkerRestart(source, error);
  }
  private scheduleWorkerRestart(source: string, error?: unknown): void {
    this.source = source;
    if (this.stopping || this.restartTimer) return;
    this.log.warn({ err: error }, "plankton entry shadow worker restarting; trading unaffected");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startWorker();
    }, RESTART_BACKOFF_MS);
  }
  private onWorkerMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    if (value["type"] === "ready" && Array.isArray(value["targets"])) {
      this.targets.clear();
      this.targetKeysByToken.clear();
      this.trackedStateByTarget.clear();
      for (const target of value["targets"] as ShadowTarget[]) this.setTarget(target);
    } else if (value["type"] === "target_added") {
      const target = value["target"] as ShadowTarget;
      if (target?.tokenId) this.setTarget(target);
    } else if (value["type"] === "health") {
      this.source = String(value["source"] ?? "unknown");
      this.cursor = typeof value["cursor"] === "number" ? value["cursor"] : null;
    } else if (value["type"] === "target_closed") {
      this.removeTarget(value["target"] as ShadowTarget);
    } else if (value["type"] === "stopped") this.resolveStopped?.();
  }
  private onNormalized(event: RuntimeEventMap["NormalizedMarketUpdated"]): void {
    for (const market of event.markets) {
      for (const target of this.exactTargets(market.tokenId, market)) {
        this.observe({
          ...target,
          stage: "normalized",
          result: market.active ? "active" : "inactive",
          observedAt: event.timestamp,
          payload: {},
        });
      }
    }
  }
  private onSignal(event: RuntimeEventMap["SignalProduced"]): void {
    const { signal, market } = event;
    const observedAt = Date.parse(signal.generatedAt);
    if (
      String(market.tokenId) !== String(signal.tokenId) ||
      String(market.conditionId) !== String(signal.conditionId) ||
      !market.outcome ||
      !Number.isInteger(market.outcomeIndex) ||
      !Number.isFinite(observedAt)
    )
      return;
    const payload = {
      tokenId: String(signal.tokenId),
      conditionId: String(signal.conditionId),
      outcome: market.outcome,
      outcomeIndex: market.outcomeIndex,
      side: signal.side,
      signalId: signal.signalId,
      rule: signal.decisionRuleId,
      generatedAt: signal.generatedAt,
      suggestedPrice: signal.suggestedPrice,
      suggestedSize: signal.suggestedSize,
      suggestedSizeUsdc: signal.suggestedSizeUsdc,
    };
    for (const target of this.exactTargets(signal.tokenId, market)) {
      this.observe({
        ...target,
        stage: "signal",
        result: signal.side === "buy" ? "produced_buy" : "produced_sell",
        observedAt,
        payload,
      });
    }
  }
  private exactTargets(
    tokenId: unknown,
    identity?: { conditionId: unknown; outcome: unknown; outcomeIndex?: unknown },
  ): ShadowTarget[] {
    if (typeof tokenId !== "string") return [];
    const keys = this.targetKeysByToken.get(tokenId);
    if (!keys) return [];
    if (!identity) return [...keys].map((key) => this.targets.get(key)!);
    if (
      typeof identity.conditionId !== "string" ||
      typeof identity.outcome !== "string" ||
      !Number.isInteger(identity.outcomeIndex)
    )
      return [];
    return [...keys]
      .map((key) => this.targets.get(key)!)
      .filter(
        (target) =>
          identity.conditionId === target.conditionId &&
          identity.outcome === target.outcome &&
          Number(identity.outcomeIndex) === target.outcomeIndex,
      );
  }
  private setTarget(target: ShadowTarget): void {
    const key = targetKey(target);
    if (this.targets.has(key)) return;
    this.targets.set(key, target);
    const keys = this.targetKeysByToken.get(target.tokenId) ?? new Set<string>();
    keys.add(key);
    this.targetKeysByToken.set(target.tokenId, keys);
    if (this.trackedSnapshotAt != null) this.observeTrackedState(target, this.trackedSnapshotAt);
  }
  private removeTarget(target: ShadowTarget): void {
    const key = targetKey(target);
    if (!this.targets.delete(key)) return;
    this.trackedStateByTarget.delete(key);
    const keys = this.targetKeysByToken.get(target.tokenId);
    keys?.delete(key);
    if (keys?.size === 0) this.targetKeysByToken.delete(target.tokenId);
  }
  private observeTrackedState(target: ShadowTarget, observedAt: number): void {
    if (observedAt < target.coverageStartedAt || observedAt >= target.coverageEndsAt) return;
    const key = targetKey(target);
    const tracked = this.trackedTokenIds.has(target.tokenId);
    if (this.trackedStateByTarget.get(key) === tracked) return;
    this.trackedStateByTarget.set(key, tracked);
    this.observe({
      ...target,
      stage: "tracking",
      result: tracked ? "tracked_snapshot" : "untracked_snapshot",
      observedAt,
      payload: {},
    });
  }
  private observe(observation: ShadowObservation): void {
    this.post({ type: "observation", ...observation });
  }

  private post(message: unknown): void {
    const worker = this.worker;
    try {
      worker?.postMessage(message);
    } catch (error) {
      this.source = "worker_post_failed";
      this.log.warn(
        { err: error },
        "plankton entry shadow observation dropped; trading unaffected",
      );
    }
  }
}

function targetKey(
  target: Pick<ShadowTarget, "conditionId" | "tokenId" | "outcomeIndex" | "generation">,
): string {
  return `${target.conditionId}\0${target.tokenId}\0${target.outcomeIndex}\0${target.generation}`;
}
