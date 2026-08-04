import { describe, expect, it } from "vitest";

import { decideCensus } from "../decide.js";
import { evaluateCensusGates } from "../gates.js";
import { renderCensusReport } from "../report.js";
import {
  AFTER_CUTOFF,
  BEFORE_CUTOFF,
  OTHER_CONDITION,
  WHITELISTED_CONDITION,
  policyJson,
  seedSql,
} from "./fixtures.js";
import { gateById, ownerPlan, runCensus } from "./pipeline.js";

/**
 * §7 tests 2, 4, 5 and 14a — the decision pass and the three gates that are about the DECISION rather than
 * about the ledger's invariants: the parser, the cross-check, and the authoritative market condition.
 *
 * §2.2 is the property test 2 exists for: a dust row, a zero-size row and a row with no `leg_states` entry
 * are all ordinary targets. They get an owner like every other target — "unusual" is not a census verdict,
 * and a row the census silently skipped would be left NULL by a run that reported success.
 */

interface TargetSpec {
  readonly positionId?: string;
  readonly tokenId?: string;
  /** The AUTHORITATIVE `markets.condition_id` (§2.3). `null` seeds no `markets` row at all. */
  readonly marketCondition?: string | null;
  readonly entryLane?: string | null;
  readonly openedAt?: string;
  /** `null` seeds no `leg_states` row — §2.2's "missing leg state". */
  readonly firstTradeAt?: string | null;
  readonly status?: string;
  readonly size?: number;
}

/**
 * ONE target, with `positions.condition_id` deliberately populated to the authoritative value: the
 * condition-evidence gates are test 3's and 14's subject, and leaving them on the happy path here is what
 * keeps a test 2 failure readable as a decision failure.
 */
function oneTarget(spec: TargetSpec = {}): string {
  const tokenId = spec.tokenId ?? "tok-1";
  const marketCondition =
    spec.marketCondition === undefined ? WHITELISTED_CONDITION : spec.marketCondition;
  const firstTradeAt = spec.firstTradeAt === undefined ? AFTER_CUTOFF : spec.firstTradeAt;
  return seedSql({
    markets: marketCondition === null ? [] : [{ tokenId, conditionId: marketCondition }],
    positions: [
      {
        positionId: spec.positionId ?? "pos-1",
        tokenId,
        // `''` when there is no market row: a populated value with no authoritative counterpart is
        // test 14's contradiction case, not test 2's.
        conditionId: marketCondition ?? "",
        entryLane: spec.entryLane === undefined ? "R23" : spec.entryLane,
        openedAt: spec.openedAt ?? AFTER_CUTOFF,
        ...(spec.status === undefined ? {} : { status: spec.status }),
        ...(spec.size === undefined ? {} : { size: spec.size }),
      },
    ],
    legStates: firstTradeAt === null ? [] : [{ tokenId, firstTradeAt }],
    // A BUY, so the absent-`condition_id` seeds carry the order evidence §2.3 requires without creating
    // an active SELL that I1–I3/I5 would then read.
    orders: [
      {
        orderId: `o-${tokenId}`,
        tokenId,
        side: "buy",
        status: "filled",
        ...(marketCondition === null ? { conditionId: "" } : { conditionId: marketCondition }),
      },
    ],
  });
}

