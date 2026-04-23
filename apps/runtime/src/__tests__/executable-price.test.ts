import { describe, expect, it } from "vitest";
import { deriveExecutableTopOfBook, validateExecutablePrice } from "../executable-price.js";

describe("validateExecutablePrice", () => {
  it("accepts tick-aligned prices inside the executable interval", () => {
    expect(validateExecutablePrice(0.001, 0.001)).toMatchObject({ ok: true });
    expect(validateExecutablePrice(0.999, 0.001)).toMatchObject({ ok: true });
    expect(validateExecutablePrice(0.505, 0.001)).toMatchObject({ ok: true });
  });

  it("rejects prices outside the executable interval", () => {
    expect(validateExecutablePrice(0.0005, 0.001)).toMatchObject({
      ok: false,
      reason: "price-below-min-tick",
    });
    expect(validateExecutablePrice(1, 0.001)).toMatchObject({
      ok: false,
      reason: "price-above-max-bound",
    });
  });

  it("rejects off-grid prices inside the numeric interval", () => {
    expect(validateExecutablePrice(0.5005, 0.001)).toMatchObject({
      ok: false,
      reason: "price-off-tick-grid",
    });
  });
});

describe("deriveExecutableTopOfBook", () => {
  it("uses the first deeper executable level when the raw best prices are invalid", () => {
    expect(
      deriveExecutableTopOfBook(
        {
          bestBid: 0.0005,
          bestAsk: 1,
          bids: [
            { price: 0.0005, size: 100 },
            { price: 0.001, size: 90 },
          ],
          asks: [
            { price: 1, size: 100 },
            { price: 0.999, size: 90 },
          ],
        },
        0.001,
      ),
    ).toEqual({
      bestBid: 0.001,
      bestAsk: 0.999,
      midPrice: 0.5,
      spread: 0.998,
    });
  });

  it("drops scalar quotes when no executable levels exist", () => {
    expect(
      deriveExecutableTopOfBook(
        {
          bestBid: 0.0005,
          bestAsk: 1,
        },
        0.001,
      ),
    ).toEqual({
      bestBid: null,
      bestAsk: null,
      midPrice: null,
      spread: null,
    });
  });
});
