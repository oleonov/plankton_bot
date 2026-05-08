export interface WarnThrottleState {
  lastLoggedAtMs: number | null;
  suppressedCount: number;
}

export function createWarnThrottleState(): WarnThrottleState {
  return { lastLoggedAtMs: null, suppressedCount: 0 };
}

export function consumeWarnThrottle(
  state: WarnThrottleState,
  nowMs: number,
  throttleMs: number,
): number | null {
  if (state.lastLoggedAtMs == null || nowMs - state.lastLoggedAtMs >= throttleMs) {
    const suppressedCount = state.suppressedCount;
    state.lastLoggedAtMs = nowMs;
    state.suppressedCount = 0;
    return suppressedCount;
  }
  state.suppressedCount++;
  return null;
}

export function resetWarnThrottle(state: WarnThrottleState): void {
  state.lastLoggedAtMs = null;
  state.suppressedCount = 0;
}
