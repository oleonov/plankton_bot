import { describe, expect, it } from "vitest";
import { createTokenId } from "@krabs/domain";
import {
  InMemoryProfileOwnershipReader,
  createS1OwnershipAdapter,
} from "../profile-ownership-reader.js";
import type { ProfileSnapshot } from "../types.js";

const tokenId = createTokenId("owned-token");

function snapshot(
  state: ProfileSnapshot["state"],
  overrides: Partial<ProfileSnapshot> = {},
): ProfileSnapshot {
  return {
    tokenId,
    profile: "cheap",
    state,
    assumedAt: "2026-06-14T00:00:00.000Z",
    lastTransitionAt: "2026-06-14T00:00:00.000Z",
    activeLadderId: "ladder-1",
    ...overrides,
  };
}

describe("ProfileOwnershipReader", () => {
  it("treats ABANDONED as owned and CLOSED/SCANNING as unowned", () => {
    const reader = new InMemoryProfileOwnershipReader();

    for (const state of [
      "PROBING",
      "ACCUMULATING",
      "EXITING",
      "QD_HANDOFF",
      "ABANDONED",
      "ABANDONED_DORMANT",
    ] as const) {
      reader.setSnapshot(snapshot(state));
      expect(reader.isProfileOwned(tokenId)).toBe(true);
    }

    for (const state of ["SCANNING", "CLOSED"] as const) {
      reader.setSnapshot(snapshot(state));
      expect(reader.isProfileOwned(tokenId)).toBe(false);
    }

    reader.deleteSnapshot(tokenId);
    expect(reader.isProfileOwned(tokenId)).toBe(false);
  });

  it("returns snapshots without repository I/O", () => {
    const reader = new InMemoryProfileOwnershipReader([snapshot("EXITING")]);

    expect(reader.getSnapshot(tokenId)).toMatchObject({
      profile: "cheap",
      state: "EXITING",
      activeLadderId: "ladder-1",
    });
  });

  it("maps profile snapshots to the legacy S1 ownership shape through an adapter", () => {
    const reader = new InMemoryProfileOwnershipReader([snapshot("QD_HANDOFF")]);
    const adapter = createS1OwnershipAdapter(reader);

    expect(adapter.getSnapshot(tokenId)).toEqual({
      owned: true,
      ladderId: "ladder-1",
      assumedAtMs: Date.parse("2026-06-14T00:00:00.000Z"),
      reason: "handoff",
    });
  });
});
