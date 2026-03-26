/**
 * Live ExchangeGateway — wraps @polymarket/clob-client for order lifecycle.
 *
 * The SDK ClobClient is accepted as `unknown` in the public config interface
 * to prevent SDK types from leaking into @plankton/domain consumers.
 */

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
} from "@plankton/domain";
import { classifyError } from "../errors.js";
import { mapOpenOrder, mapTrade, mapBalance, toSdkSide, toSdkTickSize } from "../mappers.js";

export interface LiveExchangeConfig {
  /** ClobClient instance — typed as unknown to avoid SDK type leakage. */
  client: unknown;
}

export class LiveExchangeGateway implements ExchangeGateway {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;

  constructor(config: LiveExchangeConfig) {
    this.client = config.client;
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

      const result = await this.client.createAndPostOrder(userOrder, options, params.orderType);
      const orderId = result?.orderID ?? result?.id ?? "";

      return { success: true, orderId: String(orderId) };
    } catch (err) {
      const { code, message } = classifyError(err);
      return { success: false, errorCode: code, errorMessage: message };
    }
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
      return extractArray(raw).map((t: Record<string, unknown>) => mapTrade(t));
    } catch {
      return [];
    }
  }

  async getBalances(): Promise<ExchangeBalance[]> {
    try {
      const raw = await this.client.getBalanceAllowance();
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
    return Number(raw?.balance ?? 0);
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
