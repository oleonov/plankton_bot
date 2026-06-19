import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadEnv } from "../env.js";

describe("speedup config vars", () => {
  const testEnvKeys = [
    "RUNTIME_MODE",
    "POLY_API_KEY",
    "POLY_API_SECRET",
    "POLY_PASSPHRASE",
    "POLY_PRIVATE_KEY",
    "STRATEGY_SCAN_INTERVAL_MS",
    "MARKET_SCAN_INTERVAL_MS",
    "MARKET_SCAN_HINT_MIN_INTERVAL_MS",
    "RECONCILIATION_INTERVAL_MS",
    "PLANNER_SUPPRESSION_ROLLUP_WINDOW_MS",
    "MARKET_DATA_DISCOVERY_POLL_INTERVAL_MS",
    "MARKET_DATA_DISCOVERY_BATCH_SIZE",
    "FILL_POLL_INTERVAL_MS",
    "EXECUTION_MAX_CONCURRENCY",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of testEnvKeys) {
      savedEnv[key] = process.env[key];
    }
    process.env.RUNTIME_MODE = "live-lite";
    process.env.POLY_API_KEY = "key";
    process.env.POLY_API_SECRET = "secret";
    process.env.POLY_PASSPHRASE = "pass";
    process.env.POLY_PRIVATE_KEY =
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    delete process.env.STRATEGY_SCAN_INTERVAL_MS;
    delete process.env.MARKET_SCAN_INTERVAL_MS;
    delete process.env.MARKET_SCAN_HINT_MIN_INTERVAL_MS;
    delete process.env.RECONCILIATION_INTERVAL_MS;
    delete process.env.PLANNER_SUPPRESSION_ROLLUP_WINDOW_MS;
    delete process.env.MARKET_DATA_DISCOVERY_POLL_INTERVAL_MS;
    delete process.env.MARKET_DATA_DISCOVERY_BATCH_SIZE;
    delete process.env.FILL_POLL_INTERVAL_MS;
    delete process.env.EXECUTION_MAX_CONCURRENCY;
  });

  afterEach(() => {
    for (const key of testEnvKeys) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
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

  it("defaults PLANNER_SUPPRESSION_ROLLUP_WINDOW_MS to five minutes", () => {
    const config = loadEnv();
    expect(config.plannerSuppressionRollupWindowMs).toBe(5 * 60 * 1000);
  });

  it("defaults FILL_POLL_INTERVAL_MS to 5000", () => {
    const config = loadEnv();
    expect(config.fillPollIntervalMs).toBe(5000);
  });

  it("defaults MARKET_DATA_POLL_INTERVAL_MS to 5000", () => {
    const config = loadEnv();
    expect(config.marketDataPollIntervalMs).toBe(5000);
  });

  it("defaults MARKET_DATA_DISCOVERY_POLL_INTERVAL_MS to 5 minutes", () => {
    const config = loadEnv();
    expect(config.marketDataDiscoveryPollIntervalMs).toBe(5 * 60 * 1000);
  });

  it("defaults MARKET_DATA_DISCOVERY_BATCH_SIZE to 50", () => {
    const config = loadEnv();
    expect(config.marketDataDiscoveryBatchSize).toBe(50);
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

  it("allows PLANNER_SUPPRESSION_ROLLUP_WINDOW_MS=0 for legacy write-through", () => {
    process.env.PLANNER_SUPPRESSION_ROLLUP_WINDOW_MS = "0";
    const config = loadEnv();
    expect(config.plannerSuppressionRollupWindowMs).toBe(0);
  });

  it("reads custom PLANNER_SUPPRESSION_ROLLUP_WINDOW_MS from env", () => {
    process.env.PLANNER_SUPPRESSION_ROLLUP_WINDOW_MS = "60000";
    const config = loadEnv();
    expect(config.plannerSuppressionRollupWindowMs).toBe(60_000);
  });

  it("reads custom EXECUTION_MAX_CONCURRENCY from env", () => {
    process.env.EXECUTION_MAX_CONCURRENCY = "8";
    const config = loadEnv();
    expect(config.executionMaxConcurrency).toBe(8);
  });
});
