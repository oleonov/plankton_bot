/**
 * Gateway factory — maps runtime mode to the correct MarketDataGateway + ExchangeGateway pair.
 */

import type { MarketDataGateway, ExchangeGateway } from "@plankton/domain";
import {
  SimulationMarketDataGateway,
  SimulationExchangeGateway,
  LiveMarketDataGateway,
  LiveExchangeGateway,
} from "@plankton/exchange";

export interface CreateGatewaysInput {
  runtimeMode: "simulation" | "paper" | "live-lite";
  polyClient?: unknown;
  traderAddress?: string | undefined;
  /** Optional slug filter passed to live market data gateway. */
  slugFilter?: ((slug: string) => boolean) | undefined;
  /** Initial USDC balance for simulation/paper exchange gateway. Ignored in live-lite. */
  initialBalanceUsdc?: number;
}

export interface CreateGatewaysResult {
  marketDataGateway: MarketDataGateway;
  exchangeGateway: ExchangeGateway;
  modeLabel: string;
  marketDataSource: "live" | "simulation";
  executionMode: "simulation" | "live";
}

export function createGateways(input: CreateGatewaysInput): CreateGatewaysResult {
  const { runtimeMode, polyClient, traderAddress, slugFilter, initialBalanceUsdc } = input;

  if (runtimeMode === "simulation") {
    return {
      marketDataGateway: new SimulationMarketDataGateway(),
      exchangeGateway: new SimulationExchangeGateway(
        initialBalanceUsdc !== undefined ? { initialBalanceUsdc } : undefined,
      ),
      modeLabel: "simulation",
      marketDataSource: "simulation",
      executionMode: "simulation",
    };
  }

  if (!polyClient) {
    throw new Error(`polyClient is required for ${runtimeMode} mode`);
  }

  if (runtimeMode === "paper") {
    return {
      marketDataGateway: new LiveMarketDataGateway({ client: polyClient, slugFilter }),
      exchangeGateway: new SimulationExchangeGateway(
        initialBalanceUsdc !== undefined ? { initialBalanceUsdc } : undefined,
      ),
      modeLabel: "paper",
      marketDataSource: "live",
      executionMode: "simulation",
    };
  }

  // live-lite
  const liveExchangeConfig = {
    client: polyClient,
    ...(traderAddress ? { traderAddress } : {}),
  };
  return {
    marketDataGateway: new LiveMarketDataGateway({ client: polyClient, slugFilter }),
    exchangeGateway: new LiveExchangeGateway(liveExchangeConfig),
    modeLabel: "live-lite",
    marketDataSource: "live",
    executionMode: "live",
  };
}
