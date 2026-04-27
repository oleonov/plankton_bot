/**
 * Verifies buildTradeCountObserver wires DataApiTradeCountProvider events to
 * the runtime_metrics writer (success counter + error counter) and only
 * warn-logs on errors.
 *
 * Without `trade_count_fetch_ok` in the metrics ledger, operators can read
 * the absolute count of failures but cannot derive an error rate. The
 * observer must emit both counters so a SQL query
 *   SELECT count(*) FROM runtime_metrics
 *   WHERE metric_name IN ('trade_count_fetch_ok','trade_count_fetch_err')
 *   AND captured_at > ?
 * yields the denominator and numerator over any window.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createConditionId } from "@plankton/domain";
import type { TradeCountFetchEvent } from "@plankton/exchange";
import { buildTradeCountObserver } from "../trade-count-observer.js";

interface MetricCall {
  name: string;
  value: number;
  labels: string | null;
}

interface LogCall {
  level: "info" | "warn" | "error" | "debug";
  fields: Record<string, unknown>;
  msg: string;
}

function makeStubs(): {
  metrics: { writeEvent: (n: string, v?: number, l?: string | null) => void; calls: MetricCall[] };
  log: { warn: (f: Record<string, unknown>, m: string) => void; logs: LogCall[] };
} {
  const calls: MetricCall[] = [];
  const logs: LogCall[] = [];
  return {
    metrics: {
      writeEvent: (name: string, value = 1, labels: string | null = null) => {
        calls.push({ name, value, labels });
      },
      calls,
    },
    log: {
      warn: (fields: Record<string, unknown>, msg: string) => {
        logs.push({ level: "warn", fields, msg });
      },
      logs,
    },
  };
}

const COND = createConditionId("0x" + "ab".repeat(32));

describe("buildTradeCountObserver", () => {
  let stubs: ReturnType<typeof makeStubs>;

  beforeEach(() => {
    stubs = makeStubs();
  });

  it("emits trade_count_fetch_ok with latency on a successful fetch and does not log", () => {
    const observer = buildTradeCountObserver({
      log: stubs.log as unknown as Parameters<typeof buildTradeCountObserver>[0]["log"],
      metrics: stubs.metrics as unknown as Parameters<
        typeof buildTradeCountObserver
      >[0]["metrics"],
    });

    const event: TradeCountFetchEvent = {
      type: "fetch_ok",
      conditionId: COND,
      latencyMs: 42,
      count: 3,
    };
    observer(event);

    expect(stubs.metrics.calls).toHaveLength(1);
    expect(stubs.metrics.calls[0]).toEqual({
      name: "trade_count_fetch_ok",
      value: 1,
      labels: JSON.stringify({ latencyMs: 42 }),
    });
    expect(stubs.log.logs).toHaveLength(0);
  });

  it("emits trade_count_fetch_err with error+latency and warn-logs on failure", () => {
    const observer = buildTradeCountObserver({
      log: stubs.log as unknown as Parameters<typeof buildTradeCountObserver>[0]["log"],
      metrics: stubs.metrics as unknown as Parameters<
        typeof buildTradeCountObserver
      >[0]["metrics"],
    });

    observer({
      type: "fetch_error",
      conditionId: COND,
      latencyMs: 5_004,
      error: "TimeoutError",
    });

    expect(stubs.metrics.calls).toEqual([
      {
        name: "trade_count_fetch_err",
        value: 1,
        labels: JSON.stringify({ latencyMs: 5004, error: "TimeoutError" }),
      },
    ]);
    expect(stubs.log.logs).toHaveLength(1);
    expect(stubs.log.logs[0]?.msg).toBe("trade_count_fetch_error");
    expect(stubs.log.logs[0]?.fields).toMatchObject({
      conditionId: COND,
      error: "TimeoutError",
      latencyMs: 5_004,
    });
  });

  it("ignores cache_hit and cache_miss events", () => {
    const observer = buildTradeCountObserver({
      log: stubs.log as unknown as Parameters<typeof buildTradeCountObserver>[0]["log"],
      metrics: stubs.metrics as unknown as Parameters<
        typeof buildTradeCountObserver
      >[0]["metrics"],
    });

    observer({ type: "cache_hit", conditionId: COND, count: 5 });
    observer({ type: "cache_miss", conditionId: COND });

    expect(stubs.metrics.calls).toHaveLength(0);
    expect(stubs.log.logs).toHaveLength(0);
  });

  it("falls back to nulls when error event lacks latency or error string", () => {
    const observer = buildTradeCountObserver({
      log: stubs.log as unknown as Parameters<typeof buildTradeCountObserver>[0]["log"],
      metrics: stubs.metrics as unknown as Parameters<
        typeof buildTradeCountObserver
      >[0]["metrics"],
    });

    observer({ type: "fetch_error", conditionId: COND });

    expect(stubs.metrics.calls).toHaveLength(1);
    expect(stubs.metrics.calls[0]?.labels).toBe(
      JSON.stringify({ latencyMs: null, error: "unknown" }),
    );
  });

  it("does not propagate metrics.writeEvent throws — provider contract is null-on-error", () => {
    // Regression: DataApiTradeCountProvider#prefetch uses Promise.all, so any
    // throw from the observer rejects the whole sweep and breaks the
    // documented "errors collapse to null" contract on the hot path.
    const writeCalls: Array<{ name: string }> = [];
    const warnLogs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const throwingMetrics = {
      writeEvent: (name: string) => {
        writeCalls.push({ name });
        throw new Error("SQLITE_BUSY: database is locked");
      },
    };
    const capturingLog = {
      warn: (fields: Record<string, unknown>, msg: string) => {
        warnLogs.push({ fields, msg });
      },
    };

    const observer = buildTradeCountObserver({
      log: capturingLog as unknown as Parameters<typeof buildTradeCountObserver>[0]["log"],
      metrics: throwingMetrics as unknown as Parameters<
        typeof buildTradeCountObserver
      >[0]["metrics"],
    });

    expect(() =>
      observer({ type: "fetch_ok", conditionId: COND, latencyMs: 42, count: 3 }),
    ).not.toThrow();
    expect(() =>
      observer({ type: "fetch_error", conditionId: COND, latencyMs: 9, error: "TimeoutError" }),
    ).not.toThrow();

    expect(writeCalls.map((c) => c.name)).toEqual([
      "trade_count_fetch_ok",
      "trade_count_fetch_err",
    ]);
    expect(warnLogs.some((l) => l.msg === "trade_count_observer_metric_write_failed")).toBe(true);
  });

  it("survives a logger that throws on warn", () => {
    const calls: MetricCall[] = [];
    const throwingLog = {
      warn: () => {
        throw new Error("disk full");
      },
    };
    const capturingMetrics = {
      writeEvent: (name: string, value = 1, labels: string | null = null) => {
        calls.push({ name, value, labels });
      },
    };

    const observer = buildTradeCountObserver({
      log: throwingLog as unknown as Parameters<typeof buildTradeCountObserver>[0]["log"],
      metrics: capturingMetrics as unknown as Parameters<
        typeof buildTradeCountObserver
      >[0]["metrics"],
    });

    expect(() =>
      observer({ type: "fetch_error", conditionId: COND, latencyMs: 5, error: "X" }),
    ).not.toThrow();

    // Metric must still be written even if the warn-log throws first.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("trade_count_fetch_err");
  });
});
