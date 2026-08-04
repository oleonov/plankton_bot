import { describe, expect, it } from "vitest";

import { BEFORE_CUTOFF, OTHER_CONDITION, seedSql, WHITELISTED_CONDITION } from "./fixtures.js";
import { CHECK_FAILED, expectRolledBack, prepareApply as prepare } from "./pipeline.js";

/**
 * §7 test 7 (apply accounting) and §7 test 12(e) (the happy path — the emitted script must actually
 * COMMIT), against a temp ledger with the real schema and the pinned production CLI.
 *
 * Every other apply assertion in this suite is a ROLLBACK; 12(e) is here because a suite made only of
 * ROLLBACK assertions cannot see a guard that errors on EVERY run — which is exactly how the
 * `projected_owners` name mismatch stayed invisible through a whole plan revision.
 */

describe("§7.12(e) — the emitted apply script commits on a clean fixture", () => {
  it("writes exactly the planned owner for every target and post-verifies 0|0|0", () => {
    const { fixture, applySql, postverifySql, plannedOwners } = prepare();

    expect(plannedOwners).toEqual({
      "pos-bounce": "bounce",
      "pos-gate": "bounce",
      "pos-profile": "profile",
    });

    const run = fixture.runApply(applySql);
    expect(run.stderr).toBe("");
    expect(run.ok).toBe(true);
    expect(fixture.ownerMap()).toEqual(plannedOwners);

    const postverify = fixture.runReadOnly(postverifySql);
    expect(postverify.ok).toBe(true);
    expect(postverify.stdout.trim()).toBe("0|0|0");
  });

  it("is idempotent — a second run is a clean no-op", () => {
    const { fixture, applySql, plannedOwners } = prepare();
    expect(fixture.runApply(applySql).ok).toBe(true);

    const second = fixture.runApply(applySql);
    expect(second.stderr).toBe("");
    expect(second.ok).toBe(true);
    expect(fixture.ownerMap()).toEqual(plannedOwners);
  });

  it("negative control — dropping the projected_owners table makes the run fail and write nothing", () => {
    const { fixture, applySql } = prepare();
    // §7 test 12(e)'s negative control: the statements cannot be dropped from the generator unnoticed.
    const mutated = applySql
      .replace(/CREATE TEMP TABLE projected_owners[^;]*;/, "")
      .replace(/INSERT INTO projected_owners \(position_id, owner\)\nVALUES\n[^;]*;/, "");

    const run = fixture.runApply(mutated);
    expect(run.ok).toBe(false);
    expect(run.stderr).toContain("no such table: projected_owners");
    expect(Object.values(fixture.ownerMap()).every((o) => o === null)).toBe(true);
  });
});

describe("§7.7 — apply accounting: every drift class rolls the WHOLE run back", () => {
  it("a target closed between export and apply", () => {
    const applied = prepare();
    applied.fixture.seed(
      "UPDATE positions SET status = 'closed' WHERE position_id = 'pos-bounce';",
    );
    expectRolledBack(applied, CHECK_FAILED);
  });

  it("a target that acquired a DIFFERENT owner", () => {
    const applied = prepare();
    applied.fixture.seed(
      "UPDATE positions SET exit_owner = 'profile' WHERE position_id = 'pos-bounce';",
    );
    // The whole-run assertion lives in `expectRolledBack`: every OTHER target must still be NULL. A
    // test that only checked the drifted row passes even when the others committed — the v5 defect.
    expectRolledBack(applied, CHECK_FAILED);
  });

  it("a vanished target (the inner-JOIN defect — final-fresh-review Critical #1)", () => {
    const applied = prepare();
    applied.fixture.seed("DELETE FROM positions WHERE position_id = 'pos-profile';");
    expectRolledBack(applied, CHECK_FAILED);
  });

  it("leg_states.first_trade_at moved between export and lock", () => {
    const applied = prepare();
    applied.fixture.seed(
      `UPDATE leg_states SET first_trade_at = '${BEFORE_CUTOFF}' WHERE token_id = 'tok-bounce';`,
    );
    expectRolledBack(applied, CHECK_FAILED);
  });

  it("markets.condition_id moved between export and lock", () => {
    const applied = prepare();
    applied.fixture.seed(
      `UPDATE markets SET condition_id = '${OTHER_CONDITION}' WHERE token_id = 'tok-bounce';`,
    );
    expectRolledBack(applied, CHECK_FAILED);
  });

  it("positions.token_id moved between export and lock", () => {
    const applied = prepare();
    applied.fixture.seed(
      `${seedSql({ markets: [{ tokenId: "tok-moved", conditionId: WHITELISTED_CONDITION }] })}
       UPDATE positions SET token_id = 'tok-moved' WHERE position_id = 'pos-bounce';`,
    );
    expectRolledBack(applied, CHECK_FAILED);
  });

  it("an I1 violation created after export but before the lock", () => {
    const applied = prepare();
    // An active SELL bound to no position at all — `unboundSells`.
    applied.fixture.seed(
      seedSql({
        orders: [
          { orderId: "o-unbound", tokenId: "tok-bounce", side: "sell", status: "open", size: 1 },
        ],
      }),
    );
    expectRolledBack(applied, CHECK_FAILED);
  });

  it("order evidence that turned CONFLICTING after export (§5.4 step 3, guard #4)", () => {
    const applied = prepare();
    applied.fixture.seed(
      seedSql({
        orders: [
          {
            orderId: "o-conflict",
            tokenId: "tok-bounce",
            conditionId: OTHER_CONDITION,
            side: "buy",
            status: "filled",
          },
        ],
      }),
    );
    expectRolledBack(applied, CHECK_FAILED);
  });

  it("order evidence that turned AMBIGUOUS after export for an absent-evidence target", () => {
    const applied = prepare();
    // `pos-gate` carries the legacy `''` condition, so its owner rests entirely on order evidence.
    applied.fixture.seed(
      seedSql({
        orders: [
          {
            orderId: "o-ambiguous",
            tokenId: "tok-gate",
            conditionId: OTHER_CONDITION,
            side: "buy",
            status: "filled",
          },
        ],
      }),
    );
    expectRolledBack(applied, CHECK_FAILED);
  });

  it("swapped owners — the case aggregate counts would miss", () => {
    const applied = prepare();
    // Two targets, each written with the OTHER's planned owner: every aggregate count matches, and only
    // guard #8's per-position_id map can see it. Simulated by pre-owning both rows crosswise.
    applied.fixture.seed(
      `UPDATE positions SET exit_owner = 'profile' WHERE position_id = 'pos-bounce';
       UPDATE positions SET exit_owner = 'bounce'  WHERE position_id = 'pos-profile';`,
    );
    expectRolledBack(applied, CHECK_FAILED);
  });
});
