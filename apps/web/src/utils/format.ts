export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/** Parse a timestamp as UTC. SQLite's datetime() omits the Z suffix. */
function parseUtc(ts: string): number {
  // Check if timestamp already has timezone info (Z, +HH:MM, or -HH:MM after time)
  // The regex matches Z or ±HH:MM at the end of the string
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(ts)) return new Date(ts).getTime();
  // No timezone — SQLite datetime format. Normalize to ISO UTC.
  return new Date(ts.replace(" ", "T") + "Z").getTime();
}

export function formatAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - parseUtc(iso)) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
  }
  const days = Math.floor(diff / 86400);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function formatAge(openedAt: string): string {
  const ms = Date.now() - parseUtc(openedAt);
  if (Number.isNaN(ms) || ms < 0) return "\u2014";
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Smart timestamp for trading tables.
 * Today:      "14:38"
 * This year:  "14:38, 31 Mar"
 * Other year: "14:38, 31 Mar 2025"
 */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return "\u2014";
  const date = new Date(parseUtc(iso));
  if (Number.isNaN(date.getTime())) return "\u2014";

  const now = new Date();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const time = `${hh}:${mm}`;

  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  if (isToday) return time;

  const day = date.getDate();
  const month = SHORT_MONTHS[date.getMonth()]!;

  if (date.getFullYear() === now.getFullYear()) return `${time}, ${day} ${month}`;

  return `${time}, ${day} ${month} ${date.getFullYear()}`;
}

export function formatTimeLeft(endDate: string | null): { text: string; color: string } {
  if (!endDate) return { text: "\u2014", color: "var(--text-dim)" };
  const end = parseUtc(endDate);
  if (Number.isNaN(end)) return { text: "\u2014", color: "var(--text-dim)" };
  const diffMs = end - Date.now();

  if (diffMs <= 0) return { text: "Expired", color: "var(--red)" };

  const hours = diffMs / 3_600_000;
  if (hours < 24) return { text: `${Math.round(hours)}h left`, color: "var(--orange)" };

  const days = Math.floor(hours / 24);
  if (days <= 7) return { text: `${days}d left`, color: "var(--yellow, #cc0)" };

  return { text: `${days}d left`, color: "var(--green)" };
}
