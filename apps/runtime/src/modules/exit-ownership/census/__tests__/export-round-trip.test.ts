import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OWNERSHIP_INVARIANT_ROW_SQL, type OwnershipInvariantId } from "@krabs/db";
import { BOUNCE_EXIT_TARGET_RULE_ID } from "@krabs/domain";
import { beforeAll, describe, expect, it } from "vitest";

import { buildCensusExportSql, realString } from "../export-sql.js";
import {
  canonicalPayloadDigest,
  ENVELOPE_FIELDS,
  loadManifest,
  type CensusManifest,
} from "../manifest.js";
import {
  AFTER_CUTOFF,
  OTHER_CONDITION,
  WHITELISTED_CONDITION,
  cleanSeed,
  createCensusFixture,
  rejected,
  seedSql,
  writeSidecar,
  type CensusFixture,
} from "./fixtures.js";
import {
  CHECK_FAILED,
  expectRolledBack,
  prepareApply,
  probeGuard,
  reevaluate,
} from "./pipeline.js";

/**
 * §7 tests 10 and 16 — the export as a TRANSPORT: what the ledger holds must be what the local dry run
 * decides on, and the digest that binds the two must see all of it.
 *
 * These two groups are one file because they share one question. Test 10 asks whether the whole pipeline
 * (emit → digest → the real loader) carries the ROWS; test 16 asks whether it carries the NUMBERS. §9a.2
 * makes the manifest an input of computation — the invariants are re-evaluated against a ledger rebuilt
 * from it — so a transport that is merely close is a transport that decides differently, and §7.16a is
 * that stated as an arithmetic fact rather than as a worry.
 *
 * **Two deviations from the plan's §7.16 wording, both because the literal fixture is unreachable on the
 * pinned 3.37.2 build.** Neither weakens what is asserted; each replaces an unconstructible claim with the
 * measured property the code actually has.
 *
 *  - **16b's `Number(exported) === originalRealBits` is not a property this build has — on some hosts.**
 *    `%!.17g` predates the 3.44 dtoa rewrite and converts through `LONGDOUBLE_TYPE`, so on arm64 macOS
 *    (`long double == double`) it is off by up to ~1 ULP and the build's decimal→double parser is off too;
 *    on x86_64 the 80-bit intermediate makes it correctly rounded. Measured on the same pinned 3.37.2
 *    source over 200 000 realistic sizes: **56 820 fail the render→parse round trip on arm64, 0 on
 *    x86_64.** A contract that held only where `long double` is wide would be no contract, so the
 *    operator-approved one is render-against-render (`export-sql.ts`, guard #3 in `generate-sql.ts`): the
 *    rendering must be DETERMINISTIC, not accurate — it is never parsed back. 16b below therefore asserts
 *    only what holds on both hosts: the exported string is the ledger renderer's own output, identical
 *    across all four columns, stable across two exports, and within 1 ULP. Nothing here is `toBeCloseTo`,
 *    and no rendering is pinned as a literal.
 *  - **16e's "`null` accepted unchanged for a nullable REAL" is not constructible.** All four REALs §5.1
 *    exports come from NOT NULL columns (`ledger.sql`: `positions.size`, `orders.size`, `fills.size`) and
 *    `filled_size` is COALESCEd, so no export can carry a null REAL. The NULL transport is pinned one level
 *    down instead, at the expression that produces it — §7.16c, which is where the `'0.0'` defect lives.
 */

/**
 * No freshness bound. `nowMs` is unread when the bound is `null` (`manifest.ts:verifyFreshness` returns
 * first), so this stays a constant rather than a clock — every case below is about content, not age.
 */
const NO_FRESHNESS_BOUND = { maxAgeHours: null, nowMs: 0 } as const;

/** The four REAL-bearing fields §5.1 exports, as `(content group, key)` pairs. */
const EXPORTED_REALS = [
  ["targets", "size"],
  ["nonclosed_positions", "size"],
  ["active_sell_orders", "size"],
  ["active_sell_orders", "filled_size"],
] as const;

// ───────────────────────────── the two seeds ─────────────────────────────

/**
 * §7.16a's demonstration ledger, exactly as the plan specifies it: a position of `9.774` against a resting
 * SELL of `10` that has taken two fills, `0.015` and `0.211`.
 *
 * The numbers are the point. SQLite computes `0.015 + 0.211` as the double below `0.226`, so the remaining
 * shares are one ULP ABOVE the position's `9.774` and I3 fires. Route the same quantity through a bare
 * `json_object` numeric and the sum becomes `0.226` exactly, the remainder becomes `9.774` exactly, and the
 * violation disappears — a difference of one ULP deciding whether two engines are selling the same shares.
 *
 * `decisionRuleId` is the bounce target rule so that I5 stays clean (the projected owner of a `GATE` lane
 * position on a whitelisted market is `bounce`, which is what the order implies): I3 must be the ONLY
 * violation, or the test could not tell which invariant the precision changed.
 */
