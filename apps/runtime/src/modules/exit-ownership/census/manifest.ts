import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { OWNERSHIP_INVARIANT_ROW_SQL, type OwnershipInvariantId } from "@krabs/db";

import { isCanonicalTimestamp } from "./timestamp-sql.js";

/**
 * §5.1.8 / §5.2 — the ONE place a census manifest is validated.
 *
 * The manifest is the only way production ledger state reaches local code: it is produced by a server-side
 * `sqlite3` redirect, digested with `sha256sum`, and fetched over `ssh`. Every step of that is unvalidated
 * by construction, so the loader is the boundary, and it is deliberately the ONLY validator.
 *
 * Rejections are typed rather than a single generic error because the operator's remedy differs per class:
 * re-fetch (`hash`), re-export (`stale`), rebuild the exporter (`version`), fix the path (`io`).
 */

/**
 * **2** since §5.1.11 (v25). The export gained a ninth content group — the six invariant row-sets — so a
 * `manifestVersion 1` document is missing the entire local I1–I5 verdict and MUST be re-exported. Bumping
 * the version is what makes that a loud rejection instead of six silently-empty arrays reading as "clean".
 */
export const SUPPORTED_MANIFEST_VERSION = 2;

/**
 * The envelope — the fields excluded from the canonical payload digest. This is a DENY-list on purpose
 * (§5.1.8): §5.1 keeps gaining content groups, and an allow-list would silently drop each new one from the
 * determinism comparison. `manifestVersion` is deliberately NOT here — exporter drift is exactly what the
 * digest should surface.
 *
 * Exported so §7.16's determinism table reads the deny-list instead of restating it: a hard-coded
 * `"exportedAt"` there would keep passing after a second envelope field was added, which is the one
 * change that test exists to catch.
 */
export const ENVELOPE_FIELDS = ["exportedAt"] as const;

/** §5.1.10 — a canonical finite decimal: the one shape `Number(...)` reads without surprises. */
const CANONICAL_DECIMAL_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?$/;

const SHA256_HEX_RE = /\b[0-9a-f]{64}\b/i;

const MS_PER_HOUR = 3_600_000;

/**
 * `io` and `json` share one ledger record (`cen-manifest-json`) but not one diagnostic: "the file is not
 * there" and "the file is there and is not JSON" send the operator to different places.
 */
export type ManifestRejectionKind =
  | "io"
  | "json"
  | "hash"
  | "version"
  | "schema"
  | "real_string"
  | "stale";

export class ManifestRejection extends Error {
  readonly kind: ManifestRejectionKind;

  constructor(kind: ManifestRejectionKind, message: string) {
    super(message);
    this.name = "ManifestRejection";
    this.kind = kind;
  }
}

export interface CensusTarget {
  positionId: string;
  tokenId: string;
  conditionId: string;
  status: string;
  size: string;
  entryLane: string | null;
  openedAt: string;
  firstTradeAt: string | null;
}

export interface CensusNonclosedPosition {
  positionId: string;
  tokenId: string;
  status: string;
  exitOwner: string | null;
  size: string;
}

export interface CensusActiveSellOrder {
  orderId: string;
  tokenId: string;
  positionId: string | null;
  conditionId: string;
  side: string;
  status: string;
  size: string;
  decisionRuleId: string | null;
  filledSize: string;
}

export interface CensusTargetMarket {
  tokenId: string;
  marketConditionId: string | null;
  marketRowPresent: boolean;
}

export interface CensusTargetOrderCondition {
  tokenId: string;
  conditionId: string;
}

export interface CensusPolicySnapshot {
  executionPolicyJson: string | null;
  policyRowCount: number;
}

export interface CensusSqlOwnerProjection {
  positionId: string;
  owner: "bounce" | "profile";
}

export interface CensusOwnedClosedPosition {
  positionId: string;
  status: string;
  exitOwner: string;
}

/**
 * §5.1.11 content group 9 — the offending rows per invariant, as the LIVE ledger's own engine computed
 * them at export time. A row is left as an untyped record on purpose: the six shapes are heterogeneous,
 * they are only ever displayed, and any non-empty array blocks the run regardless of its contents. What
 * the loader must guarantee is that all six keys are PRESENT — an absent one must never read as "clean".
 */
