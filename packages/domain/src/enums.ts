// ─── Market / Family classification ───────────────────────────────────────────

export const Regime = {
  Threshold: "threshold",
  PriceRange: "price-range",
  DirectionalUpdown: "directional-updown",
  SocialActivity: "social-activity",
  Succession: "succession",
  Geopolitics: "geopolitics",
  Generic: "generic",
  Tournament: "tournament",
  WeatherRange: "weather-range",
} as const;
export type Regime = (typeof Regime)[keyof typeof Regime];

export const StrategyProfile = {
  Scalp: "scalp",
  EventDriven: "event-driven",
  InventoryRecycle: "inventory-recycle",
  OptionalProbe: "optional-probe",
  Restricted: "restricted",
} as const;
export type StrategyProfile = (typeof StrategyProfile)[keyof typeof StrategyProfile];

export const FeeTier = {
  FeeFree: "fee-free",
  FeeEnabled: "fee-enabled",
  Unknown: "unknown",
} as const;
export type FeeTier = (typeof FeeTier)[keyof typeof FeeTier];

export const LiveWalletRequirement = {
  EoaOk: "eoa-ok",
  RelayerRequired: "relayer-required",
} as const;
export type LiveWalletRequirement =
  (typeof LiveWalletRequirement)[keyof typeof LiveWalletRequirement];

export const WalletMode = {
  Eoa: "eoa",
  Relayer: "relayer",
} as const;
export type WalletMode = (typeof WalletMode)[keyof typeof WalletMode];

// ─── Evidence / Promotion ─────────────────────────────────────────────────────

export const EvidenceStatus = {
  Confirmed: "confirmed",
  Partial: "partial",
  Weak: "weak",
  Unknown: "unknown",
} as const;
export type EvidenceStatus = (typeof EvidenceStatus)[keyof typeof EvidenceStatus];

// ─── Entry / exit / scale / session policy enums ─────────────────────────────

export const EntryMode = {
  SprayFirst: "spray-first",
  ProbeFirst: "probe-first",
  ConvictionOnly: "conviction-only",
  Disabled: "disabled",
} as const;
export type EntryMode = (typeof EntryMode)[keyof typeof EntryMode];

export const ExitMode = {
  RepricingSell: "repricing-sell",
  ReduceOnly: "reduce-only",
  Disabled: "disabled",
} as const;
export type ExitMode = (typeof ExitMode)[keyof typeof ExitMode];

export const ScaleMode = {
  ConfirmOnly: "confirm-only",
  Disabled: "disabled",
  AggressiveConfirm: "aggressive-confirm",
} as const;
export type ScaleMode = (typeof ScaleMode)[keyof typeof ScaleMode];

export const SessionMode = {
  ActiveWindow: "active-window",
  Reduced: "reduced",
  AlwaysReduced: "always-reduced",
} as const;
export type SessionMode = (typeof SessionMode)[keyof typeof SessionMode];

export const WeekdayBias = {
  Normal: "normal",
  Preferred: "preferred",
  Required: "required",
} as const;
export type WeekdayBias = (typeof WeekdayBias)[keyof typeof WeekdayBias];

export const ProfitModel = {
  SellIntoStrength: "sell-into-strength",
} as const;
export type ProfitModel = (typeof ProfitModel)[keyof typeof ProfitModel];

// ─── Order ────────────────────────────────────────────────────────────────────

export const OrderSide = {
  Buy: "buy",
  Sell: "sell",
} as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

