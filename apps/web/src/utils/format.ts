export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function formatAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  return `${Math.floor(diff / 60)}m ago`;
}

export function formatTimeLeft(endDate: string | null): { text: string; color: string } {
  if (!endDate) return { text: "\u2014", color: "var(--text-dim)" };
  const end = new Date(endDate).getTime();
  if (Number.isNaN(end)) return { text: "\u2014", color: "var(--text-dim)" };
  const diffMs = end - Date.now();

  if (diffMs <= 0) return { text: "Expired", color: "var(--red)" };

  const hours = diffMs / 3_600_000;
  if (hours < 24) return { text: `${Math.round(hours)}h left`, color: "var(--orange)" };

  const days = Math.floor(hours / 24);
  if (days <= 7) return { text: `${days}d left`, color: "var(--yellow, #cc0)" };

  return { text: `${days}d left`, color: "var(--green)" };
}
