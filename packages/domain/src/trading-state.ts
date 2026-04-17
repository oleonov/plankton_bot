export type TradingState =
  | "PAUSED"
  | "NO_SIGNALS"
  | "ACTIVELY_TRADING"
  | "EXITS_ONLY"
  | "ALIVE_BUT_BLOCKED";

export interface TradingStateSignalWindow {
  readonly produced: number;
  readonly approved: number;
  readonly rejected: number;
  readonly entryApproved: number;
  readonly exitApproved: number;
}

export function resolveTradingState(opts: {
  readonly paused?: boolean;
  readonly signalWindow: TradingStateSignalWindow | null;
}): TradingState {
  if (opts.paused) return "PAUSED";
  if (!opts.signalWindow) return "NO_SIGNALS";

  const signalWindow = opts.signalWindow;

  if (signalWindow.entryApproved > 0) {
    return "ACTIVELY_TRADING";
  }

  if (
    signalWindow.produced > 0 &&
    signalWindow.exitApproved > 0 &&
    signalWindow.entryApproved === 0
  ) {
    return "EXITS_ONLY";
  }

  if (signalWindow.produced > 0 && signalWindow.rejected > 0 && signalWindow.entryApproved === 0) {
    return "ALIVE_BUT_BLOCKED";
  }

  return "NO_SIGNALS";
}
