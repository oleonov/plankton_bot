import { describe, expect, it } from "vitest";
import { createTokenId } from "@krabs/domain";

import { createStubScaleInSignalSource } from "../signal-feed-stub.js";

describe("createStubScaleInSignalSource", () => {
  it("returns zeroed rolling signals for safe bounded behavior", () => {
    const source = createStubScaleInSignalSource();

    expect(source.getSignalSnapshot(createTokenId("stub-token"))).toEqual({
      recovery60: 0,
      range60: 0,
      std60: 0,
      tradeCount3h: 0,
      notional3h: 0,
    });
  });
});
