import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildCensusExportSql } from "../export-sql.js";
import { ManifestRejection, loadManifest, type LoadedCensusManifest } from "../manifest.js";
import { productionSqlite3 } from "./sqlite-cli.js";

/**
 * §7's shared fixture builder — ONE way to construct a census fixture, for all of test groups 2–21.
 *
 * Three rules the plan states and this file enforces mechanically:
 *
 *  - **Fixtures are built from the REAL schema.** `ledger.sql` / `control.sql` are executed verbatim, so a
 *    seed the production schema would reject (two `open` rows on one `token_id`, a NULL
 *    `markets.condition_id`, a NULL `leg_states.first_trade_at`) fails HERE, at seed time, rather than
 *    becoming a test that cannot fail. §7 test 3 and test 14a both turn on exactly that.
 *  - **The manifest is EXPORTED, never hand-built** (§7 test 3, author finding A5). The dry run has no
 *    local ledger, so a test that evaluates a directly-constructed database exercises a path production
 *    never takes, and any column §5.1 forgets to carry stays invisible.
 *  - **Everything runs on the pinned 3.37.2 CLI** — see `sqlite-cli.ts`.
 *
 * `split-db.test.ts`'s position helper was deliberately NOT reused (§7 test 3): it hardcodes
 * `token_id = 'tok-1'`, so two calls collide on the partial UNIQUE index instead of on the invariant, and
 * it seeds no `orders`/`fills`, which I1/I2/I3/I5 all read.
 */

const SCHEMAS_DIR = resolve(import.meta.dirname, "../../../../../../../packages/db/src/schemas");

/**
 * The SAME text `bootstrapLedgerDb` executes for a fresh ledger (`bootstrap.ts:504`). Exported because
 * §9a.6 test 8(d) asserts the fixture's schema PROVENANCE against it — that the DDL under test is the
 * shipped one rather than a hand-rolled `CREATE TABLE`, which is how column drift becomes invisible.
 */
export const LEDGER_SQL = readFileSync(resolve(SCHEMAS_DIR, "ledger.sql"), "utf8");
const CONTROL_SQL = readFileSync(resolve(SCHEMAS_DIR, "control.sql"), "utf8");

/** The cutoff every fixture dates itself against — `sellableFlow.appliesFromMs` in the seeded policy. */
export const FIXTURE_CUTOFF_MS = Date.parse("2026-07-20T00:00:00.000Z");
export const AFTER_CUTOFF = new Date(FIXTURE_CUTOFF_MS + 60_000).toISOString();
export const BEFORE_CUTOFF = new Date(FIXTURE_CUTOFF_MS - 60_000).toISOString();

/** The whitelisted condition, and one that is deliberately not. */
export const WHITELISTED_CONDITION = "0xwhitelisted";
export const OTHER_CONDITION = "0xnotwhitelisted";

export interface SqliteRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

export interface CensusFixture {
  readonly dir: string;
  readonly ledgerPath: string;
  readonly controlPath: string;
  /** Run SQL against the ledger, throwing on error — for seeding, where a failure is a broken fixture. */
  seed(sql: string): void;
  /** Run SQL against `control.db`, throwing on error. */
  seedControl(sql: string): void;
  /** A read-only query against the ledger, `|`-separated, trimmed. */
  query(sql: string): string;
  /** A read-only query against `control.db` — the fence tests read the policy text back. */
  queryControl(sql: string): string;
  /**
   * Run a script the way §5.4's runbook does — `-bail`, read-write — WITHOUT throwing.
   *
   * `bail: false` exists for ONE test: §7 test 12(d)'s negative control, which has to demonstrate what the
   * runbook flag actually buys. Nothing else may drop it.
   */
  runApply(sql: string, options?: { readonly bail?: boolean }): SqliteRunResult;
  /** Run a script read-only, as §5.5's post-verify is run. */
  runReadOnly(sql: string): SqliteRunResult;
  /** Every `position_id → exit_owner`, for the whole-run "nothing was written" assertions. */
  ownerMap(): Record<string, string | null>;
  /**
   * §5.1's exporter, end to end: emit → digest → real loader.
   *
   * `mutateSql` edits the exporter's TEXT, which is the only way to obtain a manifest today's §5.1 cannot
   * emit — the negative controls of §9a.6 test 8 need exactly that, and deriving it from the live SQL is
   * what stops a hand-written counter-example from going stale.
   */
  exportManifest(options?: {
    readonly nowMs?: number;
    readonly maxAgeHours?: number;
    readonly mutateSql?: (sql: string) => string;
  }): {
    readonly loaded: LoadedCensusManifest;
    readonly path: string;
    readonly json: string;
  };
}

