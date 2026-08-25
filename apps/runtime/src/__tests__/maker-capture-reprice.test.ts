import { describe, expect, it, vi } from "vitest";
import {
  createOrderId,
  createTokenId,
  type ExchangeOrder,
  type OrderBookSnapshot,
} from "@krabs/domain";
import {
  buildMakerCaptureRepriceIdentity,
  computeMakerCaptureCandidate,
  isMakerCaptureCancellationReason,
  isMakerCaptureBookAfterCancellation,
  isMakerCaptureExactCancellation,
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
  it("accepts only capture-owned exact cancellations", () => {
    const predecessor = {
      exchangeOrderId: "exchange-predecessor",
      tokenId: TOKEN,
      side: "buy" as const,
      price: 0.3,
      size: 3,
      status: "cancelled" as const,
      cancelReason: "maker_capture_reprice",
    };
    const exact: ExchangeOrder = {
      orderId: predecessor.exchangeOrderId,
      clientOrderId: null,
      tokenId: TOKEN,
      side: "buy",
      price: 0.3,
      sizeTotal: 3,
      sizeFilled: 0.7,
      sizeRemaining: 2.3,
      status: "CANCELLED",
      createdAt: 1,
    };

    expect(isMakerCaptureCancellationReason("maker_capture_reprice")).toBe(true);
    expect(isMakerCaptureCancellationReason("exchange-exact-cancelled")).toBe(true);
    expect(isMakerCaptureCancellationReason("operator_cancelled")).toBe(false);
    expect(isMakerCaptureExactCancellation(predecessor, 2.3, exact)).toBe(true);
    expect(
      isMakerCaptureExactCancellation(
        { ...predecessor, cancelReason: "operator_cancelled" },
        2.3,
        exact,
      ),
    ).toBe(false);
    for (const status of ["OPEN", "PARTIALLY_FILLED", "EXPIRED", "REJECTED"] as const) {
      expect(isMakerCaptureExactCancellation(predecessor, 2.3, { ...exact, status })).toBe(false);
    }
    expect(
      isMakerCaptureExactCancellation(predecessor, 2.3, { ...exact, orderId: "foreign" }),
    ).toBe(false);
    expect(isMakerCaptureExactCancellation(predecessor, 2.3, { ...exact, sizeFilled: 0.6 })).toBe(
      false,
    );
    expect(isMakerCaptureExactCancellation(predecessor, 2.3, null)).toBe(false);
  });

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
    expect(moved).toMatchObject({ ok: true, price: 0.32, bestBid: 0.31, bestAsk: 0.34 });
  });

  it("keeps working-order ambiguity fail-closed", () => {
    expect(
      computeMakerCaptureCandidate({
        book: book(
          [
            { price: 0.31, size: 20 },
            { price: 0.3, size: 1 },
          ],
          [{ price: 0.34, size: 20 }],
        ),
        tickSize: 0.01,
        predecessorPrice: 0.3,
        predecessorVisibleShares: 2.3,
        originalSuggestedPrice: 0.4,
        entryPriceCeiling: 0.45,
      }),
    ).toEqual({ ok: false, reason: "self-book-ambiguous" });
  });

  it("accepts only a REST observation captured after durable cancellation", () => {
    expect(
      isMakerCaptureBookAfterCancellation({ snapshotTs: 999, sourcePolledAtMs: 1_001 }, 1_000),
    ).toBe(false);
    expect(
      isMakerCaptureBookAfterCancellation({ snapshotTs: 1_000, sourcePolledAtMs: 1_000 }, 1_000),
    ).toBe(true);
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
