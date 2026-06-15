import { describe, expect, it, vi } from "vitest";
import { reduceProfileState } from "../profile-state-reducer.js";
import type { ExecutionProfileStateRecord } from "../types.js";
import { createTokenId, createConditionId } from "@krabs/domain";

const tokenId = createTokenId("profile-token");
const conditionId = createConditionId("profile-condition");
const ASSUMED = "2026-06-14T00:00:00.000Z";
const EVENT_MS = Date.parse("2026-06-14T01:00:00.000Z");

function record(state: ExecutionProfileStateRecord["state"]): ExecutionProfileStateRecord {
  return {
    tokenId,
    conditionId,
    profile: "medium",
    state,
    assumedAt: ASSUMED,
    lastAvgEntry: 0.12,
    lastTransitionAt: ASSUMED,
    activeLadderId: null,
    handoffStartedAt: null,
    addCount: 0,
    lastBuyAtMs: null,
    initialProbeSizeUsd: null,
    metadata: null,
    createdAt: ASSUMED,
    updatedAt: ASSUMED,
  };
}

function event(type: Parameters<typeof reduceProfileState>[1]["type"]) {
  return { type, tokenId, occurredAtMs: EVENT_MS, payload: {} } as Parameters<
    typeof reduceProfileState
  >[1];
}

describe("reduceProfileState", () => {
  it("handles null-state first encounters", () => {
    expect(reduceProfileState(null, event("position_adopted")).next?.state).toBe("EXITING");
    expect(reduceProfileState(null, event("buy_fill_received")).next?.state).toBe("PROBING");
  });

  it("covers core lifecycle transitions", () => {
    expect(reduceProfileState(record("SCANNING"), event("buy_fill_received")).next?.state).toBe(
      "PROBING",
    );
    expect(reduceProfileState(record("PROBING"), event("buy_fill_received")).next?.state).toBe(
      "ACCUMULATING",
    );
    expect(
      reduceProfileState(record("PROBING"), event("sell_lifecycle_activated")).next?.state,
    ).toBe("EXITING");
    expect(
      reduceProfileState(record("ACCUMULATING"), event("sell_lifecycle_activated")).next?.state,
    ).toBe("EXITING");
    expect(reduceProfileState(record("PROBING"), event("qd_handoff_started")).next?.state).toBe(
      "QD_HANDOFF",
    );
    expect(
      reduceProfileState(record("ACCUMULATING"), event("qd_handoff_started")).next?.state,
    ).toBe("QD_HANDOFF");
    expect(reduceProfileState(record("EXITING"), event("qd_handoff_started")).next?.state).toBe(
      "QD_HANDOFF",
    );
    expect(reduceProfileState(record("QD_HANDOFF"), event("position_closed")).next?.state).toBe(
      "CLOSED",
    );
  });

  it("closes and abandons non-closed states", () => {
    for (const state of [
      "SCANNING",
      "PROBING",
      "ACCUMULATING",
      "EXITING",
      "QD_HANDOFF",
      "ABANDONED",
    ] as const) {
      expect(reduceProfileState(record(state), event("position_settled")).next?.state).toBe(
        "CLOSED",
      );
    }
    for (const state of ["SCANNING", "PROBING", "ACCUMULATING", "EXITING", "QD_HANDOFF"] as const) {
      expect(reduceProfileState(record(state), event("abandonment_triggered")).next?.state).toBe(
        "ABANDONED",
      );
    }
  });

  it("rejects invalid terminal transitions", () => {
    expect(reduceProfileState(record("CLOSED"), event("buy_fill_received")).rejected).toBe(true);
    expect(reduceProfileState(record("ABANDONED"), event("buy_fill_received")).rejected).toBe(true);
    expect(reduceProfileState(record("QD_HANDOFF"), event("buy_fill_received")).rejected).toBe(
      true,
    );
  });

  it("is deterministic and uses occurredAtMs instead of Date.now", () => {
    const nowSpy = vi.spyOn(Date, "now");
    const result = reduceProfileState(record("EXITING"), event("qd_handoff_started"));

    expect(nowSpy).not.toHaveBeenCalled();
    expect(result.next?.lastTransitionAt).toBe(new Date(EVENT_MS).toISOString());
    expect(result.effects.map((effect) => effect.type)).toContain("persist_state");

    nowSpy.mockRestore();
  });
});
