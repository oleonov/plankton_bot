import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConditionId,
  createFillId,
  createOrderId,
  createPositionId,
  createTokenId,
  type ClientOrderId,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { HoldResolutionCleanupModule } from "../hold-resolution-cleanup.js";
import type { Logger } from "../../../logger.js";

const tokenId = createTokenId("hold-cleanup-token");
const conditionId = createConditionId("hold-cleanup-condition");
const now = Date.parse("2026-06-02T12:00:00.000Z");

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => silentLog,
} as unknown as Logger;

describe("HoldResolutionCleanupModule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks settled losers as resolved_zero_loss", async () => {
    const env = makeEnv();
    await env.module.start();

    await env.bus.publish("PositionSettled", {
      positionId: createPositionId("pos-zero"),
      tokenId,
      resolution: "NO",
      settlementPrice: 0,
      realizedPnl: -1,
      size: 10,
      avgEntryPrice: 0.1,
      timestamp: now,
    });
    await env.bus.drain();

    expect(env.repo.transitionActive).toHaveBeenCalledWith(tokenId, {
      status: "resolved_zero_loss",
      clearedAt: new Date(now).toISOString(),
      clearReason: "position_settled_zero_loss",
    });
  });

  it("marks settled winners as recovered", async () => {
    const env = makeEnv();
    await env.module.start();

    await env.bus.publish("PositionSettled", {
      positionId: createPositionId("pos-recovered"),
      tokenId,
      resolution: "YES",
      settlementPrice: 1,
      realizedPnl: 5,
      size: 10,
      avgEntryPrice: 0.5,
      timestamp: now,
    });
    await env.bus.drain();

    expect(env.repo.transitionActive).toHaveBeenCalledWith(tokenId, {
      status: "recovered",
      clearedAt: new Date(now).toISOString(),
      clearReason: "position_settled_recovered",
    });
  });

  it("cancels active hold state when a position closes externally", async () => {
    const env = makeEnv();
    await env.module.start();

    await env.bus.publish("PositionUpdated", {
      position: {
        positionId: createPositionId("pos-closed"),
        tokenId,
        conditionId,
        side: "buy",
        status: "closed",
        size: 0,
        avgEntryPrice: 0.1,
        costBasisUsdc: 1,
        realizedPnl: 0,
        currentValueUsdc: 0,
        entryStyle: null,
        openedAt: new Date(now - 1_000).toISOString(),
        updatedAt: new Date(now).toISOString(),
        closedAt: new Date(now).toISOString(),
      },
    });
    await env.bus.drain();

    expect(env.repo.transitionActive).toHaveBeenCalledWith(tokenId, {
      status: "cancelled",
      clearedAt: new Date(now).toISOString(),
      clearReason: "position_closed",
    });
  });

  it("cancels active hold state after a sell fill", async () => {
    const env = makeEnv();
    await env.module.start();

    await env.bus.publish("FillReceived", {
      fillId: createFillId("fill-hold-cleanup"),
      orderId: createOrderId("order-hold-cleanup"),
      clientOrderId: "client-hold-cleanup" as ClientOrderId,
      tokenId,
      conditionId,
      side: "sell",
      price: 0.2,
      size: 1,
      sizeUsdc: 0.2,
      liquidityRole: "maker",
      fee: 0,
      feeRateBps: 0,
      signalReason: "D9_LOSS_EXIT",
      timestamp: now,
    });
    await env.bus.drain();

    expect(env.repo.transitionActive).toHaveBeenCalledWith(tokenId, {
      status: "cancelled",
      clearedAt: new Date(now).toISOString(),
      clearReason: "sell_fill_received",
    });
  });
});

function makeEnv() {
  const bus = new InProcessEventBus();
  const repo = {
    transitionActive: vi.fn().mockReturnValue(true),
  };
  const module = new HoldResolutionCleanupModule({
    bus,
    holdResolutionRepo: repo,
    log: silentLog,
  });
  return { bus, repo, module };
}
