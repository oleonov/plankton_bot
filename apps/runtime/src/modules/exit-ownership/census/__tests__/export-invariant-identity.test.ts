import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OWNERSHIP_INVARIANT_ROW_SQL,
  PROJECTED_OWNERS_CREATE_SQL,
  readOwnershipInvariantViolations,
  type ExitOwner,
  type OwnershipInvariantId,
} from "@krabs/db";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";

import { CENSUS_EXPORT_SQL, realString } from "../export-sql.js";
import { LEDGER_SQL, createCensusFixture, seedSql, type CensusFixture } from "./fixtures.js";
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
import {
  expectInvariantCounts,
  ownerPlan,
  reevaluate,
  runCensus,
  type CensusRun,
} from "./pipeline.js";
import { productionSqlite3 } from "./sqlite-cli.js";

/**
 * §9a.6 test 8 — the export's invariant block **IS** the shared definition (v25).
 *
 * It replaces the materializer-fidelity suite. That suite asked whether a ledger rebuilt from the manifest
 * reaches the verdict the real one would; §5.1.11 deleted the materializer, so nothing rebuilds a ledger
 * and the question has no subject. What survives is the one property the census still needs and can
 * actually have: the six invariants the export evaluates are the SAME TEXT `@krabs/db` defines, evaluated
 * by the LIVE ledger's own engine — not a copy that happens to agree today.
 *
 * The comparison is split in two on purpose, because exactly one half of it crosses a text boundary:
 *
 *  - the VERDICT never crosses. `remaining_sell_shares > position_shares` and its five siblings are
 *    evaluated inside SQLite, on native doubles, on the real ledger. (b1) pins that half exactly, keyed on
 *    the non-REAL columns, and no float participates in it;
 *  - the DIAGNOSTIC columns do cross — the export renders them to JSON and Node parses them back. §5.1.10
 *    proved that leg is not a round trip on the pinned 3.37.2, so (b2) compares both sides AFTER the one
 *    shared display renderer, i.e. it asserts "the export renders what the renderer renders" rather than
 *    "the export preserved the double". `RENDER_COLLISION` is the fixture that makes the distinction
 *    unavoidable rather than theoretical.
 */

// ───────────────────────────── the two sides ─────────────────────────────

/** The projection the export bound, read off the decision so both sides answer the identical question. */
function projectionOf(run: CensusRun): ReadonlyMap<string, ExitOwner> {
  return new Map(run.decision.decisions.map((d) => [d.positionId, d.owner]));
}

/**
 * A read-only better-sqlite3 handle on the fixture's ledger — the REFERENCE engine.
 *
 * `readonly: true` rather than `openDatabase`: the census never writes to the ledger it reads, and
 * `openDatabase` would set `journal_mode = WAL`, which is a write. `projected_owners` is a TEMP table,
 * which lives in a separate database and is therefore creatable on a read-only main.
 */
function withReference<T>(fixture: CensusFixture, use: (db: Database.Database) => T): T {
  const db = new Database(fixture.ledgerPath, { readonly: true });
  try {
    return use(db);
  } finally {
    db.close();
  }
}

interface ReferenceInvariant {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** `typeof` per column per row — `diagnosticValue`'s own dispatch rule (§5.1.11), asked of the engine. */
  readonly types: ReadonlyArray<Record<string, string>>;
}

type ReferenceVerdict = Record<OwnershipInvariantId, ReferenceInvariant>;

/**
 * The reference verdict: the SAME `readOwnershipInvariantViolations` the two activation gates run,
 * against the real ledger, under the same projection.
 *
 * The storage class comes from the same engine and the same query rather than from the JS values, because
 * better-sqlite3 maps INTEGER and REAL alike onto `number` — the distinction the export dispatches on is
 * invisible on this side unless SQLite is asked for it. The outer `ORDER BY` repeats the entry's own
 * leading key, which every entry both orders by and is unique on, so the two arrays are aligned by index.
 */
