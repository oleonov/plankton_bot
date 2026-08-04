import type { SellableFlowPolicy } from "@krabs/domain";
import { describe, expect, it } from "vitest";

import { isBounceLadderEligible } from "../../bounce-eligibility.js";

/**
 * Release A Phase 6 §7 test 1 — the FROZEN behaviour vector for the §2.6 extraction.
 *
 * `isBounceLadderEligible` was extracted from three byte-identical copies
 * (decision-planner.ts, algo-decision-module.ts, resolve-new-position-exit-owner.ts).
 * The extraction is a pure refactor: the census is the 4th use site, and a divergent copy
 * would mis-assign IMMUTABLE ownership. This vector is what makes "pure" checkable —
 * every expected boolean below was PRODUCED BY the pre-refactor `decision-planner.ts`
 * predicate, executed, not transcribed by hand.
 *
 * Provenance of the expectations:
 *   generated_from : apps/runtime/src/modules/algo-decision/decision-planner.ts
 *                    (function isBounceLadderEligiblePosition, pre-extraction)
 *   oracle_sha256  : 3f7a17d0f9d7caaa0434aa9a110104d34f9514855f699bc0c43a00b3ea5dac5c
 *                    — sha256 of the predicate text SLICED VERBATIM out of that file at
 *                    generation time, so a later reader can prove which implementation
 *                    emitted these booleans.
 *   cutoff_ms      : 1784505600000 === Date.parse("2026-07-20T00:00:00.000Z")
 *
 * The generator (kept here so the vector is reproducible, not folklore): it read the
 * pre-refactor source, sliced the function from `function isBounceLadderEligiblePosition(`
 * to the first bare `}` line, wrote it out under structural shims for `Position` /
 * `ExecutionPolicy`, `require()`d that module, and mapped the case table through it:
 *
 *   const startIdx = source.indexOf("function isBounceLadderEligiblePosition(");
 *   const fnText = source.slice(startIdx, source.indexOf("\n}\n", startIdx) + 3);
 *   const oracle = require(writeShimModule(fnText)).default;
 *   const vector = CASES.map((c) =>
 *     oracle({ entryLane: c.entryLane, openedAt: c.openedAt }, c.policy, c.firstTradeAt));
 *
 * DO NOT "fix" a failing row by editing the expectation. A red row means the extracted
 * predicate no longer agrees with the shipped one — that is the defect this test exists
 * to catch.
 */

const CUTOFF_MS = Date.parse("2026-07-20T00:00:00.000Z"); // 1784505600000
const AT = new Date(CUTOFF_MS).toISOString();
const BEFORE = new Date(CUTOFF_MS - 1).toISOString();
const AFTER = new Date(CUTOFF_MS + 60_000).toISOString();

const ON: SellableFlowPolicy = {
  enabled: true,
  buffer: 1.2,
  maxEntryUsdc: 5,
  appliesFromMs: CUTOFF_MS,
};

type Case = {
  name: string;
  entryLane: "GATE" | "R23" | null | undefined;
  openedAt: string;
  firstTradeAt: string | null;
  sellableFlow: SellableFlowPolicy | null | undefined;
  expected: boolean;
};

