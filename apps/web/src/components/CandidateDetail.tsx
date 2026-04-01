import { useCandidateDetail, useCandidateTransitions } from "../api/hooks.ts";
import { ScoreBars } from "./ScoreBars.tsx";
import { Badge } from "./Badge.tsx";
import { formatAgo } from "../utils/format.ts";
import type { TransitionDTO } from "../api/types.ts";

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <span style={{ fontSize: 10, color: "var(--text-muted)", marginRight: 6 }}>{label}:</span>
      <span style={{ fontSize: 11 }}>{value ?? "\u2014"}</span>
    </div>
  );
}

function CandidateTransitions({ transitions }: { transitions: TransitionDTO[] }) {
  if (transitions.length === 0) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", marginBottom: 6 }}>
        Transitions ({transitions.length})
      </div>
      <table style={{ fontSize: 11 }}>
        <thead>
          <tr>
            <th>When</th>
            <th>From</th>
            <th>To</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {transitions.map((t) => (
            <tr key={t.id}>
              <td>{formatAgo(t.createdAt)}</td>
              <td>
                <Badge value={t.fromState} />
              </td>
              <td>
                <Badge value={t.toState} />
              </td>
              <td
                style={{
                  maxWidth: 140,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {t.reason}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CandidateDetail({
  candidateId,
  onClose,
}: {
  candidateId: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useCandidateDetail(candidateId);
  const { data: transitions } = useCandidateTransitions(candidateId);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        width: 400,
        height: "100vh",
        background: "var(--bg-card)",
        borderLeft: "1px solid var(--border)",
        overflowY: "auto",
        padding: 16,
        zIndex: 100,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Candidate Detail</span>
        <button className="btn-secondary" onClick={onClose}>
          &times;
        </button>
      </div>

      {isLoading && <div style={{ color: "var(--text-dim)" }}>Loading...</div>}

      {data && (
        <>
          <IdentitySection data={data} />
          {data.matchedFamilyId && (
            <div style={{ marginBottom: 12, fontSize: 11 }}>
              <a href={`#/families/${data.matchedFamilyId}`} style={{ color: "var(--blue)" }}>
                View family &rarr;
              </a>
            </div>
          )}
          <div style={{ margin: "12px 0" }}>
            <div
              style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", marginBottom: 6 }}
            >
              Scores
            </div>
            <ScoreBars
              recurrence={data.recurrenceScore}
              recycle={data.recycleScore}
              liveViability={data.liveViabilityScore}
              toxicity={data.toxicityPenalty}
            />
          </div>
          {transitions && <CandidateTransitions transitions={transitions} />}
          <ObservationList observations={data.recentObservations} />
        </>
      )}
    </div>
  );
}

function IdentitySection({
  data,
}: {
  data: {
    familyKey: string;
    regime: string;
    horizon: string;
    cadence: string;
    patternConfidence: string;
    slugPattern: string | null;
    matchedFamilyId: string | null;
    gateRecommendation: string;
    status: string;
  };
}) {
  return (
    <div style={{ background: "var(--bg-base)", borderRadius: 4, padding: 10, marginBottom: 12 }}>
      <DetailField label="Family Key" value={data.familyKey} />
      <DetailField label="Regime" value={data.regime} />
      <DetailField label="Horizon" value={data.horizon} />
      <DetailField label="Cadence" value={data.cadence} />
      <DetailField label="Confidence" value={data.patternConfidence} />
      <DetailField label="Slug Pattern" value={data.slugPattern} />
      <DetailField label="Matched Family" value={data.matchedFamilyId} />
      <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
        <Badge value={data.status} />
        <Badge value={data.gateRecommendation} />
      </div>
    </div>
  );
}

function ObservationList({
  observations,
}: {
  observations: Array<{
    id: number;
    activeMarketCount: number;
    clusterVolume24h: number;
    observedAt: string;
  }>;
}) {
  if (observations.length === 0) {
    return <div style={{ color: "var(--text-dim)", fontSize: 11 }}>No observations</div>;
  }

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", marginBottom: 6 }}>
        Recent Observations ({observations.length})
      </div>
      <table style={{ fontSize: 11 }}>
        <thead>
          <tr>
            <th>Observed</th>
            <th>Markets</th>
            <th>Vol 24h</th>
          </tr>
        </thead>
        <tbody>
          {observations.map((o) => (
            <tr key={o.id}>
              <td>{formatAgo(o.observedAt)}</td>
              <td>{o.activeMarketCount}</td>
              <td>${o.clusterVolume24h.toFixed(0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
