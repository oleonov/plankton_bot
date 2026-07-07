import type { NormalizedMarket, V4SelectionCategory, EntryCategoryGateClass } from "@krabs/domain";
import {
  categoryQualityBucket,
  deriveV4SelectionCategory,
  mapGammaTagsToCategory,
} from "@krabs/domain";

export type EntryCategoryGateKind = "first_entry" | "ladder_or_scale_in";
export type EntryCategorySource = "gamma_tag" | "derived" | "none";
export type EntryCategoryAgreement = "agree" | "disagree" | "gamma_only" | "derived_only" | "none";

export interface EntryCategoryGatePayload {
  tokenId: string;
  conditionId: string;
  slug: string | null;
  question: string | null;
  timestamp: string;
  decisionRuleId: string | null;
  signalReason: string;
  entryKind: EntryCategoryGateKind;
  category: V4SelectionCategory | null;
  derivedCategory: V4SelectionCategory | null;
  gammaCategory: V4SelectionCategory | null;
  gammaTags: readonly string[] | null;
  categorySource: EntryCategorySource;
  agreement: EntryCategoryAgreement;
  gateClass: EntryCategoryGateClass;
}

export interface EntryCategoryGateSignalFields {
  entryCategory: V4SelectionCategory | null;
  entryCategoryGateClass: EntryCategoryGateClass | null;
  entryCategoryPayloadJson: string | null;
}

export interface EntryCategoryGateInputs {
  market: NormalizedMarket;
  nowMs: number;
  decisionRuleId: string | null;
  signalReason: string;
  buyCount: number;
}

export function computeEntryCategoryGateSignalFields(
  inputs: EntryCategoryGateInputs,
): EntryCategoryGateSignalFields {
  const payload = computeEntryCategoryGatePayload(inputs);
  return {
    entryCategory: payload.category,
    entryCategoryGateClass: payload.gateClass,
    entryCategoryPayloadJson: JSON.stringify(payload),
  };
}

export function computeEntryCategoryGatePayload(
  inputs: EntryCategoryGateInputs,
): EntryCategoryGatePayload {
  const { market, nowMs, decisionRuleId, signalReason, buyCount } = inputs;

  const derivedCategory = deriveV4SelectionCategory(
    market.slug,
    market.eventSlug ?? null,
    market.question,
  );
  const gammaTags = market.tags ?? null;
  const gammaCategory = mapGammaTagsToCategory(gammaTags);
  const category = gammaCategory ?? derivedCategory;
  const categorySource = resolveSource(gammaCategory, derivedCategory);
  const agreement = resolveAgreement(gammaCategory, derivedCategory);
  const gateClass: EntryCategoryGateClass =
    category == null ? "UNKNOWN" : categoryQualityBucket(category);

  return {
    tokenId: String(market.tokenId),
    conditionId: String(market.conditionId),
    slug: market.slug ?? null,
    question: market.question ?? null,
    timestamp: new Date(nowMs).toISOString(),
    decisionRuleId,
    signalReason,
    entryKind: buyCount === 0 ? "first_entry" : "ladder_or_scale_in",
    category,
    derivedCategory,
    gammaCategory,
    gammaTags,
    categorySource,
    agreement,
    gateClass,
  };
}

function resolveSource(
  gammaCategory: V4SelectionCategory | null,
  derivedCategory: V4SelectionCategory | null,
): EntryCategorySource {
  if (gammaCategory != null) return "gamma_tag";
  if (derivedCategory != null) return "derived";
  return "none";
}

function resolveAgreement(
  gammaCategory: V4SelectionCategory | null,
  derivedCategory: V4SelectionCategory | null,
): EntryCategoryAgreement {
  if (gammaCategory == null && derivedCategory == null) return "none";
  if (gammaCategory != null && derivedCategory == null) return "gamma_only";
  if (gammaCategory == null && derivedCategory != null) return "derived_only";
  // both non-null
  return gammaCategory === derivedCategory ? "agree" : "disagree";
}
