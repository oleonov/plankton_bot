// ─── Opaque branded ID types ──────────────────────────────────────────────────
//
// Pattern: `string & { readonly __brand: "XId" }`
// - Prevents accidental cross-assignment between different ID kinds.
// - Carries zero runtime overhead (the __brand property never exists at runtime).
// - MarketId is intentionally absent per F1 resolution: use TokenId instead.

export type TokenId = string & { readonly __brand: "TokenId" };
export type ConditionId = string & { readonly __brand: "ConditionId" };
export type OrderId = string & { readonly __brand: "OrderId" };
export type FillId = string & { readonly __brand: "FillId" };
export type PositionId = string & { readonly __brand: "PositionId" };
export type ClientOrderId = string & { readonly __brand: "ClientOrderId" };
/** uuid v4 — uniquely identifies a single command dispatch attempt. */
export type CommandId = string & { readonly __brand: "CommandId" };
export type LotId = string & { readonly __brand: "LotId" };
export type BotRunId = string & { readonly __brand: "BotRunId" };

// ─── Constructor helpers ──────────────────────────────────────────────────────
//
// These are thin casts — they do NOT generate IDs; callers supply the raw
// string that comes from the exchange / database / YAML config.

export function createTokenId(raw: string): TokenId {
  return raw as TokenId;
}

export function createConditionId(raw: string): ConditionId {
  return raw as ConditionId;
}

export function createOrderId(raw: string): OrderId {
  return raw as OrderId;
}

export function createFillId(raw: string): FillId {
  return raw as FillId;
}

export function createPositionId(raw: string): PositionId {
  return raw as PositionId;
}

export function createLotId(raw: string): LotId {
  return raw as LotId;
}

export function createCommandId(raw: string): CommandId {
  return raw as CommandId;
}

export function createBotRunId(raw: string): BotRunId {
  return raw as BotRunId;
}

export type ScorecardId = string & { readonly __brand: "ScorecardId" };
export function createScorecardId(raw: string): ScorecardId {
  return raw as ScorecardId;
}

export type SwitchId = string & { readonly __brand: "SwitchId" };
export function createSwitchId(raw: string): SwitchId {
  return raw as SwitchId;
}

export type ReportId = string & { readonly __brand: "ReportId" };
export function createReportId(raw: string): ReportId {
  return raw as ReportId;
}

export type ImportId = string & { readonly __brand: "ImportId" };
export function createImportId(raw: string): ImportId {
  return raw as ImportId;
}
