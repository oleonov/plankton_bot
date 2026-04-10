import { describe, expect, it } from "vitest";
import { createFamilyId, type FamilyRuleBundle } from "@plankton/domain";
import { resolveFamilyThroughputPolicy } from "../family-throughput.js";

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
