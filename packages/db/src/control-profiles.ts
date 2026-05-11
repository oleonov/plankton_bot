import type Database from "better-sqlite3";
import {
  DEFAULT_BUY_CAPACITY_POLICY,
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_ORDER_CAPACITY_POLICY,
  DEFAULT_SELL_CAPACITY_POLICY,
  ProfileId,
  serializeExecutionPolicy,
  type DeadSideGuardMode,
} from "@krabs/domain";

export interface ControlProfileSeed {
  readonly profileId: string;
  readonly displayName: string;
  readonly description: string;
  /**
   * ADR-015: default dead-side guard posture seeded into
   * `profile_settings.execution_policy_json` on bootstrap. Live-lite ships
   * in `enforce` so real-money placements respect the guard immediately;
   * paper/sim ship in `observe` so canary metrics run without blocking
   * dev/CI flow.
   */
  readonly defaultDeadSideGuardMode: DeadSideGuardMode;
  /**
   * Step 0 §P3: seed `ExecutionPolicy.entryMinMarketAgeSeconds`. Simulation
   * gets 0 (full bypass — sim fixtures are freshly created and the spec floor
   * doesn't apply). Paper / live-lite get the canonical 2,504 s spec floor.
   */
  readonly defaultEntryMinMarketAgeSeconds: number;
}

export const CONTROL_PROFILES: readonly ControlProfileSeed[] = [
  {
    profileId: ProfileId.Simulation,
    displayName: "Simulation",
    description: "In-memory simulated execution",
    defaultDeadSideGuardMode: "observe",
    defaultEntryMinMarketAgeSeconds: 0,
  },
  {
    profileId: ProfileId.Paper,
    displayName: "Paper",
    description: "Live market data, simulated orders",
    defaultDeadSideGuardMode: "observe",
    defaultEntryMinMarketAgeSeconds: DEFAULT_EXECUTION_POLICY.entryMinMarketAgeSeconds,
  },
  {
    profileId: ProfileId.LiveLite,
    displayName: "Live-Lite",
    description: "Real orders with envelope caps",
    defaultDeadSideGuardMode: "enforce",
    defaultEntryMinMarketAgeSeconds: DEFAULT_EXECUTION_POLICY.entryMinMarketAgeSeconds,
  },
];

const DEFAULT_BUY_CAPACITY_POLICY_JSON = JSON.stringify(DEFAULT_BUY_CAPACITY_POLICY);
const DEFAULT_SELL_CAPACITY_POLICY_JSON = JSON.stringify(DEFAULT_SELL_CAPACITY_POLICY);
const DEFAULT_ORDER_CAPACITY_POLICY_JSON = JSON.stringify(DEFAULT_ORDER_CAPACITY_POLICY);
// R55 rollout default for seeded DB profile rows. The domain fallback remains
// conservative; production behavior is controlled by execution_policy_json.
const ACTIVE_MULTI_BUY_LADDER_POLICY = {
  ...DEFAULT_EXECUTION_POLICY.multiBuyLadder,
  enabled: true,
  maxLadderFillsPerToken: 15,
};

function defaultExecutionPolicyJson(profile: ControlProfileSeed): string {
  return serializeExecutionPolicy({
    ...DEFAULT_EXECUTION_POLICY,
    deadSideGuard: {
      ...DEFAULT_EXECUTION_POLICY.deadSideGuard,
      mode: profile.defaultDeadSideGuardMode,
    },
    entryMinMarketAgeSeconds: profile.defaultEntryMinMarketAgeSeconds,
    multiBuyLadder: ACTIVE_MULTI_BUY_LADDER_POLICY,
  });
}

export function ensureControlProfiles(db: Database.Database, now = new Date().toISOString()): void {
  const insertProfile = db.prepare(
    "INSERT OR IGNORE INTO profiles (profile_id, display_name, description, created_at) VALUES (?, ?, ?, ?)",
  );
  for (const profile of CONTROL_PROFILES) {
    insertProfile.run(profile.profileId, profile.displayName, profile.description, now);
  }
}

/**
 * Ensures every seeded profile has a `profile_settings` row with a non-null
 * `execution_policy_json`. Fresh installs skip migration 038 via the baseline
 * (columns already exist), so this helper replaces the migration's UPDATE
 * path and also backfills legacy DBs where the row pre-dates ADR-015.
 *
 * Runs only when `execution_policy_json` column exists — bootstrap adds it
 * via `safeAddColumn` before calling us, so in practice it always does.
 */