const PRECISION_SEED = seedSql({
  markets: [{ tokenId: "tok-precision", conditionId: WHITELISTED_CONDITION }],
  positions: [
    {
      positionId: "pos-precision",
      tokenId: "tok-precision",
      conditionId: WHITELISTED_CONDITION,
      entryLane: "GATE",
      size: 9.774,
    },
  ],
  legStates: [{ tokenId: "tok-precision", firstTradeAt: AFTER_CUTOFF }],
  orders: [
    {
      orderId: "o-precision",
      tokenId: "tok-precision",
      positionId: "pos-precision",
      size: 10,
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
    },
  ],
  fills: [
    { fillId: "f-precision-1", orderId: "o-precision", tokenId: "tok-precision", size: 0.015 },
    { fillId: "f-precision-2", orderId: "o-precision", tokenId: "tok-precision", size: 0.211 },
  ],
});

/**
 * §7.10's fixture: the precision ledger plus the two shapes the plan names separately.
 *
 *  - `pos-skew` carries `positions.condition_id = OTHER` while its `markets` row says WHITELISTED — the
 *    §2.3 divergence, which the export must carry as data on BOTH sides rather than resolving on the way
 *    out (the owner projection reads the market's, the target row reports the position's);
 *  - `pos-closed` is closed AND owned, which is the sole population of §5.1.9. Nothing else in this
 *    fixture puts a row there, and the sensitivity table below needs every content group non-empty.
 */
const ROUND_TRIP_SEED = [
  PRECISION_SEED,
  seedSql({
    markets: [
      { tokenId: "tok-skew", conditionId: WHITELISTED_CONDITION },
      { tokenId: "tok-closed", conditionId: WHITELISTED_CONDITION },
    ],
    positions: [
      {
        positionId: "pos-skew",
        tokenId: "tok-skew",
        conditionId: OTHER_CONDITION,
        entryLane: "GATE",
        size: 4,
      },
      {
        positionId: "pos-closed",
        tokenId: "tok-closed",
        status: "closed",
        size: 0,
        exitOwner: "profile",
      },
    ],
    legStates: [{ tokenId: "tok-skew", firstTradeAt: AFTER_CUTOFF }],
  }),
].join("\n");

// ───────────────────────────── shared primitives ─────────────────────────────

/** The one row matching `match` — a throw, not an expectation: a fixture that lost it is broken. */
function one<T>(rows: readonly T[], match: (row: T) => boolean, what: string): T {
  const found = rows.filter(match);
  if (found.length !== 1) {
    throw new Error(`expected exactly one ${what} in the exported manifest, found ${found.length}`);
  }
  return found[0] as T;
}

function rowsOf(document: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const rows = document[key];
  if (!Array.isArray(rows)) throw new Error(`$.${key} is not an array`);
  return rows as Record<string, unknown>[];
}

function firstRow(document: Record<string, unknown>, key: string): Record<string, unknown> {
  const rows = rowsOf(document, key);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`$.${key} is empty — every content group must be populated to be mutable`);
  }
  return row;
}

function invariantRows(document: Record<string, unknown>, id: string): unknown[] {
  const rows = objectAt(document, "invariants")[id];
  if (!Array.isArray(rows)) {
    throw new Error(`$.invariants.${id} is not an array`);
  }
  return rows;
}

function objectAt(document: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = document[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`$.${key} is not an object`);
  }
  return value as Record<string, unknown>;
}

let derivedCount = 0;

/** A mutated copy of an exported manifest, written to its own file and correctly signed. */
function signedManifest(
  dir: string,
  baseline: string,
  mutate: (document: Record<string, unknown>) => void,
): string {
  const document = JSON.parse(baseline) as Record<string, unknown>;
  mutate(document);
  const path = join(dir, `derived-${(derivedCount += 1)}.json`);
  writeFileSync(path, JSON.stringify(document));
  writeSidecar(path);
  return path;
}

function invariantSql(id: OwnershipInvariantId): string {
  return one(OWNERSHIP_INVARIANT_ROW_SQL, (entry) => entry.id === id, `invariant ${id}`).sql;
}

/** The production-side count of an invariant's violations, on the REAL doubles, via the pinned CLI. */
function ledgerViolationCount(fixture: CensusFixture, id: OwnershipInvariantId): number {
  return Number(fixture.query(`SELECT COUNT(*) FROM (${invariantSql(id)});`));
}

// ───────────────────────────── §7.10 — the real export round trip ─────────────────────────────

