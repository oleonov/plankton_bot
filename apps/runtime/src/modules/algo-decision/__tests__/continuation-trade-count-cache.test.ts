import { describe, expect, it, vi } from "vitest";
import { createConditionId } from "@krabs/domain";
import { ContinuationTradeCountCache } from "../continuation-trade-count-cache.js";

const log = {
  warn: vi.fn(),
  child: () => log,
} as any;

describe("ContinuationTradeCountCache", () => {
  it("returns cache miss immediately and refreshes in the background", async () => {
    const provider = {
      countTrades: vi.fn().mockResolvedValue(6),
    };
    const cache = new ContinuationTradeCountCache({
      provider,
      log,
      concurrency: 1,
    });
    const conditionId = createConditionId("cond-a");

    expect(cache.read(conditionId, 6)).toBeUndefined();
    cache.schedule([conditionId], 6);

    await vi.waitFor(() => {
      expect(provider.countTrades).toHaveBeenCalledWith(conditionId, 6);
      expect(cache.read(conditionId, 6)).toBe(6);
    });
  });

  it("bounds queue size and records dropped jobs", () => {
    const provider = {
      countTrades: vi.fn().mockResolvedValue(1),
    };
    const cache = new ContinuationTradeCountCache({
      provider,
      log,
      maxQueueSize: 1,
      concurrency: 0,
    });

    cache.schedule([createConditionId("a"), createConditionId("b")], 6);

    expect(cache.stats().dropped).toBe(1);
  });
});