export function ensureDefaultExecutionPolicy(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(profile_settings)`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((c) => c.name === "execution_policy_json")) return;

  const insertSettings = db.prepare(
    `INSERT OR IGNORE INTO profile_settings
       (profile_id, execution_policy_json, fallback_min_order_usdc_relayer,
        fallback_min_order_usdc_eoa, updated_at)
       VALUES (?, ?, 1, 3, datetime('now'))`,
  );
  const fillMissing = db.prepare(
    `UPDATE profile_settings
        SET execution_policy_json = ?, updated_at = datetime('now')
      WHERE profile_id = ? AND execution_policy_json IS NULL`,
  );
  for (const profile of CONTROL_PROFILES) {
    const json = defaultExecutionPolicyJson(profile);
    insertSettings.run(profile.profileId, json);
    fillMissing.run(json, profile.profileId);
  }
  backfillEntryMinMarketAgeSeconds(db);
  backfillMarketSelectionPolicy(db);
  backfillBuyCapacityPolicy(db);
  backfillSellCapacityPolicy(db);
  backfillOrderCapacityPolicy(db);
  backfillTakerGuardPolicy(db);
}

/**
 * Step 0 §P3 — idempotent JSON backfill.
 *
 * For every existing `profile_settings` row whose `execution_policy_json`
 * lacks `entryMinMarketAgeSeconds`, insert the per-profile default via
 * SQLite's `json_set`. Runs after `ensureDefaultExecutionPolicy` so newly
 * inserted rows already carry the field.
 *
 * Idempotency guard: `json_extract(... '$.entryMinMarketAgeSeconds') IS NULL`
 * — second run is a no-op (does not overwrite operator-edited values).
 *
 * Bumps `runtime_control_state.execution_policy_version` once when at least
 * one row was actually patched, so the running ExecutionPolicyProvider
 * picks up the new value via the existing hot-reload channel.
 */
function backfillEntryMinMarketAgeSeconds(db: Database.Database): void {
  const stateColumns = db.prepare(`PRAGMA table_info(runtime_control_state)`).all() as Array<{
    name: string;
  }>;
  const hasVersionColumn = stateColumns.some((c) => c.name === "execution_policy_version");

  // Guard `json_extract`/`json_set` from throwing on malformed JSON: SQLite
  // raises "malformed JSON" on the entire UPDATE if any matching row holds
  // a non-parseable string, which would crash bootstrap. The provider/parser
  // tolerates bad JSON at runtime (falls back to defaults + surfaces issues),
  // so the migration must mirror that posture and skip such rows. Operators
  // see the bad row via the existing parser warning path on next read.
  const update = db.prepare(
    `UPDATE profile_settings
        SET execution_policy_json = json_set(
              execution_policy_json,
              '$.entryMinMarketAgeSeconds',
              ?
            ),
            updated_at = datetime('now')
      WHERE profile_id = ?
        AND execution_policy_json IS NOT NULL
        AND json_valid(execution_policy_json) = 1
        AND json_extract(execution_policy_json, '$.entryMinMarketAgeSeconds') IS NULL`,
  );
  let totalChanges = 0;
  for (const profile of CONTROL_PROFILES) {
    const result = update.run(profile.defaultEntryMinMarketAgeSeconds, profile.profileId);
    totalChanges += result.changes;
  }

  if (totalChanges > 0 && hasVersionColumn) {
    db.prepare(
      `UPDATE runtime_control_state
          SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1`,
    ).run();
  }
}

function backfillMarketSelectionPolicy(db: Database.Database): void {
  const stateColumns = db.prepare(`PRAGMA table_info(runtime_control_state)`).all() as Array<{
    name: string;
  }>;
  const hasVersionColumn = stateColumns.some((c) => c.name === "execution_policy_version");
  const defaultMarketSelectionJson = JSON.stringify(DEFAULT_EXECUTION_POLICY.marketSelection);
  const result = db
    .prepare(
      `UPDATE profile_settings
          SET execution_policy_json = json_set(
                execution_policy_json,
                '$.marketSelection',
                json(?)
              ),
              updated_at = datetime('now')
        WHERE execution_policy_json IS NOT NULL
          AND json_valid(execution_policy_json) = 1
          AND json_extract(execution_policy_json, '$.marketSelection') IS NULL`,
    )
    .run(defaultMarketSelectionJson);

  if (result.changes > 0 && hasVersionColumn) {
    db.prepare(
      `UPDATE runtime_control_state
          SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1`,
    ).run();
  }
}

function backfillBuyCapacityPolicy(db: Database.Database): void {
  // Migration 044 patches already-running control DBs during deploy. This
  // bootstrap backfill covers fresh installs and legacy/test DBs that reach
  // profile seeding with a valid policy JSON but without the new key.
  const stateColumns = db.prepare(`PRAGMA table_info(runtime_control_state)`).all() as Array<{
    name: string;
  }>;
  const hasVersionColumn = stateColumns.some((c) => c.name === "execution_policy_version");
  const result = db
    .prepare(
      `UPDATE profile_settings
          SET execution_policy_json = json_set(
                execution_policy_json,
                '$.buyCapacity',
                json(?)
              ),
              updated_at = datetime('now')
        WHERE execution_policy_json IS NOT NULL
          AND json_valid(execution_policy_json) = 1
          AND json_extract(execution_policy_json, '$.buyCapacity') IS NULL`,
    )
    .run(DEFAULT_BUY_CAPACITY_POLICY_JSON);

  if (result.changes > 0 && hasVersionColumn) {
    db.prepare(
      `UPDATE runtime_control_state
          SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1`,
    ).run();
  }
}

function backfillSellCapacityPolicy(db: Database.Database): void {
  const stateColumns = db.prepare(`PRAGMA table_info(runtime_control_state)`).all() as Array<{
    name: string;
  }>;
  const hasVersionColumn = stateColumns.some((c) => c.name === "execution_policy_version");
  const result = db
    .prepare(
      `UPDATE profile_settings
          SET execution_policy_json = json_set(
                execution_policy_json,
                '$.sellCapacity',
                json(?)
              ),
              updated_at = datetime('now')
        WHERE execution_policy_json IS NOT NULL
          AND json_valid(execution_policy_json) = 1
          AND json_extract(execution_policy_json, '$.sellCapacity') IS NULL`,
    )
    .run(DEFAULT_SELL_CAPACITY_POLICY_JSON);

  if (result.changes > 0 && hasVersionColumn) {
    db.prepare(
      `UPDATE runtime_control_state
          SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1`,
    ).run();
  }
}

function backfillOrderCapacityPolicy(db: Database.Database): void {
  const stateColumns = db.prepare(`PRAGMA table_info(runtime_control_state)`).all() as Array<{
    name: string;
  }>;
  const hasVersionColumn = stateColumns.some((c) => c.name === "execution_policy_version");
  const result = db
    .prepare(
      `UPDATE profile_settings
          SET execution_policy_json = json_set(
                execution_policy_json,
                '$.orderCapacity',
                json(?)
              ),
              updated_at = datetime('now')
        WHERE execution_policy_json IS NOT NULL
          AND json_valid(execution_policy_json) = 1
          AND json_extract(execution_policy_json, '$.orderCapacity') IS NULL`,
    )
    .run(DEFAULT_ORDER_CAPACITY_POLICY_JSON);

  if (result.changes > 0 && hasVersionColumn) {
    db.prepare(
      `UPDATE runtime_control_state
          SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1`,
    ).run();
  }
}

function backfillTakerGuardPolicy(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(profile_settings)`).all() as Array<{
    name: string;
  }>;
  const hasFallbackRelayer = columns.some((c) => c.name === "fallback_min_order_usdc_relayer");
  const hasFallbackEoa = columns.some((c) => c.name === "fallback_min_order_usdc_eoa");
  if (hasFallbackRelayer) {
    db.prepare(
      `UPDATE profile_settings
          SET fallback_min_order_usdc_relayer = COALESCE(fallback_min_order_usdc_relayer, 1)`,
    ).run();
  }
  if (hasFallbackEoa) {
    db.prepare(
      `UPDATE profile_settings
          SET fallback_min_order_usdc_eoa = COALESCE(fallback_min_order_usdc_eoa, 3)`,
    ).run();
  }
  db.prepare(
    `UPDATE profile_settings
        SET execution_policy_json = json_set(
              execution_policy_json,
              '$.opportunisticTaker.safetyBuffer',
              COALESCE(json_extract(execution_policy_json, '$.opportunisticTaker.safetyBuffer'), 1.05),
              '$.opportunisticTaker.fallbackMinNotionalUsdc',
              COALESCE(json_extract(execution_policy_json, '$.opportunisticTaker.fallbackMinNotionalUsdc'), 1),
              '$.opportunisticTaker.marketableBuyMinNotionalUsdc',
              COALESCE(json_extract(execution_policy_json, '$.opportunisticTaker.marketableBuyMinNotionalUsdc'), 1)
            )
      WHERE execution_policy_json IS NOT NULL
        AND json_valid(execution_policy_json) = 1
        AND (
             json_type(execution_policy_json, '$.opportunisticTaker.safetyBuffer') IS NULL
          OR json_type(execution_policy_json, '$.opportunisticTaker.fallbackMinNotionalUsdc') IS NULL
          OR json_type(execution_policy_json, '$.opportunisticTaker.marketableBuyMinNotionalUsdc') IS NULL
        )`,
  ).run();
}
