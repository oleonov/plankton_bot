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

export interface SnapshotWriterConfig {
  intervalMs: number;
  pruneIntervalMs: number;
  pruneTtlMs: number;
  enabled?: () => boolean;
  preserveTokenIds?: () => readonly TokenId[];
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
    const positionByToken = new Map(
      valuation.activePositions().map((position) => [String(position.tokenId), position]),
    );
    const updatedAt = new Date(timestamp).toISOString();
    const rows: MarketSnapshotPositionValuation[] = [];

    for (const tokenId of batchTokenIds) {
      const position = positionByToken.get(tokenId);
      const market = marketByToken.get(tokenId);
      if (!position || !market) continue;

      const currentValueUsdc =
        typeof market.midPrice === "number" && Number.isFinite(market.midPrice)
          ? position.size * market.midPrice
          : null;
      const book = booksByToken?.get(tokenId) ?? null;
      const liquidation = this.computeLiquidation(position, book);
      rows.push({
        tokenId: position.tokenId,
        currentValueUsdc,
        liquidationValueUsdc: liquidation.valueUsdc,
        liquidationPrice: liquidation.price,
        liquidationDepthExhausted: liquidation.depthExhausted,
        updatedAt,
      });
      this.recordLiquidationMetrics({
        tokenId,
        currentValueUsdc,
        liquidationValueUsdc: liquidation.valueUsdc,
        skippedReason: liquidation.skippedReason,
        updatedAt,
      });
    }

    return rows;
  }

  private computeLiquidation(
    position: Position,
    book: OrderBookSnapshot | null,
  ): {
    valueUsdc: number;
    price: number;
    depthExhausted: boolean;
    skippedReason: "missing_book" | null;
  } {
    if (!book || book.bids.length === 0 || position.size <= 0) {
      return { valueUsdc: 0, price: 0, depthExhausted: true, skippedReason: "missing_book" };
    }
    const fill = computeEffectiveFillPrice(book, position.size, "sell");
    if (fill.effectiveFillPrice == null) {
      return { valueUsdc: 0, price: 0, depthExhausted: true, skippedReason: "missing_book" };
    }
    const valueUsdc = fill.effectiveFillPrice * fill.liquidityAvailable;
    return {
      valueUsdc,
      price: fill.effectiveFillPrice,
      depthExhausted: fill.exhausted,
      skippedReason: null,
    };
  }

  private recordLiquidationMetrics(args: {
    tokenId: string;
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
        JSON.stringify({ tokenId: args.tokenId }),
        args.updatedAt,
      );
      if (ratio > 1.01) {
        this.config.positionValuation?.log?.warn?.(
          {
            tokenId: args.tokenId,
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
    if (timestamp - this.lastPruneAt > this.config.pruneIntervalMs) {
      const cutoff = new Date(timestamp - this.config.pruneTtlMs).toISOString();
      const preserveTokenIds = this.config.preserveTokenIds?.() ?? [];
      this.repo.prune(cutoff, { preserveTokenIds });
      // Mirror the DB prune in memory: drop tokens we haven't written beyond
      // the TTL. Without this, lastWrittenAt grew unbounded across tracked-
      // universe churn even though the DB rows were gone.
      const cutoffMs = timestamp - this.config.pruneTtlMs;
      this.pruneMemory(this.lastRealWrittenAt, cutoffMs, preserveTokenIds);
      this.pruneMemory(this.lastHeartbeatWrittenAt, cutoffMs, preserveTokenIds);
      this.lastPruneAt = timestamp;
    }
  }

  private pruneMemory(
    writeState: Map<TokenId, number>,
    cutoffMs: number,
    preserveTokenIds: readonly TokenId[],
  ): void {
    const preserve = new Set(preserveTokenIds.map(String));
    for (const [tokenId, writtenAt] of writeState) {
      if (writtenAt < cutoffMs && !preserve.has(String(tokenId))) writeState.delete(tokenId);
    }
  }
}