function referenceVerdict(
  fixture: CensusFixture,
  projected: ReadonlyMap<string, ExitOwner> | undefined,
): ReferenceVerdict {
  return withReference(fixture, (db) => {
    const violations = readOwnershipInvariantViolations(db, projected);
    const verdict = {} as ReferenceVerdict;
    for (const { id, sql, columns } of OWNERSHIP_INVARIANT_ROW_SQL) {
      const types = db
        .prepare(
          `SELECT ${columns.map((c) => `typeof(${c}) AS ${c}`).join(", ")}
             FROM (${sql}) ORDER BY ${columns[0]}`,
        )
        .all() as Array<Record<string, string>>;
      verdict[id] = { rows: violations.rows[id], types };
    }
    return verdict;
  });
}

function referenceCounts(verdict: ReferenceVerdict): Record<OwnershipInvariantId, number> {
  return Object.fromEntries(
    OWNERSHIP_INVARIANT_ROW_SQL.map(({ id }) => [id, verdict[id].rows.length]),
  ) as Record<OwnershipInvariantId, number>;
}

// ───────────────────────────── the shared display renderer, as a reference ─────────────────────────────

/**
 * §9a.6 test 8(b2)'s reference: the native doubles of the reference engine, rendered by the SAME
 * `realString` the export uses, on the SAME pinned 3.37.2 binary.
 *
 * The transport has to be binary. A decimal literal in SQL would be re-parsed by 3.37.2 into a DIFFERENT
 * double (§5.1.10's first leg), so the value would no longer be the one under test; better-sqlite3 binds
 * a JS number as IEEE754 bytes, so the temp file carries it bit-exactly. Nothing circular happens here —
 * the verdict and the values still come from the reference engine on the real ledger, and only their
 * DISPLAY goes through the renderer under test.
 */
function renderThroughDisplay(values: readonly number[]): string[] {
  if (values.length === 0) return [];
  const path = join(mkdtempSync(join(tmpdir(), "krabs-render-")), "render.db");
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE r(i INTEGER PRIMARY KEY, v REAL NOT NULL)");
    const insert = db.prepare("INSERT INTO r(i, v) VALUES (?, ?)");
    values.forEach((value, i) => void insert.run(i, value));
  } finally {
    db.close();
  }
  const rendered = execFileSync(productionSqlite3(), ["-readonly", "-noheader", "-bail", path], {
    input: `SELECT ${realString("v")} FROM r ORDER BY i;`,
    encoding: "utf8",
  });
  const lines = rendered.split("\n").slice(0, values.length);
  expect(lines).toHaveLength(values.length);
  return lines;
}

/**
 * Whether this build's `%!.17g` is correctly rounded — and therefore injective over binary64, which is
 * what decides whether a render collision can exist at all.
 *
 * It is a property of the HOST, not of the version: 3.37.2 converts through `LONGDOUBLE_TYPE`, 80-bit on
 * x86_64 (production and CI) where the rendering is exact, and 64-bit on arm64 macOS (dev) where it is off
 * by up to ~1 ULP. `12` is the decisive probe: it renders "12.0" on the first and "11.999999999999999" —
 * which reads back as 11.999999999999998 — on the second. Measured, never assumed, because the tests must
 * make the same claim on both machines and only one of them is the one the census will run on.
 */
function rendererIsCorrectlyRounded(): boolean {
  return Object.is(Number(renderThroughDisplay([12])[0]), 12);
}

// ───────────────────────────── the row-set comparison ─────────────────────────────

/** I4's `GROUP_CONCAT` guarantees MEMBERSHIP, not sequence — comparing the raw text would over-assert. */
function stable(column: string, value: unknown): unknown {
  return column === "position_ids" && typeof value === "string"
    ? value.split(",").sort().join(",")
    : value;
}

interface SplitRow {
  readonly nonReal: Record<string, unknown>;
  readonly reals: ReadonlyArray<{ readonly column: string; readonly value: unknown }>;
}