describe("§7.10 — the whole pipeline: emit → digest → the real loader", () => {
  it("carries a lowercase SELL, its aggregated fills, and a divergent market condition", () => {
    const fixture = createCensusFixture();
    fixture.seed(ROUND_TRIP_SEED);
    const { loaded, path, json } = fixture.exportManifest();

    // Both digests are the ones the runbook's `sha256sum` and §5.1.8's determinism comparison mean.
    expect(loaded.bytesSha256).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
    expect(loaded.canonicalPayloadSha256).toBe(canonicalPayloadDigest(JSON.parse(json)));

    // `side='SELL'` returns ZERO rows on this schema — the defect §5.1 was reshaped to avoid, and the
    // reason the existence of this row is asserted before anything about its contents.
    const order = one(loaded.manifest.activeSellOrders, () => true, "active sell order");
    expect(order.orderId).toBe("o-precision");
    expect(order.side).toBe("sell");
    expect(order.positionId).toBe("pos-precision");
    // Several `fills` rows, summed ONCE by the exporter: the aggregate is the double SQLite computed, not
    // a re-sum of parts (which is what §9a.2's single materialized fill row preserves).
    expect(Object.is(Number(order.filledSize), 0.015 + 0.211)).toBe(true);

    // §2.3's divergence, carried on both sides instead of resolved: the target reports the POSITION's
    // condition, `target_markets` the authoritative MARKET one, and the owner projection reads the latter.
    const target = one(
      loaded.manifest.targets,
      (t) => t.positionId === "pos-skew",
      "pos-skew target",
    );
    expect(target.conditionId).toBe(OTHER_CONDITION);
    const market = one(
      loaded.manifest.targetMarkets,
      (m) => m.tokenId === "tok-skew",
      "tok-skew market",
    );
    expect(market).toEqual({
      tokenId: "tok-skew",
      marketConditionId: WHITELISTED_CONDITION,
      marketRowPresent: true,
    });
    const projected = one(
      loaded.manifest.sqlOwnerProjection,
      (p) => p.positionId === "pos-skew",
      "pos-skew projection",
    );
    expect(projected.owner).toBe("bounce");

    // §5.1.9 — closed AND owned. The sole input of `--verify-owner-map`'s deletion clause.
    expect(loaded.manifest.ownedClosedPositions).toEqual([
      { positionId: "pos-closed", status: "closed", exitOwner: "profile" },
    ]);
  });

  it("rejects a single flipped byte as a DIGEST mismatch, not as bad JSON", () => {
    const fixture = createCensusFixture();
    fixture.seed(ROUND_TRIP_SEED);
    const { path } = fixture.exportManifest();

    const bytes = readFileSync(path);
    const at = Math.floor(bytes.length / 2);
    bytes.writeUInt8(bytes.readUInt8(at) ^ 0x01, at);
    writeFileSync(path, bytes);

    // The digest is verified BEFORE the parse, which is what makes it a check on the TRANSFER: a flip that
    // happens to leave valid JSON is caught all the same, and one that does not is not misreported as a
    // truncated copy. `manifest.test.ts` pins the same class from a whitespace edit; this one is a bit.
    const rejection = rejected(() => loadManifest(path, NO_FRESHNESS_BOUND));
    expect(rejection.kind).toBe("hash");
    expect(rejection.message).toContain("manifest digest mismatch: sidecar says");
  });

  it("two exports of an unchanged ledger differ in the envelope and nowhere else", () => {
    const fixture = createCensusFixture();
    fixture.seed(ROUND_TRIP_SEED);
    const first = fixture.exportManifest().loaded;
    const second = fixture.exportManifest().loaded;

    expect(second.canonicalPayloadSha256).toBe(first.canonicalPayloadSha256);
    // Full-document byte equality is deliberately NOT asserted: `exportedAt` comes from the ledger's own
    // clock, so it is false by construction and such a test could only pass by never running. The
    // constructible form is this — every field but the envelope is identical.
    expect({ ...second.manifest, exportedAt: first.manifest.exportedAt }).toEqual(first.manifest);
  });
});

