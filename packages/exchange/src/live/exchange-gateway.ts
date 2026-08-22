/**
 * Live ExchangeGateway — wraps @polymarket/clob-client-v2 for order lifecycle.
 *
 * The SDK ClobClient is accepted as `unknown` in the public config interface
 * to prevent SDK types from leaking into @krabs/domain consumers.
 */

import { getContractConfig } from "@polymarket/clob-client-v2";
import type {
  ExchangeGateway,
  PlaceOrderParams,
  CancelOrderParams,
  PlaceOrderResult,
  CancelOrderResult,
  ExchangeOrder,
  ExchangeFill,
  ExchangeBalance,
  MarketFeeInfo,
  MarketFeeInfoDiagnostic,
  MarketFeeInfoResult,
  RedeemPositionsResult,
  RedeemPositionsOptions,
  TokenId,
  ExchangeUserEventStream,
  ExchangeUserOrderEvent,
  ExchangeUserTradeEvent,
  DepositActivationResult,
  PreparedOrder,
  PreparedOrderSubmitResult,
} from "@krabs/domain";
import { encodeFunctionData, parseAbi, zeroHash } from "viem";
import { classifyError } from "../errors.js";
import { executeWithRetry, type RetryDiagnosticLogger } from "../retry-helper.js";
import { classifyFetchError } from "../clob-error-classifier.js";
import { FetchParseError, type FetchResult } from "../fetch-result.js";
import { redactSensitive, sanitizeLogArg } from "../redaction.js";
import {
  mapOpenOrder,
  mapExactOrder,
  mapTrade,
  mapTradeToPersonalFills,
  mapBalance,
  toSdkSide,
  toSdkTickSize,
  ATOMIC_UNIT_DIVISOR,
} from "../mappers.js";
import {
  LiveUserEventStream,
  type UserEventStreamAuth,
  type UserEventWebSocketLike,
} from "./user-event-stream.js";
import type { CollateralResolver } from "./collateral-resolver.js";
import {
  ACTIVATION_ASSETS,
  ERC20_APPROVE_ABI,
  PUSD_WRAP_ABI,
  PUSD_WRAPPER_ADDRESS,
} from "./pusd-wrapper.js";
import { readErc20Balance, readErc20Allowance } from "./usdc-balance-reader.js";
import type { RpcRotator } from "./rpc-rotation.js";
import type { DepHealthRecorder } from "@krabs/domain";
import { timeDepCall, fetchResultOk } from "../dep-health.js";
import { hashSignedOrderV2 } from "./order-hash.js";

export interface LiveExchangeConfig {
  /** ClobClient instance — typed as unknown to avoid SDK type leakage. */
  client: unknown;
  /** Optional relayer settlement client for on-chain redeem/merge actions. */
  settlementClient?: unknown;
  /** Wallet/funder address used to extract personal fills from trade rows. */
  traderAddress?: string | null;
  userWsAuth?: UserEventStreamAuth | null;
  createWebSocket?: ((url: string) => UserEventWebSocketLike) | undefined;
  /**
   * Resolves the actual collateral token (USDC vs pUSD) used by a CTF market,
   * looked up by matching `getPositionId(candidate, collectionId)` against the
   * canonical CLOB tokenId. Required for production redeem/merge correctness —
   * @polymarket/clob-client-v2.getContractConfig always returns pUSD but a
   * significant share of legacy positions remain USDC-collateralised. If absent,
   * the gateway falls back to `contracts.collateral` and emits a warning per
   * conditionId so the gap is observable.
   */
  collateralResolver?: CollateralResolver | undefined;
  /** Optional callback used to surface infra-level settlement issues to runtime/UI. */
  onInfraAlert?:
    | ((alert: {
        code: string;
        severity: "warning" | "error";
        source: string;
        message: string;
        details?: Record<string, unknown> | undefined;
      }) => void)
    | undefined;
  /** Shared read-path RPC rotator used for on-chain balance reads and the pUSD activation flow. */
  rpcRotator?: RpcRotator | null;
  /** Optional Phase-2 dependency-latency recorder (measure-only; no-op when absent). */
  depHealthRecorder?: DepHealthRecorder | null;
  /** Test-only override for the relayer settlement submit lane backstop. */
  __settlementLaneBackstopMs?: number;
  /** Test-only override for the relayer settlement submit lane task watchdog. */
  __settlementLaneTaskTimeoutMs?: number;
  /** Override for balance reads — for testing without a live RPC. */
  __readErc20Balance?: typeof readErc20Balance;
  /** Override for allowance reads — for testing without a live RPC. */
  __readErc20Allowance?: typeof readErc20Allowance;
  /**
   * Retry policy for the reliable read paths (`getOpenOrdersResult`/`getFillsResult`).
   * Only those Result-returning methods retry; the legacy `getOpenOrders`/`getFills`
   * keep their single-shot `catch → []` behavior. `sleep` is injectable for tests.
   */
  fetchRetry?: {
    retries?: number;
    backoffMs?: number[];
    sleep?: (ms: number) => Promise<void>;
    /** Diagnostic sink for `unknown`-classified fetch errors (#36 LOW 2). */
    log?: RetryDiagnosticLogger | undefined;
  };
}

const CTF_REDEEM_ABI = parseAbi([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
]);
const CTF_MERGE_ABI = parseAbi([
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 amount)",
]);
const NEG_RISK_REDEEM_ABI = parseAbi([
  "function redeemPositions(bytes32 _conditionId, uint256[] _amounts)",
]);
const RECENT_SETTLEMENT_SUBMISSION_TTL_MS = 10 * 60 * 1000;
const SETTLEMENT_CONFIRM_WAIT_TIMEOUT_MS = 15 * 1000;
const SETTLEMENT_SUBMIT_LANE_BACKSTOP_MS = 60_000;
const SETTLEMENT_SUBMIT_LANE_TASK_TIMEOUT_MS = 90_000;
// Polymarket relayer validates the `metadata` field server-side and rejects
// free-form strings (colon, spaces, hex digests) with 400 `invalid metadata
// field`. Use short alphanumeric slugs — the relayer accepts these and the
// per-request conditionIds are already captured via logSettlementLifecycle.
const RELAYER_METADATA_REDEEM = "redeem";
const RELAYER_METADATA_MERGE = "merge";
const RELAYER_METADATA_ACTIVATE_FUNDS = "activatefunds";

type SettlementTransaction = {
  to: string;
  data: `0x${string}`;
  value: string;
};

type SettlementRequest = {
  conditionId: string;
  tx: SettlementTransaction;
  /** Phase 1.A REDEEM instrumentation — per-outcome-token balances read at build time. */
  precheckTokenIds?: readonly string[];
  /** Phase 1.A REDEEM instrumentation — decimal strings to preserve bigint precision in logs. */
  precheckBalances?: readonly string[];
};

type SettlementTxMetadata = {
  txHash: string | null;
  gasUsed: number | null;
};

type SettlementSubmitOperation = "redeem" | "merge" | "activation";

type SettlementLaneRelease =
  | "released_confirmed"
  | "released_ttl"
  | "released_watchdog"
  | "released_error";

type SettlementLaneTaskResult<T> = {
  value: T;
  release: SettlementLaneRelease;
};

type MarketTokenEntry = {
  readonly tokenId: string;
  readonly index: number;
};

type PreparedOrderRecord = {
  readonly signedOrder: object;
  readonly orderType: string;
  readonly postOnly: boolean;
};

type PreparedOrderClient = {
  readonly chainId: unknown;
  createOrder(
    userOrder: ReturnType<typeof toSdkUserOrder>,
    options: ReturnType<typeof toSdkOrderOptions>,
  ): Promise<unknown>;
  postOrder(signedOrder: object, orderType: string, postOnly: boolean): Promise<unknown>;
};

type ExactOrderClient = {
  getOrder(orderId: string): Promise<unknown>;
};

function toSdkUserOrder(params: PlaceOrderParams) {
  return {
    tokenID: String(params.tokenId),
    price: params.price,
    size: params.size,
    side: toSdkSide(params.side),
    ...(params.expiration !== undefined ? { expiration: params.expiration } : {}),
  };
}

function toSdkOrderOptions(params: PlaceOrderParams) {
  return { tickSize: toSdkTickSize(params.tickSize), negRisk: params.negRisk };
}

function isDefinitiveSubmissionRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const response: unknown = Reflect.get(error, "response");
  const status: unknown =
    response && typeof response === "object"
      ? Reflect.get(response, "status")
      : Reflect.get(error, "status");
  return (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

function isResolvedSubmissionRejection(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  if (Reflect.get(response, "error") == null) return false;
  return isDefinitiveSubmissionRejection(response);
}

class SettlementTransactionFailedError extends Error {
  constructor() {
    super("Settlement transaction reached failed state before balances cleared");
    this.name = "SettlementTransactionFailedError";
  }
}

/**
 * A settlement call that provably broadcast NOTHING — the failure happened before submission.
 *
 * This is the one class of failure whose write-ahead intent rows are safe to discard: they record
 * something that demonstrably did not happen. Everything else — a rejected submission whose request
 * may still have reached the relayer, a confirmation we could not observe — stays "we do not know".
 *
 * The message deliberately carries no transport vocabulary (`429`, `rate limit`): the caller
 * classifies rate limits by matching text, and a borrowed token here would route this into the
 * breaker branch and open a breaker for a failure that has nothing to do with infrastructure.
 */
export class SettlementNotSubmittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementNotSubmittedError";
  }
}

