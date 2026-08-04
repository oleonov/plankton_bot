import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CensusDecision, CensusOwner } from "./decide.js";

/**
 * §9 — the decision artifact: the persisted expected-owner map that check (c) compares against.
 *
 * It exists because the expected side of that check lives nowhere else. The fresh manifest cannot carry it
 * (on a successful census its target array is empty by construction — that is check (b)), and the frozen
 * manifest cannot either (its targets' `exit_owner` are all NULL, which is what made them targets). The map
 * exists only in the memory of the `--apply` process, so it is written to disk before the ledger is touched
 * or (c) is not a check at all.
 *
 * This module owns clause 1 and every intra-file shape check (`cen-decision-schema`). The relational
 * clauses 2–5 need two files at once and belong to `verify-owner-map.ts` — a loader sees exactly one file
 * and can therefore never check completeness, which is precisely how v11's clause 2 came to compare the
 * artifact against itself.
 */

export const SUPPORTED_DECISION_VERSION = 1;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export interface CensusDecisionOwner {
  readonly positionId: string;
  readonly expectedOwner: CensusOwner;
}

export interface CensusDecisionArtifact {
  readonly decisionVersion: number;
  /** SHA-256 of the FROZEN manifest bytes this decision was computed from. */
  readonly manifestDigest: string;
  readonly targetCount: number;
  readonly owners: readonly CensusDecisionOwner[];
}

export interface LoadedDecisionArtifact {
  readonly path: string;
  readonly artifact: CensusDecisionArtifact;
  /** SHA-256 of the file bytes — the quantity `--apply` printed as `DECISION_SHA256`. */
  readonly bytesSha256: string;
}

/**
 * `digest` is clause 1a (the artifact is the one the runbook recorded) and `manifest_binding` is clause 1b
 * (it belongs to THIS census). Separate kinds because the remedies differ: the first means the file was
 * edited after the digest was taken, the second that it came from a different frozen manifest entirely.
 */
export type DecisionRejectionKind =
  | "io"
  | "json"
  | "version"
  | "schema"
  | "empty"
  | "digest"
  | "manifest_binding";

export class DecisionArtifactRejection extends Error {
  readonly kind: DecisionRejectionKind;

  constructor(kind: DecisionRejectionKind, message: string) {
    super(message);
    this.name = "DecisionArtifactRejection";
    this.kind = kind;
  }
}

export interface LoadDecisionArtifactOptions {
  /** Clause 1a — the `DECISION_SHA256` line the runbook recorded, passed back verbatim. */
  readonly expectedBytesSha256: string;
  /** Clause 1b — SHA-256 of the `--frozen` manifest's bytes, as computed by `loadManifest`. */
  readonly expectedManifestDigest: string;
}

/**
 * §9 — `dirname(--manifest)/census-decision-<manifestDigest>.json`, i.e. NEXT TO the frozen manifest it was
 * computed from, never the process CWD. The two artifacts then travel together and a decision cannot be
 * silently paired with a different manifest.
 */
export function decisionArtifactPath(manifestPath: string, manifestDigest: string): string {
  return join(dirname(manifestPath), `census-decision-${manifestDigest}.json`);
}

/**
 * The expected-owner map, from the SAME decision array that populates `manifest_targets.expected_owner`
 * (§5.4). One source, never recomputed — a second derivation would be a second definition of ownership.
 */
export function buildDecisionArtifact(
  manifestDigest: string,
  decisions: readonly CensusDecision[],
): CensusDecisionArtifact {
  const owners = decisions
    .map((d) => ({ positionId: d.positionId, expectedOwner: d.owner }))
    .sort((a, b) => (a.positionId < b.positionId ? -1 : a.positionId > b.positionId ? 1 : 0));
  return {
    decisionVersion: SUPPORTED_DECISION_VERSION,
    manifestDigest,
    targetCount: owners.length,
    owners,
  };
}

