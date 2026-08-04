import { BOUNCE_EXIT_BACKSTOP_RULE_ID, BOUNCE_EXIT_TARGET_RULE_ID } from "@krabs/domain";
import type { OwnershipInvariantId } from "@krabs/db";
import { describe, expect, it } from "vitest";

import { renderCensusReport } from "../report.js";
import { runCli } from "./cli.js";
import {
  AFTER_CUTOFF,
  OTHER_CONDITION,
  WHITELISTED_CONDITION,
  createCensusFixture,
  seedSql,
} from "./fixtures.js";
import {
  CLOSED_POINTER,
  CROSS_TOKEN_STALE,
  DUPLICATE_TOKEN,
  OVERCOMMIT_FLOOR,
  UNBOUND_SELL,
  UNCOVERED_NULL_OWNER,
  WRONG_OWNER_SELL,
  partialFillSeed,
  withClean,
} from "./invariant-fixtures.js";
import { expectInvariantCounts, gateById, runCensus, type CensusRun } from "./pipeline.js";

/**
 * §7 test 3 — one fixture per invariant, every one driven through the REAL dry-run path: seed a temp
 * ledger → EXPORT a manifest (which is where §5.1.11 now EVALUATES the invariants, on the server, inside
 * the live database) → read the verdict back off the manifest. Constructing the violation rows directly
 * would test a path production never takes, and any column §5.1's export fails to carry would stay
 * invisible — which is exactly how `size` went missing from §5.1.2 through an entire earlier revision.
 *
 * Diagnostics arrive as the §5.1.10 display strings (`"1.0"`, not `1`) because they crossed SQLite→JSON:
 * the manifest is the transport, and this suite asserts what the OPERATOR is shown. That the strings are
 * the faithful rendering of the engine's own doubles is `export-invariant-identity.test.ts`'s 8(b2).
 */

function expectCounts(
  run: CensusRun,
  expected: Partial<Record<OwnershipInvariantId, number>>,
): void {
  expectInvariantCounts(run.gates.invariants.counts, expected);
}

function report(run: CensusRun): string {
  return renderCensusReport({
    loaded: run.loaded,
    decision: run.decision,
    gates: run.gates,
    artifacts: null,
  });
}

/** A block the operator cannot act on is a block that costs a re-run: every offending row must be named. */
function expectReportNames(run: CensusRun, ...fragments: readonly string[]): void {
  const text = report(run);
  for (const fragment of fragments) expect(text).toContain(fragment);
  expect(text).toContain("=> BLOCKED: --apply is refused");
}

describe("§7.3 — I1 unboundSells", () => {
  it("an active SELL with no position_id blocks the run and is named", () => {
    const run = runCensus(withClean(UNBOUND_SELL));

    expectCounts(run, { unboundSells: 1 });
    expect(run.gates.blocked).toBe(true);
    expect(gateById(run.gates, "invariants").offending).toEqual([
      {
        invariant: "unboundSells",
        order_id: "o-unbound",
        token_id: "tok-clean",
        status: "open",
        size: "1.0",
        decision_rule_id: null,
      },
    ]);
    expectReportNames(run, "o-unbound");
  });

  it("specificity — the same SELL bound to its position is clean", () => {
    const run = runCensus(
      withClean(
        seedSql({
          orders: [
            {
              orderId: "o-bound",
              tokenId: "tok-clean",
              positionId: "pos-clean",
              side: "sell",
              status: "open",
              decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
            },
          ],
        }),
      ),
    );
    expectCounts(run, {});
    expect(run.gates.blocked).toBe(false);
  });

  // The exclusion set, not an `IN` list: `orders.status` has no CHECK, so an unknown status is ACTIVE.
  it.each(["open", "placed", "some-status-nobody-has-seen"])(
    "status %j counts as an active SELL",
    (status) => {
      const run = runCensus(
        withClean(seedSql({ orders: [{ orderId: "o-x", tokenId: "tok-clean", status }] })),
      );
      expectCounts(run, { unboundSells: 1 });
    },
  );

  it.each(["filled", "rejected", "cancelled"])(
    "status %j is inactive and never exported",
    (status) => {
      const run = runCensus(
        withClean(seedSql({ orders: [{ orderId: "o-x", tokenId: "tok-clean", status }] })),
      );
      expect(run.loaded.manifest.activeSellOrders).toEqual([]);
      expectCounts(run, {});
    },
  );
});

