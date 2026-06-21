import type { S1OwnershipReader, S1OwnershipSnapshot, TokenId } from "@krabs/domain";

import type { ProfileSnapshot, ProfileState } from "./types.js";

const OWNED_STATES = new Set<ProfileState>([
  "PROBING",
  "ACCUMULATING",
  "HARVESTING",
  "EXITING",
  "QD_HANDOFF",
  "ABANDONED",
  "ABANDONED_DORMANT",
]);

export interface ProfileOwnershipReader {
  isProfileOwned(tokenId: TokenId): boolean;
  getSnapshot(tokenId: TokenId): ProfileSnapshot | undefined;
}

export class InMemoryProfileOwnershipReader implements ProfileOwnershipReader {
  private readonly snapshots = new Map<string, ProfileSnapshot>();

  constructor(initial: readonly ProfileSnapshot[] = []) {
    for (const snapshot of initial) this.setSnapshot(snapshot);
  }

  isProfileOwned(tokenId: TokenId): boolean {
    const snapshot = this.snapshots.get(String(tokenId));
    return snapshot != null && OWNED_STATES.has(snapshot.state);
  }

  getSnapshot(tokenId: TokenId): ProfileSnapshot | undefined {
    return this.snapshots.get(String(tokenId));
  }

  setSnapshot(snapshot: ProfileSnapshot): void {
    this.snapshots.set(String(snapshot.tokenId), snapshot);
  }

  deleteSnapshot(tokenId: TokenId): void {
    this.snapshots.delete(String(tokenId));
  }

  hydrate(snapshots: readonly ProfileSnapshot[]): void {
    this.snapshots.clear();
    for (const snapshot of snapshots) this.setSnapshot(snapshot);
  }

  size(): number {
    return this.snapshots.size;
  }
}

export function createS1OwnershipAdapter(reader: ProfileOwnershipReader): S1OwnershipReader {
  return {
    getSnapshot(tokenId: TokenId): S1OwnershipSnapshot | null {
      const snapshot = reader.getSnapshot(tokenId);
      if (snapshot == null || !reader.isProfileOwned(tokenId)) return null;
      return {
        owned: true,
        ladderId: snapshot.activeLadderId ?? "",
        assumedAtMs: Date.parse(snapshot.assumedAt),
        reason: toS1Reason(snapshot),
      };
    },
  };
}

function toS1Reason(snapshot: ProfileSnapshot): S1OwnershipSnapshot["reason"] {
  if (snapshot.state === "QD_HANDOFF") return "handoff";
  if (snapshot.activeLadderId != null && snapshot.activeLadderId !== "") return "active_ladder";
  return "eligible";
}
