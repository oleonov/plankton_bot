import { afterEach, describe, expect, it, vi } from "vitest";

import { PRICE_KEY_WINDOW_MS, SignalPathTelemetry } from "./signal-path-telemetry.js";

const TOKEN_ID = "token-1";
const SIDE = "SELL";
const PRICE = 0.423;
const TICK_SIZE = 0.01;

function recordEarly(telemetry: SignalPathTelemetry, signalId: string): void {
  telemetry.recordEarlyCooldown(signalId, TOKEN_ID, SIDE, PRICE, TICK_SIZE);
}

function recordLate(telemetry: SignalPathTelemetry, signalId: string): void {
  telemetry.recordLateCooldown(signalId, TOKEN_ID, SIDE, PRICE, TICK_SIZE);
}

describe("SignalPathTelemetry cooldown diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deduplicates early and late cooldown phases by signal id per window", () => {
    const telemetry = new SignalPathTelemetry();

    recordEarly(telemetry, "early-only-1");
    recordEarly(telemetry, "early-only-2");
    recordLate(telemetry, "late-only-1");
    recordEarly(telemetry, "both-1");
    recordLate(telemetry, "both-1");
    recordEarly(telemetry, "early-only-1");
    recordLate(telemetry, "late-only-1");

    const snapshot = telemetry.snapshotAndReset();

    expect(snapshot.signalsSkippedEarlyCooldown).toBe(4);
    expect(snapshot.signalsSkippedLateCooldown).toBe(3);
    expect(snapshot.cooldownSignalDedupe).toEqual({
      total: 4,
      earlyOnly: 2,
      lateOnly: 1,
      earlyAndLate: 1,
      duplicateEarly: 1,
      duplicateLate: 1,
    });
  });

  it("deduplicates early and late cooldown phases by token side price and time bucket", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const telemetry = new SignalPathTelemetry();

    telemetry.recordEarlyCooldown("early-random-1", TOKEN_ID, SIDE, 0.424, TICK_SIZE);
    telemetry.recordLateCooldown("late-random-1", TOKEN_ID, SIDE, 0.423, TICK_SIZE);

    const snapshot = telemetry.snapshotAndReset();

    expect(snapshot.cooldownPriceDedupe).toEqual({
      total: 1,
      earlyOnly: 0,
      lateOnly: 0,
      earlyAndLate: 1,
      duplicateEarly: 0,
      duplicateLate: 0,
      skippedNoPrice: 0,
    });
  });

  it("keeps identical token side price signals in separate time buckets independent", () => {
    const now = vi.spyOn(Date, "now");
    const telemetry = new SignalPathTelemetry();

    now.mockReturnValue(1_000_000);
    recordEarly(telemetry, "early-random-1");
    now.mockReturnValue(1_000_000 + PRICE_KEY_WINDOW_MS + 1);
    recordLate(telemetry, "late-random-1");

    const snapshot = telemetry.snapshotAndReset();

    expect(snapshot.cooldownPriceDedupe).toEqual({
      total: 2,
      earlyOnly: 1,
      lateOnly: 1,
      earlyAndLate: 0,
      duplicateEarly: 0,
      duplicateLate: 0,
      skippedNoPrice: 0,
    });
  });

  it("skips price-key dedupe for null price but preserves signal-id dedupe", () => {
    const telemetry = new SignalPathTelemetry();

    telemetry.recordEarlyCooldown("signal-1", TOKEN_ID, SIDE, null, TICK_SIZE);
    telemetry.recordLateCooldown("signal-1", TOKEN_ID, SIDE, undefined, TICK_SIZE);

    const snapshot = telemetry.snapshotAndReset();

    expect(snapshot.cooldownSignalDedupe.earlyAndLate).toBe(1);
    expect(snapshot.cooldownPriceDedupe).toEqual({
      total: 0,
      earlyOnly: 0,
      lateOnly: 0,
      earlyAndLate: 0,
      duplicateEarly: 0,
      duplicateLate: 0,
      skippedNoPrice: 2,
    });
  });

  it("skips price-key dedupe for zero tick size", () => {
    const telemetry = new SignalPathTelemetry();

    telemetry.recordEarlyCooldown("signal-1", TOKEN_ID, SIDE, PRICE, 0);

    const snapshot = telemetry.snapshotAndReset();

    expect(snapshot.cooldownSignalDedupe.earlyOnly).toBe(1);
    expect(snapshot.cooldownPriceDedupe).toEqual({
      total: 0,
      earlyOnly: 0,
      lateOnly: 0,
      earlyAndLate: 0,
      duplicateEarly: 0,
      duplicateLate: 0,
      skippedNoPrice: 1,
    });
  });

  it("resets cooldown dedupe state with the aggregate window", () => {
    const telemetry = new SignalPathTelemetry();

    recordEarly(telemetry, "signal-1");
    recordLate(telemetry, "signal-2");

    expect(telemetry.snapshotAndReset().cooldownSignalDedupe.total).toBe(2);
    const reset = telemetry.snapshotAndReset();
    expect(reset.cooldownSignalDedupe).toEqual({
      total: 0,
      earlyOnly: 0,
      lateOnly: 0,
      earlyAndLate: 0,
      duplicateEarly: 0,
      duplicateLate: 0,
    });
    expect(reset.cooldownPriceDedupe).toEqual({
      total: 0,
      earlyOnly: 0,
      lateOnly: 0,
      earlyAndLate: 0,
      duplicateEarly: 0,
      duplicateLate: 0,
      skippedNoPrice: 0,
    });
  });
});
