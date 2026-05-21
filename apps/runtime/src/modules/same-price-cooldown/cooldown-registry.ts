import type { OrderSide, TokenId } from "@krabs/domain";
import type { Logger } from "../../logger.js";

const EXTENSION_LOG_THRESHOLD_MS = 30_000;
const TOP_TOKEN_LIMIT = 20;

export interface CooldownRegistryEntry {
  readonly tokenId: TokenId;
  readonly side: OrderSide;
  readonly priceX10000: number;
  readonly staleCancelCount: number;
  readonly cooldownUntilTsUtc: number;
  readonly activatedAtMs: number;
}

export interface CooldownRegistrySnapshot {
  readonly signalsSuppressedEarlyCooldownTotal: number;
  readonly signalsSuppressedEarlyCooldownByToken: Readonly<Record<string, number>>;
  readonly cooldownRegistrySize: number;
}

export class CooldownRegistry {
  private readonly entries = new Map<string, CooldownRegistryEntry>();
  private readonly earlySuppressedByToken = new Map<string, number>();
  private earlySuppressedTotal = 0;

  constructor(private readonly log: Logger) {}

  static key(tokenId: TokenId, side: OrderSide, priceX10000: number): string {
    return `${String(tokenId)}|${side.toUpperCase()}|${priceX10000}`;
  }

  get(
    tokenId: TokenId,
    side: OrderSide,
    priceX10000: number,
    nowMs: number,
  ): CooldownRegistryEntry | null {
    const key = CooldownRegistry.key(tokenId, side, priceX10000);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.cooldownUntilTsUtc > nowMs) return entry;
    this.entries.delete(key);
    if (entry.side === "sell") this.logSellExpired(entry);
    return null;
  }

  upsert(entry: Omit<CooldownRegistryEntry, "activatedAtMs">, nowMs: number): void {
    const key = CooldownRegistry.key(entry.tokenId, entry.side, entry.priceX10000);
    const existing = this.entries.get(key);
    const next: CooldownRegistryEntry = {
      ...entry,
      activatedAtMs: existing?.activatedAtMs ?? nowMs,
    };
    this.entries.set(key, next);

    if (!existing) {
      if (entry.side !== "sell") return;
      this.log.info(
        {
          event: "sell_cooldown_activated",
          tokenId: String(entry.tokenId),
          price: entry.priceX10000 / 10_000,
          expiresAt: entry.cooldownUntilTsUtc,
        },
        "sell cooldown activated",
      );
      return;
    }

    const extensionMs = entry.cooldownUntilTsUtc - existing.cooldownUntilTsUtc;
    if (entry.side === "sell" && extensionMs > EXTENSION_LOG_THRESHOLD_MS) {
      this.log.info(
        {
          event: "sell_cooldown_extended",
          tokenId: String(entry.tokenId),
          price: entry.priceX10000 / 10_000,
          oldExpiresAt: existing.cooldownUntilTsUtc,
          newExpiresAt: entry.cooldownUntilTsUtc,
        },
        "sell cooldown extended",
      );
    }
  }

  hydrate(entry: Omit<CooldownRegistryEntry, "activatedAtMs">, activatedAtMs: number): void {
    this.entries.set(CooldownRegistry.key(entry.tokenId, entry.side, entry.priceX10000), {
      ...entry,
      activatedAtMs,
    });
  }

  delete(tokenId: TokenId, side: OrderSide, priceX10000: number): void {
    this.entries.delete(CooldownRegistry.key(tokenId, side, priceX10000));
  }

  deleteByTokenId(tokenId: TokenId): void {
    const prefix = `${String(tokenId)}|`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  recordEarlySuppression(tokenId: TokenId): void {
    const key = String(tokenId);
    this.earlySuppressedTotal++;
    this.earlySuppressedByToken.set(key, (this.earlySuppressedByToken.get(key) ?? 0) + 1);
    if (this.earlySuppressedByToken.size <= TOP_TOKEN_LIMIT) return;
    let smallestKey: string | null = null;
    let smallestValue = Number.POSITIVE_INFINITY;
    for (const [candidate, count] of this.earlySuppressedByToken) {
      if (count >= smallestValue) continue;
      smallestKey = candidate;
      smallestValue = count;
    }
    if (smallestKey) this.earlySuppressedByToken.delete(smallestKey);
  }

  sweepExpired(nowMs: number): number {
    let deleted = 0;
    for (const [key, entry] of this.entries) {
      if (entry.cooldownUntilTsUtc > nowMs) continue;
      this.entries.delete(key);
      if (entry.side === "sell") this.logSellExpired(entry);
      deleted++;
    }
    return deleted;
  }

  snapshot(): CooldownRegistrySnapshot {
    return {
      signalsSuppressedEarlyCooldownTotal: this.earlySuppressedTotal,
      signalsSuppressedEarlyCooldownByToken: Object.fromEntries(this.earlySuppressedByToken),
      cooldownRegistrySize: this.entries.size,
    };
  }

  private logSellExpired(entry: CooldownRegistryEntry): void {
    this.log.info(
      {
        event: "sell_cooldown_expired",
        tokenId: String(entry.tokenId),
        price: entry.priceX10000 / 10_000,
        lifetimeMs: Math.max(0, entry.cooldownUntilTsUtc - entry.activatedAtMs),
      },
      "sell cooldown expired",
    );
  }
}
