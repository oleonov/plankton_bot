import { describe, it, expect } from "vitest";
import type { Market, ClobMarket } from "../index.js";

describe("signature type fields", () => {
  it("Market carries sig_* and ClobMarket carries volume24hr", () => {
    const clob: Pick<ClobMarket, "volume24hr"> = { volume24hr: 42 };
    const sig: Pick<
      Market,
      "sigMid" | "sigCheapMid" | "sigLiquidity" | "sigVol24h" | "sigFeaturesAt"
    > = {
      sigMid: 0.05,
      sigCheapMid: 0.05,
      sigLiquidity: 500,
      sigVol24h: 100,
      sigFeaturesAt: "2026-07-01T00:00:00.000Z",
    };
    expect(clob.volume24hr).toBe(42);
    expect(sig.sigCheapMid).toBe(0.05);
  });
});