export type CensusInvariantRows = Readonly<
  Record<OwnershipInvariantId, ReadonlyArray<Record<string, unknown>>>
>;

export interface CensusManifest {
  manifestVersion: number;
  exportedAt: string;
  targets: CensusTarget[];
  nonclosedPositions: CensusNonclosedPosition[];
  activeSellOrders: CensusActiveSellOrder[];
  targetMarkets: CensusTargetMarket[];
  targetOrderConditions: CensusTargetOrderCondition[];
  policy: CensusPolicySnapshot;
  sqlOwnerProjection: CensusSqlOwnerProjection[];
  ownedClosedPositions: CensusOwnedClosedPosition[];
  invariants: CensusInvariantRows;
}

export interface LoadedCensusManifest {
  path: string;
  manifest: CensusManifest;
  /** SHA-256 of the file bytes — the quantity the `sha256sum` sidecar carries. */
  bytesSha256: string;
  /** SHA-256 of the document minus the envelope — the quantity re-exports must agree on. */
  canonicalPayloadSha256: string;
}

export interface LoadManifestOptions {
  /**
   * `null` means "no freshness bound", and it exists for exactly one operand: `--frozen`, which is old by
   * construction. Making the bound a per-call parameter rather than a module constant is what lets one
   * mode apply it to `--manifest` and exempt `--frozen` in the same run (§5.2, v14 Major 3).
   */
  maxAgeHours: number | null;
  nowMs: number;
}

/** §5.1.8's canonical payload digest: the whole document minus the envelope, in the emitted key order. */
export function canonicalPayloadDigest(document: unknown): string {
  const payload = { ...requireRecord(document, "$") };
  for (const field of ENVELOPE_FIELDS) delete payload[field];
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function loadManifest(path: string, options: LoadManifestOptions): LoadedCensusManifest {
  const bytes = readFile(path, "manifest");
  const sidecarPath = `${path}.sha256`;
  const sidecar = readFile(sidecarPath, "sidecar");

  const bytesSha256 = createHash("sha256").update(bytes).digest("hex");
  verifySidecar(sidecar.toString("utf8"), sidecarPath, bytesSha256);

  const document = parseJson(bytes, path);
  const manifest = readManifest(document);
  verifyFreshness(manifest.exportedAt, options);

  return {
    path,
    manifest,
    bytesSha256,
    canonicalPayloadSha256: canonicalPayloadDigest(document),
  };
}

function readFile(path: string, role: "manifest" | "sidecar"): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    // Naming WHICH of the two files is missing is the point: a half-completed fetch is the common cause,
    // and "could not read the manifest" would send the operator to re-copy the file they already have.
    throw new ManifestRejection("io", `cannot read the census ${role} at ${path} (${code})`);
  }
}

function verifySidecar(sidecarText: string, sidecarPath: string, actualSha256: string): void {
  // `sha256sum FILE` writes "<hex>  <name>"; only the digest is ours to check — the recorded name is
  // whatever directory the operator ran it from and carries no authority.
  const expected = SHA256_HEX_RE.exec(sidecarText)?.[0]?.toLowerCase();
  if (expected === undefined) {
    throw new ManifestRejection(
      "hash",
      `the sidecar ${sidecarPath} carries no sha256 digest (content: ${truncate(sidecarText.trim(), 80)})`,
    );
  }
  if (expected !== actualSha256) {
    throw new ManifestRejection(
      "hash",
      `manifest digest mismatch: sidecar says ${expected}, the bytes hash to ${actualSha256}`,
    );
  }
}

function parseJson(bytes: Buffer, path: string): unknown {
  const text = bytes.toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    // The first bytes separate the two real causes: a truncated transfer vs. a CLI error line captured
    // into the payload by the server-side redirect.
    throw new ManifestRejection(
      "json",
      `${path} is not valid JSON: ${(error as Error).message}; first bytes: ${truncate(text, 120)}`,
    );
  }
}

function verifyFreshness(exportedAt: string, options: LoadManifestOptions): void {
  if (options.maxAgeHours === null) return;
  const ageMs = options.nowMs - Date.parse(exportedAt);
  const boundMs = options.maxAgeHours * MS_PER_HOUR;
  if (ageMs <= boundMs) return;
  throw new ManifestRejection(
    "stale",
    `manifest exportedAt ${exportedAt} is ${(ageMs / MS_PER_HOUR).toFixed(2)}h old, ` +
      `past the ${options.maxAgeHours}h bound — re-export and re-run`,
  );
}