function splitRow(
  row: Record<string, unknown>,
  types: Record<string, string> | undefined,
  columns: readonly string[],
): SplitRow {
  expect(Object.keys(row)).toEqual([...columns]);
  const nonReal: Record<string, unknown> = {};
  const reals: Array<{ column: string; value: unknown }> = [];
  for (const column of columns) {
    if (types?.[column] === "real") reals.push({ column, value: row[column] });
    else nonReal[column] = stable(column, row[column]);
  }
  return { nonReal, reals };
}

/** A REAL diagnostic, labelled so a failure names the invariant, the row and the column it came from. */
interface RealSample {
  readonly label: string;
  readonly exported: unknown;
  readonly reference: number;
}

/**
 * (b1) + (b2) for one run, over all six invariants.
 *
 * (b1) is asserted per invariant so a failure names which one drifted; (b2) is collected across all six
 * and rendered in ONE batch, because each batch is a `sqlite3` process and the labels already localise a
 * failure precisely.
 */
function expectRowSetIdentity(run: CensusRun, verdict: ReferenceVerdict): void {
  const samples: RealSample[] = [];
  for (const { id, columns } of OWNERSHIP_INVARIANT_ROW_SQL) {
    const exported = run.gates.invariants.rows[id];
    const { rows, types } = verdict[id];
    expect(`${id}: ${exported.length} rows`).toBe(`${id}: ${rows.length} rows`);

    const split = (source: ReadonlyArray<Record<string, unknown>>) =>
      source.map((row, i) => splitRow(row, types[i], columns));
    const exportedSplit = split(exported);
    const referenceSplit = split(rows);

    // (b1) — predicate identity, exact, and no float participates.
    expect(exportedSplit.map((r) => r.nonReal)).toEqual(referenceSplit.map((r) => r.nonReal));

    // (b2) — the REAL diagnostics, collected for the render-against-render comparison below.
    exportedSplit.forEach((row, i) => {
      const reference = referenceSplit[i];
      row.reals.forEach(({ column, value }, j) => {
        const referenceValue = reference?.reals[j]?.value;
        expect(typeof referenceValue).toBe("number");
        samples.push({
          label: `${id}[${i}].${column}`,
          exported: value,
          reference: referenceValue as number,
        });
      });
    });
  }

  const rendered = renderThroughDisplay(samples.map((s) => s.reference));
  expect(samples.map((s) => `${s.label} = ${String(s.exported)}`)).toEqual(
    samples.map((s, i) => `${s.label} = ${String(rendered[i])}`),
  );
}

// ───────────────────────────── the fixtures ─────────────────────────────

/**
 * §9a.6 test 8(b2)'s REQUIRED fixture — order `0.9`, fill `0.06`, position `0.84`.
 *
 * Measured on this exact seed: the reference engine computes `remaining_sell_shares` as
 * `0.8400000000000001` and `position_shares` as `0.84` (`Object.is` is FALSE, and the violation is real —
 * the predicate is evaluated on those doubles). On arm64 macOS the pinned 3.37.2 renders BOTH as
 * `0.84000000000000003`: a deep-equality assertion over the diagnostics fails on it with both sides
 * correct, which is why the fixture is required rather than optional. On x86_64 the wider `long double`
 * makes `%!.17g` correctly rounded and hence injective, so the same pair renders `0.84000000000000008` and
 * `0.83999999999999997` and no collision exists. (b2) compares renderings on both, because the census must
 * decide the same thing on the dev machine and on production — see `rendererIsCorrectlyRounded`.
 */
const RENDER_COLLISION = seedSql({
  positions: [{ positionId: "pos-r", tokenId: "tok-r", exitOwner: "profile", size: 0.84 }],
  orders: [
    {
      orderId: "o-r",
      tokenId: "tok-r",
      positionId: "pos-r",
      side: "sell",
      status: "open",
      size: 0.9,
    },
  ],
  fills: [{ fillId: "f-r", orderId: "o-r", tokenId: "tok-r", size: 0.06 }],
});

