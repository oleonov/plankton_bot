import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_HYSTERESIS, resolveProfile } from "../profile-resolver.js";

describe("resolveProfile", () => {
  it("assigns a first-time profile on half-open boundaries", () => {
    expect(
      resolveProfile({
        currentProfile: null,
        avgEntry: 0.049999,
        config: DEFAULT_PROFILE_HYSTERESIS,
      }),
    ).toMatchObject({
      profile: "cheap",
      changed: true,
    });
    expect(
      resolveProfile({ currentProfile: null, avgEntry: 0.05, config: DEFAULT_PROFILE_HYSTERESIS }),
    ).toMatchObject({
      profile: "medium",
      changed: true,
    });
    expect(
      resolveProfile({
        currentProfile: null,
        avgEntry: 0.349999,
        config: DEFAULT_PROFILE_HYSTERESIS,
      }),
    ).toMatchObject({
      profile: "medium",
      changed: true,
    });
    expect(
      resolveProfile({ currentProfile: null, avgEntry: 0.35, config: DEFAULT_PROFILE_HYSTERESIS }),
    ).toMatchObject({
      profile: "expensive",
      changed: true,
    });
  });

  it("rejects invalid average entries", () => {
    for (const avgEntry of [Number.NaN, Number.POSITIVE_INFINITY, 0, -0.1]) {
      expect(
        resolveProfile({ currentProfile: null, avgEntry, config: DEFAULT_PROFILE_HYSTERESIS }),
      ).toEqual({
        profile: null,
        changed: false,
        reason: "invalid_avg_entry",
      });
    }
  });

  it("uses configured cheap/medium hysteresis bounds", () => {
    const config = {
      cheapMediumLow: 0.04,
      cheapMediumHigh: 0.06,
      mediumExpensiveLow: 0.325,
      mediumExpensiveHigh: 0.375,
    };

    expect(resolveProfile({ currentProfile: "cheap", avgEntry: 0.0599, config })).toMatchObject({
      profile: "cheap",
      changed: false,
    });
    expect(resolveProfile({ currentProfile: "cheap", avgEntry: 0.06, config })).toMatchObject({
      profile: "medium",
      changed: true,
    });
    expect(resolveProfile({ currentProfile: "medium", avgEntry: 0.04, config })).toMatchObject({
      profile: "medium",
      changed: false,
    });
    expect(resolveProfile({ currentProfile: "medium", avgEntry: 0.0399, config })).toMatchObject({
      profile: "cheap",
      changed: true,
    });
  });

  it("uses configured medium/expensive hysteresis bounds", () => {
    const config = {
      cheapMediumLow: 0.045,
      cheapMediumHigh: 0.055,
      mediumExpensiveLow: 0.3,
      mediumExpensiveHigh: 0.4,
    };

    expect(resolveProfile({ currentProfile: "medium", avgEntry: 0.3999, config })).toMatchObject({
      profile: "medium",
      changed: false,
    });
    expect(resolveProfile({ currentProfile: "medium", avgEntry: 0.4, config })).toMatchObject({
      profile: "expensive",
      changed: true,
    });
    expect(resolveProfile({ currentProfile: "expensive", avgEntry: 0.3, config })).toMatchObject({
      profile: "expensive",
      changed: false,
    });
    expect(resolveProfile({ currentProfile: "expensive", avgEntry: 0.2999, config })).toMatchObject(
      {
        profile: "medium",
        changed: true,
      },
    );
  });

  it("prevents oscillation inside the default cheap/medium band", () => {
    let profile: "cheap" | "medium" | "expensive" | null = "cheap";
    for (const avgEntry of [0.051, 0.049, 0.054, 0.046, 0.052]) {
      const result = resolveProfile({
        currentProfile: profile,
        avgEntry,
        config: DEFAULT_PROFILE_HYSTERESIS,
      });
      profile = result.profile;
      expect(profile).toBe("cheap");
    }
  });
});
