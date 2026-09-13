import type {
  MarketSnapshotRepository,
  MarketSnapshotPositionValuation,
  MarketSnapshot,
  NormalizedMarket,
  OrderBookSnapshot,
  Position,
  TokenId,
} from "@krabs/domain";
import { computeEffectiveFillPrice } from "@krabs/domain";
import { compareActivePositions } from "./active-positions.js";
import { MARKET_SNAPSHOT_RETENTION_MS } from "./modules/retention/ledger-retention-module.js";

export interface SnapshotWriterConfig {
  intervalMs: number;
  enabled?: () => boolean;
  positionValuation?: SnapshotPositionValuationConfig;
}

export interface SnapshotPositionValuationConfig {
  activePositions: () => readonly Position[];
  runtimeMetrics?: {
    writeCounter?: (metricName: string, value?: number, labels?: string | null) => void;
    writeEvent?: (
      metricName: string,
      value?: number,
      labels?: string | null,
      capturedAt?: string,
    ) => void;
  };
  log?: {
    warn?: (obj: Record<string, unknown>, msg: string) => void;
  };
}

export class SnapshotWriter {
  private readonly lastRealWrittenAt = new Map<TokenId, number>();
  private readonly lastHeartbeatWrittenAt = new Map<TokenId, number>();
  private lastPruneAt = Date.now();

  constructor(
    private readonly repo: MarketSnapshotRepository,
    private readonly config: SnapshotWriterConfig,
  ) {}

  onSnapshot(markets: readonly NormalizedMarket[], timestamp: number): void {
    if (this.config.enabled && !this.config.enabled()) return;

    const batch = this.buildBatch(markets, timestamp, (tokenId) =>
      this.lastRealWrittenAt.get(tokenId),
    );
    this.writeBatch(batch, timestamp, this.lastRealWrittenAt);
    this.maybePrune(timestamp);
  }

  onHeartbeat(
    markets: readonly NormalizedMarket[],
    timestamp: number,
    booksByToken?: ReadonlyMap<string, OrderBookSnapshot>,
  ): void {
    if (this.config.enabled && !this.config.enabled()) return;

    const batch = this.buildBatch(markets, timestamp, (tokenId) => {
      const lastReal = this.lastRealWrittenAt.get(tokenId) ?? 0;
      const lastHeartbeat = this.lastHeartbeatWrittenAt.get(tokenId) ?? 0;
      return Math.max(lastReal, lastHeartbeat);
    });
    const valuations = this.buildPositionValuations(batch, markets, timestamp, booksByToken);
    this.writeBatch(batch, timestamp, this.lastHeartbeatWrittenAt, valuations);
    this.maybePrune(timestamp);
  }

  private buildBatch(
    markets: readonly NormalizedMarket[],
    timestamp: number,
    lastWrittenAt: (tokenId: TokenId) => number | undefined,
  ): MarketSnapshot[] {
    const batch: MarketSnapshot[] = [];

    for (const m of markets) {
      const lastAt = lastWrittenAt(m.tokenId);
      if (lastAt !== undefined && timestamp - lastAt < this.config.intervalMs) continue;
      batch.push({
        tokenId: m.tokenId,
        bestBid: m.bestBid,
        bestAsk: m.bestAsk,
        lastPrice: m.lastTradePrice ?? null,
        volume24h: m.volume24hr ?? m.volume24h ?? null,
        liquidity: m.liquidity ?? null,
        publicTradeCount24h: m.publicTradeCount24h ?? null,
        capturedAt: new Date(timestamp).toISOString(),
      });
    }

    return batch;
  }

  private writeBatch(
    batch: readonly MarketSnapshot[],
    timestamp: number,
    writeState: Map<TokenId, number>,
    valuations: readonly MarketSnapshotPositionValuation[] = [],
  ): void {
    if (batch.length === 0) return;
    if (valuations.length > 0 && this.repo.saveBatchWithPositionValuations) {
      this.repo.saveBatchWithPositionValuations([...batch], [...valuations]);
    } else {
      this.repo.saveBatch([...batch]);
    }
    for (const s of batch) writeState.set(s.tokenId, timestamp);
  }

  private buildPositionValuations(
    batch: readonly MarketSnapshot[],
    markets: readonly NormalizedMarket[],
    timestamp: number,
    booksByToken?: ReadonlyMap<string, OrderBookSnapshot>,
  ): MarketSnapshotPositionValuation[] {
    const valuation = this.config.positionValuation;
    if (!valuation || batch.length === 0) return [];

    const batchTokenIds = new Set(batch.map((snapshot) => String(snapshot.tokenId)));
    const marketByToken = new Map(markets.map((market) => [String(market.tokenId), market]));
    // Every valuation below is derived from ONE row's `size`, so a token that holds an `open` row
    // plus dust rows needs one valuation PER ROW — collapsing to a single winner and letting the
    // repository write it `WHERE token_id = ?` stamped the winner's value and `updated_at` onto its
    // siblings, which both overstates them and hides them from the revaluation loop's staleness check.
    const positionsByToken = new Map<string, Position[]>();
    for (const position of valuation.activePositions()) {
      const key = String(position.tokenId);
      const rowsForToken = positionsByToken.get(key);
      if (rowsForToken) rowsForToken.push(position);
      else positionsByToken.set(key, [position]);
    }
    const updatedAt = new Date(timestamp).toISOString();
    const rows: MarketSnapshotPositionValuation[] = [];

    for (const tokenId of batchTokenIds) {
      const positions = positionsByToken.get(tokenId);
      const market = marketByToken.get(tokenId);
      if (!positions || !market) continue;
      const book = booksByToken?.get(tokenId) ?? null;
      rows.push(...this.buildTokenValuations(positions, market, book, updatedAt));
    }

    return rows;
  }

