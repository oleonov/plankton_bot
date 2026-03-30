import { useState } from "react";
import { useAudit, useProfiles } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { formatAgo } from "../utils/format.ts";
import type { AuditEntryDTO } from "../api/types.ts";

const TRIGGER_BADGE: Record<string, string> = {
  system: "badge-blue",
  operator: "badge-green",
  recovery: "badge-orange",
};

function TriggerBadge({ trigger }: { trigger: string }) {
  const cls = TRIGGER_BADGE[trigger] ?? "badge-blue";
  return <span className={`badge ${cls}`}>{trigger}</span>;
}

function AuditRow({ entry }: { entry: AuditEntryDTO }) {
  return (
    <div className="audit-row">
      <span>{formatAgo(entry.created_at)}</span>
      <span><Badge value={entry.entity_type} /></span>
      <span style={{ color: "var(--blue)" }}>{entry.entity_id}</span>
      <span>
        {entry.from_state} &rarr; {entry.to_state}
        {entry.reason && (
          <span style={{ color: "var(--text-dim)", marginLeft: 6, fontSize: 11 }}>
            {entry.reason}
          </span>
        )}
      </span>
      <span><TriggerBadge trigger={entry.trigger_type} /></span>
      <span>{entry.initiator}</span>
    </div>
  );
}

export function Audit() {
  const { data: profilesData } = useProfiles();
  const [typeFilter, setTypeFilter] = useState("");
  const [profileFilter, setProfileFilter] = useState("");
  const [familySearch, setFamilySearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();

  const { data, isLoading } = useAudit({
    type: typeFilter || undefined,
    profile: profileFilter || undefined,
    familyId: familySearch || undefined,
    cursor,
    limit: 50,
  });

  const profiles = profilesData?.profiles ?? [];
  const entries = data?.items ?? [];

  return (
    <div className="page">
      <div className="page-title">Audit Log</div>
      <div className="filter-bar">
        <label>
          Type:
          <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setCursor(undefined); }}>
            <option value="">All</option>
            <option value="system">System</option>
            <option value="operator">Operator</option>
            <option value="recovery">Recovery</option>
          </select>
        </label>
        <label>
          Profile:
          <select value={profileFilter} onChange={(e) => { setProfileFilter(e.target.value); setCursor(undefined); }}>
            <option value="">All</option>
            {profiles.map((p) => (
              <option key={p.profile_id} value={p.profile_id}>{p.display_name}</option>
            ))}
          </select>
        </label>
        <label>
          Family:
          <input
            value={familySearch}
            onChange={(e) => { setFamilySearch(e.target.value); setCursor(undefined); }}
            placeholder="family ID..."
            style={{ width: 140 }}
          />
        </label>
      </div>

      {isLoading ? (
        <div style={{ padding: 16, fontSize: 12 }}>Loading...</div>
      ) : entries.length === 0 ? (
        <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>No audit entries found</div>
      ) : (
        <>
          <div className="audit-row header">
            <span>Time</span>
            <span>Type</span>
            <span>Entity</span>
            <span>From &rarr; To / Reason</span>
            <span>Trigger</span>
            <span>Initiator</span>
          </div>
          {entries.map((e) => (
            <AuditRow key={e.id} entry={e} />
          ))}
          <Pagination nextCursor={data?.nextCursor ?? null} onNext={setCursor} />
        </>
      )}
    </div>
  );
}
