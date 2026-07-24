import { describe, expect, it } from "vitest";
import type { ExecutionPolicy } from "@krabs/domain";
import { resolveNewPositionExitOwner } from "../modules/exit-ownership/resolve-new-position-exit-owner.js";

const CUTOFF_MS = Date.parse("2026-07-01T00:00:00.000Z");
const AFTER = "2026-07-24T00:00:00.000Z"; // > cutoff
const BEFORE = "2026-06-01T00:00:00.000Z"; // < cutoff
const CID = "0xwhitelisted";

function policy(overrides: {
  enabled?: boolean;
  mode?: "off" | "shadow" | "micro_live";
  whitelist?: string[];
  applyToAllMarkets?: boolean;
  sellableEnabled?: boolean;
  appliesFromMs?: number | null;
}): ExecutionPolicy {
  return {
    bounceExit: {
      enabled: overrides.enabled ?? true,
      mode: overrides.mode ?? "micro_live",
      whitelistConditionIds: overrides.whitelist ?? [CID],
      ...(overrides.applyToAllMarkets !== undefined
        ? { applyToAllMarkets: overrides.applyToAllMarkets }
        : {}),
    },
    sellableFlow: {
      enabled: overrides.sellableEnabled ?? true,
      appliesFromMs: overrides.appliesFromMs === undefined ? CUTOFF_MS : overrides.appliesFromMs,
    },
  } as unknown as ExecutionPolicy;
}

const base = { conditionId: CID, openedAt: AFTER, firstTradeAt: AFTER };

describe("resolveNewPositionExitOwner (Release A Phase 2)", () => {
  it("bounce engine off/disabled → profile", () => {
    expect(
      resolveNewPositionExitOwner({ ...base, entryLane: "GATE" }, policy({ enabled: false })),
    ).toBe("profile");
    expect(
      resolveNewPositionExitOwner({ ...base, entryLane: "GATE" }, policy({ mode: "shadow" })),
    ).toBe("profile");
    expect(resolveNewPositionExitOwner({ ...base, entryLane: "GATE" }, null)).toBe("profile");
  });

  it("GATE lane + enabled micro_live + whitelisted → bounce (mirrors today's routing)", () => {
    expect(resolveNewPositionExitOwner({ ...base, entryLane: "GATE" }, policy({}))).toBe("bounce");
  });

  it("GATE lane but NOT whitelisted → profile (Phase 2 mirrors today: whitelist only)", () => {
    expect(
      resolveNewPositionExitOwner(
        { ...base, entryLane: "GATE" },
        policy({ whitelist: ["0xother"] }),
      ),
    ).toBe("profile");
    // applyToAllMarkets must NOT broaden in Phase 2 — it lands atomically with the
    // Phase-5 owner-driven routing. A non-whitelisted market stays profile even if
    // the (undeclared) flag were somehow set.
    expect(
      resolveNewPositionExitOwner(
        { ...base, entryLane: "GATE" },
        policy({ whitelist: ["0xother"], applyToAllMarkets: true }),
      ),
    ).toBe("profile");
  });

  it("non-GATE + sellableFlow enabled + post-cutoff + whitelisted → bounce", () => {
    expect(resolveNewPositionExitOwner({ ...base, entryLane: null }, policy({}))).toBe("bounce");
    expect(resolveNewPositionExitOwner({ ...base, entryLane: "R23" }, policy({}))).toBe("bounce");
  });

  it("non-GATE + sellableFlow disabled → profile", () => {
    expect(
      resolveNewPositionExitOwner({ ...base, entryLane: null }, policy({ sellableEnabled: false })),
    ).toBe("profile");
  });

  it("non-GATE pre-cutoff (opened/firstTrade before appliesFromMs) → profile", () => {
    expect(
      resolveNewPositionExitOwner(
        { conditionId: CID, entryLane: null, openedAt: BEFORE, firstTradeAt: BEFORE },
        policy({}),
      ),
    ).toBe("profile");
  });

  it("GATE lane is eligible regardless of sellableFlow/cutoff", () => {
    expect(
      resolveNewPositionExitOwner(
        { conditionId: CID, entryLane: "GATE", openedAt: BEFORE, firstTradeAt: BEFORE },
        policy({ sellableEnabled: false }),
      ),
    ).toBe("bounce");
  });
});