  /**
   * Sibling rows of a token share ONE order book, so pricing each row against the FULL book (as if
   * it were the only claimant) double-counts depth and overstates their summed liquidation value —
   * the exact defect this method exists to avoid. Rank rows with `compareActivePositions` (the
   * `open` row first — it is the live tradable position and would really be sold off the top of the
   * book before any dust row) and allocate the book's depth to each row MARGINALLY: row i gets
   * whatever is left after the rows ranked ahead of it have already claimed their share.
   */
  private buildTokenValuations(
    positions: readonly Position[],
    market: NormalizedMarket,
    book: OrderBookSnapshot | null,
    updatedAt: string,
  ): MarketSnapshotPositionValuation[] {
    const ranked = [...positions].sort(compareActivePositions);
    const rows: MarketSnapshotPositionValuation[] = [];
    let cumulativeSize = 0;
    let cumulativeValueUsdc = 0;

    for (const position of ranked) {
      const currentValueUsdc =
        typeof market.midPrice === "number" && Number.isFinite(market.midPrice)
          ? position.size * market.midPrice
          : null;
      cumulativeSize += position.size;
      const liquidation = this.computeMarginalLiquidation(
        book,
        position.size,
        cumulativeSize,
        cumulativeValueUsdc,
      );
      cumulativeValueUsdc += liquidation.valueUsdc;

      rows.push({
        positionId: position.positionId,
        tokenId: position.tokenId,
        currentValueUsdc,
        liquidationValueUsdc: liquidation.valueUsdc,
        liquidationPrice: liquidation.price,
        liquidationDepthExhausted: liquidation.depthExhausted,
        updatedAt,
      });
      this.recordLiquidationMetrics({
        tokenId: String(position.tokenId),
        positionId: String(position.positionId),
        currentValueUsdc,
        liquidationValueUsdc: liquidation.valueUsdc,
        skippedReason: liquidation.skippedReason,
        updatedAt,
      });
    }

    return rows;
  }

  private computeMarginalLiquidation(
    book: OrderBookSnapshot | null,
    rowSize: number,
    cumulativeSize: number,
    priorCumulativeValueUsdc: number,
  ): {
    valueUsdc: number;
    price: number;
    depthExhausted: boolean;
    skippedReason: "missing_book" | null;
  } {
    if (!book || book.bids.length === 0 || rowSize <= 0) {
      return { valueUsdc: 0, price: 0, depthExhausted: true, skippedReason: "missing_book" };
    }
    const fill = computeEffectiveFillPrice(book, cumulativeSize, "sell");
    if (fill.effectiveFillPrice == null) {
      return { valueUsdc: 0, price: 0, depthExhausted: true, skippedReason: "missing_book" };
    }
    // fill.effectiveFillPrice * fill.liquidityAvailable is V(cumulativeSize) — the value realizable
    // by selling everything ranked at-or-above this row. It's monotonic non-decreasing in
    // cumulativeSize (liquidityAvailable is capped by real depth), so the rows ranked ahead never
    // claim more than this row's own marginal share; subtracting what they already claimed
    // (priorCumulativeValueUsdc) leaves exactly what THIS row realizes.
    const valueUsdc = fill.effectiveFillPrice * fill.liquidityAvailable - priorCumulativeValueUsdc;
    return {
      valueUsdc,
      price: valueUsdc / rowSize,
      depthExhausted: fill.exhausted,
      skippedReason: null,
    };
  }

  private recordLiquidationMetrics(args: {
    tokenId: string;
    /** A token can carry several rows, and each has its own size-derived ratio — label them apart. */
    positionId: string;
    currentValueUsdc: number | null;
    liquidationValueUsdc: number;
    skippedReason: "missing_book" | null;
    updatedAt: string;
  }): void {
    const metrics = this.config.positionValuation?.runtimeMetrics;
    if (args.skippedReason) {
      metrics?.writeCounter?.(
        "track_r_liquidation_compute_skipped_no_book",
        1,
        JSON.stringify({ reason: args.skippedReason }),
      );
    } else {
      metrics?.writeCounter?.(
        "track_r_liquidation_computed_total",
        1,
        JSON.stringify({ outcome: "computed" }),
      );
    }
    if (typeof args.currentValueUsdc === "number" && args.currentValueUsdc > 0) {
      const ratio = args.liquidationValueUsdc / args.currentValueUsdc;
      metrics?.writeEvent?.(
        "track_r_liquidation_value_vs_mid_ratio",
        ratio,
        JSON.stringify({ tokenId: args.tokenId, positionId: args.positionId }),
        args.updatedAt,
      );
      if (ratio > 1.01) {
        this.config.positionValuation?.log?.warn?.(
          {
            tokenId: args.tokenId,
            positionId: args.positionId,
            currentValueUsdc: args.currentValueUsdc,
            liquidationValueUsdc: args.liquidationValueUsdc,
            ratio,
          },
          "Track R liquidation value exceeds current mid value",
        );
      }
    }
  }

  private maybePrune(timestamp: number): void {
    if (timestamp - this.lastPruneAt > 60 * 60_000) {
      // LedgerRetention alone deletes rows; these maps only throttle capture during churn.
      const cutoffMs = timestamp - MARKET_SNAPSHOT_RETENTION_MS;
      this.pruneMemory(this.lastRealWrittenAt, cutoffMs);
      this.pruneMemory(this.lastHeartbeatWrittenAt, cutoffMs);
      this.lastPruneAt = timestamp;
    }
  }

  private pruneMemory(writeState: Map<TokenId, number>, cutoffMs: number): void {
    for (const [tokenId, writtenAt] of writeState) {
      if (writtenAt < cutoffMs) writeState.delete(tokenId);
    }
  }
}
