/**
 * Live ExchangeGateway — wraps @polymarket/clob-client for order lifecycle.
 *
 * The SDK ClobClient is accepted as `unknown` in the public config interface
 * to prevent SDK types from leaking into @plankton/domain consumers.
 */

import { getContractConfig } from "@polymarket/clob-client";
import type {
  ExchangeGateway,
  PlaceOrderParams,
  CancelOrderParams,
  PlaceOrderResult,
  CancelOrderResult,
  ExchangeOrder,
  ExchangeFill,
  ExchangeBalance,
  TokenId,
  ExchangeUserEventStream,
  ExchangeUserOrderEvent,
  ExchangeUserTradeEvent,
} from "@plankton/domain";
import { encodeFunctionData, parseAbi, zeroHash } from "viem";
import { classifyError } from "../errors.js";
import { redactSensitive, sanitizeLogArg } from "../redaction.js";
import {
  mapOpenOrder,
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

export interface LiveExchangeConfig {
  /** ClobClient instance — typed as unknown to avoid SDK type leakage. */
  client: unknown;
  /** Optional relayer settlement client for on-chain redeem/merge actions. */
  settlementClient?: unknown;
  /** Wallet/funder address used to extract personal fills from trade rows. */
  traderAddress?: string | null;
  userWsAuth?: UserEventStreamAuth | null;
  createWebSocket?: ((url: string) => UserEventWebSocketLike) | undefined;
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
  for (const probe of ["txHash", "hash", "transactionHash", "blockNumber", "gasUsed", "status"]) {
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
  private warnedRedeemUnsupported = false;
  private warnedMergeUnsupported = false;
  private readonly recentRedeemSubmissions = new Map<string, number>();
  private readonly recentInfraAlerts = new Map<string, number>();

  constructor(config: LiveExchangeConfig) {
    this.client = config.client;
    this.settlementClient = config.settlementClient ?? null;
    this.traderAddress = config.traderAddress?.trim().toLowerCase() ?? null;
    this.userWsAuth = config.userWsAuth ?? null;
    this.createWebSocket = config.createWebSocket;
    this.onInfraAlert = config.onInfraAlert ?? null;
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    try {
      const userOrder = {
        tokenID: String(params.tokenId),
        price: params.price,
        size: params.size,
        side: toSdkSide(params.side),
        ...(params.expiration !== undefined ? { expiration: params.expiration } : {}),
      };

      const options = {
        tickSize: toSdkTickSize(params.tickSize),
        negRisk: params.negRisk,
      };

      const result = params.postOnly
        ? await this.postMakerOnlyOrder(userOrder, options, params.orderType)
        : await this.client.createAndPostOrder(userOrder, options, params.orderType);
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
      await this.client.cancelOrder({ orderID: params.orderId });
      return { success: true };
    } catch (err) {
      const { code, message } = classifyError(err);
      return { success: false, errorCode: code, errorMessage: message };
    }
  }

  async cancelAllOrders(): Promise<CancelOrderResult> {
    try {
      await this.client.cancelAll();
      return { success: true };
    } catch (err) {
      const { code, message } = classifyError(err);
      return { success: false, errorCode: code, errorMessage: message };
    }
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    try {
      const raw = await this.client.getOpenOrders();
      return extractArray(raw).map((o: Record<string, unknown>) => mapOpenOrder(o));
    } catch {
      return [];
    }
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
      const raw = await this.client.getTrades({
        after: Math.floor(sinceMs / 1000).toString(),
      });
      return extractArray(raw).flatMap((trade: Record<string, unknown>) =>
        this.traderAddress ? mapTradeToPersonalFills(trade, this.traderAddress) : [mapTrade(trade)],
      );
    } catch {
      return [];
    }
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

  async redeemPositions(conditionIds: string[]): Promise<void> {
    const settlementExecute = this.getSettlementExecuteMethod();
    if (settlementExecute) {
      const requests = await this.buildRedeemRequests(conditionIds);
      if (requests.length === 0) return;

      const submitStartedAt = Date.now();
      try {
        const response = await settlementExecute(
          requests.map((request) => request.tx),
          `redeem positions: ${requests.map((request) => request.conditionId).join(",")}`,
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
        await this.observeSettlementExecution(response, requests);
      } catch (e) {
        logSettlementLifecycle({
          lifecycle: "redeem_submit_error",
          conditionIds: requests.map((r) => r.conditionId),
          elapsedMs: Date.now() - submitStartedAt,
          errorMessage: e instanceof Error ? e.message : String(e),
          errorName: e instanceof Error ? e.name : undefined,
          revertReason:
            e && typeof e === "object" && "reason" in e
              ? (e as { reason?: unknown }).reason
              : undefined,
        });
        this.reportInfraAlert(e);
        console.error(
          `Failed to submit relayer redeem for conditions ${requests.map((r) => r.conditionId).join(",")}:`,
          sanitizeLogArg(e),
        );
        throw e;
      }
      return;
    }

    const redeemOne = this.getClientMethod("postRedeem") ?? this.getClientMethod("redeem");
    const redeemBatch = this.getClientMethod("redeemPositions");
    if (!redeemOne && !redeemBatch) {
      this.warnUnsupportedSettlement("redeem");
      return;
    }

    if (redeemBatch) {
      try {
        await redeemBatch(conditionIds);
      } catch (e) {
        console.error(`Failed to redeem conditions ${conditionIds.join(",")}:`, sanitizeLogArg(e));
        throw e;
      }
      return;
    }

    for (const conditionId of conditionIds) {
      try {
        await redeemOne!({ conditionId });
      } catch (e) {
        console.error(`Failed to redeem ${conditionId}:`, sanitizeLogArg(e));
        throw e;
      }
    }
  }

  hasPendingRedeemSubmission(conditionId: string): boolean {
    return this.wasRedeemRecentlySubmitted(conditionId);
  }

  async mergePositions(merges: { conditionId: string; amount: number }[]): Promise<void> {
    const settlementExecute = this.getSettlementExecuteMethod();
    if (settlementExecute) {
      const requests = await this.buildMergeRequests(merges);
      if (requests.length === 0) return;

      try {
        const response = await settlementExecute(
          requests.map((request) => request.tx),
          `merge positions: ${requests.map((request) => request.conditionId).join(",")}`,
        );
        await this.observeSettlementExecution(response, requests);
      } catch (e) {
        this.reportInfraAlert(e);
        console.error(
          `Failed to submit relayer merge for conditions ${requests.map((r) => r.conditionId).join(",")}:`,
          sanitizeLogArg(e),
        );
        throw e;
      }
      return;
    }

    // Fallback: use client merge if available
    const mergeOne = this.getClientMethod("postMerge") ?? this.getClientMethod("merge");
    if (!mergeOne) {
      this.warnUnsupportedSettlement("merge");
      return;
    }

    for (const merge of merges) {
      try {
        await mergeOne({ conditionId: merge.conditionId, amount: merge.amount });
      } catch (e) {
        console.error(`Failed to merge ${merge.conditionId}:`, sanitizeLogArg(e));
        throw e;
      }
    }
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

  private async buildMergeRequests(
    merges: { conditionId: string; amount: number }[],
  ): Promise<SettlementRequest[]> {
    const requests: SettlementRequest[] = [];
    for (const merge of merges) {
      try {
        const request = await this.buildMergeRequest(merge.conditionId, merge.amount);
        if (request) requests.push(request);
      } catch (e) {
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
    const data = encodeFunctionData({
      abi: CTF_MERGE_ABI,
      functionName: "mergePositions",
      args: [
        contracts.collateral as `0x${string}`,
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

  private async buildRedeemRequests(conditionIds: string[]): Promise<SettlementRequest[]> {
    const requests: SettlementRequest[] = [];
    for (const conditionId of conditionIds) {
      if (this.wasRedeemRecentlySubmitted(conditionId)) continue;
      const request = await this.buildRedeemRequest(conditionId);
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

  private async buildRedeemRequest(conditionId: string): Promise<SettlementRequest | null> {
    const market = await this.client.getMarket(conditionId);
    const tokenIds = this.extractMarketTokenIds(market);
    if (tokenIds.length === 0) {
      logSettlementLifecycle({ lifecycle: "redeem_skip_no_tokens", conditionId });
      return null;
    }

    const chainId = this.getChainId();
    const contracts = getContractConfig(chainId);
    const balances = await Promise.all(
      tokenIds.map((tokenId) => this.getRawPositionBalance(tokenId)),
    );
    const balanceStrings = balances.map((b) => b.toString());

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
      const data = encodeFunctionData({
        abi: NEG_RISK_REDEEM_ABI,
        functionName: "redeemPositions",
        args: [conditionId as `0x${string}`, balances],
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

    const indexSets = tokenIds.map((_, index) => 1n << BigInt(index));
    const data = encodeFunctionData({
      abi: CTF_REDEEM_ABI,
      functionName: "redeemPositions",
      args: [
        contracts.collateral as `0x${string}`,
        zeroHash,
        conditionId as `0x${string}`,
        indexSets,
      ],
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
  ): Promise<void> {
    if (!response || typeof response !== "object") return;
    const waitForConfirmation = Reflect.get(response, "wait");
    if (typeof waitForConfirmation !== "function") return;

    const conditionIds = requests.map((r) => r.conditionId);
    const responseShape = describeShape(response);

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
          return;
        }
        throw new Error("Settlement transaction failed or returned empty result");
      }

      logSettlementLifecycle({
        lifecycle: "redeem_wait_result",
        conditionIds,
        elapsedMs,
        resultShape: describeShape(result),
      });
      this.clearPendingRedeemSubmissions(requests);
    } catch (err) {
      const elapsedMs = Date.now() - waitStartedAt;
      const message = err instanceof Error ? err.message : String(err);
      if (
        message !== "Settlement transaction failed or returned empty result" // already logged above
      ) {
        logSettlementLifecycle({
          lifecycle: "redeem_wait_error",
          conditionIds,
          elapsedMs,
          errorMessage: message,
          errorName: err instanceof Error ? err.name : undefined,
          responseShape,
        });
      }
      if (
        message !== "Settlement transaction failed or returned empty result" &&
        (await this.verifySettlementBalancesCleared(requests, "redeem_postcheck_after_wait_error"))
      ) {
        this.clearPendingRedeemSubmissions(requests);
        return;
      }
      throw err;
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

  private warnUnsupportedSettlement(kind: "redeem" | "merge"): void {
    if (kind === "redeem") {
      if (this.warnedRedeemUnsupported) return;
      this.warnedRedeemUnsupported = true;
    } else {
      if (this.warnedMergeUnsupported) return;
      this.warnedMergeUnsupported = true;
    }

    process.emitWarning(
      `LiveExchangeGateway ${kind}Positions skipped: installed @polymarket/clob-client does not expose a ${kind} API`,
      {
        code: kind === "redeem" ? "PLANKTON_REDEEM_UNSUPPORTED" : "PLANKTON_MERGE_UNSUPPORTED",
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

/**
 * SDK responses vary between raw arrays and paginated wrappers.
 * Normalize to a plain array regardless of shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractArray(raw: any): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw;
  return raw?.data ?? raw?.orders ?? raw?.trades ?? [];
}

function extractOrderId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;

  const candidate = Reflect.get(raw, "orderID") ?? Reflect.get(raw, "id");
  if (typeof candidate !== "string") return null;

  const orderId = candidate.trim();
  return orderId.length > 0 ? orderId : null;
}

function classifySettlementInfraAlert(error: unknown): {
  code: string;
  severity: "warning" | "error";
  source: string;
  message: string;
  details?: Record<string, unknown> | undefined;
} | null {
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const normalized = rawMessage.toLowerCase();

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