interface IdentityCase {
  readonly name: string;
  readonly seed: string;
  readonly expected: Partial<Record<OwnershipInvariantId, number>>;
}

/**
 * One seed per invariant class — the SAME objects `invariants.test.ts` drives, so a class whose detection
 * changes shape cannot keep its identity claim green against a stale copy. Every seed is composable (no
 * two share a `position_id`, `order_id` or `token_id`), which is what lets the composite below be their
 * union with the expectations simply added up.
 */
const CLASSES: readonly IdentityCase[] = [
  { name: "the clean control", seed: "", expected: {} },
  { name: "nullOwners — an uncovered NULL owner", seed: UNCOVERED_NULL_OWNER, expected: { nullOwners: 1 } }, // prettier-ignore
  { name: "I1 — an unbound active SELL", seed: UNBOUND_SELL, expected: { unboundSells: 1 } },
  {
    name: "I2 — a cross-token pointer",
    seed: CROSS_TOKEN_STALE,
    expected: { stalePointerSells: 1 },
  },
  {
    name: "I2 — a pointer into a closed row",
    seed: CLOSED_POINTER,
    expected: { stalePointerSells: 1 },
  },
  { name: "I3 — the per-order zero floor", seed: OVERCOMMIT_FLOOR, expected: { overcommittedTokens: 1 } }, // prettier-ignore
  { name: "I3 — the render collision (8(b2))", seed: RENDER_COLLISION, expected: { overcommittedTokens: 1 } }, // prettier-ignore
  { name: "I4 — two nonclosed rows on a token", seed: DUPLICATE_TOKEN, expected: { duplicateNonclosedTokens: 1 } }, // prettier-ignore
  { name: "I5 — a bounce SELL on a profile row", seed: WRONG_OWNER_SELL, expected: { wrongOwnerSells: 1 } }, // prettier-ignore
];

const COMPOSITE: IdentityCase = {
  name: "all classes at once",
  seed: CLASSES.map((c) => c.seed).join("\n"),
  expected: CLASSES.reduce<Partial<Record<OwnershipInvariantId, number>>>((total, c) => {
    for (const [id, n] of Object.entries(c.expected)) {
      const key = id as OwnershipInvariantId;
      total[key] = (total[key] ?? 0) + n;
    }
    return total;
  }, {}),
};

// ───────────────────────────── 8(a) text identity ─────────────────────────────

describe("§9a.6 test 8(a) — the export EMBEDS the shared definition, verbatim", () => {
  it.each(OWNERSHIP_INVARIANT_ROW_SQL)(
    "$id — its `sql` appears in the emitted export text unchanged",
    ({ sql }) => {
      // Against the imported constant, never against a copy pasted into the test: this is the assertion
      // that fails if a future edit hand-writes the export block, which is the drift the deleted
      // fidelity suite was reaching for and the only form of it that is actually checkable.
      expect(CENSUS_EXPORT_SQL).toContain(sql);
    },
  );
});

// ───────────────────────────── 8(b) row-set identity ─────────────────────────────

describe("§9a.6 test 8(b) — the exported rows ARE the shared definition's rows", () => {
  it.each([...CLASSES, COMPOSITE])("$name", ({ seed, expected }) => {
    const run = runCensus(withClean(seed));
    const verdict = referenceVerdict(run.fixture, projectionOf(run));
    // On the REAL ledger first: without this the identity below could be `0 rows === 0 rows`.
    expectInvariantCounts(referenceCounts(verdict), expected);
    expectRowSetIdentity(run, verdict);
  });

  it("the render-collision fixture is what makes (b2) necessary, not decoration", () => {
    const run = runCensus(withClean(RENDER_COLLISION));
    const row = referenceVerdict(run.fixture, projectionOf(run)).overcommittedTokens.rows[0];
    const remaining = row?.remaining_sell_shares as number;
    const shares = row?.position_shares as number;

    // Different doubles — so the violation is genuine and a deep-equality assertion WOULD fire here …
    expect(Object.is(remaining, shares)).toBe(false);
    expect(remaining).toBeGreaterThan(shares);

    const [renderedRemaining, renderedShares] = renderThroughDisplay([remaining, shares]);
    if (rendererIsCorrectlyRounded()) {
      // x86_64: 17 significant digits are injective over binary64, so distinct doubles render distinctly
      // and (b2)'s rendering comparison is exactly as strict here as comparing the doubles would be.
      expect(renderedRemaining).not.toBe(renderedShares);
      expect([Number(renderedRemaining), Number(renderedShares)]).toEqual([remaining, shares]);
    } else {
      // arm64: ~1 ULP of renderer error costs injectivity, and this fixture is the witness — identical
      // renderings, so a deep-equality assertion over the diagnostics would fire with both sides correct.
      expect(renderedRemaining).toBe(renderedShares);
    }
  });
});