export interface PolicySeed {
  readonly enabled?: boolean;
  readonly mode?: string;
  readonly whitelistConditionIds?: readonly string[];
  readonly applyToAllMarkets?: boolean;
  readonly sellableFlowEnabled?: boolean;
  readonly appliesFromMs?: number | null;
}

/**
 * The four ladder fields, at the values production actually carries (read read-only from
 * `control.db` on the live host, 2026-07-29). They are not decoration: `parseExecutionPolicyJson` is
 * FAIL-CLOSED on them — with any of the four missing it forces `enabled:false, mode:off`, so a fixture
 * that omitted them would decide `profile` for EVERY target while the SQL projection (which reads only
 * `enabled`/`mode`/whitelist) said `bounce`, and the suite would be testing a policy production never has.
 */
const LADDER_FIELDS = {
  targetGainPct: 0.257,
  timeoutMs: 14_400_000,
  targetTiers: [
    { maxPrice: 0.02, gainPct: 0.36 },
    { maxPrice: 0.03, gainPct: 0.27 },
    { maxPrice: 0.05, gainPct: 0.19 },
    { maxPrice: 0.08, gainPct: 0.15 },
    { maxPrice: 0.15, gainPct: 0.15 },
    { maxPrice: 0.35, gainPct: 0.12 },
    { maxPrice: 1, gainPct: 0.08 },
  ],
  ladderFractions: [0.3, 0.4, 0.3],
  ladderStepPct: 0.22,
  backstopTtcHours: 24,
  microMaxOrderUsdc: 2,
} as const;

/** The policy every fixture starts from: bounce on, `micro_live`, one whitelisted condition, flow on. */
export function policyJson(seed: PolicySeed = {}): string {
  return JSON.stringify({
    bounceExit: {
      ...LADDER_FIELDS,
      enabled: seed.enabled ?? true,
      mode: seed.mode ?? "micro_live",
      whitelistConditionIds: seed.whitelistConditionIds ?? [WHITELISTED_CONDITION],
      // Deliberately TRUE in the default fixture (§2.5): the census must ignore it, and a fixture that
      // left it false could not tell a compliant implementation from one that reads it.
      applyToAllMarkets: seed.applyToAllMarkets ?? true,
    },
    sellableFlow: {
      enabled: seed.sellableFlowEnabled ?? true,
      buffer: 1.2,
      maxEntryUsdc: 5,
      appliesFromMs: seed.appliesFromMs === undefined ? FIXTURE_CUTOFF_MS : seed.appliesFromMs,
    },
  });
}

