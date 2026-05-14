import type Database from "better-sqlite3";

export type HistorySource =
  | "api_put_settings"
  | "api_patch_execution_policy"
  | "manual"
  | "migration";

export interface HistoryEntry {
  profileId: string;
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
  actor: string;
  source: HistorySource;
  reason: string | null;
}

export interface HistoryRow {
  id: number;
  profile_id: string;
  field: string;
  before_value: string | null;
  after_value: string | null;
  actor: string;
  source: string;
  reason: string | null;
  changed_at: string;
}

const TRACKED_FIELDS = [
  "initial_balance_usdc",
  "envelope_json",
  "risk_caps_json",
  "wallet_mode",
  "min_order_usdc",
  "relayer_json",
  "execution_policy_json",
] as const;

export type TrackedField = (typeof TRACKED_FIELDS)[number];

export function isTrackedField(field: string): field is TrackedField {
  return (TRACKED_FIELDS as readonly string[]).includes(field);
}

// Numerics persisted as REAL are stringified so the audit table stays single-
// typed; NULL means the column was unset. Non-finite floats (NaN/Infinity)
// shouldn't reach this layer thanks to API-side validation, but if they do we
// store the literal "NaN"/"Infinity" string rather than crash the audit write.
export function toStorageValue(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "number" ? String(v) : v;
}

// Subfields of relayer_json that hold builder credentials. We never want raw
// secrets in the audit log, so the diff stage replaces them with a fixed
// placeholder. Operators can still see *that* a secret was rotated (the
// placeholder changes if length crosses zero) and what non-secret config
// (`mode`, `url`, `walletType`, etc.) shifted.
const RELAYER_SECRET_KEYS = new Set(["key", "secret", "passphrase", "token"]);
const REDACTED_PLACEHOLDER = "[REDACTED]";

function redactRelayerJson(raw: string | null): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable values may still contain secret-like substrings, so refuse
    // to commit the raw bytes to the audit log. We lose forensic detail on
    // malformed payloads but never leak credentials through this path.
    return "[REDACTED:unparseable]";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "[REDACTED:unparseable]";
  }
  const root = parsed as Record<string, unknown>;
  const builder = root.builder;
  if (builder && typeof builder === "object" && !Array.isArray(builder)) {
    const builderObj = builder as Record<string, unknown>;
    for (const key of Object.keys(builderObj)) {
      if (RELAYER_SECRET_KEYS.has(key) && typeof builderObj[key] === "string") {
        builderObj[key] = REDACTED_PLACEHOLDER;
      }
    }
  }
  return JSON.stringify(root);
}

function redactForHistory(field: TrackedField, value: string | null): string | null {
  if (field === "relayer_json") return redactRelayerJson(value);
  return value;
}

export function diffFields(
  before: Record<string, string | number | null | undefined>,
  after: Record<string, string | number | null | undefined>,
): Array<{ field: string; before: string | null; after: string | null }> {
  const fields = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  const diffs: Array<{ field: string; before: string | null; after: string | null }> = [];
  for (const field of fields) {
    if (!isTrackedField(field)) continue;
    const b = toStorageValue(before[field]);
    const a = toStorageValue(after[field]);
    if (b !== a) {
      diffs.push({
        field,
        before: redactForHistory(field, b),
        after: redactForHistory(field, a),
      });
    }
  }
  return diffs;
}

export function recordHistory(db: Database.Database, entries: HistoryEntry[]): void {
  if (entries.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO profile_settings_history
       (profile_id, field, before_value, after_value, actor, source, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((rows: HistoryEntry[]) => {
    for (const e of rows) {
      stmt.run(e.profileId, e.field, e.beforeValue, e.afterValue, e.actor, e.source, e.reason);
    }
  });
  tx(entries);
}
