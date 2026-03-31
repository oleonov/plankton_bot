import type { TradingActivitySnapshot } from "../api/types.ts";

export interface SignalBucket {
  bucketStart: string;
  signalsProduced: number;
  signalsApproved: number;
  signalsRejected: number;
}

export interface StateSegment {
  state: string;
  startAt: string;
  endAt: string;
}

export function aggregateSnapshots(
  snapshots: TradingActivitySnapshot[],
  bucketMinutes: number,
): SignalBucket[] {
  if (snapshots.length === 0) return [];

  const bucketMs = bucketMinutes * 60 * 1000;
  const buckets: SignalBucket[] = [];
  let current: SignalBucket | null = null;
  let currentBucketStart = 0;

  for (const s of snapshots) {
    const ts = new Date(s.capturedAt).getTime();
    const bucketStart = Math.floor(ts / bucketMs) * bucketMs;

    if (!current || bucketStart !== currentBucketStart) {
      current = {
        bucketStart: new Date(bucketStart).toISOString(),
        signalsProduced: 0,
        signalsApproved: 0,
        signalsRejected: 0,
      };
      currentBucketStart = bucketStart;
      buckets.push(current);
    }

    current.signalsProduced += s.signalsProduced;
    current.signalsApproved += s.signalsApproved;
    current.signalsRejected += s.signalsRejected;
  }

  return buckets;
}

export function collapseStates(snapshots: TradingActivitySnapshot[]): StateSegment[] {
  if (snapshots.length === 0) return [];

  const segments: StateSegment[] = [];
  let current: StateSegment = {
    state: snapshots[0]!.tradingState,
    startAt: snapshots[0]!.capturedAt,
    endAt: snapshots[0]!.capturedAt,
  };

  for (let i = 1; i < snapshots.length; i++) {
    const s = snapshots[i]!;
    if (s.tradingState === current.state) {
      current.endAt = s.capturedAt;
    } else {
      segments.push(current);
      current = { state: s.tradingState, startAt: s.capturedAt, endAt: s.capturedAt };
    }
  }
  segments.push(current);

  return segments;
}
