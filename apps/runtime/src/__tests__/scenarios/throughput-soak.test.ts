/**
 * Throughput soak test — measures event-bus + SQLite write throughput under
 * steady synthetic load.
 *
 * Scope: performance regression detection only. No real pipeline modules are
 * started; synthetic FillReceived events drive the bus and a scratch SQLite
 * table records each write.
 *
 * Configuration:
 *   SOAK_DURATION_MS — how long to run (default 3000ms for CI)
 *
 * Assertions (lax — must pass comfortably under in-memory conditions):
 *   orders/sec ≥ 2
 *   p99 latency < 500ms
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  createTokenId,
  createConditionId,
  createOrderId,
  createFillId,
  OrderSide,
  LiquidityRole,
} from "@plankton/domain";
import type { ClientOrderId, FillReceived } from "@plankton/domain";

// ─── Config ───────────────────────────────────────────────────────────────────

const SOAK_DURATION_MS = Number(process.env["SOAK_DURATION_MS"] ?? 3000);
const TOKEN_COUNT = 200;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Compute a percentile (0–100) from a sorted array of numbers. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function seedTokenIds(): readonly ReturnType<typeof createTokenId>[] {
  return Array.from({ length: TOKEN_COUNT }, (_, i) =>
    createTokenId(`soak-token-${String(i).padStart(4, "0")}`),
  );
}

function buildFillEvent(
  tokenIdx: number,
  tokenIds: readonly ReturnType<typeof createTokenId>[],
  seq: number,
): FillReceived {
  const tokenId = tokenIds[tokenIdx % TOKEN_COUNT]!;
  return {
    type: "FillReceived",
    fillId: createFillId(`fill-soak-${seq}`),
    orderId: createOrderId(`ord-soak-${seq}`),
    clientOrderId: `cloid-soak-${seq}` as ClientOrderId,
    tokenId,
    conditionId: createConditionId(`cond-soak-${tokenIdx % TOKEN_COUNT}`),
    side: (seq % 2 === 0 ? "buy" : "sell") as OrderSide,
    price: 0.5 + (seq % 10) * 0.01,
    size: 10,
    sizeUsdc: 5,
    liquidityRole: "maker" as LiquidityRole,
    fee: 0.001,
    feeRateBps: 0,
    signalReason: null,
    timestamp: Date.now(),
  };
}

// ─── Test ─────────────────────────────────────────────────────────────────────

describe("throughput soak", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it(
    `sustains ≥2 orders/sec and p99 latency <500ms over ${SOAK_DURATION_MS}ms`,
    async () => {
      // ── Setup: in-memory-equivalent SQLite (temp file, WAL off for speed) ──
      tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-soak-"));
      const db = new Database(path.join(tmpDir, "soak.db"));
      db.pragma("journal_mode = MEMORY");
      db.pragma("synchronous = OFF");

      // Scratch table — no FK chain, fastest possible INSERT path.
      db.exec(`
        CREATE TABLE soak_writes (
          seq       INTEGER PRIMARY KEY,
          fill_id   TEXT NOT NULL,
          token_id  TEXT NOT NULL,
          price     REAL NOT NULL,
          written_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      const insertStmt = db.prepare(
        "INSERT INTO soak_writes (seq, fill_id, token_id, price) VALUES (?, ?, ?, ?)",
      );

      // ── Setup: event bus ─────────────────────────────────────────────────
      const bus = new InProcessEventBus();
      const latencySamples: number[] = [];
      let writeCount = 0;

      bus.subscribe("FillReceived", async (payload) => {
        const receiveAt = performance.now();
        insertStmt.run(writeCount, payload.fillId, payload.tokenId, payload.price);
        writeCount++;
        // Record the round-trip from the publishedAt mark embedded in tokenId
        // (we pass it via a side-channel array rather than mutating the event).
        // The latency is captured by the driver loop, not the subscriber.
        void receiveAt; // kept for future extension
      });

      // ── Drive loop ───────────────────────────────────────────────────────
      const tokenIds = seedTokenIds();
      const deadline = Date.now() + SOAK_DURATION_MS;
      let seq = 0;

      while (Date.now() < deadline) {
        const publishStart = performance.now();
        await bus.publish("FillReceived", buildFillEvent(seq, tokenIds, seq));
        const publishEnd = performance.now();
        latencySamples.push(publishEnd - publishStart);
        seq++;
      }

      await bus.drain(500);

      // ── Compute metrics ──────────────────────────────────────────────────
      const totalEvents = seq;
      const durationSec = SOAK_DURATION_MS / 1000;
      const ordersPerSec = totalEvents / durationSec;

      latencySamples.sort((a, b) => a - b);
      const p50 = percentile(latencySamples, 50);
      const p95 = percentile(latencySamples, 95);
      const p99 = percentile(latencySamples, 99);

      console.info(
        `[soak] duration=${SOAK_DURATION_MS}ms events=${totalEvents} ` +
          `orders/sec=${ordersPerSec.toFixed(1)} ` +
          `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms`,
      );

      db.close();

      // ── Assertions ───────────────────────────────────────────────────────
      expect(ordersPerSec).toBeGreaterThanOrEqual(2);
      expect(p99).toBeLessThan(500);
    },
    SOAK_DURATION_MS + 5000, // test timeout = soak + 5s headroom
  );
});