describe("§7.10 — the canonical payload digest is sensitive to every content group", () => {
  /**
   * The envelope is a DENY-list (§5.1.8), so a content group added to §5.1 joins the digest silently and
   * correctly — and a group REMOVED from it silently stops being compared. One case per top-level key, with
   * a completeness assertion below, is what keeps that from happening unnoticed.
   */
  const CASES: ReadonlyArray<{
    readonly group: string;
    readonly mutate: (document: Record<string, unknown>) => void;
  }> = [
    // Deliberately inside the payload (`manifest.ts:ENVELOPE_FIELDS`): exporter drift is exactly what the
    // digest should surface, so this is a positive case and not the negative one.
    // Incremented rather than set to a literal, so a future §5.1 version bump cannot turn this case into a
    // no-op mutation that passes `digestAfter`'s guard by accident.
    {
      group: "manifestVersion",
      mutate: (d) => void (d.manifestVersion = Number(d.manifestVersion) + 1),
    },
    { group: "targets", mutate: (d) => void (firstRow(d, "targets").size = "1.0") },
    {
      group: "nonclosed_positions",
      mutate: (d) => void (firstRow(d, "nonclosed_positions").exit_owner = "bounce"),
    },
    {
      group: "active_sell_orders",
      mutate: (d) => void (firstRow(d, "active_sell_orders").filled_size = "0.5"),
    },
    {
      group: "target_markets",
      mutate: (d) => void (firstRow(d, "target_markets").market_row_present = 0),
    },
    {
      group: "target_order_conditions",
      mutate: (d) => void (firstRow(d, "target_order_conditions").condition_id = OTHER_CONDITION),
    },
    { group: "policy", mutate: (d) => void (objectAt(d, "policy").policy_row_count = 2) },
    {
      group: "sql_owner_projection",
      mutate: (d) => void (firstRow(d, "sql_owner_projection").owner = "profile"),
    },
    {
      group: "owned_closed_positions",
      mutate: (d) => void (firstRow(d, "owned_closed_positions").exit_owner = "bounce"),
    },
    // Content group 9 (§5.1.11). Pushed rather than edited in place: on a clean ledger every invariant
    // array is legitimately empty, so there is no row to mutate — and an empty group that silently fell
    // out of the digest is precisely the failure this table exists to catch.
    {
      group: "invariants",
      mutate: (d) =>
        void invariantRows(d, "nullOwners").push({ position_id: "pos-x", token_id: "tok-x" }),
    },
  ];

  let baseline = "";
  let baselineDigest = "";

  beforeAll(() => {
    const fixture = createCensusFixture();
    fixture.seed(ROUND_TRIP_SEED);
    const { loaded, json } = fixture.exportManifest();
    baseline = json;
    baselineDigest = loaded.canonicalPayloadSha256;
    // Binds the pure helper the cases below use to the quantity the LOADER actually reports, so the table
    // cannot end up measuring a digest no consumer reads.
    expect(canonicalPayloadDigest(JSON.parse(baseline))).toBe(baselineDigest);
  });

  const digestAfter = (mutate: (document: Record<string, unknown>) => void): string => {
    const document = JSON.parse(baseline) as Record<string, unknown>;
    mutate(document);
    // A mutation that changed nothing would make its case pass or fail for the wrong reason — the negative
    // one below especially, which asserts a digest does NOT move.
    expect(JSON.stringify(document)).not.toBe(JSON.stringify(JSON.parse(baseline)));
    return canonicalPayloadDigest(document);
  };

  it.each(CASES)("mutating $group changes the digest", ({ mutate }) => {
    expect(digestAfter(mutate)).not.toBe(baselineDigest);
  });

  // Driven off the deny-list rather than off the single field it holds today: a second envelope field would
  // otherwise be excluded from the digest with nothing asserting it, which is the failure this pair owns.
  it.each(ENVELOPE_FIELDS)(
    "mutating %s — an envelope field — leaves the digest unchanged",
    (field) => {
      expect(digestAfter((d) => void (d[field] = "2020-01-01T00:00:00.000Z"))).toBe(baselineDigest);
    },
  );

  it("the table covers every top-level key except the envelope", () => {
    // The mechanical half of the deny-list argument: a further key added to §5.1 with no case above would
    // sit outside the determinism comparison, and only this assertion notices.
    const keys = Object.keys(JSON.parse(baseline) as Record<string, unknown>);
    const envelope = new Set<string>(ENVELOPE_FIELDS);
    expect(new Set(CASES.map((c) => c.group))).toEqual(
      new Set(keys.filter((key) => !envelope.has(key))),
    );
  });
});

// ───────────────────────────── §7.16a — one ULP decides an invariant ─────────────────────────────

/**
 * `realString`'s wrapper stripped back to the bare column, derived from the CURRENT exporter text rather
 * than kept as a second SQL constant: a hand-copied "old export" could not go stale, and would stop
 * tracking §5.1 the moment it changed. `\1` is a back-reference, so only a genuine `realString(X)` matches.
 */
const REAL_STRING_RE = /CASE WHEN (.+?) IS NULL THEN NULL ELSE printf\('%!\.17g', \1\) END/g;

function withBareNumericReals(sql: string): string {
  // The substitution must actually fire, once per exported REAL — a regex that silently matched nothing
  // would make the control below a copy of the positive case.
  expect([...sql.matchAll(REAL_STRING_RE)]).toHaveLength(EXPORTED_REALS.length);
  return sql.replaceAll(REAL_STRING_RE, "$1");
}