const FROZEN_VECTOR: readonly Case[] = [
  {
    name: "GATE lane, flow disabled — always eligible",
    entryLane: "GATE",
    openedAt: BEFORE,
    firstTradeAt: BEFORE,
    sellableFlow: { ...ON, enabled: false, appliesFromMs: null },
    expected: true,
  },
  {
    name: "GATE lane, no policy at all",
    entryLane: "GATE",
    openedAt: "not-a-date",
    firstTradeAt: null,
    sellableFlow: null,
    expected: true,
  },
  {
    name: "R23 lane, flow enabled, both timestamps after cutoff",
    entryLane: "R23",
    openedAt: AFTER,
    firstTradeAt: AFTER,
    sellableFlow: ON,
    expected: true,
  },
  {
    name: "null lane, flow enabled, both after cutoff",
    entryLane: null,
    openedAt: AFTER,
    firstTradeAt: AFTER,
    sellableFlow: ON,
    expected: true,
  },
  {
    name: "undefined lane, flow enabled, both after cutoff",
    entryLane: undefined,
    openedAt: AFTER,
    firstTradeAt: AFTER,
    sellableFlow: ON,
    expected: true,
  },
  {
    name: "== boundary: BOTH timestamps exactly at cutoff",
    entryLane: "R23",
    openedAt: AT,
    firstTradeAt: AT,
    sellableFlow: ON,
    expected: true,
  },
  {
    name: "== boundary: openedAt at cutoff, firstTradeAt after",
    entryLane: "R23",
    openedAt: AT,
    firstTradeAt: AFTER,
    sellableFlow: ON,
    expected: true,
  },
  {
    name: "== boundary: openedAt after, firstTradeAt at cutoff",
    entryLane: "R23",
    openedAt: AFTER,
    firstTradeAt: AT,
    sellableFlow: ON,
    expected: true,
  },
  {
    name: "one ms before: BOTH timestamps",
    entryLane: "R23",
    openedAt: BEFORE,
    firstTradeAt: BEFORE,
    sellableFlow: ON,
    expected: false,
  },
  {
    name: "one ms before: openedAt only",
    entryLane: "R23",
    openedAt: BEFORE,
    firstTradeAt: AFTER,
    sellableFlow: ON,
    expected: false,
  },
  {
    name: "one ms before: firstTradeAt only",
    entryLane: "R23",
    openedAt: AFTER,
    firstTradeAt: BEFORE,
    sellableFlow: ON,
    expected: false,
  },
  {
    name: "missing leg state — firstTradeAt null",
    entryLane: "R23",
    openedAt: AFTER,
    firstTradeAt: null,
    sellableFlow: ON,
    expected: false,
  },
  {
    name: "unparseable openedAt",
    entryLane: "R23",
    openedAt: "not-a-date",
    firstTradeAt: AFTER,
    sellableFlow: ON,
    expected: false,
  },
  {
    name: "unparseable firstTradeAt",
    entryLane: "R23",
    openedAt: AFTER,
    firstTradeAt: "not-a-date",
    sellableFlow: ON,
    expected: false,
  },
  {
    name: "sellableFlow disabled",
    entryLane: "R23",
    openedAt: AFTER,
    firstTradeAt: AFTER,
    sellableFlow: { ...ON, enabled: false },
    expected: false,
  },
  {
    name: "appliesFromMs null (parser forces off)",
    entryLane: "R23",
    openedAt: AFTER,
    firstTradeAt: AFTER,
    sellableFlow: { ...ON, appliesFromMs: null },
    expected: false,
  },
  {
    // The two nullish forms are distinct at the CALL SITES: `policy?.sellableFlow` yields
    // `undefined` for a policy with no sellableFlow, and the census may hold no policy at
    // all. Both must fail closed.
    name: "no sellableFlow on the policy (undefined)",
    entryLane: "R23",
    openedAt: AFTER,
    firstTradeAt: AFTER,
    sellableFlow: undefined,
    expected: false,
  },
  {
    name: "null executionPolicy (null sellableFlow)",
    entryLane: "R23",
    openedAt: AFTER,
    firstTradeAt: AFTER,
    sellableFlow: null,
    expected: false,
  },
];

describe("isBounceLadderEligible — frozen behaviour vector (§2.6 extraction)", () => {
  it("has not silently lost a case", () => {
    expect(FROZEN_VECTOR).toHaveLength(18);
  });

  it.each(FROZEN_VECTOR.map((c, i) => [i, c.name, c] as const))("case %i — %s", (_i, _name, c) => {
    expect(
      isBounceLadderEligible(
        { entryLane: c.entryLane, openedAt: c.openedAt, firstTradeAt: c.firstTradeAt },
        c.sellableFlow,
      ),
    ).toBe(c.expected);
  });

  it("matches the whole vector at once (guards against a skipped it.each row)", () => {
    const actual = FROZEN_VECTOR.map((c) =>
      isBounceLadderEligible(
        { entryLane: c.entryLane, openedAt: c.openedAt, firstTradeAt: c.firstTradeAt },
        c.sellableFlow,
      ),
    );
    expect(actual).toEqual(FROZEN_VECTOR.map((c) => c.expected));
  });
});