describe("§7.3 — I2 stalePointerSells, through the MATERIALIZED ledger", () => {
  it("a SELL resolving to a nonclosed position on ANOTHER token is a violation", () => {
    // It must run through the export rather than against a directly-seeded ledger: §5.1.2 exports ALL
    // nonclosed positions, so `pos-b` IS in the manifest — which is what lets a token-blind predicate
    // resolve the pointer and report clean.
    const run = runCensus(withClean(CROSS_TOKEN_STALE));

    // The pointer really does resolve — the token-blind reading would find its row and pass.
    expect(run.loaded.manifest.nonclosedPositions.map((p) => p.positionId)).toContain("pos-b");

    expectCounts(run, { stalePointerSells: 1 });
    expect(run.gates.blocked).toBe(true);
    expect(gateById(run.gates, "invariants").offending).toEqual([
      {
        invariant: "stalePointerSells",
        order_id: "o-stale",
        token_id: "tok-a",
        position_id: "pos-b",
        status: "open",
        decision_rule_id: null,
      },
    ]);
    expectReportNames(run, "o-stale", "pos-b", "tok-a");
  });

  it("specificity — the same SELL pointing at a position on its OWN token is clean", () => {
    const run = runCensus(
      withClean(
        seedSql({
          markets: [{ tokenId: "tok-a", conditionId: WHITELISTED_CONDITION }],
          positions: [
            {
              positionId: "pos-a",
              tokenId: "tok-a",
              conditionId: WHITELISTED_CONDITION,
              entryLane: "R23",
            },
          ],
          legStates: [{ tokenId: "tok-a", firstTradeAt: AFTER_CUTOFF }],
          orders: [
            // The rule id has to say `bounce`: `pos-a` is a whitelisted R23 target, so the run projects
            // it to `bounce`, and a NULL rule id would imply `profile` and trip I5 instead of leaving
            // this fixture clean — which would prove nothing about I2's specificity.
            {
              orderId: "o-stale",
              tokenId: "tok-a",
              positionId: "pos-a",
              side: "sell",
              status: "open",
              decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
            },
          ],
        }),
      ),
    );
    expectCounts(run, {});
    expect(run.gates.blocked).toBe(false);
  });

  it("a SELL pointing at a CLOSED position is stale too", () => {
    expectCounts(runCensus(withClean(CLOSED_POINTER)), { stalePointerSells: 1 });
  });
});

