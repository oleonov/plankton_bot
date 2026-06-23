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

export class SettlementInfraBreaker {
  private disabledUntilMs = 0;
  private pauseCode: string | null = null;

  constructor(
    private readonly opts: {
      readonly now?: () => number;
      readonly defaultPauseMs?: number;
    } = {},
  ) {}

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
