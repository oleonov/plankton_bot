import {
  BOUNCE_EXIT_BACKSTOP_RULE_ID,
  BOUNCE_EXIT_TARGET_RULE_ID,
  DEFAULT_BUY_CAPACITY_POLICY,
  DEFAULT_ORDER_CAPACITY_POLICY,
  DEFAULT_SELL_CAPACITY_POLICY,
  S1_LADDER_RULE_ID,
  SignalReason,
  type BuyCapacityPolicy,
  type MakerEntryPolicy,
  type MakerMicroLiveAuthorizationInput,
  type OrderCapacityPolicy,
  type OrderSide,
  type ProfileId,
  type SellCapacityPolicy,
  isMakerCaptureNextR23OrderAuthorized,
  isMakerMicroLiveWindowActive,
} from "@krabs/domain";

const BUDGET_EPSILON_USDC = 1e-9;
const CAPACITY_EPSILON_USDC = 1e-9;
const WALLET_BALANCE_READ_CACHE_TTL_MS = 100;
export const DEFAULT_WALLET_BUFFER_RATIO = 0.03;
export const DEFAULT_MIN_WALLET_BUFFER_USDC = 0.25;
export const WALLET_BUY_CAPACITY_EXHAUSTED_REASON = "wallet_buy_capacity_exhausted";
export const WALLET_SELL_CAPACITY_EXHAUSTED_REASON = "wallet_sell_capacity_exhausted";
export const TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON = "total_orders_capacity_exhausted";
export const PER_TOKEN_BUY_LIMIT_REASON = "per_token_buy_limit";
export const PER_TOKEN_SELL_LIMIT_REASON = "per_token_sell_limit";
const ADD_BUY_SIGNAL_REASONS: ReadonlySet<string> = new Set([
  SignalReason.ConfirmScale,
  SignalReason.ScaleIn,
  SignalReason.HeavyScale,
]);
const RUNTIME_DEFAULT_SELL_CAPACITY_POLICY: SellCapacityPolicy = {
  ...DEFAULT_SELL_CAPACITY_POLICY,
  enabled: DEFAULT_SELL_CAPACITY_POLICY.enabled ?? true,
  mode: DEFAULT_SELL_CAPACITY_POLICY.mode ?? "legacy_global",
  maxOpenSellOrders: DEFAULT_SELL_CAPACITY_POLICY.maxOpenSellOrders ?? 10,
  maxOpenSellOrdersPerToken: DEFAULT_SELL_CAPACITY_POLICY.maxOpenSellOrdersPerToken ?? 2,
  profileLadderLiveRungsPerPosition:
    DEFAULT_SELL_CAPACITY_POLICY.profileLadderLiveRungsPerPosition ?? 2,
  minNonLadderReserve: DEFAULT_SELL_CAPACITY_POLICY.minNonLadderReserve ?? 10,
  nonLadderReserveRatio: DEFAULT_SELL_CAPACITY_POLICY.nonLadderReserveRatio ?? 0.25,
  hardMaxOpenSellOrders: DEFAULT_SELL_CAPACITY_POLICY.hardMaxOpenSellOrders ?? 200,
};

const walletBalanceReadCache = new WeakMap<
  WalletBudgetControlDb,
  Map<string, { readonly readAtMs: number; readonly value: number | null }>
>();