describe("§7.2 — the decision pass", () => {
  it("a whitelisted condition on an eligible lane is bounce", () => {
    const { decision } = runCensus(oneTarget());
    expect(decision.decisions).toHaveLength(1);
    expect(decision.decisions[0]?.owner).toBe("bounce");
    expect(decision.decisions[0]?.reason).toBe("sellableFlow cutoff met, whitelisted");
    expect(decision.counts).toEqual({ bounce: 1, profile: 0 });
  });

  it("a condition outside the whitelist is profile", () => {
    const { decision } = runCensus(oneTarget({ marketCondition: OTHER_CONDITION }));
    expect(decision.decisions[0]?.owner).toBe("profile");
    expect(decision.decisions[0]?.reason).toBe("condition not in bounceExit.whitelistConditionIds");
  });

  it("bounceExit.enabled = false makes every target profile", () => {
    const { decision } = runCensus(oneTarget(), { policy: policyJson({ enabled: false }) });
    expect(decision.decisions[0]?.owner).toBe("profile");
    expect(decision.decisions[0]?.reason).toBe("bounceExit.enabled = false");
  });

  // `off` is the ONLY other value in `BOUNCE_EXIT_MODES`, so an out-of-domain string here would be a
  // parser test in a mode test's clothes: the enum fallback would pick the verdict, not this branch.
  it("a mode other than micro_live makes every target profile", () => {
    const { decision } = runCensus(oneTarget(), { policy: policyJson({ mode: "off" }) });
    expect(decision.policyIssues).toEqual([]);
    expect(decision.decisions[0]?.owner).toBe("profile");
    expect(decision.decisions[0]?.reason).toBe("bounceExit.mode = off");
  });

  /**
   * §2.2's three "unusual" row classes. The assertion that matters is not the owner but that there IS one,
   * and that `target-set-completeness` still passes — a row the census dropped would leave the invariant
   * evaluator with an uncovered NULL owner, which is the observable form of a silent skip.
   */
  it.each([
    { label: "a dust row", spec: { status: "dust" }, owner: "bounce" },
    { label: "an open row with size 0", spec: { size: 0 }, owner: "bounce" },
    { label: "a row with no leg_states entry", spec: { firstTradeAt: null }, owner: "profile" },
    {
      label: "a GATE-lane row with no leg_states entry",
      spec: { firstTradeAt: null, entryLane: "GATE" },
      owner: "bounce",
    },
  ])("$label still gets an owner (§2.2)", ({ spec, owner }) => {
    const { decision, gates } = runCensus(oneTarget(spec));
    expect(ownerPlan(decision)).toEqual({ "pos-1": owner });
    expect(gateById(gates, "target-set-completeness").passed).toBe(true);
    expect(gates.blocked).toBe(false);
  });

  it("the sellableFlow cutoff is the reason a pre-cutoff R23 row is profile, not an absent owner", () => {
    const { decision } = runCensus(oneTarget({ openedAt: BEFORE_CUTOFF }));
    expect(decision.decisions[0]?.owner).toBe("profile");
    expect(decision.decisions[0]?.reason).toBe(
      "not bounce-ladder eligible (lane/sellableFlow cutoff)",
    );
  });
});

describe("§7.4 — a parser issue blocks --apply while the report still renders", () => {
  /** Valid JSON that `parseExecutionPolicyJson` still complains about: `version` must be a number. */
  const policyWithBadVersion = (): string =>
    JSON.stringify({ ...(JSON.parse(policyJson()) as object), version: "oops" });

  it("blocks the whole run, and the per-row plan is still there to read", () => {
    const { decision, gates, loaded } = runCensus(oneTarget(), { policy: policyWithBadVersion() });

    expect(decision.policyIssues).toEqual(["version must be a finite number"]);
    const parser = gateById(gates, "parser");
    expect(parser.blocking).toBe(true);
    expect(parser.passed).toBe(false);
    expect(parser.offending).toEqual([{ issue: "version must be a finite number" }]);
    expect(gates.blocked).toBe(true);

    // The fallback the live provider would use is never adopted silently — but the operator still gets the
    // full picture, because a block that hides the plan cannot be diagnosed.
    const report = renderCensusReport({ loaded, decision, gates, artifacts: null });
    expect(report).toContain("=== per-row plan ===");
    expect(report).toContain("pos-1");
    expect(report).toContain("[BLOCK] #parser");
    expect(report).toContain("=> BLOCKED: --apply is refused");
  });

  it("the rest of the policy is still parsed, so the block is about the issue and nothing else", () => {
    const { decision, gates } = runCensus(oneTarget(), { policy: policyWithBadVersion() });
    // A run that fell back to DEFAULT_EXECUTION_POLICY wholesale would decide `profile` here and the
    // cross-check would fire too — masking which gate actually holds.
    expect(ownerPlan(decision)).toEqual({ "pos-1": "bounce" });
    expect(gates.gates.filter((g) => g.blocking && !g.passed).map((g) => g.id)).toEqual(["parser"]);
  });
});

