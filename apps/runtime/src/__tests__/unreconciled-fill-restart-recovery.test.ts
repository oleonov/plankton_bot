import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  bootstrapLedgerDb,
  SqliteFillRepository,
  SqliteInventoryLotRepository,
  SqliteOrderRepository,
  SqlitePositionRepository,
} from "@krabs/db";
import {
  createConditionId,
  createFillId,
  createOrderId,
  createPositionId,
  createTokenId,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { RiskInventoryModule } from "../modules/risk-inventory/risk-inventory-module.js";
import { discardStrandedFillAlert } from "../stranded-fill-alert.js";

const tokenId = createTokenId("t1-token");
const conditionId = createConditionId("t1-condition");
const fillId = createFillId("t1-fill");
const orderId = createOrderId("t1-order");
const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => log,
} as any;

function moduleFor(db: import("better-sqlite3").Database) {
  const fills = new SqliteFillRepository(db);
  const positions = new SqlitePositionRepository(db);
  const orders = new SqliteOrderRepository(db);
  const lots = new SqliteInventoryLotRepository(db);
  const bus = new InProcessEventBus();
  let tick: (() => void) | undefined;
  const module = new RiskInventoryModule({
    bus,
    fillRepo: fills,
    positionRepo: positions,
    orderRepo: orders,
    inventoryLotRepo: lots,
    db,
    log,
    emitStrandedFillAlert: discardStrandedFillAlert,
    timers: {
      every: (_name, _ms, callback) => {
        tick = callback;
        return 1 as any;
      },
    },
  });
  return { fills, positions, bus, module, tick: () => tick! };
}

describe("unreconciled fill restart recovery", () => {
  it("T1 — a failed fill remains durable across close/reopen and a later module tick reconciles it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-t1-"));
    const file = path.join(dir, "ledger.db");
    try {
      const first = bootstrapLedgerDb(file);
      const a = moduleFor(first.db);
      a.positions.save({
        positionId: createPositionId("t1-open"),
        tokenId,
        conditionId,
        side: "buy",
        size: 1,
        avgEntryPrice: 0.5,
        costBasisUsdc: 0.5,
        currentValueUsdc: 0.5,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: "2026-01-01T00:00:00.000Z",
        closedAt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      a.positions.save({
        positionId: createPositionId("t1-dust"),
        tokenId,
        conditionId,
        side: "buy",
        size: 1,
        avgEntryPrice: 0.5,
        costBasisUsdc: 0.5,
        currentValueUsdc: 0.5,
        realizedPnl: 0,
        status: "dust",
        entryStyle: null,
        openedAt: "2026-01-02T00:00:00.000Z",
        closedAt: null,
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
      first.db
        .prepare("INSERT INTO bot_runs (run_id, mode, started_at) VALUES ('t1-run', 'test', ?)")
        .run("2026-01-01T00:00:00.000Z");
      first.db
        .prepare(
          "INSERT INTO orders (order_id, client_order_id, token_id, condition_id, side, order_type, price, size, size_usdc, status, bot_run_id, created_at, updated_at) VALUES (?, 't1-client', ?, ?, 'buy', 'GTC', .5, 1, .5, 'filled', 't1-run', ?, ?)",
        )
        .run(orderId, tokenId, conditionId, "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
      a.fills.save({
        fillId,
        orderId,
        tokenId,
        conditionId,
        side: "buy",
        price: 0.5,
        size: 1,
        sizeUsdc: 0.5,
        liquidityRole: "unknown",
        fee: 0,
        feeRateBps: 0,
        signalId: null,
        decisionRuleId: null,
        signalTimestamp: null,
        filledAt: "2026-01-03T00:00:00.000Z",
      });
      await a.module.start();
      expect(a.fills.findUnreconciled()).toHaveLength(1);
      expect(log.error).toHaveBeenCalled();
      await a.module.stop();
      first.close();

      const second = bootstrapLedgerDb(file);
      const b = moduleFor(second.db);
      expect(b.fills.findUnreconciled()).toHaveLength(1);
      second.db
        .prepare("UPDATE positions SET status = 'closed', closed_at = ? WHERE position_id = ?")
        .run("2026-01-04T00:00:00.000Z", "t1-dust");
      await b.module.start();
      b.tick()();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(b.fills.findUnreconciled()).toHaveLength(0);
      expect(b.positions.findByTokenId(tokenId)?.size).toBe(2);
      await b.module.stop();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