describe("§7.16a — the emitter is not json_object, and the precision case is why", () => {
  const I3: OwnershipInvariantId = "overcommittedTokens";

  it("the export carries the 17-digit strings the ledger holds", () => {
    const fixture = createCensusFixture();
    fixture.seed(PRECISION_SEED);

    // Production: the real invariant SQL, on the real doubles, run by the pinned 3.37.2 CLI.
    expect(ledgerViolationCount(fixture, I3)).toBe(1);

    // The dry run reads that SAME verdict — after §5.1.11 it is computed by that SQL *inside* the export
    // and never recomputed here, so what crosses the JSON boundary is only the DISPLAY of the quantities:
    // the doubles JS prints as 9.774000000000001 and 9.774, through §5.1.10's one renderer.
    const run = reevaluate(fixture);
    expect(run.gates.invariants.counts[I3]).toBe(ledgerViolationCount(fixture, I3));

    const row = one(run.gates.invariants.rows[I3], () => true, "I3 violation");
    expect(row.token_id).toBe("tok-precision");
    expect(row.remaining_sell_shares).toBe("9.7740000000000009");
    expect(row.position_shares).toBe("9.7739999999999991");

    // The fill aggregate the two are computed from, in the content group that carries it. Asked of the
    // ledger rather than pinned as a literal: `String(0.015 + 0.211)` is `…98`, and `%!.17g` emits `…97`
    // on arm64 macOS and `…98` on x86_64 — the ~1 ULP skew §7.16b documents, which is a property of the
    // host's `long double` and not of this export. What the export owes is the renderer's own output,
    // whatever it is; §5.1.10 asks for determinism, not for the shortest representation.
    expect(one(run.loaded.manifest.activeSellOrders, () => true, "order").filledSize).toBe(
      fixture.query(`SELECT ${realString("sum(size)")} FROM fills WHERE order_id = 'o-precision';`),
    );
  });

  it("a bare json_object numeric truncates that to 0.226 — which is what makes this a regression test", () => {
    const fixture = createCensusFixture();
    fixture.seed(PRECISION_SEED);
    expect(ledgerViolationCount(fixture, I3)).toBe(1);

    const emitted = fixture.runReadOnly(
      withBareNumericReals(buildCensusExportSql(fixture.controlPath)),
    );
    expect(emitted.stderr).toBe("");
    const document = JSON.parse(emitted.stdout) as Record<string, unknown>;

    // The historical fact in observable form: SQLite computes `0.015 + 0.211` as 0.22599999999999998 and a
    // bare `json_object` emits three digits of it. `10 - 0.226` is exactly `9.774`, so a consumer of THAT
    // number sees nothing over-committed on the very ledger the under-lock guard aborts on.
    const bare = one(
      rowsOf(document, "active_sell_orders"),
      () => true,
      "active sell order",
    ).filled_size;
    expect(bare).toBe(0.226);
    expect(10 - Number(bare)).toBe(9.774);

    // The pre-§5.1.10 exporter emitted JSON numbers and its loader read them; today's refuses them by type.
    // Stringifying is the faithful bridge — it changes the TYPE the loader sees and nothing whatever about
    // the VALUE that exporter chose. `String` is JS's shortest round-trip, so it cannot reintroduce loss.
    for (const [group, key] of EXPORTED_REALS) {
      for (const row of rowsOf(document, group)) row[key] = String(row[key]);
    }
    const path = join(fixture.dir, "bare-numeric.json");
    writeFileSync(path, JSON.stringify(document));
    writeSidecar(path);

    // The assertion the test above makes, failing against a manifest built with a bare `json_object`.
    const manifest = loadManifest(path, NO_FRESHNESS_BOUND).manifest;
    const filledSize = one(manifest.activeSellOrders, () => true, "active sell order").filledSize;
    expect(filledSize).toBe("0.226");
    expect(filledSize).not.toBe("0.22599999999999998");
  });
});

// ───────────────────────────── §7.16b — every REAL, through 3.37.2 ─────────────────────────────

/**
 * The values, measured through the pinned renderer — but NOT with the rendering pinned as a literal.
 *
 * That was the first shape of this table and it was wrong. `printf('%!.17g')` in 3.37.2 converts through
 * `LONGDOUBLE_TYPE`, which is 80-bit on x86_64 and 64-bit (i.e. plain `double`) on arm64 macOS, so the SAME
 * pinned 3.37.2 build renders the same double differently on the two machines — and a literal measured on
 * the dev Mac fails on the only host that matters. Measured on both, for the eight below:
 *
 *   value                    arm64 macOS (dev)         x86_64 (production + CI)
 *   5e-324                   4.940656458412465e-324    4.9406564584124654e-324
 *   2.2250738585072014e-308  2.2250738585072009e-308   2.2250738585072014e-308
 *   12                       11.999999999999999        12.0
 *   10                       10.0                      10.0
 *   0.22599999999999998      0.22600000000000002       0.22599999999999998
 *   5.3199999999999994       5.3199999999999993        5.3199999999999994
 *   5.3200000000000003       5.3200000000000002        5.3200000000000003
 *   31897.89                 31897.889999999997        31897.889999999999
 *
 * On x86_64 the 80-bit intermediate makes `%!.17g` correctly rounded, so every rendering parses back into
 * its own double; on arm64 four of these eight do not. That asymmetry is exactly why §5.1.10 carries the
 * rendering as TEXT and compares render-against-render: the transport must not depend on the width of the
 * host's `long double`. So what this group pins is the properties that hold on BOTH — the rendering is what
 * the ledger's own renderer produced, it is identical in all four exported columns, it is deterministic,
 * and it is never more than 1 ULP from the double it came from. The rendering itself is read off the pinned
 * CLI at run time, because the CLI *is* the specification here.
 */
