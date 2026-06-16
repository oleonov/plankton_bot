import {
  DEFAULT_EXECUTION_POLICY,
  PositionStatus,
  createConditionId,
  createPositionId,
  createTokenId,
  type PlaceOrderCommand,
  type TrackS4DustAutoCloseConfig,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SqliteDustAutoCloseRepository } from "../dust-auto-close-repository.js";
import { DustAutoCloseModule, type DustAutoCloseCandidate } from "../dust-auto-close-module.js";

const NOW = 1_800_000_000_000;
const tokenA = createTokenId("s4-dark-token-a");
const tokenB = createTokenId("s4-dark-token-b");
const conditionId = createConditionId("s4-dark-condition");

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-s4-dark-"));
  db = new Database(path.join(tmpDir, "ledger.db"));
  db.exec(
    readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../../../../packages/db/src/migrations/074_dust_auto_close_state.sql",
      ),
      "utf8",
    ),
  );
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function policy(overrides: Partial<TrackS4DustAutoCloseConfig> = {}): TrackS4DustAutoCloseConfig {
  return {
    ...DEFAULT_EXECUTION_POLICY.trackS4,
    enabled: false,
    ...overrides,
  };
}

function candidate(tokenId = tokenA): DustAutoCloseCandidate {
  return {
    tokenId,
    conditionId,
    status: "open",
    liquidationValueUsdc: 0.49,
    costBasisUsdc: 5,
    sellCountTotal: 1,
    lastSellAgeMs: 7 * 24 * 60 * 60_000,
    size: 12,
    minOrderSize: 5,
    marketTradable: true,
    bestBid: 0.024,
    tickSize: 0.001,
    minValidPrice: 0.001,
    negRisk: false,
  };
}

describe("DustAutoCloseModule dark behavior", () => {
  it("has zero side effects when trackS4.enabled=false", async () => {
    const bus = new InProcessEventBus();
    const repo = new SqliteDustAutoCloseRepository(db);
    const orders: PlaceOrderCommand[] = [];
    const counters: Array<{ name: string; labels?: string }> = [];
    const riskEvents: Array<{ eventType: string; payload: Readonly<Record<string, unknown>> }> =
      [];
    const listCandidates = vi.fn().mockResolvedValue([candidate(tokenA), candidate(tokenB)]);

    bus.subscribe("PlaceOrderRequested", async ({ command }) => {
      orders.push(command);
    });
    const module = new DustAutoCloseModule({
      bus,
      repository: repo,
      policy: () => policy(),
      candidateProvider: { listCandidates },
      runtimeMetrics: {
        writeCounter: (name, _value, labels) =>
          counters.push({
            name,
            ...(labels === undefined ? {} : { labels }),
          }),
      },
      riskEvents: { insert: (event) => riskEvents.push(event) },
      isProfileOwned: vi.fn().mockReturnValue(false),
      redeemInFlightGuard: vi.fn().mockReturnValue(false),
      now: () => NOW,
    });

    await module.start();
    await module.runOnce();
    await bus.publish("PositionUpdated", {
      position: {
        positionId: createPositionId("s4-dark-position"),
        tokenId: tokenA,
        conditionId,
        side: "buy",
        size: 0,
        avgEntryPrice: 0.1,
        costBasisUsdc: 0,
        currentValueUsdc: 0,
        realizedPnl: 0,
        status: PositionStatus.Closed,
        entryStyle: "probe",
        openedAt: new Date(NOW - 10_000).toISOString(),
        closedAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      },
    });

    expect(listCandidates).not.toHaveBeenCalled();
    expect(orders).toHaveLength(0);
    expect(counters).toHaveLength(0);
    expect(riskEvents).toHaveLength(0);
    expect(repo.getState(tokenA)).toBeNull();
    expect(repo.getState(tokenB)).toBeNull();
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM dust_auto_close_state").get() as { count: number })
        .count,
    ).toBe(0);
    await module.stop();
  });
});
