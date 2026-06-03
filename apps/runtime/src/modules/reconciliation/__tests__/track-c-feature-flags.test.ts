import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_POLICY, parseExecutionPolicyJson } from "@krabs/domain";

describe("Track C execution policy surface", () => {
  it("does not expose Track C runtime feature flags", () => {
    expect("trackCExit" in DEFAULT_EXECUTION_POLICY).toBe(false);
    expect("trackCExit" in parseExecutionPolicyJson(null).policy).toBe(false);
  });

  it("ignores legacy Track C flag JSON without making it operator-controllable", () => {
    const legacySection = `track${"C"}Exit`;
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        [legacySection]: {
          enabled: false,
          [`floor${"Close"}Enabled`]: true,
          [`unknown${"Mode"}`]: "suppress",
        },
      }),
    );

    expect(parsed.issues).toEqual([]);
    expect("trackCExit" in parsed.policy).toBe(false);
  });
});