function readManifest(document: unknown): CensusManifest {
  const root = requireRecord(document, "$");

  // Version is read before anything else in the payload: an unknown version means every shape assumption
  // below is unfounded, so a schema diagnostic would name the wrong defect.
  const manifestVersion = requireInteger(root, "manifestVersion", "$");
  if (manifestVersion !== SUPPORTED_MANIFEST_VERSION) {
    throw new ManifestRejection(
      "version",
      `unsupported manifestVersion ${manifestVersion}; this build supports ${SUPPORTED_MANIFEST_VERSION}`,
    );
  }

  const exportedAt = requireString(root, "exportedAt", "$");
  if (!isCanonicalTimestamp(exportedAt)) {
    throw new ManifestRejection(
      "schema",
      `$.exportedAt is not a canonical ISO-8601 UTC millisecond timestamp: ${JSON.stringify(exportedAt)}`,
    );
  }

  return {
    manifestVersion,
    exportedAt,
    targets: readRows(root, "targets", readTarget),
    nonclosedPositions: readRows(root, "nonclosed_positions", readNonclosedPosition),
    activeSellOrders: readRows(root, "active_sell_orders", readActiveSellOrder),
    targetMarkets: readRows(root, "target_markets", readTargetMarket),
    targetOrderConditions: readRows(root, "target_order_conditions", readTargetOrderCondition),
    policy: readPolicy(requireRecord(root.policy, "$.policy")),
    sqlOwnerProjection: readRows(root, "sql_owner_projection", readSqlOwnerProjection),
    ownedClosedPositions: readRows(root, "owned_closed_positions", readOwnedClosedPosition),
    invariants: readInvariants(root),
  };
}

function readTarget(row: Record<string, unknown>, at: string): CensusTarget {
  const positionId = requireString(row, "position_id", at);
  return {
    positionId,
    tokenId: requireString(row, "token_id", at),
    conditionId: requireString(row, "condition_id", at),
    status: requireString(row, "status", at),
    size: requireReal(row, "size", at, positionId),
    entryLane: requireNullableString(row, "entry_lane", at),
    openedAt: requireString(row, "opened_at", at),
    firstTradeAt: requireNullableString(row, "first_trade_at", at),
  };
}

function readNonclosedPosition(row: Record<string, unknown>, at: string): CensusNonclosedPosition {
  const positionId = requireString(row, "position_id", at);
  return {
    positionId,
    tokenId: requireString(row, "token_id", at),
    status: requireString(row, "status", at),
    exitOwner: requireNullableString(row, "exit_owner", at),
    size: requireReal(row, "size", at, positionId),
  };
}

function readActiveSellOrder(row: Record<string, unknown>, at: string): CensusActiveSellOrder {
  const orderId = requireString(row, "order_id", at);
  return {
    orderId,
    tokenId: requireString(row, "token_id", at),
    positionId: requireNullableString(row, "position_id", at),
    conditionId: requireString(row, "condition_id", at),
    side: requireString(row, "side", at),
    status: requireString(row, "status", at),
    size: requireReal(row, "size", at, orderId),
    decisionRuleId: requireNullableString(row, "decision_rule_id", at),
    filledSize: requireReal(row, "filled_size", at, orderId),
  };
}

function readTargetMarket(row: Record<string, unknown>, at: string): CensusTargetMarket {
  return {
    tokenId: requireString(row, "token_id", at),
    // Carried as 0/1 rather than inferred from `market_condition_id === null`, because §5.3 must tell
    // "no markets row" apart from "a row whose condition_id is empty" — different gates, different rows.
    marketRowPresent: requireInteger(row, "market_row_present", at) === 1,
    marketConditionId: requireNullableString(row, "market_condition_id", at),
  };
}

function readTargetOrderCondition(
  row: Record<string, unknown>,
  at: string,
): CensusTargetOrderCondition {
  return {
    tokenId: requireString(row, "token_id", at),
    conditionId: requireString(row, "condition_id", at),
  };
}

