import { normalizeSellSizeForMinOrder, type BounceRungMetadata } from "@krabs/domain";
import { isExecutableOrderSize, isKnownMinOrderSize } from "./min-order-size.js";

export interface BounceRungSizingInput {
  readonly bounceRung: BounceRungMetadata;
  readonly originalPositionSize: number;
  readonly availableSize: number;
  readonly ladderFractions: readonly number[];
  readonly minOrderSize: number | null | undefined;
}

export interface BounceRungSizing {
  readonly size: number;
  readonly metadata: BounceRungMetadata;
}

export function resolveBounceRungRollover(input: BounceRungSizingInput): BounceRungSizing | null {
  const { bounceRung, originalPositionSize, availableSize, ladderFractions, minOrderSize } = input;
  if (!(originalPositionSize > 0) || !(availableSize > 0)) return null;
  let fraction = 0;
  const rungIndicesCovered: number[] = [];
  for (let index = bounceRung.rungIndex; index < ladderFractions.length; index++) {
    fraction += ladderFractions[index] ?? 0;
    rungIndicesCovered.push(index);
    const size = Math.min(fraction * originalPositionSize, availableSize);
    if (isExecutableOrderSize(size, minOrderSize)) {
      return { size, metadata: { ...bounceRung, fraction, rungIndicesCovered } };
    }
  }
  if (
    !isKnownMinOrderSize(minOrderSize) ||
    !Number.isFinite(availableSize) ||
    !isExecutableOrderSize(availableSize, minOrderSize)
  ) {
    return null;
  }
  return {
    size: availableSize,
    metadata: { ...bounceRung, fraction, rungIndicesCovered, isCleanupRung: true },
  };
}

export function resolveBounceSupplementalRungSizing(
  input: BounceRungSizingInput,
): BounceRungSizing | null {
  const rollover = resolveBounceRungRollover(input);
  if (!rollover || rollover.metadata.isCleanupRung === true) return null;
  const normalized = normalizeSellSizeForMinOrder({
    availableSize: input.availableSize,
    desiredSize: rollover.size,
    marketMinOrderSize: input.minOrderSize,
  });
  return normalized.kind === "unsellable" ? null : { ...rollover, size: normalized.size };
}
