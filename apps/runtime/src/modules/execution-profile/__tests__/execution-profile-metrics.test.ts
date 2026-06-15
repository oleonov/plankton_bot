import { describe, expect, it, vi } from "vitest";

import {
  EXECUTION_PROFILE_METRICS,
  serializeExecutionProfileLabels,
  validateExecutionProfileLabels,
  writeExecutionProfileGaugeEvent,
} from "../execution-profile-metrics.js";

describe("execution profile metric contracts", () => {
  it("writes labeled gauges as append-only events, not writeLatest rows", () => {
    const writer = {
      writeEvent: vi.fn(),
      writeLatest: vi.fn(),
    };

    writeExecutionProfileGaugeEvent(
      writer,
      EXECUTION_PROFILE_METRICS.activeTokensGauge,
      3,
      { profile: "cheap", state: "PROBING" },
      Date.parse("2026-06-14T00:00:00.000Z"),
    );

    expect(writer.writeEvent).toHaveBeenCalledWith(
      EXECUTION_PROFILE_METRICS.activeTokensGauge,
      3,
      '{"profile":"cheap","state":"PROBING"}',
      "2026-06-14T00:00:00.000Z",
    );
    expect(writer.writeLatest).not.toHaveBeenCalled();
  });

  it("rejects unbounded labels and serializes finite labels deterministically", () => {
    expect(
      serializeExecutionProfileLabels({ reason: "allowed", profile: "cheap", outcome: "allow" }),
    ).toBe('{"outcome":"allow","profile":"cheap","reason":"allowed"}');

    expect(() =>
      validateExecutionProfileLabels(EXECUTION_PROFILE_METRICS.chainDecision, {
        profile: "cheap",
        tokenId: "raw-token-id",
      }),
    ).toThrow(/tokenId/);

    expect(() =>
      validateExecutionProfileLabels(EXECUTION_PROFILE_METRICS.chainDecision, {
        profile: "cheap",
        reason: "unknown-new-reason",
      }),
    ).toThrow(/reason/);
  });
});
