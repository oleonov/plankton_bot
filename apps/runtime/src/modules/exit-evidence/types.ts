import type { RuntimeEventMap } from "@krabs/domain";

export const LIMITS = Object.freeze({
  chains: 32,
  captureMs: 14 * 86_400_000,
  retentionMs: 21 * 86_400_000,
  books: 131_072,
  events: 8_192,
  bookBytes: 1_024,
  eventBytes: 2_048,
  packets: 128,
  transportBytes: 1_048_576,
  packetBytes: 8_192,
  batch: 16,
  pages: 65_536,
  pageSize: 4_096,
  familyBytes: 520 * 1_048_576,
  diskFloor: 1_073_741_824,
  periodicMs: 300_000,
});
export const KINDS = [
  "PlaceOrderRequested",
  "OrderPlaced",
  "OrderSkipped",
  "OrderRejected",
  "OrderCancelled",
  "FillReceived",
  "PositionUpdated",
] as const satisfies readonly (keyof RuntimeEventMap)[];
export type Kind = (typeof KINDS)[number];
export const QUALITY = [
  "enrollment_drop",
  "book_drop",
  "lifecycle_drop",
  "invalid_field",
  "invalid_time",
  "future_time",
  "clock_backwards",
  "book_missing",
  "book_stale",
  "depth_oversize",
  "post_fill",
  "book_quota",
  "event_quota",
  "payload_quota",
  "link_unknown",
  "link_ambiguous",
  "left_censored",
  "catchup_incomplete",
  "disk_pressure",
  "settlement_detail_unavailable",
  "comparison_unavailable",
  "restart_gap",
] as const;
export type Quality = (typeof QUALITY)[number];
export type Counters = Record<Quality, number>;
export const counters = (): Counters => Object.fromEntries(QUALITY.map((k) => [k, 0])) as Counters;
export type Facts = Record<string, string | number | boolean | null>;
export interface Book {
  bestBid: number | null;
  bestAsk: number | null;
  time: number | null;
  fresh: boolean;
  oversize: boolean;
  bids: Float64Array;
  asks: Float64Array;
}
export interface Packet {
  slot: number;
  kind: Kind | "Book";
  id: string;
  received: number;
  source: number | null;
  facts: Facts;
  book?: Book;
}
export interface Episode {
  slot: number;
  client: string;
  command: string;
  signal: string;
  token: string;
  condition: string;
  position: string | null;
  terminal: boolean;
  ambiguous: boolean;
}
export interface Run {
  started: number;
  deadline: number;
  expires: number;
  last_seen: number;
  spent: number;
  event_count: number;
  book_count: number;
  disabled: number;
  clean_shutdown: number;
}
export type MainMessage =
  | { type: "init"; path: string; ledgerPath: string; parentPid: number }
  | { type: "progressAck" }
  | { type: "batch"; packets: Packet[]; drops: Counters; grant: boolean }
  | { type: "shutdown"; drops?: Counters };
export type WorkerMessage =
  | {
      type: "ready" | "ack" | "progress";
      quality: Counters;
      run: Run;
      episodes: Episode[];
      credit: number | null;
    }
  | { type: "stopped" }
  | { type: "disabled" };

// Bounded UTF-8, with no truncation of identities (truncation could merge two orders).
export function identifier(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    Buffer.byteLength(value, "utf8") <= 160
    ? value
    : null;
}
export function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8.64e15;
}
