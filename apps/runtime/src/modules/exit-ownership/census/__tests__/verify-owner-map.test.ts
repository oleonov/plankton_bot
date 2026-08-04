import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { CensusDecisionArtifact } from "../decision-artifact.js";
import { verifyOwnerMap } from "../verify-owner-map.js";
import { cleanSeed, createCensusFixture, seedSql, WHITELISTED_CONDITION } from "./fixtures.js";
import { censusedFixture, verifyOwnerMapCli } from "./pipeline.js";

/**
 * §7 test 13 — `--verify-owner-map`, the last gate between the mandated restart and live routing.
 *
 * The three fixture files are BUILT BY THE REAL PIPELINE — §5.1's exporter for both manifests and `--apply`
 * itself for the decision artifact — never hand-written, so a test cannot drift from the loaders it is
 * supposed to pin. `K` is the fixture's own construction parameter (3, from `cleanSeed`) and is deliberately
 * not production's target count: the clause-2 cardinality check reads N from the frozen manifest at run
 * time, and a fixture that hardcoded production's N would go green on an implementation that did the same.
 */

/**
 * A writable view of the artifact. The production type is `readonly` end to end — which is the point of
 * it — so the corruption fixtures below get one shared mutable alias rather than a cast per site.
 */
type MutableDecisionArtifact = {
  -readonly [K in keyof CensusDecisionArtifact]: CensusDecisionArtifact[K] extends readonly (infer E)[]
    ? E[]
    : CensusDecisionArtifact[K];
};

/** Rewrites the decision artifact in place and returns the digest that now matches its bytes. */
function rewriteDecision(
  path: string,
  mutate: (artifact: MutableDecisionArtifact) => void,
): string {
  const artifact = JSON.parse(readFileSync(path, "utf8")) as MutableDecisionArtifact;
  mutate(artifact);
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  writeFileSync(path, text);
  return createHash("sha256").update(text).digest("hex");
}

describe("§7.13 — the clean case", () => {
  it("exits 0 and names the cardinality it verified", () => {
    const run = verifyOwnerMapCli(censusedFixture());
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("owner map verified");
    expect(run.stdout).toContain("all 3 censused position(s)");
  });

  it("still passes when a censused position CLOSED inside the window (§5.1.9)", () => {
    const trio = censusedFixture();
    // A resting SELL filling to zero flips the row to `closed` while keeping its immutable owner. Reading
    // only the nonclosed projection would report that normal exit as a deletion.
    trio.fixture.seed(
      "UPDATE positions SET status = 'closed', size = 0 WHERE position_id = 'pos-profile';",
    );
    const run = verifyOwnerMapCli(trio);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("owner map verified");
  });
});

