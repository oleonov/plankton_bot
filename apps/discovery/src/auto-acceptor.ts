import type { Logger } from "pino";
type Database = import("@plankton/db").DbConnection["db"];

export interface AutoAcceptorConfig {
  apiBaseUrl: string; // e.g., "http://localhost:3100"
  apiKey: string; // PLANKTON_API_KEY
  enabled: boolean; // AUTO_APPROVE_ENABLED
}

export interface AutoAcceptResult {
  accepted: number;
  promoted: number;
  skippedAtCap: number;
}

const MAX_ACCEPT_PER_PASS = 10;
const DEFAULT_MAX_FAMILIES = 100;

export async function autoAcceptAndPromote(
  db: Database,
  config: AutoAcceptorConfig,
  log: Logger,
): Promise<AutoAcceptResult> {
  if (!config.enabled) return { accepted: 0, promoted: 0, skippedAtCap: 0 };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };

  const currentProfile = resolveCurrentProfile(db);

  // Phase 0: Compute available slots for auto-accept
  let availableSlots = MAX_ACCEPT_PER_PASS;
  if (currentProfile) {
    const enabled = countEnabledFamilies(db, currentProfile);
    const max = resolveMaxFamilies(db, currentProfile);
    availableSlots = Math.min(MAX_ACCEPT_PER_PASS, Math.max(0, max - enabled));
    if (availableSlots <= 0) {
      const skippedAtCap = countQualifyingCandidates(db);
      log.info(
        { enabledCount: enabled, maxFamilies: max, skippedAtCap },
        "at family cap, skipping auto-accept",
      );
      const promoted = await runAutoPromote(db, currentProfile, headers, config, log);
      return { accepted: 0, promoted, skippedAtCap };
    }
  }

  // Phase 1: Auto-accept probe-candidates (top N per pass, capped by available slots)
  const candidates = db
    .prepare(
      `SELECT candidate_id FROM family_candidates
       WHERE gate_recommendation IN ('probe-candidate', 'scaled-candidate')
         AND status = 'discovered'
         AND pattern_confidence != 'low'
         AND matched_family_id IS NULL
       ORDER BY
         CASE gate_recommendation WHEN 'scaled-candidate' THEN 0 ELSE 1 END,
         CASE pattern_confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         (COALESCE(recurrence_score, 0) * COALESCE(live_viability_score, 0)) DESC
       LIMIT ?`,
    )
    .all(availableSlots) as Array<{ candidate_id: string }>;

  let accepted = 0;
  for (const c of candidates) {
    try {
      const res = await fetch(
        `${config.apiBaseUrl}/api/v1/discovery/candidates/${c.candidate_id}/accept`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            maxOpenValueUsdc: 10,
            maxActiveMarkets: 3,
            maxDustPositions: 2,
          }),
        },
      );
      if (res.ok) {
        accepted++;
        log.info({ candidateId: c.candidate_id }, "auto-accepted candidate");
      } else {
        log.warn({ candidateId: c.candidate_id, status: res.status }, "auto-accept failed");
      }
    } catch (err) {
      log.warn({ candidateId: c.candidate_id, err }, "auto-accept error");
    }
  }

  // Phase 2: Auto-promote
  const promoted = await runAutoPromote(db, currentProfile, headers, config, log);

  return { accepted, promoted, skippedAtCap: 0 };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveCurrentProfile(db: Database): string | null {
  const row = db.prepare("SELECT current_profile FROM runtime_control_state WHERE id = 1").get() as
    | { current_profile: string | null }
    | undefined;
  return row?.current_profile ?? null;
}

function countEnabledFamilies(db: Database, profile: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM family_deployments WHERE profile = ? AND enabled = 1")
    .get(profile) as { cnt: number };
  return row.cnt;
}

function resolveMaxFamilies(db: Database, profile: string): number {
  const row = db
    .prepare("SELECT envelope_json FROM profile_settings WHERE profile_id = ?")
    .get(profile) as { envelope_json: string | null } | undefined;
  if (!row?.envelope_json) return DEFAULT_MAX_FAMILIES;
  try {
    const envelope = JSON.parse(row.envelope_json);
    if (typeof envelope.maxFamilies === "number") return envelope.maxFamilies;
  } catch {
    /* ignore malformed JSON */
  }
  return DEFAULT_MAX_FAMILIES;
}

function isAtFamilyCap(db: Database, profile: string): boolean {
  return countEnabledFamilies(db, profile) >= resolveMaxFamilies(db, profile);
}

function countQualifyingCandidates(db: Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM family_candidates
       WHERE gate_recommendation IN ('probe-candidate', 'scaled-candidate')
         AND status = 'discovered'
         AND pattern_confidence != 'low'
         AND matched_family_id IS NULL`,
    )
    .get() as { cnt: number };
  return row.cnt;
}

/** Phase 2: auto-promote families with exclusive current-profile proposals */
async function runAutoPromote(
  db: Database,
  currentProfile: string | null,
  headers: Record<string, string>,
  config: AutoAcceptorConfig,
  log: Logger,
): Promise<number> {
  // Safety: only auto-promote families where the ONLY pending proposal is for
  // current profile. Exclude families with NULL-profile legacy proposals or
  // proposals in other profiles — the family-scoped /promote API would pick
  // the wrong one.
  const familiesToPromote = currentProfile
    ? (db
        .prepare(
          `SELECT DISTINCT pp.family_id
           FROM promotion_proposals pp
           WHERE pp.status = 'pending'
             AND pp.profile = ?
             AND pp.family_id NOT IN (
               SELECT family_id FROM promotion_proposals
               WHERE status = 'pending' AND (profile != ? OR profile IS NULL)
             )
             AND pp.family_id NOT IN (
               SELECT DISTINCT target_id FROM operator_commands
               WHERE action = 'family_promote_scaled' AND status = 'pending'
             )`,
        )
        .all(currentProfile, currentProfile) as Array<{ family_id: string }>)
    : [];

  let promoted = 0;
  for (const f of familiesToPromote) {
    try {
      const res = await fetch(`${config.apiBaseUrl}/api/v1/actions/family/${f.family_id}/promote`, {
        method: "POST",
        headers,
        body: JSON.stringify({ reason: "auto-promote: promotion thresholds met" }),
      });
      if (res.ok) {
        promoted++;
        log.info({ familyId: f.family_id, profile: currentProfile }, "auto-promoted");
      } else {
        log.warn({ familyId: f.family_id, status: res.status }, "auto-promote failed");
      }
    } catch (err) {
      log.warn({ familyId: f.family_id, err }, "auto-promote error");
    }
  }

  return promoted;
}
