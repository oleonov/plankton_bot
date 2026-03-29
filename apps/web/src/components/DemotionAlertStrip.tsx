import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client.ts";
import type { TransitionDTO } from "../api/types.ts";

function formatMinsAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return mins < 1 ? "just now" : `${mins}m ago`;
}

export function DemotionAlertStrip() {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  const { data: transitions } = useQuery({
    queryKey: ["families", "transitions", "recent-demotions"],
    queryFn: () => apiFetch<TransitionDTO[]>("/api/v1/families/recent-demotions"),
    refetchInterval: 30_000,
  });

  const visible = (transitions ?? []).filter((t) => !dismissed.has(t.id));
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
            Family {t.entityId} demoted to {t.toState} {formatMinsAgo(t.createdAt)}
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
