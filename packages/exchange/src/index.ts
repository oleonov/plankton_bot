// @krabs/exchange — ExchangeGateway + MarketDataGateway implementations

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
} from "@krabs/domain";

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
export { type UserEventStreamAuth } from "./live/user-event-stream.js";
export {
  createCollateralResolver,
  type CollateralResolver,
  type CollateralResolverInput,
  type CreateCollateralResolverOptions,
} from "./live/collateral-resolver.js";
export { buildClobAxiosAgent, type ClobAxiosAgentOptions } from "./live/axios-agent.js";
export { installClobErrorSanitizer, sanitizeAxiosError } from "./live/clob-error-sanitizer.js";
export {
  PolymarketDataPositionReader,
  aggregatePolymarketPositions,
  fetchPolymarketPositions,
  normalizePolymarketPosition,
  type FetchLike,
  type FetchPolymarketPositionsOptions,
  type PolymarketDataPosition,
  type PolymarketPositionAggregate,
  type PolymarketPositionReader,
} from "./polymarket-data-api.js";
export {
  DataApiTradeCountProvider,
  DATA_API_DEFAULT_BASE_URL,
  DATA_API_DEFAULT_CACHE_TTL_MS,
  DATA_API_DEFAULT_TIMEOUT_MS,
  DATA_API_DEFAULT_MAX_CACHE_ENTRIES,
  DATA_API_DEFAULT_PREFETCH_CONCURRENCY,
  type DataApiTradeCountProviderOptions,
  type TradeCountFetchEvent,
  type TradeCountObserver,
} from "./data-api-trade-count-provider.js";

// Gamma discovery + resolution
export { GammaMarketDiscoveryGateway, type GammaDiscoveryConfig } from "./gamma/index.js";
export {
  GammaResolutionClient,
  type GammaResolutionConfig,
  type GammaMarketInfo,
} from "./gamma/index.js";

// Shared utilities
export { classifyError } from "./errors.js";
export {
  redactSensitive,
  redactText,
  sanitizeErrorDetails,
  sanitizeErrorMessage,
  sanitizeLogArg,
} from "./redaction.js";
export {
  mapOpenOrder,
  mapTrade,
  mapTradeToPersonalFills,
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
