// @krabs/domain — pure types, enums, and branded IDs. Zero runtime deps.
export * from "./enums.js";
export * from "./ids.js";
export * from "./types.js";
export * from "./events.js";
export * from "./commands.js";
export * from "./gateway.js";
export * from "./repositories.js";
export * from "./bus.js";
export * from "./runtime-control.js";
export * from "./slug-pattern.js";
export * from "./trading-state.js";
export * from "./algo-engine.js";
export * from "./market-selection.js";
export * from "./polymarket-fees.js";
export { SelectionRuleEngine, normalizeSelectionPattern } from "./selection-rule-engine.js";
export type { PreEntryInput } from "./market-selection.js";
export {
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_BUY_CAPACITY_POLICY,
  DEFAULT_SELL_CAPACITY_POLICY,
  DEFAULT_ORDER_CAPACITY_POLICY,
  DEFAULT_OPPORTUNISTIC_TAKER_POLICY,
  DEFAULT_DEAD_SIDE_GUARD,
  DEFAULT_PRICING_POLICY,
  DEFAULT_TELEMETRY,
  DEFAULT_ORDER_LIFETIME_POLICY,
  DEFAULT_EXIT_REPRICE_ON_DOWNPRICE_POLICY,
  DEFAULT_ENTRY_MIN_MARKET_AGE_SECONDS,
  DEFAULT_R23_DIP_TRIGGER_POLICY,
  DEFAULT_LOSS_EXIT_POLICY,
  DEFAULT_DEPOSIT_ACTIVATION_POLICY,
  parseExecutionPolicyJson,
  serializeExecutionPolicy,
} from "./execution-policy.js";
export type { ParseResult } from "./execution-policy.js";
export {
  DEFAULT_PROFIT_TARGET_POLICY,
  D8_HOLD_SECONDS_MIN,
  D8_THRESHOLD_BUCKETS,
  evaluateD8ProfitRatio,
  getProfitThresholdByPrice,
} from "./d8-profit-target.js";
export type { D8EvalContext, D8EvalResult } from "./d8-profit-target.js";
export { evaluateD9LossExit, H5_WIDE_COHORT_GUARD_REASON } from "./d9-loss-exit.js";
export type {
  D9LossExitCohortGuardPolicy,
  D9LossExitContext,
  D9LossExitPolicy,
  D9Result,
} from "./d9-loss-exit.js";
export {
  DEFAULT_DUST_ABANDONMENT_POLICY,
  isAbandoned,
  shouldMarkAbandoned,
  shouldRecoverFromPriceMove,
} from "./dust-abandonment.js";
export {
  DEFAULT_REPRICE_CHAIN_POLICY,
  shouldBlockRepriceChain,
  nextRepriceChainState,
} from "./reprice-chain.js";
export type { NextRepriceChainState } from "./reprice-chain.js";
export { evaluateMinMarketAge } from "./min-market-age.js";
export type {
  MinMarketAgeArgs,
  MinMarketAgeResult,
  MinMarketAgeReasonCode,
} from "./min-market-age.js";
export {
  R23_DIP_TRIGGER_RULE_ID,
  R23_DIP_FIRED_REASON,
  R23_DISABLED_REASON,
  R23_EXISTING_POSITION_REASON,
  R23_INVALID_PRICE_REASON,
  R23_NO_HISTORY_REASON,
  R23_NO_DIP_REASON,
  evaluateR23DipTrigger,
} from "./r23-dip-trigger.js";
export type { R23DipTriggerContext, R23DipTriggerResult } from "./r23-dip-trigger.js";
export { deriveCategory, HEURISTIC_CATEGORIES } from "./category.js";
export type { HeuristicCategory } from "./category.js";
export {
  loadLogisticModel,
  predictScore,
  ModelArtifactSchemaError,
} from "./scoring/logistic-scorer.js";
export type { LogisticModel, LogisticModelDecile } from "./scoring/logistic-scorer.js";
export { buildFeatureRow } from "./scoring/feature-builder.js";
export type { FeatureRowInput } from "./scoring/feature-builder.js";
