import { describe, expect, it } from "vitest";

import { evaluateMinMarketAge, DEFAULT_ENTRY_MIN_MARKET_AGE_SECONDS } from "./index.js";

const NOW_MS = Date.UTC(2026, 4, 5, 12, 0, 0);
const ISO = (offsetMs: number): string => new Date(NOW_MS + offsetMs).toISOString();

describe("evaluateMinMarketAge", () => {
  it("threshold=0 bypasses everything (including null createdAt)", () => {
    expect(
      evaluateMinMarketAge({ gammaCreatedAt: null, thresholdSeconds: 0, nowMs: NOW_MS }),
    ).toEqual({ ok: true });
  });

  it("threshold=0 bypasses unparseable createdAt", () => {
    expect(
      evaluateMinMarketAge({
        gammaCreatedAt: "not-an-iso-string",
        thresholdSeconds: 0,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: true });
  });

  it("null createdAt + threshold>0 → market_age_unknown", () => {
    expect(
      evaluateMinMarketAge({
        gammaCreatedAt: null,
        thresholdSeconds: DEFAULT_ENTRY_MIN_MARKET_AGE_SECONDS,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reasonCode: "market_age_unknown" });
  });

  it("unparseable createdAt + threshold>0 → market_age_unknown", () => {
    expect(
      evaluateMinMarketAge({
        gammaCreatedAt: "garbage",
        thresholdSeconds: DEFAULT_ENTRY_MIN_MARKET_AGE_SECONDS,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reasonCode: "market_age_unknown" });
  });

  it("empty string + threshold>0 → market_age_unknown", () => {
    expect(
      evaluateMinMarketAge({
        gammaCreatedAt: "",
        thresholdSeconds: DEFAULT_ENTRY_MIN_MARKET_AGE_SECONDS,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reasonCode: "market_age_unknown" });
  });

  it("age < threshold → market_too_young", () => {
    expect(
      evaluateMinMarketAge({
        gammaCreatedAt: ISO(-1_000 * 1_000), // 1000 s ago
        thresholdSeconds: DEFAULT_ENTRY_MIN_MARKET_AGE_SECONDS, // 2 504 s
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reasonCode: "market_too_young" });
  });

  it("age == threshold → ok", () => {
    expect(
      evaluateMinMarketAge({
        gammaCreatedAt: ISO(-DEFAULT_ENTRY_MIN_MARKET_AGE_SECONDS * 1_000),
        thresholdSeconds: DEFAULT_ENTRY_MIN_MARKET_AGE_SECONDS,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: true });
  });

  it("age > threshold → ok", () => {
    expect(
      evaluateMinMarketAge({
        gammaCreatedAt: ISO(-(DEFAULT_ENTRY_MIN_MARKET_AGE_SECONDS + 1) * 1_000),
        thresholdSeconds: DEFAULT_ENTRY_MIN_MARKET_AGE_SECONDS,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: true });
  });

  it("future createdAt (clock skew) → market_too_young", () => {
    expect(
      evaluateMinMarketAge({
        gammaCreatedAt: ISO(60 * 1_000),
        thresholdSeconds: DEFAULT_ENTRY_MIN_MARKET_AGE_SECONDS,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reasonCode: "market_too_young" });
  });
});
