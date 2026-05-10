import { describe, it, expect, beforeEach } from "vitest";
import { loadEnv } from "../env.js";

describe("speedup config vars", () => {
  beforeEach(() => {
    process.env.RUNTIME_MODE = "simulation";
    delete process.env.STRATEGY_SCAN_INTERVAL_MS;
    delete process.env.MARKET_SCAN_INTERVAL_MS;
    delete process.env.MARKET_SCAN_HINT_MIN_INTERVAL_MS;
    delete process.env.RECONCILIATION_INTERVAL_MS;
    delete process.env.FILL_POLL_INTERVAL_MS;
    delete process.env.EXECUTION_MAX_CONCURRENCY;
  });

  it("defaults STRATEGY_SCAN_INTERVAL_MS to 12000", () => {
    const config = loadEnv();
    expect(config.strategyScanIntervalMs).toBe(12000);
  });

  it("defaults MARKET_SCAN_INTERVAL_MS to 15 minutes", () => {
    const config = loadEnv();
    expect(config.marketScanIntervalMs).toBe(15 * 60 * 1000);
  });

  it("defaults MARKET_SCAN_HINT_MIN_INTERVAL_MS to 15 minutes", () => {
    const config = loadEnv();
    expect(config.marketScanHintMinIntervalMs).toBe(15 * 60 * 1000);
  });

  it("defaults RECONCILIATION_INTERVAL_MS to 15000", () => {
    const config = loadEnv();
    expect(config.reconciliationIntervalMs).toBe(15000);
  });

  it("defaults FILL_POLL_INTERVAL_MS to 5000", () => {
    const config = loadEnv();
    expect(config.fillPollIntervalMs).toBe(5000);
  });

  it("defaults MARKET_DATA_POLL_INTERVAL_MS to 5000", () => {
    const config = loadEnv();
    expect(config.marketDataPollIntervalMs).toBe(5000);
  });

  it("defaults EXECUTION_MAX_CONCURRENCY to 16", () => {
    const config = loadEnv();
    expect(config.executionMaxConcurrency).toBe(16);
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
