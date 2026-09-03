import { cpus } from "node:os";
import { Worker } from "node:worker_threads";
import { isDeepStrictEqual } from "node:util";
import type { Logger } from "../../logger.js";
import {
  evaluateDecisionPlan,
  type DecisionPlanResult,
  type DecisionPlanningInput,
} from "./decision-planner.js";

type PendingRequest = {
  resolve: (results: DecisionPlanResult[]) => void;
  reject: (err: Error) => void;
  inputs: readonly DecisionPlanningInput[];
};

type DecisionEvaluation = {
  readonly inputIndex: number;
  readonly tokenId: DecisionPlanningInput["tokenId"];
  readonly result: DecisionPlanResult;
};

type DecisionWorkerState = {
  worker: Worker;
  inFlight: number;
  crashed: boolean;
};

export interface DecisionWorkerPoolOptions {
  readonly workerCount?: number;
  readonly batchSize?: number;
  readonly log: Logger;
}

export class DecisionWorkerPool {
  private readonly workerCount: number;
  private readonly batchSize: number;
  private readonly workers: DecisionWorkerState[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  private requestSeq = 0;
  private nextWorkerIdx = 0;
  private started = false;
  private workerDispatches = 0;
  private localFallbacks = 0;
  private workerCrashes = 0;

  constructor(private readonly opts: DecisionWorkerPoolOptions) {
    const defaultWorkers = Math.max(1, cpus().length - 1);
    this.workerCount =
      opts.workerCount === undefined ? defaultWorkers : Math.max(0, Math.floor(opts.workerCount));
    this.batchSize = Math.max(1, Math.floor(opts.batchSize ?? 100));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.workerCount; i++) this.spawnWorker();
  }

  async stop(): Promise<void> {
    const workers = this.workers.splice(0);
    this.started = false;
    await Promise.allSettled(workers.map((state) => state.worker.terminate()));
    for (const pending of this.pending.values()) {
      pending.reject(new Error("decision worker pool stopped"));
    }
    this.pending.clear();
  }

  getStats(): {
    workerCount: number;
    inFlight: number;
    workerDispatches: number;
    localFallbacks: number;
    workerCrashes: number;
  } {
    return {
      workerCount: this.workers.length,
      inFlight: [...this.workers].reduce((sum, worker) => sum + worker.inFlight, 0),
      workerDispatches: this.workerDispatches,
      localFallbacks: this.localFallbacks,
      workerCrashes: this.workerCrashes,
    };
  }

  async evaluate(inputs: readonly DecisionPlanningInput[]): Promise<DecisionPlanResult[]> {
    if (inputs.length === 0) return [];
    if (!this.started) this.start();
    if (this.workers.length === 0) {
      this.localFallbacks += inputs.length;
      return inputs.map(evaluateDecisionPlan);
    }
    const chunks = chunk(inputs, this.batchSize);
    const results = await Promise.all(chunks.map((batch) => this.dispatchBatch(batch)));
    return results.flat();
  }

