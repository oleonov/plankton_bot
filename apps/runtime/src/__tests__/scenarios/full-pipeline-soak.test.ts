/**
 * Full-pipeline soak — drives the real Supervisor stack (MarketData →
 * Normalization → LegStateTracker → AlgoDecision → RiskInventory → Execution
 * → Reconciliation) through `runScenario`, measures per-tick wall-clock
 * latency, and reports p50/p95/p99.
 *
 * Differs from `throughput-soak.test.ts` (scratch bench that only measures
 * raw bus + SQLite INSERT throughput): this one exercises every runtime
 * module against a simulation gateway, so regressions in normalization,
 * signal evaluation, execution, or reconciliation will surface here.
 *
 * ─── What this test actually does ────────────────────────────────────────
 *
 * Two modes, selectable via env:
 *
 *   (A) BURST mode (default). Runs `SOAK_TICKS` iterations back-to-back
 *       with no delay between ticks. Catches *throughput* regressions —
 *       latency spikes, O(n²) drift, supervisor stop/start bugs. Does NOT
 *       catch wall-clock-bounded failure modes (memory drift, interval-
 *       timer bugs, slow handle leaks) because the timers inside each
 *       module are all pollIntervalMs=60_000 and never fire during the
 *       burst. This is the CI mode.
 *
 *   (B) WALL-CLOCK mode. Set either `SOAK_DURATION_MS` (the loop exits
 *       once wall-clock elapsed ≥ that value) or `SOAK_TICK_DELAY_MS`
 *       (sleep between ticks). Combine with a large `SOAK_TICKS` cap.
 *       Use this for a real soak: CommandPoller / ReconciliationModule
 *       interval timers will fire naturally, exercising the real runtime
 *       cadence.
 *
 * ─── Configuration ───────────────────────────────────────────────────────
 *
 *   SOAK_MARKETS          — distinct markets seeded (default 50)
 *   SOAK_TICKS            — max iterations (default 5; upper bound in
 *                           wall-clock mode)
 *   SOAK_DURATION_MS      — wall-clock cap (unset = no cap, pure burst)
 *   SOAK_TICK_DELAY_MS    — sleep between ticks (unset = 0, burst)
 *
 * ─── Recipes ─────────────────────────────────────────────────────────────
 *
 *   CI default (fast regression guard):
 *     npx vitest run src/__tests__/scenarios/full-pipeline-soak.test.ts
 *
 *   Burst stress (what the pipeline can push without throttling):
 *     SOAK_MARKETS=200 SOAK_TICKS=60 \
 *       npx vitest run src/__tests__/scenarios/full-pipeline-soak.test.ts
 *
 *   Real 30-minute wall-clock soak (production cadence — actually sleeps
 *   60s between ticks, so 30 ticks = ~30 min real time; this exercises
 *   interval-timer modules that are dormant in burst mode):
 *     SOAK_MARKETS=200 SOAK_TICKS=1000 \
 *       SOAK_DURATION_MS=1800000 SOAK_TICK_DELAY_MS=60000 \
 *       npx vitest run src/__tests__/scenarios/full-pipeline-soak.test.ts
 *
 * Assertions are lenient — they only catch catastrophic regressions (p99
 * > 10s per tick or avg > 5s per tick). Real performance tuning should
 * read the reported metrics, not chase the thresholds.
 */

import { describe, it, expect } from "vitest";
import { createTokenId } from "@krabs/domain";
import { runScenario } from "../../scenario/runner.js";
import {
  makeMarket,
  makeMarketFixture,
  resetFixtureCounters,
} from "../../scenario/fixture-helpers.js";
import type { MarketFixture } from "../../scenario/types.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const SOAK_MARKETS = Number(process.env["SOAK_MARKETS"] ?? 50);
const SOAK_TICKS = Number(process.env["SOAK_TICKS"] ?? 5);
const SOAK_DURATION_MS =
  process.env["SOAK_DURATION_MS"] != null ? Number(process.env["SOAK_DURATION_MS"]) : undefined;
const SOAK_TICK_DELAY_MS = Number(process.env["SOAK_TICK_DELAY_MS"] ?? 0);

const WALL_CLOCK_MODE = SOAK_DURATION_MS != null || SOAK_TICK_DELAY_MS > 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function buildMarketFixtures(count: number): MarketFixture[] {
  resetFixtureCounters();
  const fixtures: MarketFixture[] = [];
  for (let i = 0; i < count; i++) {
    // Spread bid/ask across the 0.30–0.70 range so different markets exercise
    // different entry-rule code paths in AlgoDecisionModule.
    const yesBid = +(0.3 + (i % 40) * 0.01).toFixed(2);
    const yesAsk = +(yesBid + 0.01).toFixed(2);
    const market = makeMarket({ slug: `soak-market-${i}` });
    fixtures.push(makeMarketFixture(market, yesBid, yesAsk));
  }
  return fixtures;
}