export function createCensusFixture(
  options: { readonly policy?: string | null } = {},
): CensusFixture {
  const bin = productionSqlite3();
  const dir = mkdtempSync(join(tmpdir(), "krabs-census-"));
  const ledgerPath = join(dir, "ledger.db");
  const controlPath = join(dir, "control.db");

  const run = (db: string, sql: string, args: readonly string[]): SqliteRunResult => {
    const result = spawnSqlite(bin, [...args, db], sql);
    return result;
  };
  const must = (db: string, sql: string, args: readonly string[] = ["-bail"]): string => {
    const r = run(db, sql, args);
    if (!r.ok) throw new Error(`sqlite3 failed on ${db}: ${r.stderr || r.stdout}`);
    return r.stdout;
  };

  must(ledgerPath, LEDGER_SQL);
  // `ledger.sql` deliberately omits it — bootstrapLedgerDb creates it after a repair step
  // (bootstrap.ts:548). Production HAS it, and it is what forces an I4 fixture to be open+dust rather
  // than open+open; a fixture without it would let a seed pass here that the real ledger rejects.
  must(
    ledgerPath,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_unique_open_per_token
       ON positions(token_id) WHERE status = 'open';`,
  );
  must(controlPath, CONTROL_SQL);

  const policy = options.policy === undefined ? policyJson() : options.policy;
  must(
    controlPath,
    `INSERT INTO profiles (profile_id, display_name, created_at)
       VALUES ('live-lite', 'live-lite', '${BEFORE_CUTOFF}');` +
      (policy === null
        ? ""
        : `\nINSERT INTO profile_settings (profile_id, execution_policy_json, updated_at)
       VALUES ('live-lite', ${sqlLiteral(policy)}, '${BEFORE_CUTOFF}');`),
  );

  let exportCounter = 0;

  return {
    dir,
    ledgerPath,
    controlPath,
    seed: (sql) => void must(ledgerPath, sql),
    seedControl: (sql) => void must(controlPath, sql),
    query: (sql) => must(ledgerPath, sql, ["-readonly", "-noheader", "-bail"]).trim(),
    queryControl: (sql) => must(controlPath, sql, ["-readonly", "-noheader", "-bail"]).trim(),
    runApply: (sql, options = {}) => run(ledgerPath, sql, options.bail === false ? [] : ["-bail"]),
    runReadOnly: (sql) => run(ledgerPath, sql, ["-readonly", "-bail"]),
    ownerMap: () => {
      const rows = must(
        ledgerPath,
        "SELECT position_id, COALESCE(exit_owner, '<null>') FROM positions ORDER BY position_id;",
        ["-readonly", "-noheader", "-bail"],
      );
      return Object.fromEntries(
        rows
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => {
            const [id, owner] = line.split("|");
            return [id ?? "", owner === "<null>" ? null : (owner ?? null)];
          }),
      );
    },
    exportManifest: (opts = {}) => {
      const path = join(dir, `manifest-${(exportCounter += 1)}.json`);
      const exportSql = buildCensusExportSql(controlPath);
      const json = must(ledgerPath, opts.mutateSql?.(exportSql) ?? exportSql, [
        "-readonly",
        "-noheader",
        "-bail",
      ]);
      writeFileSync(path, json);
      writeSidecar(path);
      const loaded = loadManifest(path, {
        maxAgeHours: opts.maxAgeHours ?? 24,
        nowMs: opts.nowMs ?? Date.now(),
      });
      return { loaded, path, json };
    },
  };
}

/** `sha256sum FILE`'s exact output shape, which `loadManifest` parses. */
export function writeSidecar(path: string): void {
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(`${path}.sha256`, `${digest}  ${path}\n`);
}

/**
 * Edit an EXPORTED manifest in place and re-sign its sidecar, so the only thing under test is the edit.
 *
 * Re-signing is the point: without it every corruption fixture would be rejected as a digest mismatch
 * before the loader ever looked at the content, and the schema/version/real-string classes would all pass
 * for the wrong reason. The one test that wants a mismatch corrupts the bytes WITHOUT calling this.
 */
export function rewriteManifest(
  path: string,
  mutate: (document: Record<string, unknown>) => void,
): void {
  const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(document);
  writeFileSync(path, JSON.stringify(document, null, 2));
  writeSidecar(path);
}

/** The loader's refusal, as a value — so each case asserts its own KIND rather than just "it threw". */
export function rejected(load: () => unknown): ManifestRejection {
  try {
    load();
  } catch (error) {
    if (error instanceof ManifestRejection) return error;
    throw error;
  }
  throw new Error("the loader accepted a manifest it had to reject");
}

/**
 * Never throws on a non-zero exit: half of §7 asserts that a script ABORTS, so a throwing runner would
 * make the interesting cases indistinguishable from a broken harness.
 */
function spawnSqlite(bin: string, args: readonly string[], input: string): SqliteRunResult {
  try {
    const stdout = execFileSync(bin, [...args], { input, encoding: "utf8", stdio: "pipe" });
    return { ok: true, stdout, stderr: "", status: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(error),
      status: e.status ?? 1,
    };
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// ───────────────────────────── seed builders ─────────────────────────────

export interface MarketSeed {
  readonly tokenId: string;
  readonly conditionId: string;
}

export interface PositionSeed {
  readonly positionId: string;
  readonly tokenId: string;
  /** `''` is the legacy shape §2.3 describes; the column is `TEXT NOT NULL DEFAULT ''`. */
  readonly conditionId?: string;
  readonly status?: string;
  readonly size?: number;
  readonly entryLane?: string | null;
  readonly openedAt?: string;
  readonly exitOwner?: string | null;
}

/** `leg_states` is keyed by `token_id` alone and carries NO condition — the census reads only its
 * `first_trade_at`, which is what §2.1's sellable-flow branch gates on. */
export interface LegStateSeed {
  readonly tokenId: string;
  readonly firstTradeAt: string;
}

export interface OrderSeed {
  readonly orderId: string;
  readonly tokenId: string;
  readonly conditionId?: string;
  readonly positionId?: string | null;
  readonly side?: string;
  readonly status?: string;
  readonly size?: number;
  readonly decisionRuleId?: string | null;
}

export interface FillSeed {
  readonly fillId: string;
  readonly orderId: string;
  readonly tokenId: string;
  readonly size: number;
}

/** One SQL text for a whole fixture, so a test reads as a table of rows rather than as string plumbing. */
export function seedSql(seed: {
  readonly markets?: readonly MarketSeed[];
  readonly positions?: readonly PositionSeed[];
  readonly legStates?: readonly LegStateSeed[];
  readonly orders?: readonly OrderSeed[];
  readonly fills?: readonly FillSeed[];
}): string {
  const statements: string[] = [];
  for (const m of seed.markets ?? []) {
    statements.push(
      `INSERT INTO markets (token_id, condition_id, slug, question, outcome, tick_size, updated_at)` +
        ` VALUES (${sqlLiteral(m.tokenId)}, ${sqlLiteral(m.conditionId)}, ` +
        `${sqlLiteral(`slug-${m.tokenId}`)}, 'q', 'Yes', 0.01, '${AFTER_CUTOFF}');`,
    );
  }
  for (const p of seed.positions ?? []) {
    statements.push(
      `INSERT INTO positions (position_id, token_id, condition_id, side, status, size, avg_entry_price,` +
        ` entry_lane, opened_at, updated_at, exit_owner) VALUES (${sqlLiteral(p.positionId)}, ` +
        `${sqlLiteral(p.tokenId)}, ${sqlLiteral(p.conditionId ?? "")}, 'buy', ` +
        `${sqlLiteral(p.status ?? "open")}, ${p.size ?? 10}, 0.2, ` +
        `${p.entryLane == null ? "NULL" : sqlLiteral(p.entryLane)}, ` +
        `'${p.openedAt ?? AFTER_CUTOFF}', '${AFTER_CUTOFF}', ` +
        `${p.exitOwner == null ? "NULL" : sqlLiteral(p.exitOwner)});`,
    );
  }
  for (const l of seed.legStates ?? []) {
    statements.push(
      `INSERT INTO leg_states (token_id, last_action, first_trade_price, first_trade_at, last_trade_at,` +
        ` updated_at) VALUES (${sqlLiteral(l.tokenId)}, 'buy', 0.2, ${sqlLiteral(l.firstTradeAt)}, ` +
        `'${AFTER_CUTOFF}', '${AFTER_CUTOFF}');`,
    );
  }
  for (const o of seed.orders ?? []) {
    statements.push(
      `INSERT INTO orders (order_id, client_order_id, token_id, condition_id, position_id, side,` +
        ` order_type, price, size, size_usdc, status, decision_rule_id, bot_run_id, created_at,` +
        ` updated_at) VALUES (${sqlLiteral(o.orderId)}, ${sqlLiteral(`c-${o.orderId}`)}, ` +
        `${sqlLiteral(o.tokenId)}, ${sqlLiteral(o.conditionId ?? WHITELISTED_CONDITION)}, ` +
        `${o.positionId == null ? "NULL" : sqlLiteral(o.positionId)}, ${sqlLiteral(o.side ?? "sell")}, ` +
        `'GTC', 0.25, ${o.size ?? 1}, 0.25, ${sqlLiteral(o.status ?? "open")}, ` +
        `${o.decisionRuleId == null ? "NULL" : sqlLiteral(o.decisionRuleId)}, 'run-fixture', ` +
        `'${AFTER_CUTOFF}', '${AFTER_CUTOFF}');`,
    );
  }
  for (const f of seed.fills ?? []) {
    statements.push(
      `INSERT INTO fills (fill_id, order_id, token_id, side, price, size, size_usdc, fee, filled_at)` +
        ` VALUES (${sqlLiteral(f.fillId)}, ${sqlLiteral(f.orderId)}, ${sqlLiteral(f.tokenId)}, 'sell',` +
        ` 0.25, ${f.size}, ${f.size * 0.25}, 0, '${AFTER_CUTOFF}');`,
    );
  }
  return statements.join("\n");
}

/**
 * The smallest ledger that still satisfies all twelve guards — one target, its market and its leg state.
 * `withMarket: false` drops the `markets` row, which is guard #3b's class and nothing else's.
 *
 * `firstTradeAt: null` drops the `leg_states` row entirely, which is §5.4.2's **absent row** — a distinct
 * fixture from a row that EXISTS carrying malformed text (`firstTradeAt: "2026-06-04 20:12:04"`), and the
 * pair is what guard #7's `INNER JOIN` has to tell apart. The column is `TEXT NOT NULL`, so "the row
 * exists with a NULL value" is not a third option — it is not insertable at all.
 */
export function soloTargetSeed(
  position: PositionSeed,
  options: { readonly withMarket?: boolean; readonly firstTradeAt?: string | null } = {},
): string {
  const firstTradeAt = options.firstTradeAt === undefined ? AFTER_CUTOFF : options.firstTradeAt;
  return seedSql({
    markets:
      options.withMarket === false
        ? []
        : [{ tokenId: position.tokenId, conditionId: WHITELISTED_CONDITION }],
    positions: [{ conditionId: WHITELISTED_CONDITION, ...position }],
    legStates: firstTradeAt === null ? [] : [{ tokenId: position.tokenId, firstTradeAt }],
  });
}

/**
 * The default clean fixture: three targets spanning both owners and both `positions.condition_id` shapes.
 * `pos-gate` carries the legacy `''` condition, so the absent-evidence path of §2.3 / guard #4 is on the
 * happy path rather than only in its own test.
 */
export function cleanSeed(): string {
  return seedSql({
    markets: [
      { tokenId: "tok-bounce", conditionId: WHITELISTED_CONDITION },
      { tokenId: "tok-gate", conditionId: WHITELISTED_CONDITION },
      { tokenId: "tok-profile", conditionId: OTHER_CONDITION },
    ],
    positions: [
      {
        positionId: "pos-bounce",
        tokenId: "tok-bounce",
        conditionId: WHITELISTED_CONDITION,
        entryLane: "R23",
        size: 12.5,
      },
      {
        positionId: "pos-gate",
        tokenId: "tok-gate",
        status: "dust",
        size: 0.75,
        entryLane: "GATE",
        openedAt: BEFORE_CUTOFF,
      },
      {
        positionId: "pos-profile",
        tokenId: "tok-profile",
        conditionId: OTHER_CONDITION,
        entryLane: "R23",
        size: 3,
      },
    ],
    legStates: [
      { tokenId: "tok-bounce", firstTradeAt: AFTER_CUTOFF },
      { tokenId: "tok-gate", firstTradeAt: BEFORE_CUTOFF },
      { tokenId: "tok-profile", firstTradeAt: AFTER_CUTOFF },
    ],
    orders: [
      // A BUY, so the fixture carries order evidence for `pos-gate`'s absent `positions.condition_id`
      // without creating an active SELL (which every one of I1–I3/I5 would then read).
      { orderId: "o-gate", tokenId: "tok-gate", side: "buy", status: "filled" },
    ],
  });
}
