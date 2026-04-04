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
}

export async function autoAcceptAndPromote(
  db: Database,
  config: AutoAcceptorConfig,
  log: Logger,
): Promise<AutoAcceptResult> {
  if (!config.enabled) return { accepted: 0, promoted: 0 };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };

  // Phase 1: Auto-accept probe-candidates
  const candidates = db
    .prepare(
      `SELECT candidate_id FROM family_candidates
     WHERE gate_recommendation IN ('probe-candidate', 'scaled-candidate')
       AND status = 'discovered'
       AND pattern_confidence != 'low'
       AND matched_family_id IS NULL`,
    )
    .all() as Array<{ candidate_id: string }>;

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

  // Phase 2: Auto-promote — only for current profile, exclusive proposals
  const profileRow = db
    .prepare("SELECT current_profile FROM runtime_control_state WHERE id = 1")
    .get() as { current_profile: string | null } | undefined;
  const currentProfile = profileRow?.current_profile;

  const familiesToPromote = currentProfile
    ? (db
        .prepare(
          `SELECT DISTINCT pp.family_id
       FROM promotion_proposals pp
       WHERE pp.status = 'pending'
         AND pp.profile = ?
         AND pp.family_id NOT IN (
           SELECT family_id FROM promotion_proposals
           WHERE status = 'pending' AND profile != ?
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

  return { accepted, promoted };
}
