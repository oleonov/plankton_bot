import type { Order } from "./types.js";
import type { OrderSide } from "./enums.js";
import type { PlaceOrderCommand } from "./commands.js";

export function isKnownTokenMinimum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export type TokenMinimumReason = "token-minimum-unavailable" | "token-minimum-below";
export class TokenMinimumBlocked extends Error {
  constructor(
    readonly reason: TokenMinimumReason,
    readonly minimum: number | null,
  ) {
    super(reason);
    this.name = "TokenMinimumBlocked";
  }
}

export function evaluateTokenMinimum(size: number, minimum: unknown): void {
  if (!isKnownTokenMinimum(minimum))
    throw new TokenMinimumBlocked("token-minimum-unavailable", null);
  if (!Number.isFinite(size) || size <= 0 || size + 1e-9 < minimum) {
    throw new TokenMinimumBlocked("token-minimum-below", minimum);
  }
}

export interface TokenMinimumObservation {
  readonly sequence: number;
  readonly requestedAt: number;
  readonly completedAt: number;
  readonly minimum: number | null;
}
export interface TokenMinimumReceipt {
  readonly tokenId: string;
  readonly sequence: number;
}
export interface TokenMinimumSource {
  read(tokenId: string): { remembered: number | null; latest: TokenMinimumObservation | null };
  resolve(tokenId: string): Promise<TokenMinimumReceipt>;
  validate(receipt: TokenMinimumReceipt, tokenId: string, size: number): void;
  consume(receipt: TokenMinimumReceipt): void;
}

/** Owned by the candidate cache; book eviction and wall time cannot grant permission. */
export class TokenMinimumAuthority implements TokenMinimumSource {
  private sequence = 0;
  private disposed = false;
  private readonly latest = new Map<string, TokenMinimumObservation>();
  private readonly remembered = new Map<string, TokenMinimumObservation>();
  private readonly active = new Map<string, Set<number>>();
  private readonly receipts = new WeakSet<TokenMinimumReceipt>();
  constructor(
    private readonly refresh: (tokenId: string) => Promise<boolean>,
    private readonly changed: (tokenId: string, minimum: number | null) => void,
  ) {}

  begin(tokenIds: readonly string[]): { sequence: number; requestedAt: number } {
    const request = { sequence: ++this.sequence, requestedAt: Date.now() };
    if (!this.disposed)
      for (const tokenId of tokenIds) {
        const requests = this.active.get(tokenId) ?? new Set<number>();
        requests.add(request.sequence);
        this.active.set(tokenId, requests);
      }
    return request;
  }

  complete(
    request: { sequence: number; requestedAt: number },
    outcomes: ReadonlyMap<string, number | null>,
  ): void {
    if (this.disposed) return;
    for (const [tokenId, value] of outcomes) {
      const minimum = isKnownTokenMinimum(value) ? value : null;
      const observation = { ...request, completedAt: Date.now(), minimum };
      const previous = this.latest.get(tokenId);
      const remembered = this.remembered.get(tokenId)?.minimum ?? null;
      const active = this.active.get(tokenId);
      active?.delete(request.sequence);
      if (!active?.size) this.active.delete(tokenId);
      if (minimum !== null && request.sequence > (this.remembered.get(tokenId)?.sequence ?? 0)) {
        this.remembered.set(tokenId, observation);
      }
      if (request.sequence <= (previous?.sequence ?? 0)) {
        if (remembered !== (this.remembered.get(tokenId)?.minimum ?? null))
          this.changed(tokenId, previous?.minimum ?? null);
        continue;
      }
      this.latest.set(tokenId, observation);
      if (!previous || previous.minimum !== minimum) this.changed(tokenId, minimum);
    }
  }

  read(tokenId: string) {
    return {
      remembered: this.remembered.get(tokenId)?.minimum ?? null,
      latest: this.latest.get(tokenId) ?? null,
    };
  }

  async resolve(tokenId: string): Promise<TokenMinimumReceipt> {
    const active = this.active.get(tokenId);
    const eligibleSequence = active?.size ? Math.min(...active) : this.sequence + 1;
    const refreshed = !this.disposed && (await this.refresh(tokenId));
    const latest = this.latest.get(tokenId);
    if (!refreshed || this.disposed || !latest || latest.sequence < eligibleSequence) {
      throw new TokenMinimumBlocked("token-minimum-unavailable", null);
    }
    evaluateTokenMinimum(Number.MAX_VALUE, latest.minimum);
    const receipt = Object.freeze({ tokenId, sequence: latest.sequence });
    this.receipts.add(receipt);
    return receipt;
  }

  validate(receipt: TokenMinimumReceipt, tokenId: string, size: number): void {
    const latest = this.latest.get(tokenId);
    if (
      this.disposed ||
      !this.receipts.has(receipt) ||
      receipt.tokenId !== tokenId ||
      !latest ||
      latest.sequence < receipt.sequence
    ) {
      throw new TokenMinimumBlocked("token-minimum-unavailable", null);
    }
    evaluateTokenMinimum(size, latest.minimum);
  }

  consume(receipt: TokenMinimumReceipt): void {
    this.receipts.delete(receipt);
  }
  dispose(): void {
    this.disposed = true;
    this.active.clear();
  }
}

export interface SignedOrderFacts {
  readonly version: 1;
  readonly orderId: string;
  readonly tokenId: string;
  readonly side: OrderSide;
  readonly logicalSize: number;
  readonly shares: number;
}

/** Only exact exchange comparisons use signed shares; reservations remain logical. */
export function exchangeComparisonOrder(order: Order): Order {
  const facts = order.metadata?.signedOrderFactsV1 as SignedOrderFacts | undefined;
  if (
    !facts ||
    facts.version !== 1 ||
    facts.orderId !== String(order.orderId) ||
    facts.tokenId !== String(order.tokenId) ||
    facts.side !== order.side ||
    facts.logicalSize !== order.size ||
    !isKnownTokenMinimum(facts.shares) ||
    facts.shares > order.size
  )
    return order;
  return { ...order, size: facts.shares };
}

export function minimumRetryIdentity(order: Order | PlaceOrderCommand): string {
  return JSON.stringify([
    order.clientOrderId,
    order.tokenId,
    order.conditionId,
    order.side,
    order.positionId ?? null,
    order.size,
    order.price,
    order.orderType,
    order.postOnly === true,
    order.signalId ?? null,
    order.decisionRuleId ?? null,
    order.entryStyle ?? null,
    order.metadata?.makerCaptureRepriceV1 ?? null,
    order.metadata?.bounceAskCaptureRepriceV1 ?? null,
    order.metadata?.bounceRung ?? null,
    order.metadata?.profileLadder ?? null,
  ]);
}

export function hasNeverPostedMinimumEvidence(order: Order): boolean {
  const evidence = order.metadata?.neverPostedMinimumV1 as Record<string, unknown> | undefined;
  return (
    order.status === "rejected" &&
    order.exchangeErrorCode === "INVALID_SIZE" &&
    (order.exchangeErrorMessage === "token-minimum-unavailable" ||
      order.exchangeErrorMessage === "token-minimum-below") &&
    evidence?.version === 1 &&
    evidence.orderId === String(order.orderId) &&
    evidence.identity === minimumRetryIdentity(order) &&
    evidence.originalIdentity === order.metadata?.minimumOriginalIntentV1 &&
    typeof evidence.originalIdentity === "string" &&
    (order.fillProgressShares ?? 0) === 0
  );
}