export function serializeDecisionArtifact(artifact: CensusDecisionArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

export function loadDecisionArtifact(
  path: string,
  options: LoadDecisionArtifactOptions,
): LoadedDecisionArtifact {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new DecisionArtifactRejection(
      "io",
      `cannot read the census decision artifact at ${path} (${code})`,
    );
  }

  const bytesSha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytesSha256 !== options.expectedBytesSha256.toLowerCase()) {
    throw new DecisionArtifactRejection(
      "digest",
      `decision artifact digest mismatch: --decision-digest says ${options.expectedBytesSha256}, ` +
        `the bytes of ${path} hash to ${bytesSha256}`,
    );
  }

  const artifact = readArtifact(parseJson(bytes, path));
  if (artifact.manifestDigest !== options.expectedManifestDigest) {
    throw new DecisionArtifactRejection(
      "manifest_binding",
      `${path} was computed from manifest ${artifact.manifestDigest}, ` +
        `but --frozen hashes to ${options.expectedManifestDigest} — ` +
        `this decision belongs to a different census`,
    );
  }

  return { path, artifact, bytesSha256 };
}

function parseJson(bytes: Buffer, path: string): unknown {
  const text = bytes.toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new DecisionArtifactRejection(
      "json",
      `${path} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

function readArtifact(document: unknown): CensusDecisionArtifact {
  const root = requireRecord(document, "$");

  const decisionVersion = root.decisionVersion;
  if (decisionVersion !== SUPPORTED_DECISION_VERSION) {
    throw new DecisionArtifactRejection(
      "version",
      `unsupported decisionVersion ${describe(decisionVersion)}; ` +
        `this build supports ${SUPPORTED_DECISION_VERSION}`,
    );
  }

  const manifestDigest = requireString(root, "manifestDigest", "$");
  if (!SHA256_HEX_RE.test(manifestDigest)) {
    throw new DecisionArtifactRejection(
      "schema",
      `$.manifestDigest must be a 64-hex sha256, got ${JSON.stringify(manifestDigest)}`,
    );
  }

  const targetCount = root.targetCount;
  if (typeof targetCount !== "number" || !Number.isInteger(targetCount) || targetCount < 0) {
    throw new DecisionArtifactRejection(
      "schema",
      `$.targetCount must be a non-negative integer, got ${describe(targetCount)}`,
    );
  }

  const owners = readOwners(root.owners);

  // `targetCount = 0` is rejected here and NOT in the applier's sense: an empty owner map makes §9's check
  // (c) vacuously true, and absence must never read as success. `--apply` is separately forbidden from
  // producing one (`cen-apply-zero-targets`), which makes this unreachable from a well-formed run — but
  // unreachable-by-construction is not unreachable-by-inspection, and the file can arrive hand-edited.
  if (targetCount === 0) {
    throw new DecisionArtifactRejection(
      "empty",
      "$.targetCount is 0 — an empty owner map would make the post-restart owner check vacuous",
    );
  }
  if (owners.length !== targetCount) {
    throw new DecisionArtifactRejection(
      "schema",
      `$.owners has ${owners.length} entries but $.targetCount says ${targetCount}`,
    );
  }

  return { decisionVersion, manifestDigest, targetCount, owners };
}

function readOwners(value: unknown): CensusDecisionOwner[] {
  if (!Array.isArray(value)) {
    throw new DecisionArtifactRejection(
      "schema",
      `$.owners must be an array, got ${describe(value)}`,
    );
  }
  return value.map((entry, index) => {
    const at = `$.owners[${index}]`;
    const row = requireRecord(entry, at);
    const expectedOwner = requireString(row, "expectedOwner", at);
    if (expectedOwner !== "bounce" && expectedOwner !== "profile") {
      throw new DecisionArtifactRejection(
        "schema",
        `${at}.expectedOwner must be "bounce" or "profile", got ${JSON.stringify(expectedOwner)}`,
      );
    }
    return { positionId: requireString(row, "positionId", at), expectedOwner };
  });
}

function requireRecord(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DecisionArtifactRejection(
      "schema",
      `${at} must be an object, got ${describe(value)}`,
    );
  }
  return value as Record<string, unknown>;
}

function requireString(row: Record<string, unknown>, key: string, at: string): string {
  const value = row[key];
  if (typeof value !== "string" || value === "") {
    throw new DecisionArtifactRejection(
      "schema",
      `${at}.${key} must be a non-empty string, got ${describe(value)}`,
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