const RENDERED_REALS = [
  { label: "the smallest denormal", value: 5e-324 },
  { label: "the smallest normal double", value: 2.2250738585072014e-308 },
  { label: "an integer stored as REAL", value: 12 },
  { label: "an integer that survives", value: 10 },
  { label: "all 17 significant digits", value: 0.22599999999999998 },
  { label: "production's resting SELL, lower", value: 5.3199999999999994 },
  { label: "production's resting SELL, upper", value: 5.3200000000000003 },
  { label: "the value §5.1.10 names", value: 31897.89 },
].map((real, index) => ({ ...real, id: `r${index}` }));

/** Distance in representable doubles. Adjacent binary64 values differ by 1 in this encoding, denormals included. */
function ulpDistance(a: number, b: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  const bits = (x: number): bigint => {
    view.setFloat64(0, x);
    return view.getBigUint64(0);
  };
  const [x, y] = [bits(a), bits(b)];
  return x > y ? x - y : y - x;
}

describe("§7.16b — every REAL column §5.1 exports, on the pinned 3.37.2 renderer", () => {
  let first: CensusManifest = {} as CensusManifest;
  let second: CensusManifest = {} as CensusManifest;
  /** What the pinned CLI renders the seeded REAL as, asked of the ledger column itself — the expectation. */
  const rendered = new Map<string, string>();

  beforeAll(() => {
    const fixture = createCensusFixture();
    // Every value gets its own token, position, SELL order and single fill, so all four exported REAL
    // columns carry it: `targets.size`, `nonclosed_positions.size`, `active_sell_orders.size` and the
    // `filled_size` aggregate. One seed covers the whole table times the whole column list.
    fixture.seed(
      seedSql({
        positions: RENDERED_REALS.map(({ id, value }) => ({
          positionId: `pos-${id}`,
          tokenId: `tok-${id}`,
          conditionId: WHITELISTED_CONDITION,
          size: value,
        })),
        orders: RENDERED_REALS.map(({ id, value }) => ({
          orderId: `o-${id}`,
          tokenId: `tok-${id}`,
          positionId: `pos-${id}`,
          size: value,
        })),
        fills: RENDERED_REALS.map(({ id, value }) => ({
          fillId: `f-${id}`,
          orderId: `o-${id}`,
          tokenId: `tok-${id}`,
          size: value,
        })),
      }),
    );
    // Read the expectation off the ledger through the SAME fragment the exporter uses, before the export
    // runs. Not circular: it is the renderer that is being taken as given, and the export chain
    // (`json_object` → the file → `loadManifest`) that is being asserted to add nothing to it.
    for (const { id } of RENDERED_REALS) {
      rendered.set(
        id,
        fixture.query(
          `SELECT ${realString("size")} FROM positions WHERE position_id = 'pos-${id}';`,
        ),
      );
    }

    first = fixture.exportManifest().loaded.manifest;
    second = fixture.exportManifest().loaded.manifest;
  });

  it.each(RENDERED_REALS)("$label renders identically in all four columns", ({ id }) => {
    const expected = rendered.get(id) ?? "";
    expect(expected).not.toBe("");
    expect(one(first.targets, (t) => t.positionId === `pos-${id}`, `target ${id}`).size).toBe(
      expected,
    );
    expect(
      one(first.nonclosedPositions, (p) => p.positionId === `pos-${id}`, `position ${id}`).size,
    ).toBe(expected);
    const order = one(first.activeSellOrders, (o) => o.orderId === `o-${id}`, `order ${id}`);
    expect(order.size).toBe(expected);
    // The SUM aggregate over one fill, which must not differ from the column it summed.
    expect(order.filledSize).toBe(expected);
  });

  it.each(RENDERED_REALS)(
    "$label lands within 1 ULP of the double it came from",
    ({ id, value }) => {
      // NOT `toBeCloseTo`: a tolerance-based assertion here would pass on the very defect §5.1.10 exists for.
      // Exactness cannot be asserted — it holds on x86_64 and fails on four of these on arm64 (see the table
      // above) — but "off by at most one representable double" holds on both, and separates a renderer that
      // is merely imprecise from one that is broken. §5.1.10 needs neither: it never parses this back.
      expect(ulpDistance(Number(rendered.get(id) ?? ""), value)).toBeLessThanOrEqual(1n);
    },
  );

  it("the alternate form keeps an integral REAL a REAL", () => {
    // `%!.17g`, not `%.17g`: the `!` is what makes `10` render `10.0` rather than `10`, on every host. A
    // rendering that lost the point would re-enter the ledger as an INTEGER and change the row's type.
    const ten = RENDERED_REALS.find((real) => real.value === 10);
    expect(rendered.get(ten?.id ?? "")).toBe("10.0");
  });

  it("two exports of the same ledger render every REAL to the same bytes", () => {
    // Determinism is the property the whole transport rests on — drift is detected by comparing renderings,
    // so a renderer that varied between two runs would report drift on a ledger that never moved.
    expect(second.targets).toEqual(first.targets);
    expect(second.nonclosedPositions).toEqual(first.nonclosedPositions);
    expect(second.activeSellOrders).toEqual(first.activeSellOrders);
  });
});

