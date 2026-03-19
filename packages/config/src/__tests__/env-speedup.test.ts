import { describe, it, expect, beforeEach } from "vitest";
import { loadEnv } from "../env.js";

describe("speedup config vars", () => {
  beforeEach(() => {
    process.env.RUNTIME_MODE = "simulation";
    delete process.env.STRATEGY_SCAN_INTERVAL_MS;
    delete process.env.FILL_POLL_INTERVAL_MS;
    delete process.env.EXECUTION_MAX_CONCURRENCY;
  });

  it("defaults STRATEGY_SCAN_INTERVAL_MS to 5000", () => {
    const config = loadEnv();
    expect(config.strategyScanIntervalMs).toBe(5000);
  });

  it("defaults FILL_POLL_INTERVAL_MS to 5000", () => {
    const config = loadEnv();
    expect(config.fillPollIntervalMs).toBe(5000);
  });

  it("defaults MARKET_DATA_POLL_INTERVAL_MS to 5000", () => {
    const config = loadEnv();
    expect(config.marketDataPollIntervalMs).toBe(5000);
  });

  it("defaults EXECUTION_MAX_CONCURRENCY to 4", () => {
    const config = loadEnv();
    expect(config.executionMaxConcurrency).toBe(4);
  });

  it("reads custom STRATEGY_SCAN_INTERVAL_MS from env", () => {
    process.env.STRATEGY_SCAN_INTERVAL_MS = "10000";
    const config = loadEnv();
    expect(config.strategyScanIntervalMs).toBe(10000);
  });

  it("reads custom EXECUTION_MAX_CONCURRENCY from env", () => {
    process.env.EXECUTION_MAX_CONCURRENCY = "8";
    const config = loadEnv();
    expect(config.executionMaxConcurrency).toBe(8);
  });
});
