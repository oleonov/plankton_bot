import type { PriceLevel, TokenId } from "@krabs/domain";

const WINDOW_30M_MS = 30 * 60_000;
const WINDOW_1H_MS = 60 * 60_000;
const SAME_BID_TOLERANCE = 1e-12;
const DEFAULT_MAX_ENTRIES_PER_BUFFER = 1_000;
const DEFAULT_PRUNE_INTERVAL_MS = 60_000;

export interface BidState {
  readonly ts: number;
  readonly bestBid: number | null;
}

export interface DepthState {
  readonly ts: number;
  readonly depthTop3: number | null;
}

export interface TrackCBookSignals {
  readonly bidPersistenceS: number | null;
  readonly bidMovement30m: number | null;
  readonly publicTradeCount1h: number | null;
  readonly depthTop3: number | null;
}

export interface TrackCBookSignalsProviderOptions {
  readonly maxEntriesPerBuffer?: number;
  readonly pruneIntervalMs?: number;
}

export interface TopOfBookObservation {
  readonly tokenId: TokenId;
  readonly ts: number;
  readonly bestBid: number | null;
  readonly bestAsk?: number | null;
}

export interface LastTradePriceObservation {
  readonly tokenId: TokenId;
  readonly ts: number;
  readonly price: number | null;
}

export interface BookDepthObservation {
  readonly tokenId: TokenId;
  readonly ts: number;
  readonly bids: readonly PriceLevel[];
}

interface TokenSignalState {
  readonly bidStates: TimeBoundedBuffer<BidState>;
  readonly tradeTimestamps: TimeBoundedBuffer<TimestampState>;
  readonly depthStates: TimeBoundedBuffer<DepthState>;
}

interface TimestampState {
  readonly ts: number;
}

export interface TrackCBookSignalsDebugSnapshot {
  readonly bidStateCount: number;
  readonly tradeTimestampCount: number;
  readonly depthStateCount: number;
  readonly activeTokenCount: number;
}

const NULL_SIGNALS: TrackCBookSignals = {
  bidPersistenceS: null,
  bidMovement30m: null,
  publicTradeCount1h: null,
  depthTop3: null,
};

export class TrackCBookSignalsProvider {
  private readonly maxEntriesPerBuffer: number;
  private readonly pruneIntervalMs: number;
  private activeTokenIds = new Set<string>();
  private readonly invalidatedTokenIds = new Set<string>();
  private readonly stateByToken = new Map<string, TokenSignalState>();

  constructor(options: TrackCBookSignalsProviderOptions = {}) {
    this.maxEntriesPerBuffer = resolvePositiveInt(
      options.maxEntriesPerBuffer,
      DEFAULT_MAX_ENTRIES_PER_BUFFER,
    );
    this.pruneIntervalMs = resolvePositiveInt(options.pruneIntervalMs, DEFAULT_PRUNE_INTERVAL_MS);
  }

  setOpenPositionTokenIds(tokenIds: readonly TokenId[]): void {
    const next = new Set(tokenIds.map(String));
    this.activeTokenIds = next;
    for (const tokenId of [...this.stateByToken.keys()]) {
      if (!next.has(tokenId)) this.stateByToken.delete(tokenId);
    }
    for (const tokenId of [...this.invalidatedTokenIds]) {
      if (!next.has(tokenId)) this.invalidatedTokenIds.delete(tokenId);
    }
  }

  invalidateTokenIds(tokenIds: readonly TokenId[] | readonly string[]): void {
    for (const tokenId of tokenIds) {
      const key = String(tokenId);
      this.stateByToken.delete(key);
      if (this.activeTokenIds.has(key)) this.invalidatedTokenIds.add(key);
    }
  }

  ingestTopOfBook(observation: TopOfBookObservation): void {
    if (!this.shouldTrack(observation.tokenId)) return;
    const state = this.ensureState(observation.tokenId);
    state.bidStates.push({
      ts: observation.ts,
      bestBid: finiteOrNull(observation.bestBid),
    });
  }

  ingestLastTradePrice(observation: LastTradePriceObservation): void {
    if (!this.shouldTrack(observation.tokenId)) return;
    const state = this.ensureState(observation.tokenId);
    state.tradeTimestamps.push({ ts: observation.ts });
  }

