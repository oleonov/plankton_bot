import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client.ts";
import type { TransitionDTO } from "../api/types.ts";
import { formatAgo } from "../utils/format.ts";

export function DemotionAlertStrip() {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  const { data: transitions } = useQuery({
    queryKey: ["families", "transitions", "recent-demotions"],
    queryFn: () => apiFetch<TransitionDTO[]>("/api/v1/families/recent-demotions"),
    refetchInterval: 30_000,
  });

  // Dedup: show only the latest transition per family
  const dedupedByFamily = new Map<string, TransitionDTO>();
  for (const t of transitions ?? []) {
    if (!dedupedByFamily.has(t.entityId) || t.id > dedupedByFamily.get(t.entityId)!.id) {
      dedupedByFamily.set(t.entityId, t);
    }
  }
  const visible = [...dedupedByFamily.values()].filter((t) => !dismissed.has(t.id));
  if (visible.length === 0) return null;

  return (
    <div
      style={{
        background: "var(--orange-bg)",
        borderBottom: "1px solid #7d5a2f",
        padding: "6px 16px",
        fontSize: 11,
        color: "#ffcc80",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <span style={{ fontWeight: 700, color: "var(--orange)" }}>&#9888;</span>
      <span>
        {visible.map((t, i) => (
          <span key={t.id}>
            {i > 0 && " \u2022 "}
            Family {t.entityId} demoted to {t.toState} {formatAgo(t.createdAt)}
            {t.reason && ` (${t.reason})`}
          </span>
        ))}
      </span>
      <button
        className="btn-secondary"
        style={{ marginLeft: "auto", fontSize: 10 }}
        onClick={() => setDismissed(new Set(visible.map((t) => t.id)))}
      >
        Dismiss
      </button>
    </div>
  );
}