/**
 * A settlement batch that WAS broadcast but whose on-chain outcome we could not confirm.
 *
 * `observeSettlementExecution` reports `submitted` when the relayer response exposes no `wait()`,
 * and `pending` when the wait timed out or errored. Both mean the transaction is somewhere between
 * the mempool and a receipt — it may land, it may revert. Resolving on either is what let the merge
 * caller mark its rows 'onchain', consume the local YES/NO lots and settle to 'applied': terminal,
 * and the startup divergence report surfaces only NON-terminal rows, so a merge that never landed
 * would be invisible forever.
 *
 * Throwing puts the caller on its "we do not know" path, which leaves the rows 'pending' — visible
 * to that report, and re-checkable. The opposite mistake (leaving rows 'pending' for a merge that
 * DID land) is recoverable precisely because 'pending' is non-terminal.
 *
 * Production evidence that this is the exception and not the norm: the live relayer response does
 * expose `wait()`, and every observed settlement confirmed inside the wait window (4/4
 * `redeem_wait_result`, zero `redeem_pending_after_wait_error` in the runtime log).
 */
export class SettlementUnconfirmedError extends Error {
  constructor(
    readonly operation: SettlementSubmitOperation,
    readonly observedStatus: string,
    readonly conditionIds: readonly string[],
  ) {
    super(
      `Settlement ${operation} was broadcast but not confirmed (observed status '${observedStatus}') for ${conditionIds.join(",")}`,
    );
    this.name = "SettlementUnconfirmedError";
  }
}

class SettlementSubmitLaneTimeoutError extends Error {
  constructor(
    readonly operation: SettlementSubmitOperation,
    readonly timeoutMs: number,
  ) {
    super(`Settlement submit lane ${operation} task timed out after ${timeoutMs}ms`);
    this.name = "SettlementSubmitLaneTimeoutError";
  }
}

export class SettlementCollateralUnresolvedError extends Error {
  readonly conditionId: string;
  readonly operation: "redeem" | "merge";
  readonly cause: unknown;
  constructor(conditionId: string, operation: "redeem" | "merge", cause?: unknown) {
    // Embed the original cause message so upstream rate-limit detectors that
    // grep `error.message` (e.g. redeem-sweep's `isRpcRateLimitError`) keep
    // working when the resolver fails with a 429 / 503 / quota error.
    const causeMsg = cause instanceof Error ? cause.message : cause != null ? String(cause) : "";
    const suffix = causeMsg ? `: ${causeMsg}` : "";
    super(
      `Could not resolve collateral token (USDC vs pUSD) for ${operation} of condition ${conditionId}${suffix}`,
    );
    this.name = "SettlementCollateralUnresolvedError";
    this.conditionId = conditionId;
    this.operation = operation;
    this.cause = cause;
  }
}

/** Lifecycle diagnostics for REDEEM/MERGE paths. Stdout JSON — picked up by docker log capture. */
function logSettlementLifecycle(event: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ source: "exchange-gateway", ...event }));
}

/** Summarize an arbitrary value for log output without dumping full contents. */
function describeShape(value: unknown): Record<string, unknown> {
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "undefined" };
  const type = typeof value;
  if (type !== "object") return { type, value: String(value).slice(0, 128) };
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const summary: Record<string, unknown> = { type: "object", keys };
  for (const probe of [
    "transactionID",
    "txHash",
    "hash",
    "transactionHash",
    "blockNumber",
    "gasUsed",
    "status",
    "state",
  ]) {
    if (probe in obj) {
      const v = obj[probe];
      summary[probe] = typeof v === "object" ? describeShape(v) : v;
    }
  }
  if ("receipt" in obj && obj.receipt && typeof obj.receipt === "object") {
    const r = obj.receipt as Record<string, unknown>;
    summary.receipt = {
      keys: Object.keys(r),
      status: r.status,
      blockNumber: r.blockNumber,
      gasUsed: r.gasUsed,
      transactionHash: r.transactionHash,
    };
  }
  return summary;
}

function emptySettlementTxMetadata(): SettlementTxMetadata {
  return { txHash: null, gasUsed: null };
}

function extractSettlementTxMetadata(value: unknown): SettlementTxMetadata {
  if (!value || typeof value !== "object") return emptySettlementTxMetadata();
  const obj = value as Record<string, unknown>;
  const receipt =
    "receipt" in obj && obj.receipt && typeof obj.receipt === "object"
      ? (obj.receipt as Record<string, unknown>)
      : null;
  return {
    txHash:
      stringField(obj, "txHash") ??
      stringField(obj, "hash") ??
      stringField(obj, "transactionHash") ??
      stringField(obj, "transactionID") ??
      stringField(receipt, "transactionHash"),
    gasUsed: numberField(obj, "gasUsed") ?? numberField(receipt, "gasUsed"),
  };
}

function mergeSettlementTxMetadata(
  left: SettlementTxMetadata,
  right: SettlementTxMetadata,
): SettlementTxMetadata {
  return {
    txHash: left.txHash ?? right.txHash,
    gasUsed: left.gasUsed ?? right.gasUsed,
  };
}