  ingestBook(observation: BookDepthObservation): void {
    if (!this.shouldTrack(observation.tokenId)) return;
    const state = this.ensureState(observation.tokenId);
    state.depthStates.push({
      ts: observation.ts,
      depthTop3: computeTop3BidDepth(observation.bids),
    });
  }

  getBookSignals(tokenId: TokenId, anchor: number): TrackCBookSignals {
    if (!this.shouldTrack(tokenId)) return NULL_SIGNALS;
    const state = this.stateByToken.get(String(tokenId));
    if (!state && this.invalidatedTokenIds.has(String(tokenId))) return NULL_SIGNALS;
    if (!state) {
      return {
        ...NULL_SIGNALS,
        publicTradeCount1h: 0,
      };
    }
    const bidStates = state.bidStates.values();
    return {
      bidPersistenceS: computeBidPersistenceS(bidStates, anchor),
      bidMovement30m: computeBidMovement30m(bidStates, anchor),
      publicTradeCount1h: computePublicTradeCount1h(
        state.tradeTimestamps.values().map((timestamp) => timestamp.ts),
        anchor,
      ),
      depthTop3: computeDepthTop3(state.depthStates.values(), anchor),
    };
  }

  getDebugSnapshot(tokenId?: TokenId): TrackCBookSignalsDebugSnapshot {
    const states =
      tokenId == null ? [...this.stateByToken.values()] : [this.stateByToken.get(String(tokenId))];
    return states.reduce<TrackCBookSignalsDebugSnapshot>(
      (snapshot, state) => {
        if (!state) return snapshot;
        return {
          bidStateCount: snapshot.bidStateCount + state.bidStates.length,
          tradeTimestampCount: snapshot.tradeTimestampCount + state.tradeTimestamps.length,
          depthStateCount: snapshot.depthStateCount + state.depthStates.length,
          activeTokenCount: snapshot.activeTokenCount,
        };
      },
      {
        bidStateCount: 0,
        tradeTimestampCount: 0,
        depthStateCount: 0,
        activeTokenCount: this.activeTokenIds.size,
      },
    );
  }

  private shouldTrack(tokenId: TokenId): boolean {
    return this.activeTokenIds.has(String(tokenId));
  }

  private ensureState(tokenId: TokenId): TokenSignalState {
    const key = String(tokenId);
    this.invalidatedTokenIds.delete(key);
    const existing = this.stateByToken.get(key);
    if (existing) return existing;
    const created: TokenSignalState = {
      bidStates: new TimeBoundedBuffer<BidState>({
        windowMs: WINDOW_30M_MS,
        maxEntries: this.maxEntriesPerBuffer,
        pruneIntervalMs: this.pruneIntervalMs,
      }),
      tradeTimestamps: new TimeBoundedBuffer<TimestampState>({
        windowMs: WINDOW_1H_MS,
        maxEntries: this.maxEntriesPerBuffer,
        pruneIntervalMs: this.pruneIntervalMs,
      }),
      depthStates: new TimeBoundedBuffer<DepthState>({
        windowMs: WINDOW_30M_MS,
        maxEntries: this.maxEntriesPerBuffer,
        pruneIntervalMs: this.pruneIntervalMs,
      }),
    };
    this.stateByToken.set(key, created);
    return created;
  }
}

class TimeBoundedBuffer<T extends { readonly ts: number }> {
  private readonly entries: T[] = [];
  private head = 0;
  private lastPruneAnchor = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly options: {
      readonly windowMs: number;
      readonly maxEntries: number;
      readonly pruneIntervalMs: number;
    },
  ) {}

  get length(): number {
    return this.entries.length - this.head;
  }

  push(entry: T): void {
    this.entries.push(entry);
    this.enforceMaxEntries();
    this.pruneByTtlIfDue(entry.ts);
    this.compactIfNeeded();
  }

  values(): T[] {
    return this.entries.slice(this.head);
  }

  private enforceMaxEntries(): void {
    const overflow = this.length - this.options.maxEntries;
    if (overflow > 0) this.head += overflow;
  }

  private pruneByTtlIfDue(anchor: number): void {
    if (anchor - this.lastPruneAnchor < this.options.pruneIntervalMs) return;
    const minTs = anchor - this.options.windowMs;
    while (this.head < this.entries.length && this.entries[this.head]!.ts < minTs) {
      this.head++;
    }
    this.lastPruneAnchor = anchor;
  }

  private compactIfNeeded(): void {
    if (this.head < 1_024 || this.head * 2 < this.entries.length) return;
    this.entries.splice(0, this.head);
    this.head = 0;
  }
}

