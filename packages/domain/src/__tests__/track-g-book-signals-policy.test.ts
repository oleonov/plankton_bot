import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_POLICY, parseExecutionPolicyJson } from "../execution-policy.js";

describe("Track G book signals execution policy surface", () => {
  it("does not expose a book-signals feature flag", () => {
    expect("trackG" in DEFAULT_EXECUTION_POLICY).toBe(false);
    expect("trackG" in parseExecutionPolicyJson(null).policy).toBe(false);
  });

  it("ignores legacy Track G flag JSON without making it operator-controllable", () => {
    const legacySection = `track${"G"}`;
    const legacyBookSignals = `book${"Signals"}`;
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        [legacySection]: {
          [legacyBookSignals]: {
            enabled: false,
          },
        },
      }),
    );

    expect(parsed.issues).toEqual([]);
    expect("trackG" in parsed.policy).toBe(false);
  });
});
