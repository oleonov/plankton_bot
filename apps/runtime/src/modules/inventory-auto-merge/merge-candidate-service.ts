import type {
  PositionRepository,
  OrderRepository,
  MarketRepository,
  FillRepository,
  Position,
  TokenId,
  FamilyId,
  PositionId,
} from "@plankton/domain";

export interface MergeCandidate {
  conditionId: string;
  familyId: FamilyId;
  mergeAmount: number;
  yesTokenId: TokenId;
  noTokenId: TokenId;
  yesPositionId: PositionId;
  noPositionId: PositionId;
}

export class MergeCandidateService {
  constructor(
    private readonly positionRepo: PositionRepository,
    private readonly orderRepo: OrderRepository,
    private readonly marketRepo: MarketRepository,
    private readonly fillRepo: FillRepository,
  ) {}

  public findMergeCandidates(): MergeCandidate[] {
    const openPositions = this.positionRepo.findOpen();
    if (openPositions.length === 0) return [];

    // Map positions by conditionId
    const positionsByCondition = new Map<string, Position[]>();

    for (const pos of openPositions) {
      const market = this.marketRepo.findByTokenId(pos.tokenId);
      if (!market) continue;

      const condId = market.conditionId;
      if (!positionsByCondition.has(condId)) {
        positionsByCondition.set(condId, []);
      }
      positionsByCondition.get(condId)!.push(pos);
    }

    const candidates: MergeCandidate[] = [];

    for (const [conditionId, positions] of positionsByCondition.entries()) {
      if (positions.length < 2) continue;

      // Ensure we have at least one YES and one NO position
      // For binary markets, one should be "yes" outcome and one "no" outcome, but our position 'side' is always "buy" (since we buy shares).
      // We need to check the market outcome or index.
      // Wait, Plankton XD buys YES or NO shares, but the side in position is always 'buy'.
      // We need to differentiate YES tokens from NO tokens.
      // We can look at market.outcome (usually "Yes" / "No") or outcome_index (0/1).
      const yesPos = positions.find((p) => {
        const m = this.marketRepo.findByTokenId(p.tokenId);
        return m?.outcome?.toUpperCase() === "YES" || m?.outcomeIndex === 0;
      });
      const noPos = positions.find((p) => {
        const m = this.marketRepo.findByTokenId(p.tokenId);
        return m?.outcome?.toUpperCase() === "NO" || m?.outcomeIndex === 1;
      });

      if (!yesPos || !noPos) continue;

      // Calculate locked sizes from open SELL orders
      const yesOrders = this.orderRepo.findByTokenId(yesPos.tokenId);
      const noOrders = this.orderRepo.findByTokenId(noPos.tokenId);

      const yesLocked = yesOrders
        .filter(
          (o) =>
            o.side === "sell" &&
            (o.status === "open" || o.status === "pending" || o.status === "partially-filled"),
        )
        .reduce((sum, o) => {
          const fills = this.fillRepo.findByOrderId(o.orderId);
          const filledSize = fills.reduce((s, f) => s + f.size, 0);
          return sum + Math.max(0, o.size - filledSize);
        }, 0);

      const noLocked = noOrders
        .filter(
          (o) =>
            o.side === "sell" &&
            (o.status === "open" || o.status === "pending" || o.status === "partially-filled"),
        )
        .reduce((sum, o) => {
          const fills = this.fillRepo.findByOrderId(o.orderId);
          const filledSize = fills.reduce((s, f) => s + f.size, 0);
          return sum + Math.max(0, o.size - filledSize);
        }, 0);

      const yesFree = yesPos.size - yesLocked;
      const noFree = noPos.size - noLocked;

      const mergeAmount = Math.min(yesFree, noFree);

      // Only merge if amount is greater than a sensible dust threshold
      if (mergeAmount > 1) {
        candidates.push({
          conditionId,
          familyId: yesPos.familyId,
          mergeAmount,
          yesTokenId: yesPos.tokenId,
          noTokenId: noPos.tokenId,
          yesPositionId: yesPos.positionId,
          noPositionId: noPos.positionId,
        });
      }
    }

    return candidates;
  }
}