describe("§7.3 — I3 overcommittedTokens", () => {
  const FLOOR_FIXTURE = withClean(OVERCOMMIT_FLOOR);

  it("floors each order's remainder at zero before summing", () => {
    const run = runCensus(FLOOR_FIXTURE);

    // The aggregate really is over-filled — otherwise the two implementations would not disagree.
    const over = run.loaded.manifest.activeSellOrders.find((o) => o.orderId === "o-over");
    expect(over).toMatchObject({ size: "5.0", filledSize: "8.0" });

    expectCounts(run, { overcommittedTokens: 1 });
    expect(run.gates.blocked).toBe(true);
    expect(gateById(run.gates, "invariants").offending).toEqual([
      {
        invariant: "overcommittedTokens",
        token_id: "tok-owned",
        remaining_sell_shares: "11.0",
        position_shares: "10.0",
      },
    ]);
    expectReportNames(run, "tok-owned");
  });

  it("--apply is refused on it, and nothing is written", () => {
    const fixture = createCensusFixture();
    fixture.seed(FLOOR_FIXTURE);
    const before = fixture.ownerMap();
    const manifestPath = fixture.exportManifest().path;

    const run = runCli(["--apply", "--manifest", manifestPath, "--max-manifest-age-hours", "24"]);
    expect(run.code).not.toBe(0);
    expect(run.stdout).toContain("[BLOCK] #invariants");
    expect(run.stdout).toContain("tok-owned");
    expect(fixture.ownerMap()).toEqual(before);
  });

  it("subtracts the fills: size alone would overcommit, size − fills does not", () => {
    const run = runCensus(withClean(partialFillSeed({ fills: true })));
    expectCounts(run, {});
    expect(run.gates.blocked).toBe(false);
  });

  it("negative control — the SAME order with no fills DOES overcommit", () => {
    expectCounts(runCensus(withClean(partialFillSeed({ fills: false }))), {
      overcommittedTokens: 1,
    });
  });

  it("holdings are summed per token, so two nonclosed rows cover a SELL neither could alone", () => {
    const run = runCensus(
      withClean(
        seedSql({
          positions: [
            {
              positionId: "pos-1",
              tokenId: "tok-s",
              status: "dust",
              exitOwner: "profile",
              size: 6,
            },
            {
              positionId: "pos-2",
              tokenId: "tok-s",
              status: "dust",
              exitOwner: "profile",
              size: 6,
            },
          ],
          orders: [
            {
              orderId: "o-s",
              tokenId: "tok-s",
              positionId: "pos-1",
              side: "sell",
              status: "open",
              size: 10,
            },
          ],
        }),
      ),
    );
    // I4 fires on the duplicate token — I3 does NOT, because 10 ≤ 6 + 6.
    expectCounts(run, { duplicateNonclosedTokens: 1 });
  });
});

