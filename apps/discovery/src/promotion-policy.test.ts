import { describe, expect, it } from "vitest";
import {
  DISCOVERY_SCAN_INTERVAL_MS,
  DISMISSED_PROPOSAL_COOLDOWN_MS,
  PROMOTION_EVALUATION_INTERVAL_MS,
  recentDismissalCutoffIso,
} from "./promotion-policy.js";

describe("promotion policy", () => {
  it("keeps promotion reevaluation faster than full discovery scans", () => {
    expect(PROMOTION_EVALUATION_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(DISCOVERY_SCAN_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(PROMOTION_EVALUATION_INTERVAL_MS).toBeLessThan(DISCOVERY_SCAN_INTERVAL_MS);
  });

  it("uses a one-hour dismiss cooldown", () => {
    expect(DISMISSED_PROPOSAL_COOLDOWN_MS).toBe(60 * 60 * 1000);
    expect(recentDismissalCutoffIso(new Date("2026-04-03T12:00:00.000Z"), 15 * 60 * 1000)).toBe(
      "2026-04-03T11:45:00.000Z",
    );
  });
});