// ───────────────────────────── §7.16c — the NULL trap ─────────────────────────────

const UNFILLED_SEED = seedSql({
  markets: [{ tokenId: "tok-unfilled", conditionId: WHITELISTED_CONDITION }],
  positions: [
    {
      positionId: "pos-unfilled",
      tokenId: "tok-unfilled",
      conditionId: WHITELISTED_CONDITION,
      entryLane: "GATE",
    },
  ],
  legStates: [{ tokenId: "tok-unfilled", firstTradeAt: AFTER_CUTOFF }],
  orders: [
    {
      orderId: "o-unfilled",
      tokenId: "tok-unfilled",
      positionId: "pos-unfilled",
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
    },
  ],
});

describe("§7.16c — the NULL trap the CASE wrapper exists for", () => {
  it("realString renders NULL as JSON null; the bare printf renders the STRING '0.0'", () => {
    const fixture = createCensusFixture();
    expect(fixture.query(`SELECT json_object('v', ${realString("NULL")});`)).toBe('{"v":null}');
    // Not null, not 0 — the string "0.0", which is a REAL-shaped value that every consumer downstream
    // would read as a real quantity.
    expect(fixture.query(`SELECT json_object('v', printf('%!.17g', NULL));`)).toBe('{"v":"0.0"}');
  });

  it("end to end: an absent fill aggregate stays absent, and becomes 0.0 without the wrapper", () => {
    const fixture = createCensusFixture();
    fixture.seed(UNFILLED_SEED);

    // `f.filled` is NULL under §5.1.3's LEFT JOIN whenever an order has no `fills` rows. The COALESCE
    // normally answers that case first, so the wrapper's own behaviour is only observable with it removed —
    // and removing it is also how a future edit could reach production.
    const withCase = buildCensusExportSql(fixture.controlPath).replaceAll(
      "COALESCE(f.filled, 0)",
      "f.filled",
    );
    const withoutCase = withCase.replaceAll(realString("f.filled"), `printf('%!.17g', f.filled)`);
    expect(withoutCase).not.toBe(withCase);

    expect(exportedFilledSize(fixture, withCase)).toBeNull();
    // The defect in observable form: an ABSENT aggregate becomes a real quantity, and I3 subtracts it from
    // the order's size as though a fill had happened.
    expect(exportedFilledSize(fixture, withoutCase)).toBe("0.0");
  });
});

function exportedFilledSize(fixture: CensusFixture, sql: string): unknown {
  const run = fixture.runReadOnly(sql);
  expect(run.stderr).toBe("");
  const document = JSON.parse(run.stdout) as Record<string, unknown>;
  return one(rowsOf(document, "active_sell_orders"), () => true, "active sell order").filled_size;
}

// ─────────────────────── §7.16d — the two DECISIONS agree, end to end ───────────────────────

/**
 * v15 asked this group whether §9a.2's materialized invariant verdict agreed with guard #5's under-lock
 * one. After §5.1.11 those two ARE one text over one live ledger, so the question is an identity rather
 * than a claim — and §9a.6 test 8 is where the identity is pinned.
 *
 * What remains a genuine two-implementation property, and is what this group now asserts, is the one the
 * immutable column actually rests on: the LOCAL decision (§5.2, TS, via `isBounceLadderEligible`) and
 * guard #6's under-lock re-derivation (`ownerProjectionSql`) must assign the same owner to every target.
 * §7 test 5 seeds the negative direction — a planted TS/SQL disagreement blocks the whole run — so this is
 * the positive control, over a fixture set spanning both owners (`cleanSeed` carries `bounce`, `GATE` and
 * `profile` targets) and both outcomes (commit / abort).
 */