// ───────────────────────────── 8(c) the projection CTE ─────────────────────────────

/**
 * The `WITH projected_owners(...)` binding, as a removable unit. Derived from §5.1's live text rather than
 * hand-written, so the counter-example cannot go stale against the projection it is a counter-example to.
 */
const PROJECTION_CTE_RE =
  /,\n(?:--[^\n]*\n)*projected_owners\(position_id, owner\) AS \(\n[\s\S]*?\n\)\n(?=SELECT json_object\()/;

function withoutProjectionCte(sql: string): string {
  expect(sql).toMatch(PROJECTION_CTE_RE);
  const stripped = sql.replace(PROJECTION_CTE_RE, "\n");
  expect(stripped).not.toContain("projected_owners(position_id, owner) AS (");
  return stripped;
}

/** A target with a resting SELL whose rule implies the OTHER owner — I5's only projection-dependent shape. */
const PROJECTED_I5 = withClean(
  seedSql({
    orders: [
      {
        orderId: "o-projected",
        tokenId: "tok-clean",
        positionId: "pos-clean",
        side: "sell",
        status: "open",
      },
    ],
  }),
);

describe("§9a.6 test 8(c) — the exported verdict is evaluated against the PROJECTED owner", () => {
  it("a target's NULL owner stops counting, and its resting SELL starts being owner-checked", () => {
    const run = runCensus(PROJECTED_I5);
    expect(ownerPlan(run.decision)).toEqual({ "pos-clean": "bounce" });

    expectInvariantCounts(run.gates.invariants.counts, { wrongOwnerSells: 1 });
    expect(run.gates.invariants.rows.wrongOwnerSells[0]).toMatchObject({
      order_id: "o-projected",
      effective_owner: "bounce",
      implied_owner: "profile",
    });

    // The same ledger with NO projection decides the OPPOSITE way on both counts, which is what makes
    // "the projection is load-bearing" an observation rather than an assertion about the code's shape.
    expectInvariantCounts(referenceCounts(referenceVerdict(run.fixture, undefined)), {
      nullOwners: 1,
    });
  });

  it("an empty target set yields the ledger-only verdict — the activation gates' semantics", () => {
    const run = runCensus(UNCOVERED_NULL_OWNER);
    expect(run.loaded.manifest.targets).toHaveLength(0);
    expectInvariantCounts(run.gates.invariants.counts, { nullOwners: 1 });
    expectRowSetIdentity(run, referenceVerdict(run.fixture, undefined));
  });

  it("without the WITH binding the export FAILS — it can never be silently unprojected", () => {
    const fixture = createCensusFixture();
    fixture.seed(withClean(UNCOVERED_NULL_OWNER));
    expect(() => fixture.exportManifest({ mutateSql: withoutProjectionCte })).toThrow(
      /no such table: projected_owners/,
    );
  });
});

// ───────────────────────────── 8(d) schema provenance ─────────────────────────────

describe("§9a.6 test 8(d) — the fixture schema is production's, not a hand-rolled CREATE", () => {
  let fixture: CensusFixture;
  beforeAll(() => {
    fixture = createCensusFixture();
    fixture.seed(withClean());
  });

  it("carries the shipped `positions` DDL verbatim", () => {
    const ddl = withReference(fixture, (db) =>
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'positions'")
        .pluck()
        .get(),
    ) as string;
    // `sqlite_master` records the CREATE as executed minus `IF NOT EXISTS`; every other byte is the
    // shipped text, so containment after restoring that clause is exact provenance rather than a
    // resemblance check. A hand-rolled CREATE is how column drift becomes invisible.
    expect(LEDGER_SQL).toContain(
      ddl.replace("CREATE TABLE positions", "CREATE TABLE IF NOT EXISTS positions"),
    );
    expect(ddl).toContain("CHECK (exit_owner IN ('bounce', 'profile') OR exit_owner IS NULL)");
  });

  it("enforces the two artefacts bootstrap adds on top of it, both of which DECIDE fixtures in §7", () => {
    // The partial UNIQUE index is what forces the I4 fixture to be open+dust rather than open+open …
    expect(() =>
      fixture.seed(seedSql({ positions: [{ positionId: "pos-second", tokenId: "tok-clean" }] })),
    ).toThrow(/UNIQUE constraint failed/);

    // … and the immutability trigger is what makes `exit_owner` a one-way write, which is the whole
    // premise of the census: NULL → an owner is legal exactly once.
    fixture.seed("UPDATE positions SET exit_owner = 'bounce' WHERE position_id = 'pos-clean';");
    expect(() =>
      fixture.seed("UPDATE positions SET exit_owner = 'profile' WHERE position_id = 'pos-clean';"),
    ).toThrow(/exit_owner is immutable once set/);
  });
});

// ───────────────────────────── 8(e) I3 subtracts real fills ─────────────────────────────

/** The term under test, as it appears once in the embedded I3 — asserted, not assumed, below. */
const FILL_SUBTRACTION = "o.size - COALESCE(f.filled, 0)";

function withoutFillSubtraction(sql: string): string {
  expect(sql.split(FILL_SUBTRACTION)).toHaveLength(2);
  return sql.replace(FILL_SUBTRACTION, "o.size - 0");
}

describe("§9a.6 test 8(e) — the export's I3 subtracts real `fills` rows", () => {
  it("a resting SELL that only overcommits BEFORE its fill is subtracted reads clean", () => {
    const fixture = createCensusFixture();
    // `size` alone is 12 against a position of 10; `size − SUM(fills.size)` is 7. The difference falls in
    // the PASSING direction, which is the only direction a blocked-direction fixture cannot cover.
    fixture.seed(withClean(partialFillSeed({ fills: true })));
    expectInvariantCounts(reevaluate(fixture).gates.invariants.counts, {});

    // The control operates on the SQL under test rather than on the data: drop the subtraction term from
    // the embedded I3 and the very same ledger must flip to a violation.
    const unsubtracted = reevaluate(fixture, { mutateSql: withoutFillSubtraction });
    expectInvariantCounts(unsubtracted.gates.invariants.counts, { overcommittedTokens: 1 });
  });
});

// ───────────────────────────── 8(f) the declared columns ─────────────────────────────

describe("§9a.6 test 8(f) — the declared `columns` are the SQL's actual result columns", () => {
  let fixture: CensusFixture;
  beforeAll(() => {
    fixture = createCensusFixture();
  });

  it.each(OWNERSHIP_INVARIANT_ROW_SQL)("$id", ({ sql, columns }) => {
    // `json_object(r.*)` does not exist on 3.37.2, so the export must name the columns by hand; a
    // declaration that drifted from its query would emit `null`s into the manifest silently — a
    // diagnostic that reads as "no violation detail" rather than as an error.
    const actual = withReference(fixture, (db) => {
      db.exec(PROJECTED_OWNERS_CREATE_SQL);
      return db
        .prepare(sql)
        .columns()
        .map((c) => c.name);
    });
    expect(actual).toEqual([...columns]);
  });
});
