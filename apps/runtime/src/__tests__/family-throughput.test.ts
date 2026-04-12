import { describe, expect, it } from "vitest";
import { createFamilyId, type FamilyRuleBundle } from "@plankton/domain";
import {
  isFastLaneEnabled,
  resolveFamilySpeedTier,
  resolveFamilySpeedTierByFamilyKey,
  resolveFamilyThroughputTierByFamilyKey,
  resolveFamilyThroughputPolicy,
} from "../family-throughput.js";

function makeBundle(
  familyKey: string,
  throughput?: FamilyRuleBundle["rules"]["throughput"],
): FamilyRuleBundle {
  return {
    identity: {
      familyId: createFamilyId(`${familyKey}:generic:daily`),
      familyKey,
    },
    rules: { throughput },
  } as FamilyRuleBundle;
}

describe("resolveFamilyThroughputPolicy", () => {
  it("uses core and reduced tier fallbacks when no override is configured", () => {
    expect(resolveFamilyThroughputPolicy(makeBundle("bitcoin-price"))).toMatchObject({
      maxConcurrentOrdersPerFamily: 10,
      maxProbeInFlightPerToken: 2,
      maxEntrySignalsPerTickPerFamily: 1,
      source: "core",
    });
    expect(resolveFamilyThroughputPolicy(makeBundle("ethereum-price"))).toMatchObject({
      maxConcurrentOrdersPerFamily: 3,
      maxProbeInFlightPerToken: 1,
      maxEntrySignalsPerTickPerFamily: 1,
      source: "reduced",
    });
  });

  it("lets configured values override the family tier fallback selectively", () => {
    expect(
      resolveFamilyThroughputPolicy(
        makeBundle("unknown-family", {
          maxConcurrentOrdersPerFamily: 50,
          maxProbeInFlightPerToken: null,
          maxEntrySignalsPerTickPerFamily: 20,
        }),
      ),
    ).toEqual({
      maxConcurrentOrdersPerFamily: 50,
      maxProbeInFlightPerToken: 1,
      maxEntrySignalsPerTickPerFamily: 20,
      source: "configured",
    });
  });
});

describe("family speed helpers", () => {
  it("classifies proven fast families separately from generic tiers", () => {
    expect(resolveFamilyThroughputTierByFamilyKey("bitcoin-price")).toBe("core");
    expect(resolveFamilyThroughputTierByFamilyKey("ethereum-price")).toBe("reduced");
    expect(resolveFamilyThroughputTierByFamilyKey("donald-trump-of-truth-social-posts")).toBe(
      "reduced",
    );
    expect(resolveFamilyThroughputTierByFamilyKey("highest-temperature-in-nyc")).toBe("reduced");
    expect(resolveFamilyThroughputTierByFamilyKey("unknown-family")).toBe("fallback");

    expect(resolveFamilySpeedTierByFamilyKey("bitcoin-price", true)).toBe("core-fast");
    expect(resolveFamilySpeedTierByFamilyKey("will-bitcoin-reach", true)).toBe("reduced-fast");
    expect(resolveFamilySpeedTierByFamilyKey("bitcoin-above", true)).toBe("reduced-fast");
    expect(resolveFamilySpeedTierByFamilyKey("donald-trump-of-truth-social-posts", true)).toBe(
      "reduced-fast",
    );
    expect(resolveFamilySpeedTierByFamilyKey("highest-temperature-in-london", true)).toBe(
      "reduced-fast",
    );
    expect(resolveFamilySpeedTierByFamilyKey("highest-temperature-in-seoul", true)).toBe(
      "reduced-fast",
    );
  });

  it("derives fast-lane status from throughput config instead of hardcoded family lists", () => {
    const fastBundle = makeBundle("bitcoin-price", {
      maxConcurrentOrdersPerFamily: 50,
      maxProbeInFlightPerToken: 2,
      maxEntrySignalsPerTickPerFamily: 20,
      fastLaneEnabled: true,
    });
    const standardBundle = makeBundle("bitcoin-price", {
      maxConcurrentOrdersPerFamily: 50,
      maxProbeInFlightPerToken: 2,
      maxEntrySignalsPerTickPerFamily: 20,
      fastLaneEnabled: false,
    });

    expect(isFastLaneEnabled(fastBundle)).toBe(true);
    expect(resolveFamilySpeedTier(fastBundle)).toBe("core-fast");
    expect(isFastLaneEnabled(standardBundle)).toBe(false);
    expect(resolveFamilySpeedTier(standardBundle)).toBe("standard");
  });
});