describe("§7.16d — the local decision and guard #6's re-derivation assign the same owner", () => {
  const AGREEMENT_FIXTURES = [
    { label: "a clean ledger", seed: cleanSeed(), commits: true },
    { label: "§7.16a's overcommit", seed: PRECISION_SEED, commits: false },
  ];

  it.each(AGREEMENT_FIXTURES)("$label — decision and re-derivation agree", ({ seed, commits }) => {
    const applied = prepareApply(seed);

    // Guard #6 counts the targets whose re-derived owner IS NOT the planned one; "1" is its `= 0`, i.e.
    // agreement on ALL of them. Probed rather than inferred from a clean run, so the abort fixture below
    // reports guard #6's own verdict instead of guard #5's.
    expect(probeGuard(applied, { id: "6" })).toBe("1");
    expect(Object.keys(applied.plannedOwners).length).toBeGreaterThan(0);

    // Agreement per row is not the whole claim: the run must reach the same OUTCOME. A suite that asserted
    // only "no wrong owner was committed" passes on a disagreement, because the guards abort either way.
    if (commits) {
      const run = applied.fixture.runApply(applied.applySql);
      expect(run.stderr).toBe("");
      expect(run.ok).toBe(true);
      expect(applied.fixture.ownerMap()).toEqual(expect.objectContaining(applied.plannedOwners));
      // The clean fixture is the one that spans both owners, and it is worth stating: an all-`profile`
      // (or all-`bounce`) fixture would agree trivially.
      expect(new Set(Object.values(applied.plannedOwners))).toEqual(new Set(["bounce", "profile"]));
    } else {
      expectRolledBack(applied, CHECK_FAILED);
    }
  });
});

// ─────────────────────────── §7.16e — one validator, and only one ───────────────────────────

/**
 * The plan's ten values. Emitting a REAL as a string moves a whole class of malformed input from
 * "impossible by JSON type" to "a string that parses to something else", and §5.1.10 puts every check for
 * it in ONE place. Both halves of `requireReal` are load-bearing here: the regex alone admits `"1e999"`
 * (pinned in `manifest.test.ts`) and `Number.isFinite` alone admits `""` → 0 and `" 1.5"` → 1.5.
 *
 * v16 paired this table with a totality control on `materializeManifestLedger` — "the second reader must
 * have no REAL-validation branch of its own". §5.1.11 deletes that function, so there is no second reader
 * to pin the absence of, and the control is deleted with it rather than re-pointed at something else. The
 * refinement itself is unchanged and still the only one: after §5.1.11 these strings feed the report and
 * guard #3's text comparison, where a `"1,5"` or `""` corrupts an audit record or a CAS literal.
 */
const REJECTED_REALS = [
  "",
  "bogus",
  "NaN",
  "Infinity",
  "-Infinity",
  " 1.5",
  "1,5",
  "1.",
  "01",
  "0x1p3",
];

describe("§7.16e — the string refinement lives in loadManifest, and nowhere else", () => {
  let dir = "";
  let baseline = "";

  beforeAll(() => {
    const fixture = createCensusFixture();
    fixture.seed(ROUND_TRIP_SEED);
    dir = fixture.dir;
    baseline = fixture.exportManifest().json;
  });

  it.each(REJECTED_REALS)("rejects %j, naming the field and the row it belongs to", (value) => {
    const path = signedManifest(dir, baseline, (document) => {
      firstRow(document, "targets").size = value;
    });
    const rejection = rejected(() => loadManifest(path, NO_FRESHNESS_BOUND));
    // `real_string`, not `schema`: the value IS a string, and the operator's remedy for "the exporter is
    // emitting garbage into a REAL" differs from "a column is missing".
    expect(rejection.kind).toBe("real_string");
    expect(rejection.message).toBe(
      `$.targets[0].size is not a canonical finite decimal for pos-precision: ${JSON.stringify(value)}`,
    );
  });

  it("refuses null as a SCHEMA error — no REAL this manifest carries is nullable", () => {
    // The other half of the contract, in the only form the export makes constructible (see this file's
    // header): every REAL comes from a NOT NULL column and `filled_size` is COALESCEd, so a null here is a
    // malformed DOCUMENT, not a malformed number — and the two kinds carry different operator remedies.
    // The NULL transport itself is pinned one level down, at the expression that produces it (§7.16c).
    const path = signedManifest(dir, baseline, (document) => {
      firstRow(document, "active_sell_orders").filled_size = null;
    });
    const rejection = rejected(() => loadManifest(path, NO_FRESHNESS_BOUND));
    expect(rejection.kind).toBe("schema");
    expect(rejection.message).toBe(
      "$.active_sell_orders[0].filled_size must be a decimal string (§5.1.10), got null for o-precision",
    );
  });
});