export const OrderType = {
  Gtc: "GTC",
  Gtd: "GTD",
  Fok: "FOK",
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const TimeInForce = {
  Gtc: "GTC",
  Gtd: "GTD",
  Fok: "FOK",
} as const;
export type TimeInForce = (typeof TimeInForce)[keyof typeof TimeInForce];

// ADR-025 §D-D — `Expired` removed: Polymarket GTC has no built-in
// expiry. The runtime never places FOK; exchange-level expiry from
// FOK rejection (if ever wired) would surface via the reconciler's
// stale-exchange branch and map onto `cancelled`.
export const OrderStatus = {
  Pending: "pending",
  Open: "open",
  PartiallyFilled: "partially-filled",
  Filled: "filled",
  Cancelled: "cancelled",
  Rejected: "rejected",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const LiquidityRole = {
  Maker: "maker",
  Taker: "taker",
  Unknown: "unknown",
} as const;
export type LiquidityRole = (typeof LiquidityRole)[keyof typeof LiquidityRole];

// ─── Position ─────────────────────────────────────────────────────────────────

export const PositionStatus = {
  Open: "open",
  Closed: "closed",
  Dust: "dust",
} as const;
export type PositionStatus = (typeof PositionStatus)[keyof typeof PositionStatus];

// ─── Signal ───────────────────────────────────────────────────────────────────

export const SignalReason = {
  ProbeEntry: "probe-entry",
  ConfirmScale: "confirm-scale",
  ScaleIn: "scale-in",
  HeavyScale: "heavy-scale",
  RepricingExit: "repricing-exit",
  MediumHoldExit: "medium-hold-exit",
  TailPrune: "tail-prune",
  ReduceOnly: "reduce-only",
  DustAutoClose: "dust-auto-close",
  Operator: "operator",
} as const;
export type SignalReason = (typeof SignalReason)[keyof typeof SignalReason];

/** Signal reasons that represent entries (new exposure). */
export const ENTRY_REASONS: ReadonlySet<string> = new Set([
  SignalReason.ProbeEntry,
  SignalReason.ConfirmScale,
  SignalReason.ScaleIn,
  SignalReason.HeavyScale,
]);

/** Signal reasons that represent exits (reducing exposure). */
export const EXIT_REASONS: ReadonlySet<string> = new Set([
  SignalReason.RepricingExit,
  SignalReason.MediumHoldExit,
  SignalReason.TailPrune,
  SignalReason.ReduceOnly,
  SignalReason.DustAutoClose,
]);

// ─── Operator ─────────────────────────────────────────────────────────────────

export const OperatorActionType = {
  Pause: "pause",
  Resume: "resume",
  RulesReload: "rules_reload",
  CancelMakerBuys: "cancel_maker_buys",
  RecoverMissingBounceExit: "recover_missing_bounce_exit",
  ActivatePermanentR23: "activate_permanent_r23",
  DeactivatePermanentR23: "deactivate_permanent_r23",
} as const;
export type OperatorActionType = (typeof OperatorActionType)[keyof typeof OperatorActionType];

export const CommandStatus = {
  Pending: "pending",
  Applied: "applied",
  Rejected: "rejected",
} as const;
export type CommandStatus = (typeof CommandStatus)[keyof typeof CommandStatus];

// ─── Runtime lifecycle ────────────────────────────────────────────────────────

export const RuntimePhase = {
  Initializing: "INITIALIZING",
  Connecting: "CONNECTING",
  Reconciling: "RECONCILING",
  Streaming: "STREAMING",
  Ready: "READY",
  ShuttingDown: "SHUTTING_DOWN",
  Stopped: "STOPPED",
  Error: "ERROR",
} as const;
export type RuntimePhase = (typeof RuntimePhase)[keyof typeof RuntimePhase];

// ─── Exchange error codes ─────────────────────────────────────────────────────

export const ExchangeErrorCode = {
  InsufficientBalance: "INSUFFICIENT_BALANCE",
  InvalidPrice: "INVALID_PRICE",
  InvalidSize: "INVALID_SIZE",
  DuplicateClientOrderId: "DUPLICATE_CLIENT_ORDER_ID",
  OrderNotFound: "ORDER_NOT_FOUND",
  MarketNotFound: "MARKET_NOT_FOUND",
  MarketClosed: "MARKET_CLOSED",
  RateLimited: "RATE_LIMITED",
  NonceError: "NONCE_ERROR",
  NetworkError: "NETWORK_ERROR",
  AuthenticationFailed: "AUTHENTICATION_FAILED",
  RuntimePaused: "RUNTIME_PAUSED",
  LiveLiteAllowlist: "LIVE_LITE_ALLOWLIST",
  LiveLiteOrderCap: "LIVE_LITE_ORDER_CAP",
  LivePolicyBlocked: "LIVE_POLICY_BLOCKED",
  MarketInactive: "MARKET_INACTIVE",
  Unknown: "UNKNOWN",
} as const;
export type ExchangeErrorCode = (typeof ExchangeErrorCode)[keyof typeof ExchangeErrorCode];

// ─── Profile Switching ──────────────────────────────────────────────────

export const ProfileId = {
  Simulation: "simulation",
  Paper: "paper",
  LiveLite: "live-lite",
} as const;
export type ProfileId = (typeof ProfileId)[keyof typeof ProfileId];

export const SUPPORTED_RUNTIME_PROFILE = ProfileId.LiveLite;

export function isSupportedRuntimeProfile(profile: unknown): profile is typeof ProfileId.LiveLite {
  return profile === SUPPORTED_RUNTIME_PROFILE;
}

export function assertSupportedRuntimeProfile(
  profile: string | null | undefined,
): asserts profile is typeof ProfileId.LiveLite {
  if (isSupportedRuntimeProfile(profile)) return;
  throw new Error(
    `UNSUPPORTED_RUNTIME_PROFILE: "${profile ?? "(none)"}". ` +
      `Only "${SUPPORTED_RUNTIME_PROFILE}" can run as a runtime/operator profile. ` +
      "paper/simulation are historical or test-only profiles.",
  );
}

export const DeploymentStage = {
  PaperOnly: "paper-only",
  LiveProbe: "live-probe",
  LiveScaled: "live-scaled",
  Disabled: "disabled",
} as const;
export type DeploymentStage = (typeof DeploymentStage)[keyof typeof DeploymentStage];

export const StrategyStage = {
  ProbeOnly: "probe-only",
  Scaled: "scaled",
} as const;
export type StrategyStage = (typeof StrategyStage)[keyof typeof StrategyStage];

export const OperatorMode = {
  Active: "active",
  ReduceOnly: "reduce-only",
  Quarantine: "quarantine",
  Disabled: "disabled",
} as const;
export type OperatorMode = (typeof OperatorMode)[keyof typeof OperatorMode];

export const SwitchState = {
  Requested: "requested",
  Pausing: "pausing",
  Stopping: "stopping",
  PreparingTarget: "preparing_target",
  StartingTarget: "starting_target",
  ReadyPaused: "ready_paused",
  Completed: "completed",
  Failed: "failed",
  RolledBack: "rolled_back",
} as const;
export type SwitchState = (typeof SwitchState)[keyof typeof SwitchState];

export const PreflightKind = {
  Precheck: "precheck",
  Startup: "startup",
  Resume: "resume",
} as const;
export type PreflightKind = (typeof PreflightKind)[keyof typeof PreflightKind];

export const PreflightStatus = {
  Passed: "passed",
  PassedWithWarnings: "passed_with_warnings",
  Failed: "failed",
} as const;
export type PreflightStatus = (typeof PreflightStatus)[keyof typeof PreflightStatus];

export const RuntimeStatus = {
  Stopped: "stopped",
  Starting: "starting",
  ReadyPaused: "ready_paused",
  Running: "running",
  Stopping: "stopping",
  Failed: "failed",
} as const;
export type RuntimeStatus = (typeof RuntimeStatus)[keyof typeof RuntimeStatus];

export const LedgerResetPolicy = {
  Preserve: "preserve",
  ArchiveReset: "archive-reset",
} as const;
export type LedgerResetPolicy = (typeof LedgerResetPolicy)[keyof typeof LedgerResetPolicy];