export interface WalletBudgetControlDb {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

export interface WalletBuyBudgetConfig {
  controlDb?: WalletBudgetControlDb | undefined;
  activeProfile?: ProfileId | undefined;
  walletBufferPct?: number | undefined;
  walletBufferMinUsdc?: number | undefined;
}

export interface WalletBuyBudgetSnapshot {
  walletBalanceUsdc: number;
  reservedBuyUsdc: number;
  walletBufferUsdc: number;
  freeUsdcForNewOrders: number;
}

export type BuyCapacityKind = "new-entry" | "add-buy";

export interface WalletBuyCapacityDecision {
  allowed: boolean;
  reason: typeof WALLET_BUY_CAPACITY_EXHAUSTED_REASON | null;
  kind: BuyCapacityKind;
  requiredHeadroomUsdc: number;
  availableAfterOrderUsdc: number | null;
  openBuyOrderCount: number;
  maxOpenBuyOrders: number;
  maxOpenBuyOrdersPerToken: number;
  capacityEnabled: boolean;
}

export interface ProtectedWalletBuyRequirement {
  requiredNotionalUsdc: number;
  exactCaptureNextR23: boolean;
  protectedHeadroomUsdc: number;
}

/** Apply the active capture reserve once, consistently at every BUY budget checkpoint. */
export function resolveProtectedWalletBuyRequirement(args: {
  makerEntry: Pick<MakerEntryPolicy, "mode" | "microMaxOrderUsdc" | "microLiveWindow"> | null;
  authorization: MakerMicroLiveAuthorizationInput | null;
  proposedNotionalUsdc: number;
  pendingBuyNotionalUsdc: number;
  nowMs: number;
}): ProtectedWalletBuyRequirement {
  const activeCapture =
    args.makerEntry?.mode === "micro_live" &&
    args.makerEntry.microLiveWindow?.captureNextR23 === true &&
    isMakerMicroLiveWindowActive(args.makerEntry.microLiveWindow, args.nowMs);
  const exactCaptureNextR23 =
    activeCapture &&
    args.authorization != null &&
    isMakerCaptureNextR23OrderAuthorized(args.makerEntry!, args.authorization, args.nowMs);
  const proposedNotionalUsdc = exactCaptureNextR23
    ? Math.min(args.proposedNotionalUsdc, args.makerEntry!.microMaxOrderUsdc)
    : args.proposedNotionalUsdc;
  const protectedHeadroomUsdc =
    activeCapture && !exactCaptureNextR23 ? args.makerEntry!.microMaxOrderUsdc : 0;
  return {
    requiredNotionalUsdc:
      proposedNotionalUsdc + args.pendingBuyNotionalUsdc + protectedHeadroomUsdc,
    exactCaptureNextR23,
    protectedHeadroomUsdc,
  };
}

export interface WalletSellCapacityDecision {
  allowed: boolean;
  reason: typeof WALLET_SELL_CAPACITY_EXHAUSTED_REASON | null;
  rejectionDetail: SellCapacityRejectReason | null;
  openSellOrderCount: number;
  openProfileLadderSellOrderCount: number;
  openNonProfileLadderSellOrderCount: number;
  maxOpenSellOrders: number;
  maxOpenSellOrdersPerToken: number;
  capacityEnabled: boolean;
  source: SellCapacitySource;
  mode: SellCapacityPolicy["mode"];
  dynamic: DynamicSellCapacityLimits | null;
}

export interface TotalOrdersCapacityDecision {
  allowed: boolean;
  reason: typeof TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON | null;
  openOrdersTotal: number;
  maxOpenOrdersTotal: number;
  capacityEnabled: boolean;
}

export interface PerTokenOrderCapacityDecision {
  allowed: boolean;
  reason: typeof PER_TOKEN_BUY_LIMIT_REASON | typeof PER_TOKEN_SELL_LIMIT_REASON | null;
  side: OrderSide;
  openOrdersForToken: number;
  maxOpenOrdersPerToken: number;
  capacityEnabled: boolean;
}

export interface OrderCapacityMetricsSample {
  source: "risk_gate" | "execution";
  side: OrderSide;
  approved: boolean;
  rejectionReason: string | null;
  sellCapacitySource?: SellCapacitySource | undefined;
  sellCapacityRejectReason?: SellCapacityRejectReason | null | undefined;
  sellCapacityMode?: SellCapacityPolicy["mode"] | undefined;
  profileOwnedOpenPositionCount?: number | undefined;
  profileLadderCapRaw?: number | undefined;
  effectiveProfileLadderCap?: number | undefined;
  nonLadderReserve?: number | undefined;
  dynamicGlobalCap?: number | undefined;
  openProfileLadderSellOrderCount?: number | undefined;
  openNonProfileLadderSellOrderCount?: number | undefined;
  openBuyOrderCount: number;
  openSellOrderCount: number;
  openOrdersTotal: number;
  perTokenOpenBuyOrderCount: number;
  perTokenOpenSellOrderCount: number;
}

export type SellCapacitySource = "profile_ladder" | "D8" | "D7" | "D9" | "S1" | "legacy" | "other";

export type SellCapacityRejectReason =
  | "legacy_global_cap"
  | "profile_ladder_cap"
  | "dynamic_global_cap";

export interface DynamicSellCapacityLimits {
  profileOwnedOpenPositionCount: number;
  profileLadderCapRaw: number;
  nonLadderReserve: number;
  dynamicGlobalCap: number;
  effectiveProfileLadderCap: number;
}

export function readWalletBalanceUsdc(
  controlDb: WalletBudgetControlDb | undefined,
  activeProfile: ProfileId | undefined,
): number | null {
  if (!controlDb || !activeProfile) return null;
  const profileId = String(activeProfile);
  const nowMs = Date.now();
  const dbCache = walletBalanceReadCache.get(controlDb);
  const cached = dbCache?.get(profileId);
  if (cached && nowMs - cached.readAtMs <= WALLET_BALANCE_READ_CACHE_TTL_MS) {
    return cached.value;
  }
  const walletRow = controlDb
    .prepare("SELECT wallet_balance_usdc FROM profile_summaries WHERE profile_id = ?")
    .get(activeProfile) as { wallet_balance_usdc: number | null } | undefined;
  const value = walletRow?.wallet_balance_usdc ?? null;
  const nextDbCache =
    dbCache ?? new Map<string, { readonly readAtMs: number; readonly value: number | null }>();
  nextDbCache.set(profileId, { readAtMs: nowMs, value });
  if (!dbCache) walletBalanceReadCache.set(controlDb, nextDbCache);
  return value;
}

export function getWalletBufferUsdc(
  walletBalanceUsdc: number,
  walletBufferPct = DEFAULT_WALLET_BUFFER_RATIO,
  walletBufferMinUsdc = DEFAULT_MIN_WALLET_BUFFER_USDC,
): number {
  return Math.max(walletBufferMinUsdc, walletBalanceUsdc * walletBufferPct);
}

export function resolveWalletBuyBudget(
  config: WalletBuyBudgetConfig,
  reservedBuyUsdc: number,
): WalletBuyBudgetSnapshot | null {
  const walletBalanceUsdc = readWalletBalanceUsdc(config.controlDb, config.activeProfile);
  if (walletBalanceUsdc == null) return null;

  const walletBufferUsdc = getWalletBufferUsdc(
    walletBalanceUsdc,
    config.walletBufferPct,
    config.walletBufferMinUsdc,
  );

  return {
    walletBalanceUsdc,
    reservedBuyUsdc,
    walletBufferUsdc,
    freeUsdcForNewOrders: walletBalanceUsdc - reservedBuyUsdc - walletBufferUsdc,
  };
}

export function hasWalletBuyBudget(
  snapshot: WalletBuyBudgetSnapshot | null,
  requiredNotionalUsdc: number,
): boolean {
  if (snapshot == null) return true;
  return snapshot.freeUsdcForNewOrders + BUDGET_EPSILON_USDC >= requiredNotionalUsdc;
}

export function classifyBuyCapacityKind(signalReason: string | null | undefined): BuyCapacityKind {
  return signalReason != null && ADD_BUY_SIGNAL_REASONS.has(signalReason) ? "add-buy" : "new-entry";
}

export function evaluateWalletBuyCapacity(args: {
  policy: BuyCapacityPolicy | null | undefined;
  snapshot: WalletBuyBudgetSnapshot | null;
  requiredNotionalUsdc: number;
  signalReason: string | null | undefined;
  openBuyOrderCount: number;
}): WalletBuyCapacityDecision {
  const policy = normalizeBuyCapacityPolicy(args.policy);
  const kind = classifyBuyCapacityKind(args.signalReason);
  const requiredHeadroomUsdc =
    kind === "new-entry" ? policy.minNewEntryWalletHeadroomUsdc : policy.minAddWalletHeadroomUsdc;
  const base = {
    kind,
    requiredHeadroomUsdc,
    openBuyOrderCount: args.openBuyOrderCount,
    maxOpenBuyOrders: policy.maxOpenBuyOrders,
    maxOpenBuyOrdersPerToken: policy.maxOpenBuyOrdersPerToken,
    capacityEnabled: policy.enabled,
  };

  if (!policy.enabled) {
    return { ...base, allowed: true, reason: null, availableAfterOrderUsdc: null };
  }

  if (policy.maxOpenBuyOrders > 0 && args.openBuyOrderCount >= policy.maxOpenBuyOrders) {
    return {
      ...base,
      allowed: false,
      reason: WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
      availableAfterOrderUsdc: null,
    };
  }

  if (args.snapshot == null) {
    return { ...base, allowed: true, reason: null, availableAfterOrderUsdc: null };
  }

  const availableAfterOrderUsdc =
    args.snapshot.walletBalanceUsdc -
    args.snapshot.reservedBuyUsdc -
    args.snapshot.walletBufferUsdc -
    args.requiredNotionalUsdc;
  const allowed = availableAfterOrderUsdc > requiredHeadroomUsdc + CAPACITY_EPSILON_USDC;
  return {
    ...base,
    allowed,
    reason: allowed ? null : WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
    availableAfterOrderUsdc,
  };
}

/**
 * DIAGNOSTIC-only (status/dashboard): whether new entries are EFFECTIVELY blocked. True when the entry
 * is hard-blocked (`!hardAllowed` — open-BUY-order limit reached or wallet dry) OR the deployable
 * `newEntryCapacityUsdc` (free − reserve) is below the minimum viable entry notional. A `null` capacity
 * (walletBudget/diagnostics unavailable) is NOT treated as blocked (unknown ≠ blocked). This never
 * gates trading — the real entry gate uses `evaluateWalletBuyCapacity` with the true order notional.
 */
export function resolveEntriesBlocked(args: {
  hardAllowed: boolean;
  newEntryCapacityUsdc: number | null;
  minViableEntryUsdc: number;
}): boolean {
  if (!args.hardAllowed) return true;
  return (
    args.newEntryCapacityUsdc != null &&
    Number.isFinite(args.newEntryCapacityUsdc) &&
    args.newEntryCapacityUsdc < args.minViableEntryUsdc
  );
}

export function normalizeBuyCapacityPolicy(
  policy: BuyCapacityPolicy | null | undefined,
): BuyCapacityPolicy {
  if (policy == null) {
    return { ...DEFAULT_BUY_CAPACITY_POLICY, enabled: false };
  }
  return {
    ...DEFAULT_BUY_CAPACITY_POLICY,
    ...policy,
  };
}

export function evaluateWalletSellCapacity(args: {
  policy: SellCapacityPolicy | null | undefined;
  openSellOrderCount: number;
  source?: SellCapacitySource | undefined;
  openProfileLadderSellOrderCount?: number | undefined;
  openNonProfileLadderSellOrderCount?: number | undefined;
  profileOwnedOpenPositionCount?: number | undefined;
}): WalletSellCapacityDecision {
  const policy = normalizeSellCapacityPolicy(args.policy);
  const source = args.source ?? "other";
  const dynamic =
    policy.mode === "source_aware_dynamic"
      ? computeDynamicSellCapacityLimits({
          policy,
          profileOwnedOpenPositionCount: args.profileOwnedOpenPositionCount ?? 0,
        })
      : null;
  const maxOpenSellOrders = dynamic?.dynamicGlobalCap ?? policy.maxOpenSellOrders;
  const base = {
    openSellOrderCount: args.openSellOrderCount,
    openProfileLadderSellOrderCount: args.openProfileLadderSellOrderCount ?? 0,
    openNonProfileLadderSellOrderCount: args.openNonProfileLadderSellOrderCount ?? 0,
    maxOpenSellOrders,
    maxOpenSellOrdersPerToken: policy.maxOpenSellOrdersPerToken,
    capacityEnabled: policy.enabled,
    source,
    mode: policy.mode,
    dynamic,
  };

  if (!policy.enabled) {
    return { ...base, allowed: true, reason: null, rejectionDetail: null };
  }

  if (policy.mode === "legacy_global") {
    if (policy.maxOpenSellOrders > 0 && args.openSellOrderCount >= policy.maxOpenSellOrders) {
      return {
        ...base,
        allowed: false,
        reason: WALLET_SELL_CAPACITY_EXHAUSTED_REASON,
        rejectionDetail: "legacy_global_cap",
      };
    }
    return { ...base, allowed: true, reason: null, rejectionDetail: null };
  }

  if (dynamic && args.openSellOrderCount >= dynamic.dynamicGlobalCap) {
    return {
      ...base,
      allowed: false,
      reason: WALLET_SELL_CAPACITY_EXHAUSTED_REASON,
      rejectionDetail: "dynamic_global_cap",
    };
  }

  if (
    source === "profile_ladder" &&
    dynamic &&
    (args.openProfileLadderSellOrderCount ?? 0) >= dynamic.effectiveProfileLadderCap
  ) {
    return {
      ...base,
      allowed: false,
      reason: WALLET_SELL_CAPACITY_EXHAUSTED_REASON,
      rejectionDetail: "profile_ladder_cap",
    };
  }

  return { ...base, allowed: true, reason: null, rejectionDetail: null };
}

export function computeDynamicSellCapacityLimits(args: {
  policy: SellCapacityPolicy;
  profileOwnedOpenPositionCount: number;
}): DynamicSellCapacityLimits {
  const profileOwnedOpenPositionCount = nonNegativeInt(args.profileOwnedOpenPositionCount);
  const profileLadderCapRaw =
    profileOwnedOpenPositionCount * nonNegativeInt(args.policy.profileLadderLiveRungsPerPosition);
  const nonLadderReserve = Math.max(
    nonNegativeInt(args.policy.minNonLadderReserve),
    Math.ceil(profileLadderCapRaw * nonNegativeNumber(args.policy.nonLadderReserveRatio)),
  );
  const dynamicGlobalCap = Math.min(
    profileLadderCapRaw + nonLadderReserve,
    Math.max(1, nonNegativeInt(args.policy.hardMaxOpenSellOrders)),
  );
  const effectiveProfileLadderCap = Math.min(
    profileLadderCapRaw,
    Math.max(0, dynamicGlobalCap - nonLadderReserve),
  );
  return {
    profileOwnedOpenPositionCount,
    profileLadderCapRaw,
    nonLadderReserve,
    dynamicGlobalCap,
    effectiveProfileLadderCap,
  };
}

export function classifySellCapacitySource(input: {
  decisionRuleId?: string | null | undefined;
  signalReason?: string | null | undefined;
  metadata?: Readonly<Record<string, unknown>> | null | undefined;
}): SellCapacitySource {
  const metadataSource =
    typeof input.metadata?.source === "string" ? input.metadata.source.toLowerCase() : null;
  const decisionRuleId = input.decisionRuleId ?? "";
  const upperRule = decisionRuleId.toUpperCase();
  if (decisionRuleId === "PROFILE_LADDER" || metadataSource === "profile_ladder") {
    return "profile_ladder";
  }
  if (upperRule.includes("D8")) return "D8";
  if (upperRule.includes("D7")) return "D7";
  if (upperRule.includes("D9")) return "D9";
  if (decisionRuleId === S1_LADDER_RULE_ID || metadataSource === "track_s1") return "S1";
  if (metadataSource === "legacy") return "legacy";
  return "other";
}

export function evaluateTotalOrdersCapacity(args: {
  policy: OrderCapacityPolicy | null | undefined;
  openOrdersTotal: number;
}): TotalOrdersCapacityDecision {
  const policy = normalizeOrderCapacityPolicy(args.policy);
  const base = {
    openOrdersTotal: args.openOrdersTotal,
    maxOpenOrdersTotal: policy.maxOpenOrdersTotal,
    capacityEnabled: policy.enabled,
  };

  if (
    policy.enabled &&
    policy.maxOpenOrdersTotal > 0 &&
    args.openOrdersTotal >= policy.maxOpenOrdersTotal
  ) {
    return { ...base, allowed: false, reason: TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON };
  }
  return { ...base, allowed: true, reason: null };
}

export function evaluatePerTokenOrderCapacity(args: {
  side: OrderSide;
  maxOpenOrdersPerToken: number;
  openOrdersForToken: number;
  enabled?: boolean | undefined;
}): PerTokenOrderCapacityDecision {
  const enabled = args.enabled ?? true;
  const reason = args.side === "buy" ? PER_TOKEN_BUY_LIMIT_REASON : PER_TOKEN_SELL_LIMIT_REASON;
  const base = {
    side: args.side,
    openOrdersForToken: args.openOrdersForToken,
    maxOpenOrdersPerToken: args.maxOpenOrdersPerToken,
    capacityEnabled: enabled,
  };

  if (
    enabled &&
    args.maxOpenOrdersPerToken > 0 &&
    args.openOrdersForToken >= args.maxOpenOrdersPerToken
  ) {
    return { ...base, allowed: false, reason };
  }
  return { ...base, allowed: true, reason: null };
}

/**
 * Per-decisionRuleId per-token SELL cap override (docs/plans/2026-07-16-
 * bounce-exit-ladder-redesign.md REV3 R2-M: "SELL capacity is enforced in
 * TWO places" — algo-risk-gate.ts before the bridge and execution-module.ts
 * at submission — so this lives here, shared, rather than duplicated.
 * Mirrors the pre-existing S1-ladder carve-out (S1 gets its own
 * `s1MaxOrdersPerToken`): a GATE-lane bounce-exit rung/backstop must not trip
 * the generic per-token cap (default 2) once more than 2 ladder rungs are
 * configured to rest simultaneously — `Math.max` only ever raises the cap
 * for this decision rule, never lowers the generic policy for anyone else.
 */
export function resolveEffectiveMaxOpenSellOrdersPerToken(args: {
  decisionRuleId: string | null | undefined;
  sellPolicy: Pick<SellCapacityPolicy, "maxOpenSellOrdersPerToken">;
  s1MaxOrdersPerToken?: number | undefined;
  bounceLadderRungCount?: number | undefined;
}): number {
  if (args.decisionRuleId === S1_LADDER_RULE_ID) {
    return args.s1MaxOrdersPerToken ?? args.sellPolicy.maxOpenSellOrdersPerToken;
  }
  if (
    args.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID ||
    args.decisionRuleId === BOUNCE_EXIT_BACKSTOP_RULE_ID
  ) {
    return Math.max(args.sellPolicy.maxOpenSellOrdersPerToken, args.bounceLadderRungCount ?? 0);
  }
  return args.sellPolicy.maxOpenSellOrdersPerToken;
}

export function normalizeSellCapacityPolicy(
  policy: SellCapacityPolicy | null | undefined,
): SellCapacityPolicy {
  if (policy == null) {
    return { ...RUNTIME_DEFAULT_SELL_CAPACITY_POLICY, enabled: false };
  }
  return {
    ...RUNTIME_DEFAULT_SELL_CAPACITY_POLICY,
    ...policy,
    mode: policy.mode ?? RUNTIME_DEFAULT_SELL_CAPACITY_POLICY.mode,
    profileLadderLiveRungsPerPosition:
      policy.profileLadderLiveRungsPerPosition ??
      RUNTIME_DEFAULT_SELL_CAPACITY_POLICY.profileLadderLiveRungsPerPosition,
    minNonLadderReserve:
      policy.minNonLadderReserve ?? RUNTIME_DEFAULT_SELL_CAPACITY_POLICY.minNonLadderReserve,
    nonLadderReserveRatio:
      policy.nonLadderReserveRatio ?? RUNTIME_DEFAULT_SELL_CAPACITY_POLICY.nonLadderReserveRatio,
    hardMaxOpenSellOrders:
      policy.hardMaxOpenSellOrders ?? RUNTIME_DEFAULT_SELL_CAPACITY_POLICY.hardMaxOpenSellOrders,
  };
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function nonNegativeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function normalizeOrderCapacityPolicy(
  policy: OrderCapacityPolicy | null | undefined,
): OrderCapacityPolicy {
  if (policy == null) {
    return { ...DEFAULT_ORDER_CAPACITY_POLICY, enabled: false };
  }
  return {
    ...DEFAULT_ORDER_CAPACITY_POLICY,
    ...policy,
  };
}