  private dispatchBatch(inputs: readonly DecisionPlanningInput[]): Promise<DecisionPlanResult[]> {
    const worker = this.pickWorker();
    if (!worker) {
      this.localFallbacks += inputs.length;
      return Promise.resolve(inputs.map(evaluateDecisionPlan));
    }
    const requestId = ++this.requestSeq;
    worker.inFlight++;
    this.workerDispatches += inputs.length;
    return new Promise<DecisionPlanResult[]>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, inputs });
      worker.worker.postMessage({ requestId, inputs });
    });
  }

  private pickWorker(): DecisionWorkerState | null {
    const live = this.workers.filter((worker) => !worker.crashed);
    if (live.length === 0) return null;
    const worker = live[this.nextWorkerIdx % live.length]!;
    this.nextWorkerIdx++;
    return worker;
  }

  private spawnWorker(): void {
    const worker = new Worker(new URL("./decision-evaluation-worker.js", import.meta.url));
    const state: DecisionWorkerState = { worker, inFlight: 0, crashed: false };
    this.workers.push(state);

    worker.on("message", (message: unknown) => this.handleWorkerMessage(state, message));
    worker.on("error", (err) => {
      state.crashed = true;
      this.workerCrashes++;
      this.opts.log.error({ err }, "decision worker crashed");
      this.rejectWorkerRequests(err instanceof Error ? err : new Error(String(err)));
    });
    worker.on("exit", (code) => {
      if (!this.started || code === 0) return;
      state.crashed = true;
      this.workerCrashes++;
      this.opts.log.error({ code }, "decision worker exited unexpectedly");
      this.rejectWorkerRequests(new Error(`decision worker exited with code ${code}`));
      this.spawnWorker();
    });
  }

  private handleWorkerMessage(state: DecisionWorkerState, message: unknown): void {
    if (!message || typeof message !== "object") return;
    const typed = message as {
      requestId?: number;
      results?: unknown;
      error?: string;
    };
    if (typeof typed.requestId !== "number") return;
    const pending = this.pending.get(typed.requestId);
    if (!pending) return;
    this.pending.delete(typed.requestId);
    state.inFlight = Math.max(0, state.inFlight - 1);
    if (typed.error) {
      this.localFallbacks += pending.inputs.length;
      pending.resolve(pending.inputs.map(evaluateDecisionPlan));
      this.opts.log.warn({ err: typed.error }, "decision worker batch failed; used local fallback");
      return;
    }
    const evaluations = validateWorkerEvaluations(pending.inputs, typed.results);
    if (evaluations) {
      pending.resolve(evaluations.map(({ result }) => result));
      return;
    }
    this.localFallbacks += pending.inputs.length;
    pending.resolve(pending.inputs.map(evaluateDecisionPlan));
    this.opts.log.warn("decision worker returned mismatched identities; used local fallback");
  }

  private rejectWorkerRequests(err: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      this.localFallbacks += pending.inputs.length;
      pending.resolve(pending.inputs.map(evaluateDecisionPlan));
    }
    this.opts.log.warn({ err }, "decision worker requests recovered with local fallback");
  }
}

export function validateWorkerEvaluations(
  inputs: readonly DecisionPlanningInput[],
  value: unknown,
): DecisionEvaluation[] | null {
  try {
    if (!Array.isArray(value) || value.length !== inputs.length) return null;
    return value.every((item, index) => workerEvaluationMatches(item, inputs[index]!, index))
      ? (value as DecisionEvaluation[])
      : null;
  } catch {
    return null;
  }
}

function workerEvaluationMatches(
  item: unknown,
  input: DecisionPlanningInput,
  index: number,
): boolean {
  if (!isRecord(item) || item["inputIndex"] !== index) return false;
  const token = String(item["tokenId"] ?? "");
  if (token !== String(input.tokenId)) return false;
  const result = item["result"];
  if (!isRecord(result) || (result["type"] !== "none" && result["type"] !== "signal")) return false;
  if (!validMetrics(result["metrics"])) return false;
  const suppressions = result["suppressions"];
  const sideEffects = result["sideEffects"];
  if (!tokenRowsMatch(suppressions, token) || !tokenRowsMatch(sideEffects, token)) return false;
  if (result["type"] === "none" && suppressions.length === 0 && sideEffects.length === 0)
    return true;
  return isDeepStrictEqual(result, evaluateDecisionPlan(input));
}

const METRIC_KEYS = `evalTotal suppressedMarketNotLive dropTriggerChecked dropTriggerPassed
r23DipChecked r23DipFired r23NoHistory r23NoDip rejectNoDropSignal allowNoDropData
livenessNotAcceptingOrders livenessOrderBookDisabled livenessBothFlags`.split(/\s+/);

function validMetrics(value: unknown): boolean {
  if (!isRecord(value) || !METRIC_KEYS.every((key) => Number.isFinite(value[key]))) return false;
  const matches = value["wouldMatchRule"];
  return isRecord(matches) && Object.values(matches).every((count) => Number.isFinite(count));
}

function tokenRowsMatch(value: unknown, token: string): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) && value.every((row) => isRecord(row) && String(row["tokenId"]) === token)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