describe("§7.3 — I4 duplicateNonclosedTokens", () => {
  it("open + dust on one token is a violation", () => {
    const run = runCensus(withClean(DUPLICATE_TOKEN));

    expectCounts(run, { duplicateNonclosedTokens: 1 });
    expect(run.gates.blocked).toBe(true);
    const [offending] = gateById(run.gates, "invariants").offending;
    expect(offending).toMatchObject({
      invariant: "duplicateNonclosedTokens",
      token_id: "tok-dup",
      nonclosed_rows: 2,
    });
    // GROUP_CONCAT's order is not contractual; membership is.
    expect(String(offending?.["position_ids"]).split(",").sort()).toEqual(["pos-dust", "pos-open"]);
    expectReportNames(run, "tok-dup");
  });

  /**
   * The mixed-owner form — one NULL-owner row and one already-owned row on the same token. Only §5.1.2's
   * all-nonclosed export can see it: a manifest carrying just the targets would show ONE row on the token
   * and I4 would read `0` however it is written.
   */
  it("one NULL-owner + one owned row on a token — visible only through the all-nonclosed export", () => {
    const run = runCensus(
      withClean(
        seedSql({
          markets: [{ tokenId: "tok-mix", conditionId: WHITELISTED_CONDITION }],
          positions: [
            {
              positionId: "pos-null",
              tokenId: "tok-mix",
              conditionId: WHITELISTED_CONDITION,
              entryLane: "R23",
            },
            {
              positionId: "pos-owned",
              tokenId: "tok-mix",
              conditionId: WHITELISTED_CONDITION,
              status: "dust",
              exitOwner: "bounce",
            },
          ],
          legStates: [{ tokenId: "tok-mix", firstTradeAt: AFTER_CUTOFF }],
        }),
      ),
    );

    expect(run.loaded.manifest.targets.map((t) => t.positionId)).toEqual(["pos-clean", "pos-null"]);
    expect(run.loaded.manifest.nonclosedPositions.map((p) => p.positionId)).toEqual([
      "pos-clean",
      "pos-null",
      "pos-owned",
    ]);
    expectCounts(run, { duplicateNonclosedTokens: 1 });
    expect(run.gates.blocked).toBe(true);
  });

  /**
   * The seed that SEPARATES the two status conventions. `open` + `dust` above proves I4 fires; it does not
   * prove I4 was written over the right set, because both the enumerated `IN ('open','dust')` form and the
   * exclusion `<> 'closed'` form count a `dust` row. `repairing` stands for "schema-legal and not one of
   * the three" — `positions.status` has no CHECK, and the partial UNIQUE index constrains `open` only.
   *
   * Three assertions on one seed, because the status gate and I4 are two INDEPENDENT defences and an
   * aggregate verdict cannot say which one held. It also pins §5.1.2's export predicate: under an
   * enumerated export the `repairing` row never reaches the manifest and I4 reads `0` however it is
   * written, so this seed fails on any of the three defects on its own.
   */
  it("open + repairing — I4 and the status-domain gate BOTH fire", () => {
    const run = runCensus(
      withClean(
        seedSql({
          markets: [{ tokenId: "tok-rep", conditionId: WHITELISTED_CONDITION }],
          positions: [
            {
              positionId: "pos-open",
              tokenId: "tok-rep",
              conditionId: WHITELISTED_CONDITION,
              entryLane: "R23",
            },
            { positionId: "pos-repairing", tokenId: "tok-rep", status: "repairing" },
          ],
          legStates: [{ tokenId: "tok-rep", firstTradeAt: AFTER_CUTOFF }],
        }),
      ),
    );

    // §5.1.2 carried it: an enumerated export would have dropped the row here.
    expect(run.loaded.manifest.nonclosedPositions.map((p) => p.status)).toContain("repairing");
    // … and §5.1.1 did NOT — the census's one-way target set stays enumerated. That asymmetry is why the
    // row is simultaneously an I4 participant and an uncovered NULL owner.
    expect(run.loaded.manifest.targets.map((t) => t.positionId)).not.toContain("pos-repairing");

    expectCounts(run, { duplicateNonclosedTokens: 1, nullOwners: 1 });
    expect(run.gates.blocked).toBe(true);
    expect(gateById(run.gates, "status-domain").offending).toEqual([
      { position_id: "pos-repairing", status: "repairing" },
    ]);
    expectReportNames(run, "pos-repairing", "tok-rep");
  });
});

describe("§7.3 — the SINGLETON repairing row", () => {
  // `open` + `repairing` above trips I4 no matter how `nullOwners` is written, so it cannot test
  // `nullOwners`'s own status half. This seed carries ONE row, and the clean-ness of the other five
  // invariants on it is asserted below rather than assumed.
  const run = () => runCensus(UNCOVERED_NULL_OWNER);

  it("is an uncovered NULL owner, and every other invariant stays clean", () => {
    expectCounts(run(), { nullOwners: 1 });
  });

  it("blocks the run through BOTH the completeness gate and the status-domain gate", () => {
    const r = run();
    expect(r.gates.blocked).toBe(true);
    expect(gateById(r.gates, "target-set-completeness").offending).toEqual([
      { position_id: "pos-lonely", token_id: "tok-lonely", status: "repairing", exit_owner: null },
    ]);
    expect(gateById(r.gates, "status-domain").offending).toEqual([
      { position_id: "pos-lonely", status: "repairing" },
    ]);
    expect(gateById(r.gates, "invariants").offending).toEqual([]);
    expectReportNames(r, "pos-lonely");
  });

  it("it is not a target, so no decision covers it — which is the point", () => {
    expect(run().decision.decisions).toEqual([]);
  });
});