function readSqlOwnerProjection(
  row: Record<string, unknown>,
  at: string,
): CensusSqlOwnerProjection {
  const owner = requireString(row, "owner", at);
  if (owner !== "bounce" && owner !== "profile") {
    throw new ManifestRejection(
      "schema",
      `${at}.owner must be "bounce" or "profile", got "${owner}"`,
    );
  }
  return { positionId: requireString(row, "position_id", at), owner };
}

function readOwnedClosedPosition(
  row: Record<string, unknown>,
  at: string,
): CensusOwnedClosedPosition {
  return {
    positionId: requireString(row, "position_id", at),
    status: requireString(row, "status", at),
    exitOwner: requireString(row, "exit_owner", at),
  };
}

/**
 * Iterates `OWNERSHIP_INVARIANT_ROW_SQL` rather than the document's own keys, so a manifest that dropped
 * an invariant fails to load instead of reading as "no violations" for it. `readRows` already rejects a
 * missing key (`undefined` is not an array), which is exactly the required load error. The rows
 * themselves are not validated per column: any non-empty array blocks the run whatever it contains.
 */
function readInvariants(root: Record<string, unknown>): CensusInvariantRows {
  const invariants = requireRecord(root.invariants, "$.invariants");
  const rows = {} as Record<OwnershipInvariantId, ReadonlyArray<Record<string, unknown>>>;
  for (const { id } of OWNERSHIP_INVARIANT_ROW_SQL) {
    rows[id] = readRows(invariants, id, (row) => row, "$.invariants");
  }
  return rows;
}

function readPolicy(row: Record<string, unknown>): CensusPolicySnapshot {
  return {
    // NULL is a legitimate export (no `live-lite` row at all); §5.3's execution-policy gate is what
    // blocks on it, so refusing it here would move a blocking decision into the parser.
    executionPolicyJson: requireNullableString(row, "execution_policy_json", "$.policy"),
    policyRowCount: requireInteger(row, "policy_row_count", "$.policy"),
  };
}

function readRows<T>(
  root: Record<string, unknown>,
  key: string,
  read: (row: Record<string, unknown>, at: string) => T,
  parent = "$",
): T[] {
  const value = root[key];
  const at = `${parent}.${key}`;
  if (!Array.isArray(value)) {
    throw new ManifestRejection("schema", `${at} must be an array, got ${describe(value)}`);
  }
  return value.map((row, index) => read(requireRecord(row, `${at}[${index}]`), `${at}[${index}]`));
}

function requireRecord(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManifestRejection("schema", `${at} must be an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function requireString(row: Record<string, unknown>, key: string, at: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new ManifestRejection("schema", `${at}.${key} must be a string, got ${describe(value)}`);
  }
  return value;
}

function requireNullableString(
  row: Record<string, unknown>,
  key: string,
  at: string,
): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ManifestRejection(
      "schema",
      `${at}.${key} must be a string or null, got ${describe(value)}`,
    );
  }
  return value;
}

function requireInteger(row: Record<string, unknown>, key: string, at: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ManifestRejection(
      "schema",
      `${at}.${key} must be an integer, got ${describe(value)}`,
    );
  }
  return value;
}

/**
 * §5.1.10 — a REAL arrives as a decimal STRING, which is both the drift token guard #3 compares and the
 * source of the TS-side `Number(...)`. A JSON number here is an older exporter that let SQLite's JSON
 * writer pick the rendering, which is a version skew worth refusing loudly rather than reading silently.
 *
 * Both tests are load-bearing: the regex alone admits `"1e999"` (which parses to `Infinity`), and
 * `Number.isFinite` alone admits `""` (→ 0) and `" 1.5"` (leading whitespace is skipped).
 */
function requireReal(row: Record<string, unknown>, key: string, at: string, rowId: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new ManifestRejection(
      "schema",
      `${at}.${key} must be a decimal string (§5.1.10), got ${describe(value)} for ${rowId}`,
    );
  }
  if (!CANONICAL_DECIMAL_RE.test(value) || !Number.isFinite(Number(value))) {
    throw new ManifestRejection(
      "real_string",
      `${at}.${key} is not a canonical finite decimal for ${rowId}: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `${typeof value} ${JSON.stringify(value)}`;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
