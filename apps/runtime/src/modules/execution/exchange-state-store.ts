/**
 * ExchangeStateStore — shared in-memory facade between Reconciliation and
 * Execution. The reconciliation module pushes the freshest "what the exchange
 * thinks we have" snapshot (open SELL orders + wallet share size). Execution
 * reads it on every SELL clamp/reservation evaluation to avoid the
 * "balance is not enough" race seen in production: local DB shows shares the
 * wallet does not actually hold, or `reservedSell` ignores exchange-side
 * orders that survived a process restart.
 *
 * Also stores transient per-token SELL blocks triggered by exchange
 * "balance/allowance" rejections so the bot stops bombarding the gateway with
 * the same doomed orders before the next reconciliation pass refreshes state.
 *
 * No DB writes — purely process-local; the next reconciliation tick is the
 * source of truth.
 */
import type { TokenId } from "@krabs/domain";

export interface ExchangeOpenSellSummary {
  /** Sum of exchange `sizeRemaining` across open SELL orders for the token. */
  readonly openSellSize: number;
  /** Number of open SELL orders the exchange reports for the token. */
  readonly openSellCount: number;
  /** Per-order remaining-size view, keyed by exchange orderId. */
  readonly orders: ReadonlyMap<string, number>;
  /** When this snapshot was captured (epoch ms). */
  readonly capturedAtMs: number;
}

export interface WalletPositionSnapshot {
  readonly size: number;
  readonly capturedAtMs: number;
}

export interface BalanceRejectBlock {
  readonly blockedUntilMs: number;
  readonly firstRejectAtMs: number;
  readonly count: number;
}

export interface ExchangeStateStoreMetrics {
  /** Sum |localOpenSellSize - exchangeOpenSellSize| across tokens with snapshots. */
  readonly reservedSellDriftAbs: number;
  /** Sum |localPositionSize - walletSize| across tokens with snapshots. */
  readonly walletPositionDriftAbs: number;
  /** Total `balance is not enough` rejects observed since process start. */
  readonly balanceRejectCountTotal: number;
  /** Most recent captured-at across exchange-orders snapshots (epoch ms) or null. */
  readonly latestExchangeOrdersCaptureMs: number | null;
  /** Most recent captured-at across wallet-position snapshots (epoch ms) or null. */
  readonly latestWalletCaptureMs: number | null;
}

export interface ExchangeStateStoreOptions {
  /** How long a balance-reject block lasts. Default 60s. */
  readonly balanceRejectBlockMs?: number;
  /** Beyond this age a snapshot is considered stale and ignored. Default 5 min. */
  readonly snapshotMaxAgeMs?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

const DEFAULT_BALANCE_REJECT_BLOCK_MS = 60_000;
const DEFAULT_SNAPSHOT_MAX_AGE_MS = 5 * 60_000;

export class ExchangeStateStore {
  private readonly openSellByToken = new Map<string, ExchangeOpenSellSummary>();
  private readonly walletByToken = new Map<string, WalletPositionSnapshot>();
  private readonly balanceBlocks = new Map<string, BalanceRejectBlock>();
  private balanceRejectCountTotal = 0;
  private readonly balanceRejectBlockMs: number;
  private readonly snapshotMaxAgeMs: number;
  private readonly now: () => number;
  private lastExchangeOrdersCaptureMs: number | null = null;
  private lastWalletCaptureMs: number | null = null;