describe("§7.3 — I5 wrongOwnerSells pins the WHOLE §3 rule-id mapping", () => {
  /**
   * The owner here comes from this run's PROJECTION, not from the ledger: every position below is a
   * NULL-owner target, so the fixture exercises `projected_owners` as well as the mapping. The assigned
   * owner is selected by whitelisting the condition or not.
   *
   * The unknown and NULL rule ids are the two an implementation is most likely to treat as undecidable.
   * §3 is a BIPARTITION with no third case: anything that is not one of the two bounce ids is
   * `profile`-ruled, so both must PASS against `profile` and BLOCK against `bounce`.
   */
  function i5(assigned: "bounce" | "profile", ruleId: string | null): CensusRun {
    const condition = assigned === "bounce" ? WHITELISTED_CONDITION : OTHER_CONDITION;
    return runCensus(
      seedSql({
        markets: [{ tokenId: "tok-i5", conditionId: condition }],
        positions: [
          { positionId: "pos-i5", tokenId: "tok-i5", conditionId: condition, entryLane: "R23" },
        ],
        legStates: [{ tokenId: "tok-i5", firstTradeAt: AFTER_CUTOFF }],
        orders: [
          {
            orderId: "o-i5",
            tokenId: "tok-i5",
            conditionId: condition,
            positionId: "pos-i5",
            side: "sell",
            status: "open",
            decisionRuleId: ruleId,
          },
        ],
      }),
    );
  }

  const CASES = [
    { rule: BOUNCE_EXIT_TARGET_RULE_ID, implied: "bounce", assigned: "profile", violates: true },
    { rule: BOUNCE_EXIT_BACKSTOP_RULE_ID, implied: "bounce", assigned: "profile", violates: true },
    { rule: "PROFILE_LADDER", implied: "profile", assigned: "bounce", violates: true },
    { rule: "S1_LADDER_LEGACY_2024", implied: "profile", assigned: "bounce", violates: true },
    { rule: null, implied: "profile", assigned: "bounce", violates: true },
    // The negative controls — without them a predicate that flagged EVERY active SELL would pass above.
    { rule: BOUNCE_EXIT_TARGET_RULE_ID, implied: "bounce", assigned: "bounce", violates: false },
    { rule: BOUNCE_EXIT_BACKSTOP_RULE_ID, implied: "bounce", assigned: "bounce", violates: false },
    { rule: "PROFILE_LADDER", implied: "profile", assigned: "profile", violates: false },
    { rule: "S1_LADDER_LEGACY_2024", implied: "profile", assigned: "profile", violates: false },
    { rule: null, implied: "profile", assigned: "profile", violates: false },
  ] as const;

  it.each(CASES)(
    "rule $rule on a $assigned-assigned position → violates=$violates",
    ({ rule, implied, assigned, violates }) => {
      const run = i5(assigned, rule);

      // The projection is what supplies the owner — the ledger column is still NULL at this point.
      expect(run.decision.decisions).toEqual([
        expect.objectContaining({ positionId: "pos-i5", owner: assigned }),
      ]);
      expect(run.loaded.manifest.nonclosedPositions[0]?.exitOwner).toBeNull();

      expectCounts(run, violates ? { wrongOwnerSells: 1 } : {});
      expect(run.gates.blocked).toBe(violates);
      if (!violates) return;

      expect(gateById(run.gates, "invariants").offending).toEqual([
        {
          invariant: "wrongOwnerSells",
          order_id: "o-i5",
          token_id: "tok-i5",
          position_id: "pos-i5",
          status: "open",
          decision_rule_id: rule,
          effective_owner: assigned,
          implied_owner: implied,
        },
      ]);
      expectReportNames(run, "o-i5");
    },
  );

  it("an ALREADY-OWNED position is checked too, not only this run's targets", () => {
    const run = runCensus(withClean(WRONG_OWNER_SELL));

    expectCounts(run, { wrongOwnerSells: 1 });
    expect(gateById(run.gates, "invariants").offending[0]).toMatchObject({
      effective_owner: "profile",
      implied_owner: "bounce",
    });
  });
});