describe("§7.5 — a TS/SQL disagreement blocks the whole run", () => {
  /**
   * The two projections are computed from the same manifest by two independent implementations, so a
   * disagreement cannot be seeded through the ledger — seeding one would have to break the other in the
   * same direction. The manifest is therefore mutated directly, which is the only construction that
   * isolates the gate from the two things it compares.
   */
  function withSqlOwner(
    seed: string,
    mutate: (rows: { positionId: string; owner: "bounce" | "profile" }[]) => void,
  ) {
    const { loaded } = runCensus(seed);
    const manifest = structuredClone(loaded.manifest);
    mutate(manifest.sqlOwnerProjection);
    const decision = decideCensus(manifest);
    return { gates: evaluateCensusGates(manifest, decision), decision };
  }

  it("names the row, both verdicts and the TS reason when SQL says the other owner", () => {
    const { gates } = withSqlOwner(oneTarget(), (rows) => {
      const row = rows[0];
      if (row !== undefined) row.owner = "profile";
    });

    const crossCheck = gateById(gates, "cross-check");
    expect(crossCheck.passed).toBe(false);
    expect(gates.blocked).toBe(true);
    expect(crossCheck.offending).toEqual([
      {
        position_id: "pos-1",
        ts_owner: "bounce",
        sql_owner: "profile",
        reason: "sellableFlow cutoff met, whitelisted",
      },
    ]);
  });

  it("a target the SQL projection has no row for at all fails loudly rather than comparing equal", () => {
    const { gates } = withSqlOwner(oneTarget(), (rows) => void rows.splice(0, rows.length));
    const crossCheck = gateById(gates, "cross-check");
    expect(crossCheck.passed).toBe(false);
    // `null`, not `undefined`: a shape difference must be legible in the report, and `undefined` would
    // vanish from the JSON line the operator reads.
    expect(crossCheck.offending[0]).toMatchObject({ position_id: "pos-1", sql_owner: null });
  });
});

describe("§7.14a — the authoritative market condition must EXIST (dry run)", () => {
  /**
   * The two admitting shapes, and they are two rather than three: `markets.condition_id` is `TEXT NOT NULL`
   * (`ledger.sql:12`), so a stored NULL cannot be seeded. A NULL in the manifest can therefore arise only
   * from §5.1.4's LEFT JOIN missing — which is precisely what the no-row seed exercises.
   */
  it.each([
    { label: "a markets row whose condition is ''", marketCondition: "", rowPresent: true },
    { label: "no markets row at all", marketCondition: null, rowPresent: false },
  ])("$label blocks the whole run and names the target", ({ marketCondition, rowPresent }) => {
    const { decision, gates, loaded } = runCensus(oneTarget({ marketCondition }));

    // §5.1.4 carries absence as DATA. An inner join would drop the row and the gate would pass vacuously.
    expect(loaded.manifest.targetMarkets).toEqual([
      {
        tokenId: "tok-1",
        marketConditionId: marketCondition,
        marketRowPresent: rowPresent,
      },
    ]);

    const gate = gateById(gates, "market-condition-absent");
    expect(gate.passed).toBe(false);
    expect(gates.blocked).toBe(true);
    expect(gate.offending).toEqual([
      { position_id: "pos-1", token_id: "tok-1", market_condition_id: marketCondition },
    ]);

    // The verdict is `profile` with a reason that says WHY — never a silent "not whitelisted".
    expect(decision.decisions[0]?.reason).toBe("authoritative markets.condition_id absent");
    const report = renderCensusReport({ loaded, decision, gates, artifacts: null });
    expect(report).toContain("=== per-row plan ===");
    expect(report).toContain("[BLOCK] #market-condition-absent");
  });

  it("specificity — a populated authoritative condition does not trip the gate", () => {
    const { gates } = runCensus(oneTarget());
    expect(gateById(gates, "market-condition-absent").passed).toBe(true);
    expect(gates.blocked).toBe(false);
  });

  it("a populated positions.condition_id contradicting markets.condition_id blocks too", () => {
    const { gates } = runCensus(
      seedSql({
        markets: [{ tokenId: "tok-1", conditionId: WHITELISTED_CONDITION }],
        positions: [
          { positionId: "pos-1", tokenId: "tok-1", conditionId: OTHER_CONDITION, entryLane: "R23" },
        ],
        legStates: [{ tokenId: "tok-1", firstTradeAt: AFTER_CUTOFF }],
      }),
    );
    const gate = gateById(gates, "market-condition-contradiction");
    expect(gate.passed).toBe(false);
    expect(gate.offending).toEqual([
      {
        position_id: "pos-1",
        token_id: "tok-1",
        position_condition_id: OTHER_CONDITION,
        market_condition_id: WHITELISTED_CONDITION,
      },
    ]);
  });
});

