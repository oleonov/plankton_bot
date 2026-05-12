import { afterEach, describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@krabs/event-bus";
import { createConditionId, createPositionId, createTokenId, type Position } from "@krabs/domain";
import { normalizePolymarketPosition } from "@krabs/exchange";
import type { PolymarketDataPosition } from "@krabs/exchange";
import { DEFAULT_EXECUTION_POLICY } from "../../../execution-policy.js";
import { RedeemSweepModule } from "../redeem-sweep-module.js";

const NOW = Date.parse("2026-05-11T00:00:00.000Z");

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger(),
  } as any;
}

function localPosition(tokenId: string, conditionId: string): Position {
  return {
    positionId: createPositionId(`pos-${tokenId}`),
    tokenId: createTokenId(tokenId),
    conditionId: createConditionId(conditionId),
    side: "buy",
    size: 10,
    avgEntryPrice: 0.1,
    costBasisUsdc: 1,
    currentValueUsdc: 1,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: new Date(NOW).toISOString(),
    closedAt: null,
    updatedAt: new Date(NOW).toISOString(),
  };
}

function isActiveRedeemLogStatus(status: string): boolean {
  return status === "attempting" || status === "submitted" || status === "pending";
}

function hasLaterRedeemLogRow(rows: readonly any[], row: any): boolean {
  return rows.some(
    (candidate) =>
      candidate.conditionId === row.conditionId &&
      (candidate.attemptTs > row.attemptTs ||
        (candidate.attemptTs === row.attemptTs && candidate.id > row.id)),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("redeem sweep wallet snapshot integration", () => {
  it("normalizes wallet positions and redeems only redeemable rows from wallet event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const bus = new InProcessEventBus();
    const logRows: any[] = [];
    const positions = [
      normalizePolymarketPosition({
        asset: "tok-r1",
        conditionId: "cond-r1",
        size: "10",
        redeemable: true,
        slug: "redeem-one",
        outcome: "Yes",
      }),
      normalizePolymarketPosition({
        asset: "tok-r2",
        condition_id: "cond-r2",
        size: "7",
        redeemable: "true",
        marketSlug: "redeem-two",
        outcome: "No",
      }),
      normalizePolymarketPosition({
        asset: "tok-open",
        conditionId: "cond-open",
        size: "4",
        redeemable: false,
      }),
      normalizePolymarketPosition({
        asset: "tok-zero",
        conditionId: "cond-zero",
        size: "0",
        redeemable: true,
      }),
      normalizePolymarketPosition({
        asset: "tok-missing-condition",
        size: "3",
        redeemable: false,
      }),
    ].filter((position): position is PolymarketDataPosition => position !== null);
    const localByToken = new Map<string, Position>([
      ["tok-r1", localPosition("tok-r1", "cond-r1")],
      ["tok-r2", localPosition("tok-r2", "cond-r2")],
    ]);
    const savedPositions: Position[] = [];
    const gateway = {
      redeemPositions: vi.fn().mockResolvedValue({
        status: "confirmed",
        conditionIds: ["cond-r1"],
        txHash: "0xredeem",
        gasUsed: 12_345,
      }),
    };
    const positionReader = {
      read: vi.fn().mockResolvedValueOnce([]).mockResolvedValue(positions),
    };
    const module = new RedeemSweepModule({
      bus,
      gateway: gateway as any,
      positionReader,
      positionRepo: {
        findByTokenId: vi.fn((tokenId) => localByToken.get(String(tokenId)) ?? null),
        save: vi.fn((position) => savedPositions.push(position)),
      } as any,
      lotRepo: { settleAll: vi.fn() } as any,
      marketRepo: {
        findByConditionId: vi.fn((conditionId) => [
          { tokenId: createTokenId(`${conditionId}-other`) },
        ]),
      } as any,
      redeemLogRepo: {
        insert: vi.fn((row) => logRows.push({ id: logRows.length + 1, ...row })),
        updateLatestActiveAttempt: vi.fn((entry) => {
          const row = logRows
            .filter(
              (existing) =>
                existing.conditionId === entry.conditionId &&
                isActiveRedeemLogStatus(existing.status),
            )
            .sort((a, b) => b.attemptTs - a.attemptTs || b.id - a.id)[0];
          if (!row) return false;
          Object.assign(row, entry);
          return true;
        }),
        findRecentActiveAttempts: vi.fn(() => []),
        hasRecentActiveAttempt: vi.fn((conditionId: string, sinceTs: number) =>
          logRows.some(
            (row) =>
              row.conditionId === conditionId &&
              isActiveRedeemLogStatus(row.status) &&
              row.attemptTs > sinceTs &&
              !hasLaterRedeemLogRow(logRows, row),
          ),
        ),
        findLatestAttemptTs: vi.fn(() => null),
        markOrphanedActiveAttempts: vi.fn(() => []),
      } as any,
      policy: () => ({
        ...DEFAULT_EXECUTION_POLICY.redeemSweep,
        enabled: true,
        intervalMs: 60_000,
        minAgeAfterResolutionSec: 0,
      }),
      log: logger(),
      runtimeMetrics: { writeEvent: vi.fn(), writeLatest: vi.fn() } as any,
      now: () => Date.now(),
    });

    await module.start();
    const walletEvent = {
      positions: positions.map((position) => ({
        tokenId: createTokenId(position.tokenId),
        conditionId: position.conditionId,
        size: position.size,
        redeemable: position.redeemable,
        slug: position.slug,
        outcome: position.outcome,
      })),
      timestamp: Date.now(),
    };
    await bus.publish("PolymarketWalletUpdated", walletEvent);
    await bus.publish("PolymarketWalletUpdated", walletEvent);
    await bus.drain();

    expect(positions).toHaveLength(5);
    expect(positions.filter((position) => position.redeemable)).toHaveLength(3);
    expect(gateway.redeemPositions).toHaveBeenCalledWith(["cond-r1", "cond-r2", "cond-zero"], {
      redeemTokenIdsByCondition: {
        "cond-r1": [createTokenId("tok-r1")],
        "cond-r2": [createTokenId("tok-r2")],
        "cond-zero": [createTokenId("tok-zero")],
      },
    });
    expect(logRows.filter((row) => row.status === "success")).toHaveLength(3);
    expect(savedPositions).toEqual([
      expect.objectContaining({ tokenId: createTokenId("tok-r1"), size: 0, status: "closed" }),
      expect.objectContaining({ tokenId: createTokenId("tok-r2"), size: 0, status: "closed" }),
    ]);

    await module.stop();
  });
});
