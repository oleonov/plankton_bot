import {
  ExchangeErrorCode,
  SignalReason,
  type CancelOrderReason,
  type OrderBookSnapshot,
} from "@krabs/domain";
import { DEDUPED_INTERNAL_ORDER_REJECTION_REASONS } from "../../internal-order-reasons.js";
import {
  LIMITS,
  counters,
  identifier,
  type Book,
  type Facts,
  type Packet,
  type Quality,
} from "./types.js";

const FIELDS = [
  "commandId",
  "clientOrderId",
  "signalId",
  "conditionId",
  "tokenId",
  "orderId",
  "fillId",
  "positionId",
  "side",
  "source",
  "price",
  "size",
  "sizeUsdc",
  "fee",
  "feeRateBps",
  "liquidityRole",
  "orderType",
  "tickSize",
  "negRisk",
  "postOnly",
  "status",
  "reasonCode",
  "reason",
  "signalReason",
  "errorCode",
  "openedAt",
  "closedAt",
  "updatedAt",
  "avgEntryPrice",
  "costBasisUsdc",
  "realizedPnl",
] as const;

// Exact production codes only: gatewayRejectReason can otherwise contain raw exchange text.
const REASONS: ReadonlySet<string> = new Set([
  ...DEDUPED_INTERNAL_ORDER_REJECTION_REASONS,
  ...([
    "market_resolved",
    "stale_entry_ttl",
    "track_a_resting_add_expired",
    "outbid_repriced",
    "stale_entry_enddate",
    "stale_exit_ttl",
    "downpriced_reprice",
    "buy_duplicate_replacement",
    "sell_replace_reprice",
    "sell_replace_retry",
    "sell_timeout_escalation",
    "s1_handoff_to_qd",
    "operator",
    "maker_fast_cancel",
    "maker_capture_reprice",
    "bounce_ask_capture_reprice",
    "phantom_missing_on_exchange",
    "submit_unknown_recovery",
    "exit_loss_floor",
  ] satisfies CancelOrderReason[]),
  "resolved_loser_settled_local",
  "exchange-exact-expired",
  "exchange-exact-cancelled",
  "exchange-exact-invalid",
  "exchange-insufficient-balance-or-allowance",
  "gateway returned success without order id",
  "exchange returned no order id",
  "unknown",
  "runtime-paused",
  "startup-fence-active",
  "market-inactive",
  "invalid-order-price",
  "clamped-below-min-order-size",
  "token-minimum-below",
  "token-minimum-unavailable",
  "sell-replace-chain-cap",
  "exit-owner-stale-position",
  "exit-owner-ambiguous-position",
  "exit-owner-bounce-rule-on-profile-owner",
  "exit-owner-non-bounce-rule-on-bounce-owner",
  "transition-draining",
  "bounce-backstop-below-floor-hold",
  "bounce-backstop-draining-rungs",
  "post-only-cross-pre-submit",
  "exit_loss_floor_blocked",
  "not_accepting_orders",
  "gate_open_cap",
  "tick-corrected-near-duplicate-buy",
  "tick-corrected-invalid-price",
  "duplicate_client_order_id_pre_submit",
  "buy_duplicate_deduped",
  "buy_cap_full_targeted_replacement",
]);
const CODES: Partial<Record<(typeof FIELDS)[number], ReadonlySet<string>>> = {
  reason: REASONS,
  reasonCode: REASONS,
  signalReason: new Set([...Object.values(SignalReason), "profile-ladder-exit"]),
  errorCode: new Set(Object.values(ExchangeErrorCode)),
};

function stringBytes(value: string): number {
  let bytes = Buffer.byteLength(value);
  for (const char of value)
    if (char.charCodeAt(0) < 32 || char === '"' || char === "\\") bytes += 5;
  return bytes;
}

export function copyFacts(value: object): Facts | null {
  const input = value as Record<string, unknown>;
  const facts: Facts = {};
  let bytes = 2;
  for (const key of FIELDS) {
    let v = input[key];
    if (v === undefined) continue;
    const codes = CODES[key];
    if (codes && (typeof v !== "string" || v.length > 160 || !codes.has(v))) v = null;
    if (typeof v === "string" && !identifier(v)) return null;
    if (typeof v === "number" && !Number.isFinite(v)) return null;
    if (v !== null && !["number", "boolean", "string"].includes(typeof v)) return null;
    facts[key] = v as Facts[string];
    bytes += key.length + 8 + (typeof v === "string" ? stringBytes(v) : 24);
  }
  return bytes <= LIMITS.eventBytes ? facts : null;
}

export function copyBook(book: OrderBookSnapshot | null, fresh: boolean): Book | undefined {
  if (!book) return undefined;
  const oversize = book.bids.length > 128 || book.asks.length > 128;
  const copy = (side: typeof book.bids): Float64Array => {
    if (oversize) return new Float64Array();
    const output = new Float64Array(side.length * 2);
    for (let i = 0; i < side.length; i++) {
      output[i * 2] = side[i]!.price;
      output[i * 2 + 1] = side[i]!.size;
    }
    return output;
  };
  return {
    time: book.timestamp,
    fresh,
    oversize,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    bids: copy(book.bids),
    asks: copy(book.asks),
  };
}

export class EvidenceTransport {
  readonly drops = counters();
  private queue: Packet[] = [];
  private inflight = 0;
  private scheduled = false;
  private closed = false;
  private grant = false;
  private draining = false;
  private drained: (() => void) | null = null;
  constructor(private readonly send: (packets: Packet[], requestGrant: boolean) => void) {}
  get size(): number {
    return this.queue.length + this.inflight;
  }
  get bytes(): number {
    return this.size * LIMITS.packetBytes;
  }
  drop(key: Quality): void {
    this.drops[key] = Math.min(Number.MAX_SAFE_INTEGER, this.drops[key] + 1);
  }
  enqueue(packet: Packet, grant = false): boolean {
    if (this.closed || this.draining) return false;
    this.grant ||= grant;
    if (this.size >= LIMITS.packets) {
      const optional = this.queue.findIndex((p) => p.kind === "Book");
      if (packet.kind !== "Book" && optional >= 0) {
        this.queue.splice(optional, 1);
        this.drop("book_drop");
      } else {
        this.drop(packet.kind === "Book" ? "book_drop" : "lifecycle_drop");
        return false;
      }
    }
    this.queue.push(packet);
    this.schedule();
    return true;
  }
  acknowledge(): void {
    this.inflight = 0;
    if (!this.queue.length) this.drained?.();
    this.schedule();
  }
  drain(): Promise<void> {
    this.draining = true;
    return new Promise((resolve) => {
      if (!this.size || this.closed) resolve();
      else this.drained = resolve;
    });
  }
  close(): void {
    this.closed = true;
    for (const packet of this.queue)
      this.drop(packet.kind === "Book" ? "book_drop" : "lifecycle_drop");
    this.queue = [];
    this.drained?.();
    this.drained = null;
  }
  private schedule(): void {
    if (this.closed || this.scheduled || this.inflight || !this.queue.length) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.closed || this.inflight) return;
      const batch = this.queue.splice(0, LIMITS.batch);
      this.inflight = batch.length;
      const grant = this.grant;
      this.grant = false;
      this.send(batch, grant);
    });
  }
}