export function computeBidPersistenceS(
  states: readonly BidState[],
  anchor: number,
): number | null {
  // Observer capture parses zero bids as values (observer.py lines 284-297, 313-316).
  // The analysis signal path skips only None rows before persistence
  // (pre_track_c_deep_dive_blocks_1_3_2026_05_28.py lines 311-345).
  const windowStates = statesInWindow(states, anchor, WINDOW_30M_MS).filter(
    (state): state is { readonly ts: number; readonly bestBid: number } => {
      return finiteOrNull(state.bestBid) != null;
    },
  );
  const nearest = windowStates.at(-1);
  const currentBid = nearest?.bestBid ?? null;
  if (!nearest || currentBid == null) return null;

  // Analyst formula lines 90-103: walk backward over contiguous same-bid states.
  let persistenceStart = nearest.ts;
  for (let index = windowStates.length - 1; index >= 0; index--) {
    const bid = finiteOrNull(windowStates[index]?.bestBid);
    if (bid == null || Math.abs(bid - currentBid) > SAME_BID_TOLERANCE) break;
    persistenceStart = windowStates[index]!.ts;
  }
  return Math.min(1800, Math.max(0, (anchor - persistenceStart) / 1000));
}

export function computeBidMovement30m(
  states: readonly BidState[],
  anchor: number,
): number | null {
  // Analyst formula lines 157-166 / script line 336: max-min over non-null bids.
  // Zero is a valid numeric bid for this signal.
  const bids = statesInWindow(states, anchor, WINDOW_30M_MS)
    .map((state) => finiteOrNull(state.bestBid))
    .filter((bid): bid is number => bid != null);
  if (bids.length === 0) return null;
  return Math.max(...bids) - Math.min(...bids);
}

export function computePublicTradeCount1h(
  tradeTimestamps: readonly number[],
  anchor: number,
): number {
  // Analyst formula lines 212-225: count last_trade_price rows in [anchor-3600, anchor).
  const start = anchor - WINDOW_1H_MS;
  return tradeTimestamps.filter((ts) => ts >= start && ts < anchor).length;
}

export function computeDepthTop3(states: readonly DepthState[], anchor: number): number | null {
  // Analyst formula lines 290-297: latest non-null top-3 bid depth inside 30m state window.
  const windowStates = statesInWindow(states, anchor, WINDOW_30M_MS);
  for (let index = windowStates.length - 1; index >= 0; index--) {
    const depth = finiteOrNull(windowStates[index]?.depthTop3);
    if (depth != null) return depth;
  }
  return null;
}

export function computeTop3BidDepth(bids: readonly PriceLevel[]): number | null {
  const levels = bids
    .map((bid) => ({
      price: finiteOrNull(bid.price),
      size: finiteOrNull(bid.size),
    }))
    .filter((bid): bid is { readonly price: number; readonly size: number } => {
      return bid.price != null && bid.size != null;
    })
    .sort((left, right) => {
      const priceDiff = right.price - left.price;
      return priceDiff === 0 ? right.size - left.size : priceDiff;
    });
  if (levels.length === 0) return null;
  // Observer depthTop3 uses `sum(size for _, size in sorted(levels, reverse=True)[:3])`
  // (pre_track_c_deep_dive_blocks_1_3_2026_05_28.py line 163). Python's float
  // sum is compensated; use the same compensated accumulation instead of JS reduce.
  return compensatedFloatSum(levels.slice(0, 3).map((level) => level.size));
}

function statesInWindow<T extends { readonly ts: number }>(
  states: readonly T[],
  anchor: number,
  windowMs: number,
): T[] {
  const start = anchor - windowMs;
  return states
    .filter((state) => state.ts >= start && state.ts <= anchor)
    .sort((left, right) => left.ts - right.ts);
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function resolvePositiveInt(value: number | null | undefined, fallback: number): number {
  return value != null && Number.isInteger(value) && value > 0 ? value : fallback;
}

function compensatedFloatSum(values: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const next = sum + value;
    compensation +=
      Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    sum = next;
  }
  return sum + compensation;
}
