import type { NormalizedMarket, V4SelectionCategory, EntryCategoryGateClass } from "@krabs/domain";
import {
  categoryQualityBucket,
  deriveV4SelectionCategory,
  mapGammaTagsToCategory,
} from "@krabs/domain";

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
  const derivedCategory = deriveV4SelectionCategory(
    inputs.market.slug,
    inputs.market.eventSlug ?? null,
    inputs.market.question,
  );
  const category = mapGammaTagsToCategory(inputs.market.tags ?? null) ?? derivedCategory;
  return {
    entryCategory: category,
    entryCategoryGateClass: category == null ? "UNKNOWN" : categoryQualityBucket(category),
    entryCategoryPayloadJson: null,
  };
}
