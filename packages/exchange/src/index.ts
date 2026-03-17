// @plankton/exchange — ExchangeGateway + MarketDataGateway implementations

// Re-export domain interfaces for convenience
export type {
  ExchangeGateway,
  MarketDataGateway,
  MarketDiscoveryGateway,
  PlaceOrderParams,
  CancelOrderParams,
  PlaceOrderResult,
  CancelOrderResult,
  ExchangeOrder,
  ExchangeFill,
  ExchangeBalance,
  ClobMarket,
} from "@plankton/domain";

// Simulation
export {
  SimulationExchangeGateway,
  type SimulationExchangeConfig,
  type FillMode,
} from "./simulation/exchange-gateway.js";
export { SimulationMarketDataGateway } from "./simulation/market-data-gateway.js";

// Live
export { LiveExchangeGateway, type LiveExchangeConfig } from "./live/exchange-gateway.js";
export { LiveMarketDataGateway, type LiveMarketDataConfig } from "./live/market-data-gateway.js";

// Gamma discovery + resolution
export { GammaMarketDiscoveryGateway, type GammaDiscoveryConfig } from "./gamma/index.js";
export { GammaResolutionClient, type GammaResolutionConfig, type GammaMarketInfo } from "./gamma/index.js";

// Shared utilities
export { classifyError } from "./errors.js";
export {
  mapOpenOrder,
  mapTrade,
  mapMarket,
  mapOrderBook,
  mapBalance,
  mapGammaMarket,
  mapGammaPricing,
  toDomainSide,
  toSdkSide,
  toSdkTickSize,
  type GammaPricing,
} from "./mappers.js";