// ─── Test ─────────────────────────────────────────────────────────────────────

describe("full-pipeline soak (Supervisor + all modules)", () => {
  const modeLabel = WALL_CLOCK_MODE
    ? `wall-clock (duration=${SOAK_DURATION_MS ?? "unset"}ms, delay=${SOAK_TICK_DELAY_MS}ms)`
    : "burst";

  it(
    `${SOAK_MARKETS} markets × up-to-${SOAK_TICKS} ticks [${modeLabel}] — p99 < 10s, no crash`,
    async () => {
      const marketSnapshots = buildMarketFixtures(SOAK_MARKETS);
      const tickDurations: number[] = [];

      const runStart = performance.now();

      const result = await runScenario({
        name: "full-pipeline-soak",
        description: `${SOAK_MARKETS} markets [${modeLabel}]`,
        marketSnapshots,
        ticks: SOAK_TICKS,
        ...(SOAK_DURATION_MS != null ? { maxDurationMs: SOAK_DURATION_MS } : {}),
        tickDelayMs: SOAK_TICK_DELAY_MS,
        // Pre-warm the gateway with ALL markets + books so every tick processes
        // the full fleet, not just one market at a time. The runner's per-tick
        // `addMarket`/`setOrderBook` calls then just refresh (no-op effectively).
        setup: async ({ marketDataGateway }) => {
          for (const snap of marketSnapshots) {
            marketDataGateway.addMarket(snap.market);
            for (const [tokenIdStr, book] of Object.entries(snap.orderBooks)) {
              marketDataGateway.setOrderBook(createTokenId(tokenIdStr), book.bids, book.asks);
            }
          }
        },
        onTick: (_tick, dur) => tickDurations.push(dur),
      });

      const runEndMs = performance.now() - runStart;
      const ticksExecuted = tickDurations.length;

      // Tick 0 is a cold-start outlier: fresh market cache, every signal a
      // first-time evaluation, every order a first-time write. We keep the
      // raw number in the log line but report percentiles over the
      // steady-state ticks only (tick ≥ 1) so the metrics track regressions
      // rather than warm-up noise.
      const [tick0 = 0, ...steady] = tickDurations;
      const sortedSteady = [...steady].sort((a, b) => a - b);
      const p50 = percentile(sortedSteady, 50);
      const p95 = percentile(sortedSteady, 95);
      const p99 = percentile(sortedSteady, 99);
      const avgSteadyMs =
        sortedSteady.length > 0 ? sortedSteady.reduce((a, b) => a + b, 0) / sortedSteady.length : 0;
      const ticksPerSec = ticksExecuted / (runEndMs / 1000);

      console.info(
        `[full-pipeline-soak] mode=${modeLabel} markets=${SOAK_MARKETS} ` +
          `ticksExecuted=${ticksExecuted}/${SOAK_TICKS} ` +
          `total=${runEndMs.toFixed(0)}ms ticks/sec=${ticksPerSec.toFixed(2)} ` +
          `tick0=${tick0.toFixed(1)}ms ` +
          `steady{avg=${avgSteadyMs.toFixed(1)}ms p50=${p50.toFixed(1)}ms ` +
          `p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms} | ` +
          `signals=${result.signalCount} approved=${result.approvedCount} ` +
          `rejected=${result.rejectedCount} ` +
          `placeRequested=${result.placeOrderRequestedCount} ` +
          `placed=${result.placedOrderCount} fills=${result.fillCount} ` +
          `openPositions=${result.openPositionCount} ` +
          `dustPositions=${result.dustPositionCount} ` +
          `realizedPnl=${result.totalRealizedPnl.toFixed(4)}`,
      );

      // ── Assertions: catastrophic-regression guardrails only. ─────────────
      //
      // finalPhase proves the supervisor shut down cleanly (no module crash).
      // The steady-state latency thresholds are deliberately lenient — CI
      // machines are noisy. If the real numbers drift badly, the console.info
      // above surfaces it for human review.
      expect(result.finalPhase).toBe("STOPPED");
      expect(ticksExecuted).toBeGreaterThanOrEqual(1);
      if (sortedSteady.length > 0) {
        expect(p99).toBeLessThan(10_000);
        expect(avgSteadyMs).toBeLessThan(5_000);
      }
    },
    // Test timeout: generous for 30 min wall-clock + warm-up overhead.
    35 * 60 * 1000,
  );
});
