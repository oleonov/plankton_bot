import type {
  EventBus,
  Order,
  OrderPriceCooldown,
  OrderPriceCooldownRepository,
  OrderRepository,
  OrderSide,
  RuntimeEventMap,
  RuntimeModule,
  TokenId,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";
import type { CooldownRegistry } from "./cooldown-registry.js";

const PRICE_SCALE = 10_000;
const BUY_COOLDOWN_MS = [30 * 60_000, 60 * 60_000, 24 * 60 * 60_000] as const;
const SELL_COOLDOWN_MS = [60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000] as const;

export const SAME_PRICE_COOLDOWN_REASON = "same-price-cooldown";

export interface SamePriceCooldownPlacementDecision {
  allowed: boolean;
  reason: typeof SAME_PRICE_COOLDOWN_REASON | null;
  staleCancelCount: number | null;
  cooldownUntilTsUtc: number | null;
}

export interface SamePriceCooldownModuleDeps {
  bus: EventBus;
  orderRepo: OrderRepository;
  cooldownRepo: OrderPriceCooldownRepository;
  log: Logger;
  cooldownRegistry?: CooldownRegistry | undefined;
}

export interface SamePriceCooldownPlacementArgs {
  tokenId: TokenId;
  side: OrderSide;
  price: number;
  nowMs: number;
}

export class SamePriceCooldownModule implements RuntimeModule {
  private readonly log: Logger;
  private unsubs: Array<() => void> = [];

  constructor(private readonly deps: SamePriceCooldownModuleDeps) {
    this.log = deps.log.child({ component: "same-price-cooldown" });
  }

  async start(): Promise<void> {
    this.hydrateRegistry();
    this.unsubs = [
      this.deps.bus.subscribe("OrderCancelled", (event) => this.handleOrderCancelled(event)),
      this.deps.bus.subscribe("FillReceived", (event) => this.handleFillReceived(event)),
      this.deps.bus.subscribe("PositionUpdated", (event) => this.handlePositionUpdated(event)),
      this.deps.bus.subscribe("MarketResolved", (event) => this.handleMarketResolved(event)),
    ];
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "running" };
  }

  private hydrateRegistry(): void {
    const registry = this.deps.cooldownRegistry;
    if (!registry) return;
    const nowMs = Date.now();
    for (const row of this.deps.cooldownRepo.findAll()) {
      if (row.cooldownUntilTsUtc <= nowMs) continue;
      registry.hydrate(
        {
          tokenId: row.tokenId,
          side: row.side,
          priceX10000: row.priceX10000,
          staleCancelCount: row.staleCancelCount,
          cooldownUntilTsUtc: row.cooldownUntilTsUtc,
        },
        row.lastEventTsUtc,
      );
    }
  }

  canPlaceOrder(args: SamePriceCooldownPlacementArgs): SamePriceCooldownPlacementDecision {
    const priceX10000 = priceToX10000(args.price);
    const cached = this.deps.cooldownRegistry?.get(
      args.tokenId,
      args.side,
      priceX10000,
      args.nowMs,
    );
    if (cached) {
      return {
        allowed: false,
        reason: SAME_PRICE_COOLDOWN_REASON,
        staleCancelCount: cached.staleCancelCount,
        cooldownUntilTsUtc: cached.cooldownUntilTsUtc,
      };
    }
    const row = this.deps.cooldownRepo.get(args.tokenId, args.side, priceX10000);
    if (!row || args.nowMs >= row.cooldownUntilTsUtc) {
      return {
        allowed: true,
        reason: null,
        staleCancelCount: row?.staleCancelCount ?? null,
        cooldownUntilTsUtc: row?.cooldownUntilTsUtc ?? null,
      };
    }
    this.deps.cooldownRegistry?.upsert(
      {
        tokenId: row.tokenId,
        side: row.side,
        priceX10000: row.priceX10000,
        staleCancelCount: row.staleCancelCount,
        cooldownUntilTsUtc: row.cooldownUntilTsUtc,
      },
      args.nowMs,
    );

    return {
      allowed: false,
      reason: SAME_PRICE_COOLDOWN_REASON,
      staleCancelCount: row.staleCancelCount,
      cooldownUntilTsUtc: row.cooldownUntilTsUtc,
    };
  }

  resetToken(tokenId: TokenId): number {
    this.deps.cooldownRegistry?.deleteByTokenId(tokenId);
    return this.deps.cooldownRepo.deleteByTokenId(tokenId);
  }

  private async handleOrderCancelled(event: RuntimeEventMap["OrderCancelled"]): Promise<void> {
    if (event.reason !== "stale_entry_ttl" && event.reason !== "stale_exit_ttl") return;

    const order = this.deps.orderRepo.findById(event.orderId);
    if (!order) {
      this.log.warn(
        { orderId: String(event.orderId), reason: event.reason },
        "stale cancel cooldown skipped — order not found",
      );
      return;
    }

    if (!isMatchingStaleReason(event.reason, order.side)) return;
    if (hasFillProgress(order)) {
      this.log.info(
        {
          orderId: String(order.orderId),
          tokenId: String(order.tokenId),
          side: order.side,
          price: order.price,
          fillProgressShares: order.fillProgressShares ?? null,
          status: order.status,
        },
        "same-price cooldown skipped after partial fill",
      );
      return;
    }

    const nowMs = event.timestamp;
    const priceX10000 = priceToX10000(order.price);
    const existing = this.deps.cooldownRepo.get(order.tokenId, order.side, priceX10000);
    const staleCancelCount = (existing?.staleCancelCount ?? 0) + 1;
    const cooldownUntilTsUtc = nowMs + cooldownDurationMs(order.side, staleCancelCount);
    const next: OrderPriceCooldown = {
      tokenId: order.tokenId,
      side: order.side,
      priceX10000,
      staleCancelCount,
      cooldownUntilTsUtc,
      lastEventTsUtc: nowMs,
    };

    this.deps.cooldownRepo.upsert(next);
    this.deps.cooldownRegistry?.upsert(
      {
        tokenId: next.tokenId,
        side: next.side,
        priceX10000: next.priceX10000,
        staleCancelCount: next.staleCancelCount,
        cooldownUntilTsUtc: next.cooldownUntilTsUtc,
      },
      nowMs,
    );
    this.log.info(
      {
        orderId: String(order.orderId),
        tokenId: String(order.tokenId),
        side: order.side,
        price: order.price,
        priceX10000,
        staleCancelCount,
        cooldownUntilTsUtc,
      },
      "same-price cooldown updated after stale cancel",
    );
  }

  private async handleFillReceived(event: RuntimeEventMap["FillReceived"]): Promise<void> {
    this.deps.cooldownRegistry?.delete(event.tokenId, event.side, priceToX10000(event.price));
    this.deps.cooldownRepo.delete(event.tokenId, event.side, priceToX10000(event.price));

    const order = this.deps.orderRepo.findById(event.orderId);
    if (order && fillResetNeedsOrderPrice(event, order)) {
      this.deps.cooldownRegistry?.delete(order.tokenId, order.side, priceToX10000(order.price));
      this.deps.cooldownRepo.delete(order.tokenId, order.side, priceToX10000(order.price));
    }
  }

  private async handlePositionUpdated(event: RuntimeEventMap["PositionUpdated"]): Promise<void> {
    if (!isClosedOrFlatPosition(event.position)) return;
    this.deps.cooldownRegistry?.deleteByTokenId(event.position.tokenId);
    const deleted = this.deps.cooldownRepo.deleteByTokenId(event.position.tokenId);
    if (deleted > 0) {
      this.log.info(
        { tokenId: String(event.position.tokenId), deleted },
        "same-price cooldown reset after position close",
      );
    }
  }

  private async handleMarketResolved(event: RuntimeEventMap["MarketResolved"]): Promise<void> {
    let deleted = 0;
    for (const tokenId of event.tokenIds) {
      this.deps.cooldownRegistry?.deleteByTokenId(tokenId);
      deleted += this.deps.cooldownRepo.deleteByTokenId(tokenId);
    }
    if (deleted > 0) {
      this.log.info(
        { conditionId: event.conditionId, tokenCount: event.tokenIds.length, deleted },
        "same-price cooldown reset after market resolution",
      );
    }
  }
}