/**
 * §5.1 group 7 — an unreadable policy must still EXPORT, and each unreadable shape has exactly one owner.
 *
 * The load-bearing claim is that a manifest exists at all. Measured on the pinned 3.37.2, an unguarded
 * `json_extract('{', …)` aborts the whole export with `stepping, malformed JSON (1)` and exit 1, so the
 * operator gets no document and no diagnostic naming the policy — the one input class that most needs a
 * report is the one that produces none. Every row below runs through §5.1's real exporter, so all three
 * would fail at the export step if the `json_valid` guard were dropped.
 *
 * The blocking-id list is then asserted EXACTLY, which is what makes each gate demonstrably load-bearing —
 * most sharply for `'   '`, where the parser is SILENT (`parseExecutionPolicyJson` returns the defaults
 * with no issue for a blank string) and both sides agree on `profile`, so the blank gate is the only thing
 * between the operator and a run that read as perfectly clean.
 */
describe("§7.4b — an unreadable policy exports, and one gate owns each shape", () => {
  const CASES = [
    {
      label: "'{' — invalid JSON, which the parser DOES report",
      policy: "{",
      blocking: ["parser"],
    },
    {
      label: "'   ' — present and non-empty but blank, which the parser does NOT report",
      policy: "   ",
      blocking: ["policy-blank"],
    },
    {
      // §5.3 names `'   '` AND `''` as the one trim-empty class, so the two share a gate. Routing `''` to
      // `policy-row` instead would print "no `profile_settings` row" over a manifest that carries
      // `policyRowCount: 1` — a diagnostic contradicting the ledger the operator would then go read.
      label: "'' — the empty string, the same trim-empty class as '   '",
      policy: "",
      blocking: ["policy-blank"],
    },
  ] as const;

  it.each(CASES)("$label", ({ policy, blocking }) => {
    const { loaded, decision, gates } = runCensus(oneTarget(), { policy });

    // The export happened, and it carried the offending bytes verbatim so the report can name them.
    expect(loaded.manifest.policy).toEqual({ policyRowCount: 1, executionPolicyJson: policy });

    // Both sides reach `profile` independently — the SQL guard's fallback is what the TS parser also
    // returns for these inputs — so the cross-check stays silent and the block is about the POLICY rather
    // than about a disagreement that would send the operator looking in the wrong place.
    expect(loaded.manifest.sqlOwnerProjection).toEqual([{ positionId: "pos-1", owner: "profile" }]);
    expect(ownerPlan(decision)).toEqual({ "pos-1": "profile" });
    expect(gateById(gates, "cross-check").passed).toBe(true);

    expect(gates.gates.filter((g) => g.blocking && !g.passed).map((g) => g.id)).toEqual(blocking);
    expect(gates.blocked).toBe(true);
  });

  it("negative control — the same fixture with a readable policy is runnable", () => {
    // Without it, all three rows above are equally satisfied by a suite that blocks on every policy.
    const { gates } = runCensus(oneTarget());
    for (const id of ["parser", "policy-row", "policy-blank"]) {
      expect(gateById(gates, id).passed).toBe(true);
    }
    expect(gates.blocked).toBe(false);
  });
});
