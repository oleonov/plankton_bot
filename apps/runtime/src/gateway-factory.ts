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
}

export interface CreateGatewaysResult {
  marketDataGateway: MarketDataGateway;
  exchangeGateway: ExchangeGateway;
  modeLabel: string;
  marketDataSource: "live" | "simulation";
  executionMode: "simulation" | "live";
}

export function createGateways(input: CreateGatewaysInput): CreateGatewaysResult {
  const { runtimeMode, polyClient } = input;

  if (runtimeMode === "simulation") {
    return {
      marketDataGateway: new SimulationMarketDataGateway(),
      exchangeGateway: new SimulationExchangeGateway(),
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
      marketDataGateway: new LiveMarketDataGateway({ client: polyClient }),
      exchangeGateway: new SimulationExchangeGateway(),
      modeLabel: "paper",
      marketDataSource: "live",
      executionMode: "simulation",
    };
  }

  // live-lite
  return {
    marketDataGateway: new LiveMarketDataGateway({ client: polyClient }),
    exchangeGateway: new LiveExchangeGateway({ client: polyClient }),
    modeLabel: "live-lite",
    marketDataSource: "live",
    executionMode: "live",
  };
}
