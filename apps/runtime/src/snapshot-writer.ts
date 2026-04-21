import type {
  MarketSnapshotRepository,
  MarketSnapshot,
  NormalizedMarket,
  TokenId,
} from "@plankton/domain";

export interface SnapshotWriterConfig {
  intervalMs: number;
  pruneIntervalMs: number;
  pruneTtlMs: number;
}

export class SnapshotWriter {
  private readonly lastWrittenAt = new Map<TokenId, number>();
  private lastPruneAt = Date.now();

  constructor(
    private readonly repo: MarketSnapshotRepository,
    private readonly config: SnapshotWriterConfig,
  ) {}

  onSnapshot(markets: readonly NormalizedMarket[], timestamp: number): void {
    const batch: MarketSnapshot[] = [];

    for (const m of markets) {
      const lastAt = this.lastWrittenAt.get(m.tokenId);
      if (lastAt !== undefined && timestamp - lastAt < this.config.intervalMs) continue;
      batch.push({
        tokenId: m.tokenId,
        bestBid: m.bestBid,
        bestAsk: m.bestAsk,
        lastPrice: null,
        volume24h: null,
        liquidity: null,
        capturedAt: new Date(timestamp).toISOString(),
      });
    }

    if (batch.length > 0) {
      this.repo.saveBatch(batch);
      for (const s of batch) this.lastWrittenAt.set(s.tokenId, timestamp);
    }

    if (timestamp - this.lastPruneAt > this.config.pruneIntervalMs) {
      const cutoff = new Date(timestamp - this.config.pruneTtlMs).toISOString();
      this.repo.prune(cutoff);
      // Mirror the DB prune in memory: drop tokens we haven't written beyond
      // the TTL. Without this, lastWrittenAt grew unbounded across tracked-
      // universe churn even though the DB rows were gone.
      const cutoffMs = timestamp - this.config.pruneTtlMs;
      for (const [tokenId, writtenAt] of this.lastWrittenAt) {
        if (writtenAt < cutoffMs) this.lastWrittenAt.delete(tokenId);
      }
      this.lastPruneAt = timestamp;
    }
  }
}