function stringField(obj: Record<string, unknown> | null, key: string): string | null {
  const value = obj?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(obj: Record<string, unknown> | null, key: string): number | null {
  const value = obj?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function skippedRedeemResult(
  conditionIds: readonly string[],
  reason: NonNullable<RedeemPositionsResult["reason"]>,
): RedeemPositionsResult {
  return { status: "skipped", conditionIds, reason, txHash: null, gasUsed: null };
}

function settlementLaneReleaseForStatus(
  status: RedeemPositionsResult["status"] | DepositActivationResult["status"],
): SettlementLaneRelease {
  return status === "submitted" || status === "pending" ? "released_ttl" : "released_confirmed";
}

export class LiveExchangeGateway implements ExchangeGateway {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly settlementClient: any;
  private readonly traderAddress: string | null;
  private readonly userWsAuth: UserEventStreamAuth | null;
  private readonly createWebSocket: ((url: string) => UserEventWebSocketLike) | undefined;
  private readonly onInfraAlert:
    | ((alert: {
        code: string;
        severity: "warning" | "error";
        source: string;
        message: string;
        details?: Record<string, unknown> | undefined;
      }) => void)
    | null;
  private readonly collateralResolver: CollateralResolver | null;
  private readonly rpcRotator: RpcRotator | null;
  private readonly depHealthRecorder: DepHealthRecorder | null;
  private readonly readErc20BalanceFn: typeof readErc20Balance;
  private readonly readErc20AllowanceFn: typeof readErc20Allowance;
  private readonly fetchRetries: number;
  private readonly fetchBackoffMs: number[];
  private readonly fetchSleep: (ms: number) => Promise<void>;
  private readonly fetchRetryLog: RetryDiagnosticLogger | undefined;
  private readonly settlementLaneBackstopMs: number;
  private readonly settlementLaneTaskTimeoutMs: number;
  private settlementSubmitTail: Promise<void> = Promise.resolve();
  private readonly warnedCollateralFallback = new Set<string>();
  private warnedRedeemUnsupported = false;
  private warnedMergeUnsupported = false;
  private readonly recentRedeemSubmissions = new Map<string, number>();
  private readonly recentInfraAlerts = new Map<string, number>();
  private readonly preparedOrders = new WeakMap<PreparedOrder, PreparedOrderRecord>();
  // V2 fee metadata cache with separate TTLs for hits vs misses so a transient
  // CLOB error cannot permanently disable V2 fee metadata for a market.
  // `info: null` is a valid hit (`fd` block legitimately absent).
  private readonly marketFeeInfoCache = new Map<
    string,
    { result: MarketFeeInfoResult; expiresAt: number }
  >();
  private static readonly FEE_INFO_TTL_HIT_MS = 5 * 60_000;
  private static readonly FEE_INFO_TTL_MISS_MS = 30_000;

  constructor(config: LiveExchangeConfig) {
    this.client = config.client;
    this.settlementClient = config.settlementClient ?? null;
    this.traderAddress = config.traderAddress?.trim().toLowerCase() ?? null;
    this.userWsAuth = config.userWsAuth ?? null;
    this.createWebSocket = config.createWebSocket;
    this.onInfraAlert = config.onInfraAlert ?? null;
    this.collateralResolver = config.collateralResolver ?? null;
    this.rpcRotator = config.rpcRotator ?? null;
    this.depHealthRecorder = config.depHealthRecorder ?? null;
    this.readErc20BalanceFn = config.__readErc20Balance ?? readErc20Balance;
    this.readErc20AllowanceFn = config.__readErc20Allowance ?? readErc20Allowance;
    this.fetchRetries = config.fetchRetry?.retries ?? 3;
    this.fetchBackoffMs = config.fetchRetry?.backoffMs ?? [100, 500, 2000];
    this.fetchSleep = config.fetchRetry?.sleep ?? sleep;
    this.fetchRetryLog = config.fetchRetry?.log;
    this.settlementLaneBackstopMs =
      config.__settlementLaneBackstopMs ?? SETTLEMENT_SUBMIT_LANE_BACKSTOP_MS;
    this.settlementLaneTaskTimeoutMs =
      config.__settlementLaneTaskTimeoutMs ?? SETTLEMENT_SUBMIT_LANE_TASK_TIMEOUT_MS;
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    try {
      const userOrder = toSdkUserOrder(params);
      const options = toSdkOrderOptions(params);

      const result = await timeDepCall(
        this.depHealthRecorder,
        "clob",
        () =>
          params.postOnly
            ? this.postMakerOnlyOrder(userOrder, options, params.orderType)
            : this.client.createAndPostOrder(userOrder, options, params.orderType),
        // A resolved SDK payload with no order id is a FAILED placement (see the
        // no-order-id branch below) — classify it as such so the most
        // safety-critical CLOB call isn't recorded as healthy on failure.
        { isOk: (r) => Boolean(extractOrderId(r)) },
      );
      const orderId = extractOrderId(result);
      if (!orderId) {
        return {
          success: false,
          errorCode: "UNKNOWN",
          errorMessage: "exchange returned no order id",
          errorDetails: { responseBody: redactSensitive(result) },
        };
      }

      return { success: true, orderId };
    } catch (err) {
      const { code, message, details } = classifyError(err);
      return { success: false, errorCode: code, errorMessage: message, errorDetails: details };
    }
  }

  async prepareOrder(params: PlaceOrderParams): Promise<PreparedOrder> {
    const signedOrder: unknown = await (this.client as PreparedOrderClient).createOrder(
      toSdkUserOrder(params),
      toSdkOrderOptions(params),
    );
    if (!signedOrder || typeof signedOrder !== "object") {
      throw new Error("exchange returned an invalid signed order");
    }

    const chainId: unknown = (this.client as PreparedOrderClient).chainId;
    if (typeof chainId !== "number") throw new Error("exchange client has no chain ID");
    const prepared = Object.freeze({
      orderId: hashSignedOrderV2(signedOrder, chainId, params.negRisk),
      __preparedOrderBrand: "PreparedOrder" as const,
    });
    this.preparedOrders.set(prepared, {
      signedOrder,
      orderType: params.orderType,
      postOnly: params.postOnly ?? false,
    });
    return prepared;
  }

  async submitPreparedOrder(prepared: PreparedOrder): Promise<PreparedOrderSubmitResult> {
    const record = this.preparedOrders.get(prepared);
    if (!record) {
      return {
        kind: "unknown",
        errorMessage: "prepared order does not belong to this gateway",
        errorDetails: null,
      };
    }

    try {
      const response = await timeDepCall(this.depHealthRecorder, "clob", () =>
        (this.client as PreparedOrderClient).postOrder(
          record.signedOrder,
          record.orderType,
          record.postOnly,
        ),
      );
      const orderId = extractOrderId(response);
      if (!orderId) {
        if (isResolvedSubmissionRejection(response)) {
          const { code, message, details } = classifyError(response);
          return {
            kind: "rejected",
            errorCode: code,
            errorMessage: message,
            errorDetails: details,
          };
        }
        return {
          kind: "unknown",
          errorMessage: "exchange returned no order id",
          errorDetails: { responseBody: redactSensitive(response) },
        };
      }
      return { kind: "accepted", orderId };
    } catch (err) {
      const { code, message, details } = classifyError(err);
      if (isDefinitiveSubmissionRejection(err)) {
        return { kind: "rejected", errorCode: code, errorMessage: message, errorDetails: details };
      }
      return { kind: "unknown", errorMessage: message, errorDetails: details };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async postMakerOnlyOrder(
    userOrder: Record<string, unknown>,
    options: any,
    orderType: string,
  ) {
    const signedOrder = await this.client.createOrder(userOrder, options);
    return this.client.postOrder(signedOrder, orderType, true);
  }

  async cancelOrder(params: CancelOrderParams): Promise<CancelOrderResult> {
    try {
      const raw = await timeDepCall(this.depHealthRecorder, "clob", () =>
        this.client.cancelOrder({ orderID: params.orderId }),
      );
      return cancelAcknowledged(raw, params.orderId) ? { success: true } : { success: false };
    } catch (err) {
      const { code, message } = classifyError(err);
      return { success: false, errorCode: code, errorMessage: message };
    }
  }

  async cancelAllOrders(): Promise<CancelOrderResult> {
    try {
      await timeDepCall(this.depHealthRecorder, "clob", () => this.client.cancelAll());
      return { success: true };
    } catch (err) {
      const { code, message } = classifyError(err);
      return { success: false, errorCode: code, errorMessage: message };
    }
  }

  /**
   * Throws on transport/parse failure (returned `{ error, status }` shape or a
   * non-array payload), otherwise returns the mapped open orders. The retry
   * policy lives in {@link getOpenOrdersResult}; this body is intentionally
   * single-shot so the legacy {@link getOpenOrders} keeps its old semantics.
   */
  private async fetchOpenOrders(): Promise<ExchangeOrder[]> {
    const raw = await this.client.getOpenOrders();
    throwIfReturnedError(raw);
    return extractArrayOrThrow(raw).map((row) => {
      assertReliableOpenOrderRow(row);
      return mapOpenOrder(row);
    });
  }

  private async fetchFills(sinceMs: number): Promise<ExchangeFill[]> {
    const raw = await this.client.getTrades({
      after: Math.floor(sinceMs / 1000).toString(),
    });
    throwIfReturnedError(raw);
    return extractArrayOrThrow(raw).flatMap((trade) => {
      const fills = this.traderAddress
        ? mapTradeToPersonalFills(trade, this.traderAddress)
        : [mapTrade(trade)];
      assertReliableFillRow(trade, fills);
      if (this.traderAddress) assertAuthenticatedFillRow(trade, fills);
      return fills;
    });
  }

  private async fetchExactOrder(orderId: string): Promise<ExchangeOrder | null> {
    try {
      const raw = await (this.client as ExactOrderClient).getOrder(orderId);
      if (raw === null || raw === undefined || isReturnedNotFound(raw)) return null;
      throwIfReturnedError(raw);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new FetchParseError("expected exact order object");
      }
      try {
        return mapExactOrder(raw as Record<string, unknown>, orderId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid exact order";
        throw new FetchParseError(message);
      }
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    try {
      return await this.fetchOpenOrders();
    } catch {
      return [];
    }
  }

  /**
   * Reliable variant of {@link getOpenOrders}: retries transient failures and
   * returns a discriminated {@link FetchResult} so reconciliation can tell a
   * genuine empty snapshot from a fetch failure (#36).
   */
  async getOpenOrdersResult(): Promise<FetchResult<ExchangeOrder[]>> {
    return timeDepCall(
      this.depHealthRecorder,
      "clob",
      () =>
        executeWithRetry(() => this.fetchOpenOrders(), classifyFetchError, {
          retries: this.fetchRetries,
          backoffMs: this.fetchBackoffMs,
          sleep: this.fetchSleep,
          source: "open_orders",
          log: this.fetchRetryLog,
        }),
      { isOk: fetchResultOk },
    );
  }

  async getOrderResult(orderId: string): Promise<FetchResult<ExchangeOrder | null>> {
    if (orderId.trim().length === 0) return { ok: false, reason: "parse", attempts: 1 };
    return timeDepCall(
      this.depHealthRecorder,
      "clob",
      () =>
        executeWithRetry(() => this.fetchExactOrder(orderId), classifyFetchError, {
          retries: this.fetchRetries,
          backoffMs: this.fetchBackoffMs,
          sleep: this.fetchSleep,
          source: "exact_order",
          log: this.fetchRetryLog,
        }),
      { isOk: fetchResultOk },
    );
  }

  async getOpenOrdersForToken(tokenId: TokenId): Promise<ExchangeOrder[]> {
    try {
      const raw = await this.client.getOpenOrders({
        asset_id: String(tokenId),
      });
      return extractArray(raw).map((o: Record<string, unknown>) => mapOpenOrder(o));
    } catch {
      return [];
    }
  }

  async getFills(sinceMs: number): Promise<ExchangeFill[]> {
    try {
      return await this.fetchFills(sinceMs);
    } catch {
      return [];
    }
  }

  /** Reliable variant of {@link getFills} — see {@link getOpenOrdersResult}. */
  async getFillsResult(sinceMs: number): Promise<FetchResult<ExchangeFill[]>> {
    return timeDepCall(
      this.depHealthRecorder,
      "clob",
      () =>
        executeWithRetry(() => this.fetchFills(sinceMs), classifyFetchError, {
          retries: this.fetchRetries,
          backoffMs: this.fetchBackoffMs,
          sleep: this.fetchSleep,
          source: "fills",
          log: this.fetchRetryLog,
        }),
      { isOk: fetchResultOk },
    );
  }

  createUserEventStream(
    handlers: Readonly<{
      onTradeEvents: (events: readonly ExchangeUserTradeEvent[]) => Promise<void> | void;
      onOrderEvents: (events: readonly ExchangeUserOrderEvent[]) => Promise<void> | void;
      onGapDetected?: (
        info: Readonly<{ reason: string; timestamp: number }>,
      ) => Promise<void> | void;
      onError?: (error: unknown) => Promise<void> | void;
    }>,
  ): ExchangeUserEventStream {
    if (!this.userWsAuth) {
      throw new Error("user websocket auth is not configured");
    }
    return new LiveUserEventStream({
      auth: this.userWsAuth,
      traderAddress: this.traderAddress,
      ...(this.createWebSocket ? { createWebSocket: this.createWebSocket } : {}),
      handlers,
    });
  }

  async getBalances(): Promise<ExchangeBalance[]> {
    try {
      const raw = await this.client.getBalanceAllowance({
        asset_type: "COLLATERAL",
      });
      return [mapBalance(raw as Record<string, unknown>)];
    } catch {
      return [];
    }
  }

  async getMarketFeeInfo(conditionId: string): Promise<MarketFeeInfo | null> {
    const result = await this.getMarketFeeInfoResult(conditionId);
    return result.info;
  }

  async getMarketFeeInfoResult(conditionId: string): Promise<MarketFeeInfoResult> {
    const now = Date.now();
    const cached = this.marketFeeInfoCache.get(conditionId);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }
    try {
      const raw = (await this.client.getClobMarketInfo(conditionId)) as {
        fd?: { r?: number; e?: number; to?: boolean };
        mbf?: unknown;
        tbf?: unknown;
        maker_base_fee?: unknown;
        taker_base_fee?: unknown;
      } | null;
      const result = parseMarketFeeInfoResult(raw);
      this.marketFeeInfoCache.set(conditionId, {
        result,
        expiresAt: now + LiveExchangeGateway.FEE_INFO_TTL_HIT_MS,
      });
      return result;
    } catch {
      // Short negative TTL: a transient CLOB failure must not permanently
      // disable V2 fee metadata for this condition.
      const result: MarketFeeInfoResult = {
        status: "api_error",
        info: null,
        diagnostic: {
          fieldShape: "unknown",
          fdPresent: false,
          takerBaseFeePresent: false,
          makerBaseFeePresent: false,
          message: "getClobMarketInfo threw",
        },
      };
      this.marketFeeInfoCache.set(conditionId, {
        result,
        expiresAt: now + LiveExchangeGateway.FEE_INFO_TTL_MISS_MS,
      });
      return result;
    }
  }

  async getPositionBalance(tokenId: TokenId): Promise<number> {
    const raw = await this.client.getBalanceAllowance({
      asset_type: "CONDITIONAL",
      token_id: String(tokenId),
    });
    return Number(raw?.balance ?? 0) / ATOMIC_UNIT_DIVISOR;
  }

  async getOutcomeTokenBalance(tokenId: TokenId): Promise<bigint> {
    return this.getRawPositionBalance(String(tokenId));
  }

  async redeemPositions(
    conditionIds: string[],
    options?: RedeemPositionsOptions,
  ): Promise<RedeemPositionsResult> {
    const settlementExecute = this.getSettlementExecuteMethod();
    if (settlementExecute) {
      return this.withSettlementSubmitLane("redeem", async () => {
        const requests = await this.buildRedeemRequests(
          conditionIds,
          options?.redeemTokenIdsByCondition,
        );
        if (requests.length === 0) {
          return {
            value: skippedRedeemResult(conditionIds, "no_redeem_requests"),
            release: "released_confirmed",
          };
        }

        const submitStartedAt = Date.now();
        try {
          // Polymarket relayer rejects free-form metadata with 400 `invalid metadata field`.
          // Use a short constant slug; the relayer accepts these, and conditionIds are
          // already logged separately via logSettlementLifecycle.
          const response = await timeDepCall(this.depHealthRecorder, "relayer", () =>
            settlementExecute(
              requests.map((request) => request.tx),
              RELAYER_METADATA_REDEEM,
            ),
          );
          const submittedAt = Date.now();
          for (const request of requests) {
            this.recentRedeemSubmissions.set(request.conditionId, submittedAt);
          }
          logSettlementLifecycle({
            lifecycle: "redeem_submit_response",
            conditionIds: requests.map((r) => r.conditionId),
            elapsedMs: submittedAt - submitStartedAt,
            responseShape: describeShape(response),
          });
          const metadata = extractSettlementTxMetadata(response);
          const observed = await this.observeSettlementExecution(response, requests);
          return {
            value: {
              status: observed.status,
              conditionIds: requests.map((request) => request.conditionId),
              txHash: observed.metadata.txHash ?? metadata.txHash,
              gasUsed: observed.metadata.gasUsed ?? metadata.gasUsed,
            },
            release: settlementLaneReleaseForStatus(observed.status),
          };
        } catch (e) {
          const confirmedSettlementFailure = e instanceof SettlementTransactionFailedError;
          logSettlementLifecycle({
            lifecycle: confirmedSettlementFailure
              ? "redeem_settlement_failed"
              : "redeem_submit_error",
            conditionIds: requests.map((r) => r.conditionId),
            elapsedMs: Date.now() - submitStartedAt,
            errorMessage: e instanceof Error ? e.message : String(e),
            errorName: e instanceof Error ? e.name : undefined,
            revertReason:
              e && typeof e === "object" && "reason" in e
                ? (e as { reason?: unknown }).reason
                : undefined,
          });
          if (!confirmedSettlementFailure) {
            this.reportInfraAlert(e);
            console.error(
              `Failed to submit relayer redeem for conditions ${requests.map((r) => r.conditionId).join(",")}:`,
              sanitizeLogArg(e),
            );
          }
          throw e;
        }
      });
    }

    const redeemOne = this.getClientMethod("postRedeem") ?? this.getClientMethod("redeem");
    const redeemBatch = this.getClientMethod("redeemPositions");
    if (!redeemOne && !redeemBatch) {
      this.warnUnsupportedSettlement("redeem");
      return skippedRedeemResult(conditionIds, "unsupported_settlement");
    }

    if (redeemBatch) {
      try {
        const response = await redeemBatch(conditionIds);
        const metadata = extractSettlementTxMetadata(response);
        return { status: "submitted", conditionIds, ...metadata };
      } catch (e) {
        console.error(`Failed to redeem conditions ${conditionIds.join(",")}:`, sanitizeLogArg(e));
        throw e;
      }
    }

    // Sequential submission means a batch can be PARTIALLY on chain when a later condition fails.
    // Unlike `mergePositions` — which returns void and therefore has no way to say "these went out,
    // those did not", so it must throw — `RedeemPositionsResult` carries the submitted set, and the
    // caller partitions on it: reported conditions get a non-terminal 'submitted' row plus
    // verification, unreported ones are recorded as never-submitted and verified separately. Throwing
    // instead would erase which conditions were already broadcast, and the caller's retry path would
    // redeem them a second time.
    const submittedConditionIds: string[] = [];
    // Each iteration is its own transaction, so a single flat txHash cannot describe the batch:
    // `mergeSettlementTxMetadata` keeps the FIRST non-null hash, and the caller used to stamp it on
    // every submitted condition — filing conditions 2..n under condition 1's transaction, which is
    // wrong provenance in the redeem_log and misleads any on-chain follow-up. The map is the truth
    // here; the flat fields below stay only as a summary for callers that predate it.
    const txByCondition: Record<string, SettlementTxMetadata> = {};
    let mergedMetadata: SettlementTxMetadata = emptySettlementTxMetadata();
    for (const conditionId of conditionIds) {
      try {
        const response = await redeemOne!({ conditionId });
        submittedConditionIds.push(conditionId);
        const metadata = extractSettlementTxMetadata(response);
        txByCondition[conditionId] = metadata;
        mergedMetadata = mergeSettlementTxMetadata(mergedMetadata, metadata);
      } catch (e) {
        console.error(`Failed to redeem ${conditionId}:`, sanitizeLogArg(e));
        // Nothing was broadcast, so the error is attributable to the whole call: rethrow it intact so
        // the caller keeps its 429 hard-pause, zero-balance and STATE_FAILED classification.
        if (submittedConditionIds.length === 0) throw e;
        // A partial batch reports the truth instead. The classification above is lost for THIS sweep,
        // so raise the infra alert directly — that is what carries a Polygon RPC 429 through to the
        // shared breaker — and let the next sweep, which will fail with an empty submitted list,
        // throw properly.
        this.reportInfraAlert(e);
        break;
      }
    }
    return {
      status: "submitted",
      conditionIds: submittedConditionIds,
      ...mergedMetadata,
      txByCondition,
    };
  }

  __hasPendingRedeemSubmission(conditionId: string): boolean {
    return this.wasRedeemRecentlySubmitted(conditionId);
  }

  async mergePositions(merges: { conditionId: string; amount: number }[]): Promise<void> {
    const settlementExecute = this.getSettlementExecuteMethod();
    if (settlementExecute) {
      const observed = await this.withSettlementSubmitLane("merge", async () => {
        const requests = await this.buildMergeRequests(merges);
        // `buildMergeRequests` DROPS a condition it cannot build — a market with no token ids, or
        // any build error that is not `SettlementCollateralUnresolvedError` — and the drop is
        // invisible because `mergePositions` returns void. Resolving on a short request list is
        // therefore the exact divergence the unsupported-client path below throws on, on the path
        // live-lite actually uses: the caller reads a resolved call as "every requested merge is
        // irrevocable", marks all its write-ahead rows 'onchain', consumes the local YES/NO lots and
        // settles the rows to 'applied' — terminal, so the startup divergence report (non-terminal
        // rows only) never mentions the conditions that never hit chain. Throwing BEFORE anything is
        // submitted keeps the batch atomic: nothing is broadcast, the rows stay 'pending' (honestly
        // "we do not know"), and the next sweep retries for real. A permanently unbuildable
        // condition therefore stalls its batch loudly instead of quietly destroying inventory.
        const built = new Set(requests.map((request) => request.conditionId));
        const unbuilt = merges
          .map((merge) => merge.conditionId)
          .filter((conditionId) => !built.has(conditionId));
        if (unbuilt.length > 0) {
          throw new SettlementNotSubmittedError(
            `mergePositions aborted before submission: could not build merge requests for ${unbuilt.join(",")}`,
          );
        }
        // Only reachable for an empty batch now that every requested condition must be covered.
        if (requests.length === 0) {
          return { value: null, release: "released_confirmed" };
        }

        const submitStartedAt = Date.now();
        try {
          const response = await settlementExecute(
            requests.map((request) => request.tx),
            RELAYER_METADATA_MERGE,
          );
          logSettlementLifecycle({
            lifecycle: "merge_submit_response",
            conditionIds: requests.map((r) => r.conditionId),
            elapsedMs: Date.now() - submitStartedAt,
            responseShape: describeShape(response),
          });
          const observed = await this.observeSettlementExecution(response, requests);
          return {
            value: { status: observed.status, conditionIds: requests.map((r) => r.conditionId) },
            release: settlementLaneReleaseForStatus(observed.status),
          };
        } catch (e) {
          const confirmedSettlementFailure = e instanceof SettlementTransactionFailedError;
          logSettlementLifecycle({
            lifecycle: confirmedSettlementFailure
              ? "merge_settlement_failed"
              : "merge_submit_error",
            conditionIds: requests.map((r) => r.conditionId),
            elapsedMs: Date.now() - submitStartedAt,
            errorMessage: e instanceof Error ? e.message : String(e),
            errorName: e instanceof Error ? e.name : undefined,
          });
          if (!confirmedSettlementFailure) {
            this.reportInfraAlert(e);
            console.error(
              `Failed to submit relayer merge for conditions ${requests.map((r) => r.conditionId).join(",")}:`,
              sanitizeLogArg(e),
            );
          }
          throw e;
        }
      });
      // Thrown OUTSIDE the lane, and after it released with the status-appropriate release: an
      // unconfirmed submission is not a lane failure (the batch really was broadcast, and the lane's
      // TTL release is what stops the next sweep from racing it), and routing it through the catch
      // above would raise a settlement infra alert for a transaction that may be perfectly healthy
      // and merely slow. What it MUST NOT do is resolve — see `SettlementUnconfirmedError`.
      if (observed && observed.status !== "confirmed") {
        throw new SettlementUnconfirmedError("merge", observed.status, observed.conditionIds);
      }
      return;
    }

    // No relayer settlement client: refuse BEFORE broadcasting anything.
    //
    // A per-condition `postMerge`/`merge` fallback used to live here. It resolved on acceptance for
    // broadcast, never on a receipt, so it could not honour the `mergePositions` contract
    // (@krabs/domain): resolve only on a proven on-chain settlement. Every outcome it could produce
    // was unsupported — resolving handed the caller a terminal, invisible divergence (rows flipped
    // 'onchain' → 'applied', local YES/NO lots consumed, transaction still able to revert), and
    // rejecting after a broadcast left conditions fenced with no way to confirm what landed. A path
    // that cannot confirm must also never retry, because a blind retry double-merges whatever DID
    // land — so its only honest end state was permanent. Refusing before the first broadcast is
    // strictly better: nothing is on chain, so the caller drops its write-ahead rows, no condition is
    // fenced, and auto-merge without a relayer fails loudly as the misconfiguration it is.
    this.warnUnsupportedSettlement("merge");
    throw new SettlementNotSubmittedError(
      "mergePositions unsupported: merging requires a relayer settlement client",
    );
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.client.getOk();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  private getClientMethod(name: string): ((arg: unknown) => Promise<unknown>) | null {
    const candidate = Reflect.get(this.client, name);
    return typeof candidate === "function"
      ? (candidate as (arg: unknown) => Promise<unknown>).bind(this.client)
      : null;
  }

  private getSettlementExecuteMethod():
    | ((
        txns: Array<{ to: string; data: string; value: string }>,
        metadata?: string,
      ) => Promise<unknown>)
    | null {
    if (!this.settlementClient || typeof this.settlementClient !== "object") return null;
    const candidate = Reflect.get(this.settlementClient, "execute");
    return typeof candidate === "function"
      ? (
          candidate as (
            txns: Array<{ to: string; data: string; value: string }>,
            metadata?: string,
          ) => Promise<unknown>
        ).bind(this.settlementClient)
      : null;
  }

  private async withSettlementSubmitLane<T>(
    operation: SettlementSubmitOperation,
    task: () => Promise<SettlementLaneTaskResult<T>>,
  ): Promise<T> {
    const previousTail = this.settlementSubmitTail;
    let releaseTail!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    this.settlementSubmitTail = previousTail.then(() => currentTail);

    const queuedAt = Date.now();
    await previousTail;
    const waitMs = Date.now() - queuedAt;
    if (waitMs > 0) {
      logSettlementLifecycle({
        lifecycle: "settlement_submit_lane_wait",
        operation,
        waitMs,
      });
    }

    try {
      const result = await this.runSettlementLaneTaskWithWatchdog(operation, task);
      this.releaseSettlementSubmitLane(operation, result.release, releaseTail);
      return result.value;
    } catch (error) {
      this.releaseSettlementSubmitLane(
        operation,
        error instanceof SettlementSubmitLaneTimeoutError ? "released_watchdog" : "released_error",
        releaseTail,
      );
      throw error;
    }
  }

  private async runSettlementLaneTaskWithWatchdog<T>(
    operation: SettlementSubmitOperation,
    task: () => Promise<SettlementLaneTaskResult<T>>,
  ): Promise<SettlementLaneTaskResult<T>> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        task(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new SettlementSubmitLaneTimeoutError(operation, this.settlementLaneTaskTimeoutMs),
            );
          }, this.settlementLaneTaskTimeoutMs);
          const maybeUnref = (timer as { unref?: () => void }).unref;
          if (typeof maybeUnref === "function") maybeUnref.call(timer);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private releaseSettlementSubmitLane(
    operation: SettlementSubmitOperation,
    release: SettlementLaneRelease,
    releaseTail: () => void,
  ): void {
    if (release !== "released_ttl") {
      releaseTail();
      logSettlementLifecycle({
        lifecycle: "settlement_submit_lane_release",
        operation,
        result: release,
      });
      return;
    }

    logSettlementLifecycle({
      lifecycle: "settlement_submit_lane_hold",
      operation,
      result: release,
      holdMs: this.settlementLaneBackstopMs,
    });
    const timer = setTimeout(() => {
      releaseTail();
      logSettlementLifecycle({
        lifecycle: "settlement_submit_lane_release",
        operation,
        result: release,
      });
    }, this.settlementLaneBackstopMs);
    const maybeUnref = (timer as { unref?: () => void }).unref;
    if (typeof maybeUnref === "function") maybeUnref.call(timer);
  }

  private async buildMergeRequests(
    merges: { conditionId: string; amount: number }[],
  ): Promise<SettlementRequest[]> {
    const requests: SettlementRequest[] = [];
    for (const merge of merges) {
      try {
        const request = await this.buildMergeRequest(merge.conditionId, merge.amount);
        if (request) requests.push(request);
      } catch (e) {
        // Unresolved collateral aborts the batch here so the failure keeps its own type and message.
        // Every OTHER build failure is logged and dropped from `requests` — but NOT forgiven: the
        // caller compares the built set against `merges` and refuses to submit a short batch, which
        // is what stops a dropped condition from becoming a merge the ledger applies but the chain
        // never saw. Tolerating it at THIS level only keeps one malformed market from masking the
        // others in the log.
        if (e instanceof SettlementCollateralUnresolvedError) throw e;
        console.error(
          `Failed to build merge request for condition ${merge.conditionId}:`,
          sanitizeLogArg(e),
        );
      }
    }
    return requests;
  }

  private async buildMergeRequest(
    conditionId: string,
    amount: number,
  ): Promise<SettlementRequest | null> {
    const market = await this.client.getMarket(conditionId);
    const tokenIds = this.extractMarketTokenIds(market);
    if (tokenIds.length === 0) return null;

    const chainId = this.getChainId();
    const contracts = getContractConfig(chainId);

    // Binary markets: YES/NO mapping assumed to be index 0 and 1
    const indexSets = tokenIds.map((_, index) => 1n << BigInt(index));
    // `resolveCtfCollateral` throws `SettlementCollateralUnresolvedError` when
    // a resolver is configured but cannot prove collateral (RPC failure or no
    // candidate matched). The caller treats `mergePositions` as
    // all-or-nothing — silently dropping one condition would let the ledger
    // apply a merge that never hit chain. Letting the throw propagate aborts
    // the whole batch; the inventory sweep retries on next tick.
    const collateral = await this.resolveCtfCollateral(
      conditionId,
      tokenIds[0]!,
      indexSets[0]!,
      contracts.collateral,
      "merge",
    );
    const data = encodeFunctionData({
      abi: CTF_MERGE_ABI,
      functionName: "mergePositions",
      args: [
        collateral as `0x${string}`,
        zeroHash,
        conditionId as `0x${string}`,
        indexSets,
        BigInt(Math.floor(amount * ATOMIC_UNIT_DIVISOR)),
      ],
    });

    return {
      conditionId,
      tx: {
        to: contracts.conditionalTokens,
        data,
        value: "0",
      },
    };
  }

  private async buildRedeemRequests(
    conditionIds: string[],
    redeemTokenIdsByCondition?: Readonly<Record<string, readonly TokenId[]>>,
  ): Promise<SettlementRequest[]> {
    const requests: SettlementRequest[] = [];
    for (const conditionId of conditionIds) {
      if (this.wasRedeemRecentlySubmitted(conditionId)) continue;
      const request = await this.buildRedeemRequest(
        conditionId,
        redeemTokenIdsByCondition?.[conditionId],
      );
      if (request) requests.push(request);
    }
    return requests;
  }

  private wasRedeemRecentlySubmitted(conditionId: string): boolean {
    const lastSubmittedAt = this.recentRedeemSubmissions.get(conditionId);
    if (!lastSubmittedAt) return false;
    if (Date.now() - lastSubmittedAt < RECENT_SETTLEMENT_SUBMISSION_TTL_MS) return true;
    this.recentRedeemSubmissions.delete(conditionId);
    return false;
  }

  private async buildRedeemRequest(
    conditionId: string,
    redeemTokenIds?: readonly TokenId[],
  ): Promise<SettlementRequest | null> {
    const market = await this.client.getMarket(conditionId);
    const tokenEntries = this.extractMarketTokenEntries(market);
    if (tokenEntries.length === 0) {
      logSettlementLifecycle({ lifecycle: "redeem_skip_no_tokens", conditionId });
      return null;
    }

    const allowedTokenIds = redeemTokenIds ? new Set(redeemTokenIds.map(String)) : null;
    const redeemEntries = allowedTokenIds
      ? tokenEntries.filter((entry) => allowedTokenIds.has(entry.tokenId))
      : tokenEntries;
    if (redeemEntries.length === 0) {
      logSettlementLifecycle({
        lifecycle: "redeem_skip_no_redeem_tokens",
        conditionId,
        requestedTokenIds: redeemTokenIds?.map(String) ?? [],
        marketTokenIds: tokenEntries.map((entry) => entry.tokenId),
      });
      return null;
    }

    const chainId = this.getChainId();
    const contracts = getContractConfig(chainId);
    const balances = await Promise.all(
      redeemEntries.map((entry) => this.getRawPositionBalance(entry.tokenId)),
    );
    const balanceStrings = balances.map((b) => b.toString());
    const tokenIds = redeemEntries.map((entry) => entry.tokenId);

    if (balances.every((balance) => balance === 0n)) {
      logSettlementLifecycle({
        lifecycle: "redeem_skip_already_zero",
        conditionId,
        tokenIds,
        balances: balanceStrings,
      });
      return null;
    }

    logSettlementLifecycle({
      lifecycle: "redeem_precheck",
      conditionId,
      tokenIds,
      balances: balanceStrings,
    });

    const isNegRisk = this.extractNegRisk(market);
    if (isNegRisk) {
      const balanceByTokenId = new Map<string, bigint>();
      redeemEntries.forEach((entry, index) => {
        balanceByTokenId.set(entry.tokenId, balances[index] ?? 0n);
      });
      const allOutcomeAmounts = tokenEntries.map(
        (entry) => balanceByTokenId.get(entry.tokenId) ?? 0n,
      );
      const data = encodeFunctionData({
        abi: NEG_RISK_REDEEM_ABI,
        functionName: "redeemPositions",
        args: [conditionId as `0x${string}`, allOutcomeAmounts],
      });
      return {
        conditionId,
        tx: {
          to: contracts.negRiskAdapter,
          data,
          value: "0",
        },
        precheckTokenIds: tokenIds,
        precheckBalances: balanceStrings,
      };
    }

    const indexSets = redeemEntries.map((entry) => 1n << BigInt(entry.index));
    // `resolveCtfCollateral` throws `SettlementCollateralUnresolvedError` when
    // a resolver is configured but cannot prove collateral. Silently dropping
    // one condition from the submitted batch would let redeem-sweep mark it
    // confirmed/closed locally based on the aggregate result of the other
    // conditions, corrupting ledger state. Letting the throw propagate is
    // caught by redeem-sweep's batch try/catch and recorded as a retryable
    // failure.
    const collateral = await this.resolveCtfCollateral(
      conditionId,
      redeemEntries[0]!.tokenId,
      indexSets[0]!,
      contracts.collateral,
      "redeem",
    );
    const data = encodeFunctionData({
      abi: CTF_REDEEM_ABI,
      functionName: "redeemPositions",
      args: [collateral as `0x${string}`, zeroHash, conditionId as `0x${string}`, indexSets],
    });

    return {
      conditionId,
      tx: {
        to: contracts.conditionalTokens,
        data,
        value: "0",
      },
      precheckTokenIds: tokenIds,
      precheckBalances: balanceStrings,
    };
  }

  /**
   * Resolve the actual collateral token (USDC vs pUSD) used by a CTF market.
   *
   * Returns the resolver-confirmed collateral when wired. Throws
   * `SettlementCollateralUnresolvedError` when a resolver is configured but
   * cannot prove collateral — either because the RPC call failed (cause
   * preserved on the error) or because no candidate matched. Throwing rather
   * than returning a default is mandatory: silently falling back to the SDK's
   * pUSD-default would reproduce the original `PRECHECK_SKIPPED: zero
   * position balance` rejection, and silently dropping the condition would
   * let upstream callers (which apply the aggregate result to every reserved
   * group) corrupt local ledger state.
   *
   * The `defaultCollateral` branch only applies when no resolver is wired at
   * all (unit-tests / simulation / paper paths).
   *
   * RPC errors are additionally piped through `reportInfraAlert` so the
   * existing 429 / 503 classifier raises `POLYGON_RPC_RATE_LIMITED` /
   * `POLYGON_RPC_UNAVAILABLE` and the redeem-sweep hard-pause kicks in.
   */
  private async resolveCtfCollateral(
    conditionId: string,
    canonicalTokenId: string,
    indexSet: bigint,
    defaultCollateral: string,
    operation: "redeem" | "merge",
  ): Promise<string> {
    if (!this.collateralResolver) return defaultCollateral;
    let cause: unknown = null;
    try {
      const resolved = await this.collateralResolver({
        conditionId,
        canonicalTokenId,
        indexSet,
      });
      if (resolved) return resolved;
    } catch (err) {
      cause = err;
      this.reportInfraAlert(err);
      logSettlementLifecycle({
        lifecycle: "collateral_resolve_error",
        conditionId,
        canonicalTokenId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!cause && !this.warnedCollateralFallback.has(conditionId)) {
      this.warnedCollateralFallback.add(conditionId);
      logSettlementLifecycle({
        lifecycle: "collateral_resolve_failed",
        conditionId,
        canonicalTokenId,
      });
    }
    throw new SettlementCollateralUnresolvedError(conditionId, operation, cause);
  }

  private extractMarketTokenEntries(raw: unknown): MarketTokenEntry[] {
    if (!raw || typeof raw !== "object") return [];
    const tokens = Reflect.get(raw, "tokens");
    if (!Array.isArray(tokens)) return [];
    return tokens
      .map((token, index) => {
        if (!token || typeof token !== "object") return null;
        const tokenId = Reflect.get(token, "token_id");
        return typeof tokenId === "string" && tokenId.length > 0 ? { tokenId, index } : null;
      })
      .filter((entry): entry is MarketTokenEntry => entry !== null);
  }

  private extractMarketTokenIds(raw: unknown): string[] {
    if (!raw || typeof raw !== "object") return [];
    const tokens = Reflect.get(raw, "tokens");
    if (!Array.isArray(tokens)) return [];
    return tokens
      .map((token) => {
        if (!token || typeof token !== "object") return null;
        const tokenId = Reflect.get(token, "token_id");
        return typeof tokenId === "string" && tokenId.length > 0 ? tokenId : null;
      })
      .filter((tokenId): tokenId is string => tokenId !== null);
  }

  private extractNegRisk(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const snakeCase = Reflect.get(raw, "neg_risk");
    if (typeof snakeCase === "boolean") return snakeCase;
    const camelCase = Reflect.get(raw, "negRisk");
    return typeof camelCase === "boolean" ? camelCase : false;
  }

  private getChainId(): number {
    const chainId = Reflect.get(this.client, "chainId");
    return typeof chainId === "number" ? chainId : 137;
  }

  private async getRawPositionBalance(tokenId: string): Promise<bigint> {
    const raw = await this.client.getBalanceAllowance({
      asset_type: "CONDITIONAL",
      token_id: tokenId,
    });
    const balance = Reflect.get(raw, "balance");
    return typeof balance === "string" || typeof balance === "number" ? BigInt(balance) : 0n;
  }

  private async observeSettlementExecution(
    response: unknown,
    requests: SettlementRequest[],
  ): Promise<{
    status: RedeemPositionsResult["status"];
    metadata: SettlementTxMetadata;
  }> {
    if (!response || typeof response !== "object") {
      return { status: "submitted", metadata: emptySettlementTxMetadata() };
    }
    const waitForConfirmation = Reflect.get(response, "wait");
    if (typeof waitForConfirmation !== "function") {
      return { status: "submitted", metadata: extractSettlementTxMetadata(response) };
    }

    const conditionIds = requests.map((r) => r.conditionId);
    const responseShape = describeShape(response);
    const responseMetadata = extractSettlementTxMetadata(response);

    const waitStartedAt = Date.now();
    try {
      const confirmation = (waitForConfirmation as () => Promise<unknown>).call(response);
      const result = await Promise.race([
        confirmation,
        sleep(SETTLEMENT_CONFIRM_WAIT_TIMEOUT_MS).then(() => {
          throw new Error(
            `Settlement confirmation timed out after ${SETTLEMENT_CONFIRM_WAIT_TIMEOUT_MS}ms`,
          );
        }),
      ]);

      const elapsedMs = Date.now() - waitStartedAt;

      if (!result) {
        logSettlementLifecycle({
          lifecycle: "redeem_empty_result",
          conditionIds,
          elapsedMs,
          resultValue: result === null ? "null" : "undefined",
          responseShape,
        });
        if (await this.verifySettlementBalancesCleared(requests, "redeem_postcheck_after_empty")) {
          this.clearPendingRedeemSubmissions(requests);
          return { status: "confirmed", metadata: responseMetadata };
        }
        this.clearPendingRedeemSubmissions(requests);
        throw new SettlementTransactionFailedError();
      }

      const resultMetadata = extractSettlementTxMetadata(result);
      logSettlementLifecycle({
        lifecycle: "redeem_wait_result",
        conditionIds,
        elapsedMs,
        resultShape: describeShape(result),
      });
      this.clearPendingRedeemSubmissions(requests);
      return {
        status: "confirmed",
        metadata: mergeSettlementTxMetadata(resultMetadata, responseMetadata),
      };
    } catch (err) {
      if (err instanceof SettlementTransactionFailedError) {
        throw err;
      }

      const elapsedMs = Date.now() - waitStartedAt;
      const message = err instanceof Error ? err.message : String(err);
      logSettlementLifecycle({
        lifecycle: "redeem_wait_error",
        conditionIds,
        elapsedMs,
        errorMessage: message,
        errorName: err instanceof Error ? err.name : undefined,
        responseShape,
      });
      this.reportInfraAlert(err);
      if (
        await this.verifySettlementBalancesCleared(requests, "redeem_postcheck_after_wait_error")
      ) {
        this.clearPendingRedeemSubmissions(requests);
        return { status: "confirmed", metadata: responseMetadata };
      }
      logSettlementLifecycle({
        lifecycle: "redeem_pending_after_wait_error",
        conditionIds,
        elapsedMs,
      });
      return { status: "pending", metadata: responseMetadata };
    }
  }

  private clearPendingRedeemSubmissions(requests: readonly SettlementRequest[]): void {
    for (const request of requests) {
      this.recentRedeemSubmissions.delete(request.conditionId);
    }
  }

  private async verifySettlementBalancesCleared(
    requests: readonly SettlementRequest[],
    lifecycle: "redeem_postcheck_after_empty" | "redeem_postcheck_after_wait_error",
  ): Promise<boolean> {
    const redeemRequests = requests.filter((request) => {
      return request.precheckTokenIds != null && request.precheckTokenIds.length > 0;
    });
    if (redeemRequests.length === 0) return false;

    try {
      const postcheck = await Promise.all(
        redeemRequests.map(async (request) => {
          const tokenIds = request.precheckTokenIds!;
          const balances = await Promise.all(
            tokenIds.map((tokenId) => this.getRawPositionBalance(tokenId)),
          );
          return {
            conditionId: request.conditionId,
            tokenIds,
            balances: balances.map((balance) => balance.toString()),
            allZero: balances.every((balance) => balance === 0n),
          };
        }),
      );
      const allZero = postcheck.every((entry) => entry.allZero);
      logSettlementLifecycle({
        lifecycle,
        conditionIds: postcheck.map((entry) => entry.conditionId),
        postcheck,
        verifiedCleared: allZero,
      });
      return allZero;
    } catch (err) {
      logSettlementLifecycle({
        lifecycle,
        conditionIds: redeemRequests.map((request) => request.conditionId),
        verifiedCleared: false,
        postcheckError: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async activatePendingUsdcCollateral(opts: {
    minAmountWei: bigint;
  }): Promise<DepositActivationResult> {
    const settlementExecute = this.getSettlementExecuteMethod();
    const proxyAddress = this.traderAddress;
    if (!settlementExecute || !proxyAddress || !this.rpcRotator) {
      return {
        status: "skipped_no_residue",
        perAsset: [],
        txHash: null,
        gasUsed: null,
      };
    }

    const rotator = this.rpcRotator;
    const perAsset: Array<DepositActivationResult["perAsset"][number]> = [];
    const txs: SettlementTransaction[] = [];

    for (const asset of ACTIVATION_ASSETS) {
      const balance = await this.readErc20BalanceFn({
        rotator,
        token: asset.address,
        owner: proxyAddress as `0x${string}`,
      });

      if (balance < opts.minAmountWei) {
        perAsset.push({
          asset: asset.address,
          symbol: asset.symbol,
          balanceWei: balance.toString(),
          activatedWei: "0",
          reason: balance === 0n ? "zero_balance" : "below_minimum",
        });
        continue;
      }

      const allowance = await this.readErc20AllowanceFn({
        rotator,
        token: asset.address,
        owner: proxyAddress as `0x${string}`,
        spender: PUSD_WRAPPER_ADDRESS,
      });

      // Only emit approve when the existing allowance doesn't cover the full balance.
      if (allowance < balance) {
        txs.push({
          to: asset.address,
          data: encodeFunctionData({
            abi: ERC20_APPROVE_ABI,
            functionName: "approve",
            args: [PUSD_WRAPPER_ADDRESS, balance],
          }),
          value: "0",
        });
      }

      txs.push({
        to: PUSD_WRAPPER_ADDRESS,
        data: encodeFunctionData({
          abi: PUSD_WRAP_ABI,
          functionName: "wrap",
          args: [asset.address, proxyAddress as `0x${string}`, balance],
        }),
        value: "0",
      });

      perAsset.push({
        asset: asset.address,
        symbol: asset.symbol,
        balanceWei: balance.toString(),
        activatedWei: balance.toString(),
      });
    }

    const activated = perAsset.filter((a) => a.activatedWei !== "0");
    if (activated.length === 0) {
      const allZero = perAsset.every((a) => a.reason === "zero_balance");
      return {
        status: allZero ? "skipped_no_residue" : "skipped_below_min",
        perAsset,
        txHash: null,
        gasUsed: null,
      };
    }

    let submitStartedAt = Date.now();
    try {
      return await this.withSettlementSubmitLane("activation", async () => {
        submitStartedAt = Date.now();
        const response = await settlementExecute(txs, RELAYER_METADATA_ACTIVATE_FUNDS);
        logSettlementLifecycle({
          lifecycle: "activate_submit_response",
          elapsedMs: Date.now() - submitStartedAt,
          responseShape: describeShape(response),
        });
        const metadata = extractSettlementTxMetadata(response);
        const observed = await this.observeActivationExecution(response);
        return {
          value: {
            status: observed.status,
            perAsset,
            txHash: observed.metadata.txHash ?? metadata.txHash,
            gasUsed: observed.metadata.gasUsed ?? metadata.gasUsed,
          },
          release: settlementLaneReleaseForStatus(observed.status),
        };
      });
    } catch (e) {
      const confirmedSettlementFailure = e instanceof SettlementTransactionFailedError;
      logSettlementLifecycle({
        lifecycle: confirmedSettlementFailure
          ? "activate_settlement_failed"
          : "activate_submit_error",
        elapsedMs: Date.now() - submitStartedAt,
        errorMessage: e instanceof Error ? e.message : String(e),
        errorName: e instanceof Error ? e.name : undefined,
      });
      if (!confirmedSettlementFailure) {
        this.reportInfraAlert(e);
      }
      throw e;
    }
  }

  private async observeActivationExecution(response: unknown): Promise<{
    status: DepositActivationResult["status"];
    metadata: SettlementTxMetadata;
  }> {
    if (!response || typeof response !== "object") {
      return { status: "submitted", metadata: emptySettlementTxMetadata() };
    }
    const waitForConfirmation = Reflect.get(response, "wait");
    if (typeof waitForConfirmation !== "function") {
      return { status: "submitted", metadata: extractSettlementTxMetadata(response) };
    }
    const responseMetadata = extractSettlementTxMetadata(response);
    try {
      const result = await Promise.race([
        (waitForConfirmation as () => Promise<unknown>).call(response),
        sleep(SETTLEMENT_CONFIRM_WAIT_TIMEOUT_MS).then(() => {
          throw new Error(
            `Activation confirmation timed out after ${SETTLEMENT_CONFIRM_WAIT_TIMEOUT_MS}ms`,
          );
        }),
      ]);
      if (!result) return { status: "submitted", metadata: responseMetadata };
      return {
        status: "confirmed",
        metadata: mergeSettlementTxMetadata(extractSettlementTxMetadata(result), responseMetadata),
      };
    } catch (err) {
      if (err instanceof SettlementTransactionFailedError) throw err;
      this.reportInfraAlert(err);
      return { status: "submitted", metadata: responseMetadata };
    }
  }

  private warnUnsupportedSettlement(kind: "redeem" | "merge"): void {
    if (kind === "redeem") {
      if (this.warnedRedeemUnsupported) return;
      this.warnedRedeemUnsupported = true;
    } else {
      if (this.warnedMergeUnsupported) return;
      this.warnedMergeUnsupported = true;
    }

    process.emitWarning(
      `LiveExchangeGateway ${kind}Positions skipped: installed @polymarket/clob-client-v2 does not expose a ${kind} API`,
      {
        code: kind === "redeem" ? "KRABS_REDEEM_UNSUPPORTED" : "KRABS_MERGE_UNSUPPORTED",
      },
    );
  }

  private reportInfraAlert(error: unknown): void {
    if (!this.onInfraAlert) return;
    const alert = classifySettlementInfraAlert(error);
    if (!alert) return;

    const lastRaisedAt = this.recentInfraAlerts.get(alert.code);
    if (lastRaisedAt && Date.now() - lastRaisedAt < RECENT_SETTLEMENT_SUBMISSION_TTL_MS) return;

    this.recentInfraAlerts.set(alert.code, Date.now());
    this.onInfraAlert(alert);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseMarketFeeInfoResult(
  raw: {
    fd?: { r?: number; e?: number; to?: boolean };
    mbf?: unknown;
    tbf?: unknown;
    maker_base_fee?: unknown;
    taker_base_fee?: unknown;
  } | null,
): MarketFeeInfoResult {
  const diagnostic = marketFeeDiagnostic(raw);
  const fd = raw?.fd;
  if (fd) {
    if (!Number.isFinite(fd.r)) {
      return {
        status: "api_invalid_fee_info",
        info: null,
        diagnostic: { ...diagnostic, fieldShape: "fd_invalid", message: "fd.r is missing" },
      };
    }
    // Mirror @polymarket/clob-client-v2@1.0.2 behavior: when fd.e is absent
    // or non-finite, the SDK caches `result.fd?.e ?? 0`. We do the same so
    // our local fee math agrees with the SDK's view of the market.
    return {
      status: "ok",
      info: {
        rate: Number(fd.r ?? 0),
        exponent: Number.isFinite(fd.e) ? Number(fd.e) : 0,
        takerOnly: !!fd.to,
      },
      diagnostic,
    };
  }
  if (diagnostic.takerBaseFeePresent || diagnostic.makerBaseFeePresent) {
    return {
      status: "api_unsupported_fee_info",
      info: null,
      diagnostic: {
        ...diagnostic,
        fieldShape: "base_fee_only",
        message: "base fee fields are present without fd rate/exponent",
      },
    };
  }
  return {
    status: "api_no_fee_info",
    info: null,
    diagnostic: {
      ...diagnostic,
      fieldShape: "no_fee_fields",
      message: "no fd or base fee fields present",
    },
  };
}

function marketFeeDiagnostic(
  raw: {
    fd?: unknown;
    mbf?: unknown;
    tbf?: unknown;
    maker_base_fee?: unknown;
    taker_base_fee?: unknown;
  } | null,
): MarketFeeInfoDiagnostic {
  const fdPresent = raw?.fd != null;
  const takerBaseFeePresent = raw?.tbf != null || raw?.taker_base_fee != null;
  const makerBaseFeePresent = raw?.mbf != null || raw?.maker_base_fee != null;
  return {
    fieldShape: fdPresent
      ? "fd"
      : takerBaseFeePresent || makerBaseFeePresent
        ? "base_fee_only"
        : "no_fee_fields",
    fdPresent,
    takerBaseFeePresent,
    makerBaseFeePresent,
  };
}

/**
 * SDK responses vary between raw arrays and paginated wrappers.
 * Normalize to a plain array regardless of shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractArray(raw: any): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw;
  return raw?.data ?? raw?.orders ?? raw?.trades ?? [];
}

/**
 * With `throwOnError=false` the CLOB client resolves to `{ error, status }`
 * instead of throwing. Re-throw it as an `Error` carrying the status so the
 * fetch classifier sees the same shape it would for a thrown ApiError.
 */
function throwIfReturnedError(raw: unknown): void {
  if (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    typeof (raw as Record<string, unknown>).error === "string"
  ) {
    const r = raw as Record<string, unknown>;
    const err = new Error(r.error as string);
    if (typeof r.status === "number") Object.assign(err, { status: r.status });
    throw err;
  }
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const response: unknown = Reflect.get(error, "response");
  const status: unknown =
    response && typeof response === "object"
      ? Reflect.get(response, "status")
      : Reflect.get(error, "status");
  return status === 404 || status === "404";
}

function isReturnedNotFound(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const status: unknown = Reflect.get(raw, "status");
  return (status === 404 || status === "404") && Reflect.get(raw, "error") != null;
}

function cancelAcknowledged(raw: unknown, orderId: string): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const canceled: unknown = Reflect.get(raw, "canceled");
  return (
    Array.isArray(canceled) &&
    canceled.some((candidate) => typeof candidate === "string" && candidate === orderId)
  );
}

function requiredText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function requiredNumber(value: unknown, allowZero = false): boolean {
  if (typeof value === "string" && value.trim().length === 0) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0);
}

function requiredTimestamp(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (!requiredText(value)) return false;
  const text = String(value).trim();
  return (Number.isFinite(Number(text)) && Number(text) > 0) || Number.isFinite(Date.parse(text));
}

function assertReliableOpenOrderRow(row: Record<string, unknown>): void {
  const total = Number(row.original_size ?? row.size);
  const filled = Number(row.size_matched);
  const side = typeof row.side === "string" ? row.side.toUpperCase() : "";
  const status = typeof row.status === "string" ? row.status.toUpperCase() : "";
  if (
    !requiredText(row.id) ||
    !requiredText(row.asset_id) ||
    (side !== "BUY" && side !== "SELL") ||
    ![
      "LIVE",
      "OPEN",
      "MATCHED",
      "FILLED",
      "PARTIALLY_FILLED",
      "CANCELLED",
      "CANCELED",
      "EXPIRED",
      "INVALID",
      "REJECTED",
    ].includes(status) ||
    !requiredNumber(row.price) ||
    !requiredNumber(total) ||
    !requiredNumber(filled, true) ||
    filled > total ||
    !requiredTimestamp(row.created_at)
  ) {
    throw new FetchParseError("malformed open-order row");
  }
}

function assertReliableFillRow(raw: Record<string, unknown>, fills: readonly ExchangeFill[]): void {
  const rawSide = typeof raw.side === "string" ? raw.side.toUpperCase() : "";
  if (
    !requiredText(raw.id) ||
    !requiredText(raw.asset_id) ||
    (rawSide !== "BUY" && rawSide !== "SELL") ||
    !requiredNumber(raw.price) ||
    !requiredNumber(raw.size) ||
    !requiredTimestamp(raw.match_time)
  ) {
    throw new FetchParseError("malformed fill row");
  }
  const makerOrders = Array.isArray(raw.maker_orders)
    ? (raw.maker_orders as Array<Record<string, unknown>>)
    : [];
  for (const fill of fills) {
    const source =
      fill.orderId === raw.taker_order_id
        ? raw
        : makerOrders.find((order) => order.order_id === fill.orderId);
    const side = typeof source?.side === "string" ? source.side.toUpperCase() : "";
    if (
      !requiredText(fill.fillId) ||
      !requiredText(fill.orderId) ||
      !requiredText(String(fill.tokenId)) ||
      (side !== "BUY" && side !== "SELL") ||
      !requiredNumber(fill.price) ||
      !requiredNumber(fill.size) ||
      !requiredTimestamp(fill.timestamp)
    ) {
      throw new FetchParseError("malformed fill row");
    }
  }
}

function assertAuthenticatedFillRow(
  raw: Record<string, unknown>,
  fills: readonly ExchangeFill[],
): void {
  const traderSide = typeof raw.trader_side === "string" ? raw.trader_side.toUpperCase() : "";
  if (
    (traderSide !== "MAKER" && traderSide !== "TAKER") ||
    (traderSide === "MAKER" &&
      (!Array.isArray(raw.maker_orders) ||
        raw.maker_orders.some(
          (order) => !order || typeof order !== "object" || Array.isArray(order),
        ))) ||
    fills.length === 0
  ) {
    throw new FetchParseError("malformed authenticated fill row");
  }
}

/**
 * Strict variant of {@link extractArray}: an unrecognized (non-array, no
 * `data`/`orders`/`trades`) payload is a parse failure — NOT an empty snapshot.
 * Treating it as empty is exactly what caused phantom cancellations (#36).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractArrayOrThrow(raw: any): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw;
  const nested = raw?.data ?? raw?.orders ?? raw?.trades;
  if (Array.isArray(nested)) return nested;
  throw new FetchParseError(`expected array-shaped payload, got ${typeof raw}`);
}

function extractOrderId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;

  const candidate: unknown = Reflect.get(raw, "orderID") ?? Reflect.get(raw, "id");
  if (typeof candidate !== "string") return null;

  const orderId = candidate.trim();
  return orderId.length > 0 ? orderId : null;
}

// The Polymarket relayer wraps *every* non-2xx response — including benign
// application-level rejections — in a generic
// `{"error":"request error","status":400,...,"data":{"error":"PRECHECK_SKIPPED: ..."}}`
// envelope. The ONE approved benign case is a redeem whose on-chain outcome-token
// balance is already zero (already redeemed / dust / collateral-token divergence):
// the relayer answers HTTP 400 with `PRECHECK_SKIPPED: redeem skipped: zero
// position balance`. The relayer *responded* — it is not unavailable — and there
// is simply nothing to settle. Without this guard the outer "request error" string
// below would mislabel these as a relayer outage (observed: 100% of
// POLYMARKET_RELAYER_UNAVAILABLE alerts in prod were zero-balance skips).
//
// The predicate is intentionally narrow: it requires BOTH the `PRECHECK_SKIPPED`
// marker AND the `zero position balance` reason. Any other `PRECHECK_SKIPPED`
// rejection is left to fall through to the real-error classification below — we do
// not blanket-suppress the whole precheck-skip family.
function isBenignSettlementPrecheckSkip(normalizedMessage: string): boolean {
  return (
    normalizedMessage.includes("precheck_skipped") &&
    normalizedMessage.includes("zero position balance")
  );
}

function isDuplicateInFlightSettlementSubmit(normalizedMessage: string): boolean {
  return (
    normalizedMessage.includes("duplicate in-flight transaction") &&
    normalizedMessage.includes("nonce")
  );
}

export function classifySettlementInfraAlert(error: unknown): {
  code: string;
  severity: "warning" | "error";
  source: string;
  message: string;
  details?: Record<string, unknown> | undefined;
} | null {
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const normalized = rawMessage.toLowerCase();

  // A benign precheck skip is an expected, non-actionable outcome (the per-condition
  // result is already recorded in the redeem_log). Never raise an operator infra
  // alert for it — and short-circuit before the transport-error branch that would
  // otherwise match the relayer's "request error" envelope wrapper.
  if (isBenignSettlementPrecheckSkip(normalized)) return null;

  if (isDuplicateInFlightSettlementSubmit(normalized)) {
    return {
      code: "POLYMARKET_RELAYER_DUPLICATE_IN_FLIGHT",
      severity: "warning",
      source: "polymarket-relayer",
      message: "Polymarket relayer reports settlement already in flight - Krabs will retry.",
      details: { rawMessage },
    };
  }

  if (
    normalized.includes("429") ||
    normalized.includes("rate limit") ||
    normalized.includes("throughput limit") ||
    normalized.includes("exceeded its compute units")
  ) {
    return {
      code: "POLYGON_RPC_RATE_LIMITED",
      severity: "error",
      source: "polygon-rpc",
      message: "Polygon RPC rate limited — settlement may stall until quota resets.",
      details: { rawMessage },
    };
  }

  if (
    normalized.includes("503") ||
    normalized.includes("no healthy upstream") ||
    normalized.includes("http request failed")
  ) {
    return {
      code: "POLYGON_RPC_UNAVAILABLE",
      severity: "error",
      source: "polygon-rpc",
      message: "Polygon RPC unavailable — settlement retries are degraded.",
      details: { rawMessage },
    };
  }

  if (normalized.includes("401") || normalized.includes("invalid authorization")) {
    return {
      code: "POLYMARKET_RELAYER_AUTH",
      severity: "error",
      source: "polymarket-relayer",
      message: "Polymarket relayer authorization failed — settlement submissions are blocked.",
      details: { rawMessage },
    };
  }

  if (normalized.includes("connection error") || normalized.includes("request error")) {
    return {
      code: "POLYMARKET_RELAYER_UNAVAILABLE",
      severity: "warning",
      source: "polymarket-relayer",
      message: "Polymarket relayer unavailable — settlement will retry automatically.",
      details: { rawMessage },
    };
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
