import type {
  MarketSnapshotRepository,
  MarketSnapshot,
  NormalizedMarket,
  TokenId,
} from "@krabs/domain";

export interface SnapshotWriterConfig {
  intervalMs: number;
  pruneIntervalMs: number;
  pruneTtlMs: number;
  enabled?: () => boolean;
  preserveTokenIds?: () => readonly TokenId[];
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

  onHeartbeat(markets: readonly NormalizedMarket[], timestamp: number): void {
    if (this.config.enabled && !this.config.enabled()) return;

    const batch = this.buildBatch(markets, timestamp, (tokenId) => {
      const lastReal = this.lastRealWrittenAt.get(tokenId) ?? 0;
      const lastHeartbeat = this.lastHeartbeatWrittenAt.get(tokenId) ?? 0;
      return Math.max(lastReal, lastHeartbeat);
    });
    this.writeBatch(batch, timestamp, this.lastHeartbeatWrittenAt);
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
  ): void {
    if (batch.length === 0) return;
    this.repo.saveBatch([...batch]);
    for (const s of batch) writeState.set(s.tokenId, timestamp);
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
