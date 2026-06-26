const DEFAULT_RATE_LIMIT_PAUSE_MS = 5 * 60_000;
const SECOND_MS = 1_000;
const SETTLEMENT_INFRA_RATE_LIMIT_PATTERN =
  /(?:\b429\b|rate.?limit|too many requests|throughput limit|quota exceeded|exceeded its compute units)/i;

export interface SettlementInfraPause {
  readonly code: string;
  readonly until: number;
  readonly pauseMs: number;
  readonly upstreamPauseMs: number | null;
}

/**
 * Durable backing store for the breaker's open window. Persisting the
 * until-timestamp lets a restart re-arm the pause instead of clearing it (a
 * fresh process otherwise starts with disabledUntilMs=0 and immediately hammers
 * the still-rate-limited relayer on the startup sweep).
 */
export interface SettlementInfraPauseStore {
  load(): { readonly disabledUntilMs: number; readonly code: string | null } | null;
  save(disabledUntilMs: number, code: string | null): void;
}

export class SettlementInfraBreaker {
  private disabledUntilMs = 0;
  private pauseCode: string | null = null;

  constructor(
    private readonly opts: {
      readonly now?: () => number;
      readonly defaultPauseMs?: number;
      readonly store?: SettlementInfraPauseStore;
    } = {},
  ) {
    const persisted = opts.store?.load();
    const now = opts.now?.() ?? Date.now();
    // Only re-arm if the persisted window is still in the future; an expired
    // window must not keep settlement paused after a restart.
    if (persisted && persisted.disabledUntilMs > now) {
      this.disabledUntilMs = persisted.disabledUntilMs;
      this.pauseCode = persisted.code;
    }
  }

  isOpen(): boolean {
    return this.now() < this.disabledUntilMs;
  }

  current(): SettlementInfraPause | null {
    const now = this.now();
    if (now >= this.disabledUntilMs) return null;
    return {
      code: this.pauseCode ?? "SETTLEMENT_INFRA_PAUSED",
      until: this.disabledUntilMs,
      pauseMs: this.disabledUntilMs - now,
      upstreamPauseMs: null,
    };
  }

  pause(code: string, error?: unknown): SettlementInfraPause {
    const upstreamPauseMs = parseRpcRateLimitResetMs(error);
    const pauseMs = Math.max(
      this.opts.defaultPauseMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS,
      upstreamPauseMs ?? 0,
    );
    const until = this.now() + pauseMs;
    if (until > this.disabledUntilMs) {
      this.disabledUntilMs = until;
      this.pauseCode = code;
      this.opts.store?.save(this.disabledUntilMs, this.pauseCode);
    }
    return {
      code,
      until: this.disabledUntilMs,
      pauseMs,
      upstreamPauseMs,
    };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

export function parseRpcRateLimitResetMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const match = /\bresets?\s+in\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i.exec(message);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds * SECOND_MS);
}

export function isSettlementInfraRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return SETTLEMENT_INFRA_RATE_LIMIT_PATTERN.test(message);
}

/**
 * A redeem the relayer rejected with HTTP 400 `PRECHECK_SKIPPED: redeem skipped:
 * zero position balance` — the read-model believes the position is redeemable but
 * the on-chain outcome-token balance is already zero (phantom / already-redeemed
 * / dust). This is a benign terminal outcome, NOT a settlement failure: there is
 * nothing to redeem, so retrying just burns relayer/RPC calls forever.
 *
 * Intentionally narrow — requires BOTH the `PRECHECK_SKIPPED` marker AND the
 * `zero position balance` reason. Any other PRECHECK_SKIPPED stays a real failure.
 *
 * NOTE: a twin predicate (`isBenignSettlementPrecheckSkip`) lives in
 * packages/exchange/src/live/exchange-gateway.ts for ALERT classification. The
 * duplication is deliberate: @krabs/exchange cannot import from @krabs/runtime,
 * and the two callers sit on opposite sides of that package boundary. The shared
 * knowledge is just two substring markers; keep both in sync.
 */
export function isZeroBalancePrecheckSkipError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return message.includes("precheck_skipped") && message.includes("zero position balance");
}