  constructor(opts: ExchangeStateStoreOptions = {}) {
    this.balanceRejectBlockMs = opts.balanceRejectBlockMs ?? DEFAULT_BALANCE_REJECT_BLOCK_MS;
    this.snapshotMaxAgeMs = opts.snapshotMaxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Push a fresh exchange-orders snapshot. Replaces all per-token entries —
   * tokens absent from the input are cleared so a fully-cancelled token does
   * not retain a stale reservation. Per-order remaining sizes are retained
   * keyed by exchange orderId so callers can compute a conservative union
   * against locally-known order IDs.
   */
  updateExchangeSellOrders(
    summaries: Iterable<{
      readonly orderId: string;
      readonly tokenId: TokenId | string;
      readonly sizeRemaining: number;
    }>,
    capturedAtMs: number = this.now(),
  ): void {
    const next = new Map<
      string,
      { openSellSize: number; openSellCount: number; orders: Map<string, number> }
    >();
    for (const row of summaries) {
      if (!Number.isFinite(row.sizeRemaining) || row.sizeRemaining <= 0) continue;
      const key = String(row.tokenId);
      const acc = next.get(key) ?? {
        openSellSize: 0,
        openSellCount: 0,
        orders: new Map<string, number>(),
      };
      acc.openSellSize += row.sizeRemaining;
      acc.openSellCount += 1;
      // If the snapshot somehow contains duplicate orderIds for a token, sum
      // them rather than overwrite — exchange-side truth always grows here.
      const prev = acc.orders.get(row.orderId) ?? 0;
      acc.orders.set(row.orderId, prev + row.sizeRemaining);
      next.set(key, acc);
    }
    this.openSellByToken.clear();
    for (const [key, acc] of next) {
      this.openSellByToken.set(key, { ...acc, capturedAtMs });
    }
    this.lastExchangeOrdersCaptureMs = capturedAtMs;
  }

  /** Replace the wallet snapshot for a single token. */
  updateWalletPosition(
    tokenId: TokenId | string,
    size: number,
    capturedAtMs: number = this.now(),
  ): void {
    if (!Number.isFinite(size) || size < 0) return;
    this.walletByToken.set(String(tokenId), { size, capturedAtMs });
    this.lastWalletCaptureMs = capturedAtMs;
  }

  /**
   * Replace the wallet snapshots in bulk. Tokens absent from the input keep
   * their previous entry — the wallet sentinel does not always re-iterate
   * every token, so we must not erase a still-valid snapshot just because the
   * pass produced no row for it.
   */
  updateWalletPositionsBatch(
    rows: Iterable<{ readonly tokenId: TokenId | string; readonly size: number }>,
    capturedAtMs: number = this.now(),
  ): void {
    for (const row of rows) {
      this.updateWalletPosition(row.tokenId, row.size, capturedAtMs);
    }
  }

  /**
   * Returns the exchange-side open SELL size for a token, or null if no fresh
   * snapshot is available. Callers should fall back to local order state when
   * null.
   */
  getOpenSellSizeForToken(tokenId: TokenId | string): number | null {
    const entry = this.openSellByToken.get(String(tokenId));
    if (!entry) return null;
    if (this.now() - entry.capturedAtMs > this.snapshotMaxAgeMs) return null;
    return entry.openSellSize;
  }

  /**
   * Sum of exchange `sizeRemaining` for SELL orders the local DB does NOT
   * recognise (i.e. not in `knownLocalExchangeOrderIds`). This is the
   * conservative complement to local-only reservation: total reserved exposure
   * = localOpenSellSum + thisValue, which correctly handles in-flight local
   * orders that haven't yet propagated to the exchange snapshot.
   */
  getOpenSellSizeUnknownToLocal(
    tokenId: TokenId | string,
    knownLocalExchangeOrderIds: ReadonlySet<string>,
  ): number | null {
    const entry = this.openSellByToken.get(String(tokenId));
    if (!entry) return null;
    if (this.now() - entry.capturedAtMs > this.snapshotMaxAgeMs) return null;
    let sum = 0;
    for (const [orderId, sizeRemaining] of entry.orders) {
      if (knownLocalExchangeOrderIds.has(orderId)) continue;
      sum += sizeRemaining;
    }
    return sum;
  }

  /** True when an exchange-orders snapshot has been pushed at least once. */
  hasExchangeOrdersSnapshot(): boolean {
    return this.lastExchangeOrdersCaptureMs !== null;
  }

  /** Returns the wallet share size or null if no fresh snapshot is available. */
  getWalletPositionSize(tokenId: TokenId | string): number | null {
    const entry = this.walletByToken.get(String(tokenId));
    if (!entry) return null;
    if (this.now() - entry.capturedAtMs > this.snapshotMaxAgeMs) return null;
    return entry.size;
  }

  /**
   * Epoch ms of the wallet snapshot for the token, or null when no snapshot
   * exists OR the snapshot is older than `snapshotMaxAgeMs`. Mirrors the
   * staleness contract of `getWalletPositionSize` so callers cannot
   * accidentally compare a fresh fill against an ancient wallet timestamp.
   */
  getWalletPositionCapturedAt(tokenId: TokenId | string): number | null {
    const entry = this.walletByToken.get(String(tokenId));
    if (!entry) return null;
    if (this.now() - entry.capturedAtMs > this.snapshotMaxAgeMs) return null;
    return entry.capturedAtMs;
  }

  /** Mark a token as blocked from new SELLs for the configured TTL. */
  markBalanceReject(tokenId: TokenId | string): BalanceRejectBlock {
    const now = this.now();
    const existing = this.balanceBlocks.get(String(tokenId));
    const block: BalanceRejectBlock = {
      blockedUntilMs: now + this.balanceRejectBlockMs,
      firstRejectAtMs: existing?.firstRejectAtMs ?? now,
      count: (existing?.count ?? 0) + 1,
    };
    this.balanceBlocks.set(String(tokenId), block);
    this.balanceRejectCountTotal += 1;
    return block;
  }

  /** True iff the token is currently in a balance-reject cooldown window. */
  isBalanceBlocked(tokenId: TokenId | string): boolean {
    const block = this.balanceBlocks.get(String(tokenId));
    if (!block) return false;
    if (this.now() >= block.blockedUntilMs) {
      this.balanceBlocks.delete(String(tokenId));
      return false;
    }
    return true;
  }

  /** Returns the block entry if active (after lazy expiry sweep). */
  getBalanceBlock(tokenId: TokenId | string): BalanceRejectBlock | null {
    const block = this.balanceBlocks.get(String(tokenId));
    if (!block) return null;
    if (this.now() >= block.blockedUntilMs) {
      this.balanceBlocks.delete(String(tokenId));
      return null;
    }
    return block;
  }

  clearBalanceBlock(tokenId: TokenId | string): void {
    this.balanceBlocks.delete(String(tokenId));
  }

  /**
   * Aggregate drift metrics. The store does not see local state directly;
   * the caller (reconciliation) supplies the local sums it just computed.
   */
  computeMetrics(input: {
    readonly localOpenSellSizeByToken: ReadonlyMap<string, number>;
    readonly localPositionSizeByToken: ReadonlyMap<string, number>;
  }): ExchangeStateStoreMetrics {
    let reservedSellDriftAbs = 0;
    for (const [tokenKey, entry] of this.openSellByToken) {
      const local = input.localOpenSellSizeByToken.get(tokenKey) ?? 0;
      reservedSellDriftAbs += Math.abs(local - entry.openSellSize);
    }
    for (const [tokenKey, local] of input.localOpenSellSizeByToken) {
      if (this.openSellByToken.has(tokenKey)) continue;
      reservedSellDriftAbs += Math.abs(local);
    }
    let walletPositionDriftAbs = 0;
    for (const [tokenKey, entry] of this.walletByToken) {
      const local = input.localPositionSizeByToken.get(tokenKey) ?? 0;
      walletPositionDriftAbs += Math.abs(local - entry.size);
    }
    for (const [tokenKey, local] of input.localPositionSizeByToken) {
      if (this.walletByToken.has(tokenKey)) continue;
      walletPositionDriftAbs += Math.abs(local);
    }
    return {
      reservedSellDriftAbs,
      walletPositionDriftAbs,
      balanceRejectCountTotal: this.balanceRejectCountTotal,
      latestExchangeOrdersCaptureMs: this.lastExchangeOrdersCaptureMs,
      latestWalletCaptureMs: this.lastWalletCaptureMs,
    };
  }
}

/**
 * Compute the upper-bound clamp for available SELL size on a single token.
 *
 * Returns `min(localSize, walletSize)` when the wallet snapshot is newer than
 * any fill, treating the exchange as the source of truth.
 *
 * When the wallet snapshot is older than the most recent fill, the wallet
 * number is stale (a fresh fill grew the local position beyond what the
 * sentinel has seen). In that case we fall back to `localSize` — never to
 * unbounded, otherwise the SELL clamp would silently allow an order larger
 * than the local position thinks we hold.
 *
 * Also falls back to `localSize` when there is no wallet snapshot at all —
 * the legacy behaviour, preserved so simulation/paper modes (no sentinel)
 * keep working.
 */
export function computeSellUpperBound(input: {
  readonly localPositionSize: number;
  readonly walletPositionSize: number | null;
  readonly walletCapturedAtMs: number | null;
  readonly latestFillMs: number | null;
}): number {
  const local = Number.isFinite(input.localPositionSize) ? Math.max(0, input.localPositionSize) : 0;
  if (input.walletPositionSize === null || input.walletCapturedAtMs === null) {
    return local;
  }
  if (input.latestFillMs !== null && input.latestFillMs > input.walletCapturedAtMs) {
    return local;
  }
  return Math.min(local, Math.max(0, input.walletPositionSize));
}

/**
 * Sniffs the human-readable error payload returned by the Polymarket relayer
 * when a SELL is rejected for wallet balance/allowance shortfall. The relayer
 * is the source of the "not enough balance / allowance" phrasing; gateways
 * surface it via `errorMessage` or `errorDetails.responseBody.error`.
 */
export function isExchangeBalanceRejection(input: {
  readonly errorMessage: string | null | undefined;
  readonly errorDetails: Readonly<Record<string, unknown>> | null | undefined;
}): boolean {
  const candidates: string[] = [];
  if (typeof input.errorMessage === "string") candidates.push(input.errorMessage);
  const body = input.errorDetails?.["responseBody"];
  if (typeof body === "string") candidates.push(body);
  else if (body && typeof body === "object") {
    const err = (body as Record<string, unknown>).error;
    if (typeof err === "string") candidates.push(err);
    const message = (body as Record<string, unknown>).message;
    if (typeof message === "string") candidates.push(message);
  }
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (lower.includes("not enough balance") || lower.includes("not enough allowance")) {
      return true;
    }
    if (lower.includes("insufficient balance") || lower.includes("insufficient allowance")) {
      return true;
    }
    if (lower.includes("balance") && lower.includes("allowance")) {
      return true;
    }
  }
  return false;
}
