import type { Position, PositionRepository } from "@plankton/domain";

export function findActivePositions(positionRepo: PositionRepository): Position[] {
  const byToken = new Map<string, Position>();
  const dust = typeof positionRepo.findDust === "function" ? positionRepo.findDust() : [];
  for (const position of [...positionRepo.findOpen(), ...dust]) {
    byToken.set(String(position.tokenId), position);
  }
  return [...byToken.values()];
}
