/**
 * Dependency-health recorder — DI seam for measuring outbound gateway latency
 * without coupling `packages/exchange` to `apps/runtime`.
 *
 * The exchange gateways call `record(dep, latencyMs, ok)` on an injected
 * recorder; the runtime supplies the concrete implementation (an in-memory
 * accumulator flushed to `runtime_metrics`). The interface lives in the lowest
 * layer (`@krabs/domain`) so the dependency direction stays exchange → domain.
 *
 * Measure-only: a recorder must never alter the wrapped call's result or timing
 * in a way the caller can observe, and a `record` call must never throw.
 */

/** Closed set of measured dependencies — mirrors the Status screen's 4 tiles. */
export type DepKey = "clob" | "gamma" | "rpc" | "relayer";

export interface DepHealthRecorder {
  /** Record one observed call: round-trip latency (ms) and ok/fail outcome. */
  record(dep: DepKey, latencyMs: number, ok: boolean): void;
}
