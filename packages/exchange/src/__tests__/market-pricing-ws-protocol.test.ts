import { describe, expect, it } from "vitest";
import {
  buildMarketSubscriptionPayload,
  buildMarketSubscriptionUpdatePayload,
  collectStreamUpdatesMetricsOnly,
  isPongPayload,
  normalizeTokenIds,
} from "../live/market-pricing-ws-protocol.js";

describe("market-pricing WS protocol helpers", () => {
  it("normalizes token ids deterministically before shard dispatch", () => {
    expect(normalizeTokenIds([" b ", "a", "", "a", "c"])).toEqual(["a", "b", "c"]);
  });

  it("builds Polymarket market subscription payloads", () => {
    expect(JSON.parse(buildMarketSubscriptionPayload(["tok-a", "tok-b"]))).toEqual({
      type: "market",
      assets_ids: ["tok-a", "tok-b"],
      custom_feature_enabled: true,
    });
    expect(
      JSON.parse(buildMarketSubscriptionUpdatePayload("unsubscribe", ["tok-a"], false)),
    ).toEqual({
      operation: "unsubscribe",
      assets_ids: ["tok-a"],
    });
  });

  it("recognizes Polymarket PONG text frames", () => {
    expect(isPongPayload("PONG")).toBe(true);
    expect(isPongPayload(" pong ")).toBe(true);
    expect(isPongPayload("PING")).toBe(false);
  });

  it("counts received market records without mutating stream state", () => {
    const nowMs = Date.parse("2026-05-20T00:00:10Z");
    const metrics = collectStreamUpdatesMetricsOnly(
      [
        {
          event_type: "price_change",
          timestamp: "2026-05-20T00:00:09Z",
          price_changes: [
            { asset_id: "tok-a", timestamp: "2026-05-20T00:00:09.500Z" },
            { asset_id: "tok-b", timestamp: "2026-05-20T00:00:09.750Z" },
          ],
        },
      ],
      nowMs,
    );

    expect(metrics.eventCount).toBe(2);
    expect(metrics.latencySamplesMs).toEqual([1000, 500, 250]);
  });
});
