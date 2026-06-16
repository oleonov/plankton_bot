import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("DustAutoCloseModule runtime wiring", () => {
  it("uses the wide ExecutionProfileManager ownership predicate, not sell-ladder ownership", () => {
    const indexSource = readFileSync(new URL("../../../index.ts", import.meta.url), "utf-8");
    const s4Start = indexSource.indexOf("new DustAutoCloseModule");
    const s4End = indexSource.indexOf("const s1LadderModule", s4Start);
    const s4Wiring = indexSource.slice(s4Start, s4End);

    expect(s4Wiring).toContain(
      "isProfileOwned: (tokenId) => executionProfileManager.isProfileOwned(tokenId)",
    );
    expect(s4Wiring).not.toContain("sellLadder.enabled &&");
    expect(s4Wiring).not.toContain("profileLadderRepo.isProfileLadderOwned(tokenId)");
  });
});