export function priceToX10000(price: number): number {
  return Math.round(price * PRICE_SCALE);
}

function cooldownDurationMs(side: OrderSide, staleCancelCount: number): number {
  const ladder = side === "buy" ? BUY_COOLDOWN_MS : SELL_COOLDOWN_MS;
  const index = Math.min(Math.max(staleCancelCount, 1), ladder.length) - 1;
  return ladder[index]!;
}

function isMatchingStaleReason(reason: string, side: Order["side"]): boolean {
  // End-date stale cancels are lifecycle cleanup, not evidence that this exact
  // token-side-price failed to attract fills.
  return (
    (reason === "stale_entry_ttl" && side === "buy") ||
    (reason === "stale_exit_ttl" && side === "sell")
  );
}

function hasFillProgress(order: Order): boolean {
  return order.status === "partially-filled" || (order.fillProgressShares ?? 0) > 0;
}

function fillResetNeedsOrderPrice(event: RuntimeEventMap["FillReceived"], order: Order): boolean {
  return (
    order.tokenId !== event.tokenId ||
    order.side !== event.side ||
    priceToX10000(order.price) !== priceToX10000(event.price)
  );
}

function isClosedOrFlatPosition(event: { status: string; size: number }): boolean {
  // The reset contract intentionally includes both explicit closes and a flat
  // size=0 transition so manual/repair flows cannot leave stale cooldown rows.
  return event.status === "closed" || event.size <= 0;
}