describe("§7.13 — clause 1: the decision artifact is the one the runbook recorded", () => {
  it("1a — rejects a --decision-digest that does not match the file bytes", () => {
    const trio = censusedFixture();
    const run = verifyOwnerMapCli(trio, { decisionDigest: "b".repeat(64) });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("(digest)");
    expect(run.stderr).toContain(trio.decisionDigest);
  });

  it("1b — rejects a decision artifact computed from a DIFFERENT frozen manifest", () => {
    const trio = censusedFixture();
    // A whole second census: its artifact is internally consistent and its own digest matches, so only the
    // manifest binding can tell it does not belong to THIS window.
    const other = censusedFixture();
    const run = verifyOwnerMapCli(trio, {
      decision: other.decisionPath,
      decisionDigest: other.decisionDigest,
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("(manifest_binding)");
    expect(run.stderr).toContain("different census");
  });
});

describe("§7.13 — clause 2: the owner map covers the frozen target set exactly", () => {
  it("2a — rejects a repeated positionId", () => {
    const trio = censusedFixture();
    const digest = rewriteDecision(trio.decisionPath, (a) => {
      const first = a.owners[0];
      if (first === undefined) throw new Error("fixture has no owners");
      a.owners.push(first);
      a.targetCount = a.owners.length;
    });
    const run = verifyOwnerMapCli(trio, { decisionDigest: digest });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toContain("[clause 2]");
    expect(run.stdout).toContain("repeats pos-bounce");
  });

  it("2b — rejects an id absent from the frozen target set", () => {
    const trio = censusedFixture();
    const digest = rewriteDecision(trio.decisionPath, (a) => {
      a.owners.push({ positionId: "pos-intruder", expectedOwner: "bounce" });
      a.targetCount = a.owners.length;
    });
    const run = verifyOwnerMapCli(trio, { decisionDigest: digest });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toContain("pos-intruder");
    expect(run.stdout).toContain("absent from the frozen target set");
  });

  it("2c — rejects a MISSING target, and the count it compares is the frozen manifest's", () => {
    const trio = censusedFixture();
    const digest = rewriteDecision(trio.decisionPath, (a) => {
      a.owners = a.owners.filter((o) => o.positionId !== "pos-gate");
      a.targetCount = a.owners.length;
    });
    const run = verifyOwnerMapCli(trio, { decisionDigest: digest });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toContain("missing pos-gate");
    // v11 compared `owners.length` against the artifact's OWN `targetCount`, which a self-consistent
    // truncation satisfies. The comparison must be against the frozen manifest's cardinality.
    expect(run.stdout).toContain(
      "decision.targetCount is 2 but the frozen manifest has 3 target(s)",
    );
  });
});

describe("§7.13 — clause 3: every censused position is still present", () => {
  it("names both producers and the query that separates them", () => {
    const trio = censusedFixture();
    trio.fixture.seed("DELETE FROM positions WHERE position_id = 'pos-profile';");
    const run = verifyOwnerMapCli(trio);
    expect(run.code).not.toBe(0);
    expect(run.stdout).toContain("[clause 3]");
    expect(run.stdout).toContain("pos-profile is absent from BOTH");
    expect(run.stdout).toContain(
      "SELECT status, exit_owner FROM positions WHERE position_id = 'pos-profile';",
    );
    expect(run.stdout).toContain("startup adoption DELETEd it");
  });

  it("rejects a fresh manifest that lists one id in BOTH projections", () => {
    // The two projections are disjoint by predicate, so §5.1 cannot EXPORT this contradiction — the clause
    // exists for a hand-edited or partially-regenerated manifest, and is therefore pinned at the function.
    const fixture = createCensusFixture();
    fixture.seed(cleanSeed());
    const fresh = structuredClone(fixture.exportManifest().loaded.manifest);
    fresh.ownedClosedPositions.push({
      positionId: "pos-bounce",
      status: "closed",
      exitOwner: "bounce",
    });

    const report = verifyOwnerMap({
      frozen: fresh,
      fresh,
      decision: {
        decisionVersion: 1,
        manifestDigest: "0".repeat(64),
        targetCount: 3,
        owners: [{ positionId: "pos-bounce", expectedOwner: "bounce" }],
      },
    });
    expect(report.ok).toBe(false);
    expect(
      report.failures.some((f) => f.clause === 3 && f.message.includes("contradicts itself")),
    ).toBe(true);
  });
});

describe("§7.13 — clause 4: the RAW owner, compared without COALESCE", () => {
  it("rejects a position that holds the OTHER owner", () => {
    const trio = censusedFixture();
    // The ledger's own trigger makes `exit_owner` immutable once set, so the divergence is introduced on the
    // decision side. The comparison under test is the same either way: expected vs what the ledger holds.
    const digest = rewriteDecision(trio.decisionPath, (a) => {
      a.owners = a.owners.map((o) =>
        o.positionId === "pos-bounce" ? { ...o, expectedOwner: "profile" } : o,
      );
    });
    const run = verifyOwnerMapCli(trio, { decisionDigest: digest });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toContain("[clause 4]");
    expect(run.stdout).toContain("pos-bounce: expected exit_owner profile, ledger holds bounce");
    expect(run.stdout).toContain("nonclosed_positions");
  });

  it("drives the same comparison through owned_closed_positions, not only the nonclosed one", () => {
    // The clean closed case above proves the UNION is read; this proves clause 4 actually compares the
    // owner it found there. Without it, a branch that registered closed rows carrying the expected owner —
    // or no owner comparison at all — passes every other test in this file.
    const trio = censusedFixture();
    // A resting SELL fills to zero inside the window: the row flips to `closed` keeping its immutable
    // owner, so `pos-profile` leaves §5.1.2 and is only reachable through §5.1.9.
    trio.fixture.seed(
      "UPDATE positions SET status = 'closed', size = 0 WHERE position_id = 'pos-profile';",
    );
    const digest = rewriteDecision(trio.decisionPath, (a) => {
      a.owners = a.owners.map((o) =>
        o.positionId === "pos-profile" ? { ...o, expectedOwner: "bounce" } : o,
      );
    });
    const run = verifyOwnerMapCli(trio, { decisionDigest: digest });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toContain("[clause 4]");
    expect(run.stdout).toContain(
      "pos-profile: expected exit_owner bounce, ledger holds profile (in owned_closed_positions)",
    );
    // The projection NAME is part of the finding, and the operator's next step turns on it: a closed row is
    // a completed exit to reconcile, a nonclosed one is a live position routing on the wrong owner.
    expect(run.stdout).not.toContain("(in nonclosed_positions)");
  });

  it("rejects NULL owners when the apply never committed — with clause 5 seeing them as targets", () => {
    const trio = censusedFixture(cleanSeed(), { commit: false });
    const run = verifyOwnerMapCli(trio);
    expect(run.code).not.toBe(0);
    // Every censused position is named, not just the first, and NULL is reported as NULL rather than
    // COALESCEd into a plausible-looking owner.
    for (const [id, owner] of [
      ["pos-bounce", "bounce"],
      ["pos-gate", "bounce"],
      ["pos-profile", "profile"],
    ]) {
      expect(run.stdout).toContain(`${id}: expected exit_owner ${owner}, ledger holds NULL`);
    }
    expect(run.stdout).toContain("[clause 5]");
  });
});

describe("§7.13 — clause 5: no NULL-owner nonclosed position remains", () => {
  it("rejects a NEW target opened after the apply, with clauses 2–4 all clean", () => {
    const trio = censusedFixture();
    trio.fixture.seed(
      seedSql({
        markets: [{ tokenId: "tok-late", conditionId: WHITELISTED_CONDITION }],
        positions: [
          { positionId: "pos-late", tokenId: "tok-late", conditionId: WHITELISTED_CONDITION },
        ],
        legStates: [{ tokenId: "tok-late", firstTradeAt: "2026-07-25T00:00:00.000Z" }],
      }),
    );
    const run = verifyOwnerMapCli(trio);
    expect(run.code).not.toBe(0);
    const failures = run.stdout.split("\n").filter((line) => line.includes("[clause "));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("[clause 5]");
    expect(failures[0]).toContain("pos-late");
  });
});

describe("§7.13 — every failure is reported in ONE pass", () => {
  it("reports all three clause-4 rows plus clause 5 in a single run", () => {
    // The operator is mid-window with immutable owners already written: a report that stopped at the first
    // failure would cost one re-run per offending row.
    const run = verifyOwnerMapCli(censusedFixture(cleanSeed(), { commit: false }));
    expect(run.code).not.toBe(0);
    expect(run.stdout).toContain("(4 finding(s))");
    expect(run.stdout.split("\n").filter((line) => line.includes("[clause 4]"))).toHaveLength(3);
  });
});
