import { describe, expect, it, vi } from "vitest";
import { createOrderId, createTokenId, type OrderBookSnapshot } from "@krabs/domain";
import {
  buildMakerCaptureRepriceIdentity,
  computeMakerCaptureCandidate,
  parseMakerCaptureRepriceSignal,
  primeFreshMakerCaptureBook,
} from "../maker-capture-reprice.js";

const TOKEN = createTokenId("tok-capture-reprice");

function book(
  bids: Array<{ price: number; size: number }>,
  asks: Array<{ price: number; size: number }>,
  timestamp = 10_000,
): OrderBookSnapshot {
  return {
    tokenId: TOKEN,
    bids,
    asks,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    midPrice: null,
    spread: null,
    minOrderSize: 1,
    timestamp,
  };
}

describe("maker capture reprice helper", () => {
  it("derives stable identities from the exact root hop", () => {
    const root = createOrderId("root");
    const predecessor = createOrderId("predecessor");
    const first = buildMakerCaptureRepriceIdentity(root, predecessor, 1);

    expect(buildMakerCaptureRepriceIdentity(root, predecessor, 1)).toEqual(first);
    expect(buildMakerCaptureRepriceIdentity(root, predecessor, 2)).not.toEqual(first);
    expect(first.lifecycleSignalId).toContain(":1:");
  });

  it("parses only the exact bounded signal shape", () => {
    const valid = {
      version: 1,
      intentId: "intent",
      rootOrderId: createOrderId("root"),
      predecessorOrderId: createOrderId("pred"),
      replacementIndex: 5,
    };
    expect(parseMakerCaptureRepriceSignal(valid)).toEqual(valid);
    expect(parseMakerCaptureRepriceSignal({ ...valid, replacementIndex: 6 })).toBeNull();
    expect(parseMakerCaptureRepriceSignal({ ...valid, extra: true })).toBeNull();
  });

  it("subtracts the cancelled predecessor and requires a full-tick upward move", () => {
    const held = computeMakerCaptureCandidate({
      book: book(
        [
          { price: 0.3, size: 5 },
          { price: 0.29, size: 20 },
        ],
        [{ price: 0.35, size: 20 }],
      ),
      tickSize: 0.01,
      predecessorPrice: 0.3,
      predecessorVisibleShares: 5,
      originalSuggestedPrice: 0.4,
      entryPriceCeiling: 0.45,
    });
    const moved = computeMakerCaptureCandidate({
      book: book(
        [
          { price: 0.31, size: 20 },
          { price: 0.3, size: 5 },
        ],
        [{ price: 0.34, size: 20 }],
      ),
      tickSize: 0.01,
      predecessorPrice: 0.3,
      predecessorVisibleShares: 5,
      originalSuggestedPrice: 0.4,
      entryPriceCeiling: 0.45,
    });

    expect(held).toEqual({ ok: false, reason: "no-valid-move" });
    expect(moved).toEqual({ ok: true, price: 0.32, bestBid: 0.31, bestAsk: 0.34 });
  });

  it("fails closed for missing or stale REST books", async () => {
    const entry = {
      tokenId: String(TOKEN),
      snapshotTs: 10_000,
      cachedAtMs: 10_000,
      sourcePolledAtMs: 10_000,
      bookSource: "clob" as const,
      sourceKind: "rest" as const,
      book: book([{ price: 0.3, size: 10 }], [{ price: 0.4, size: 10 }]),
    };
    const cache = { prime: vi.fn().mockResolvedValue(new Map([[String(TOKEN), entry]])) };

    await expect(primeFreshMakerCaptureBook(cache, String(TOKEN), 10_000)).resolves.toEqual(entry);
    await expect(primeFreshMakerCaptureBook(cache, String(TOKEN), 13_001)).resolves.toBeNull();
    await expect(
      primeFreshMakerCaptureBook(
        { prime: vi.fn().mockResolvedValue(new Map()) },
        String(TOKEN),
        10_000,
      ),
    ).resolves.toBeNull();
  });
});
