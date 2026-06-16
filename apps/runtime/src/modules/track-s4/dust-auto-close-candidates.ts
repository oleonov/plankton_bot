import type { FillRepository, MarketRepository, Position, PositionRepository } from "@krabs/domain";
import { PositionStatus } from "@krabs/domain";

import { resolveOpenPositionStatus } from "../../position-status.js";
import type { CandidateBookCache } from "../strategy/candidate-book-cache.js";
import type {
  DustAutoCloseCandidate,
  DustAutoCloseCandidateProvider,
} from "./dust-auto-close-module.js";

export interface RepositoryDustAutoCloseCandidateProviderDeps {
  positionRepo: PositionRepository;
  marketRepo: MarketRepository;
  fillRepo: FillRepository;
  bookCache?: Pick<CandidateBookCache, "getFreshOrRefresh"> | undefined;
  now?: (() => number) | undefined;
}

export class RepositoryDustAutoCloseCandidateProvider implements DustAutoCloseCandidateProvider {
  constructor(private readonly deps: RepositoryDustAutoCloseCandidateProviderDeps) {}

  async listCandidates(limit: number): Promise<readonly DustAutoCloseCandidate[]> {
    if (limit <= 0) return [];
    const positions = [...this.deps.positionRepo.findOpen(), ...this.deps.positionRepo.findDust()];
    const candidates: DustAutoCloseCandidate[] = [];
    const now = this.deps.now?.() ?? Date.now();

    for (const position of positions) {
      if (candidates.length >= limit) break;
      const candidate = await this.toCandidate(position, now);
      if (candidate != null) candidates.push(candidate);
    }
    return candidates;
  }

  private async toCandidate(
    position: Position,
    now: number,
  ): Promise<DustAutoCloseCandidate | null> {
    const market = this.deps.marketRepo.findByTokenId(position.tokenId);
    if (market == null) return null;

    const fills = this.deps.fillRepo.findByTokenId(position.tokenId);
    const sellFills = fills.filter((fill) => fill.side === "sell");
    const lastSellAtMs = latestFillMs(sellFills);
    const book = (await this.deps.bookCache?.getFreshOrRefresh(String(position.tokenId), now))
      ?.entry?.book;
    const minOrderSize = book?.minOrderSize ?? null;
    const status =
      position.status === PositionStatus.Dust
        ? "dust"
        : resolveOpenPositionStatus(position.costBasisUsdc, {
            size: position.size,
            minOrderSize,
          });

    return {
      tokenId: position.tokenId,
      conditionId: position.conditionId,
      status,
      liquidationValueUsdc:
        position.liquidationValueUsdc ?? position.currentValueUsdc ?? Number.POSITIVE_INFINITY,
      costBasisUsdc: position.costBasisUsdc,
      sellCountTotal: sellFills.length,
      lastSellAgeMs: lastSellAtMs == null ? null : Math.max(0, now - lastSellAtMs),
      size: position.size,
      minOrderSize,
      marketTradable: market.tradable,
      bestBid: book?.bestBid ?? null,
      tickSize: market.tickSize,
      minValidPrice: market.tickSize,
      negRisk: market.negRisk,
    };
  }
}

function latestFillMs(fills: readonly { filledAt: string }[]): number | null {
  let latest: number | null = null;
  for (const fill of fills) {
    const ms = Date.parse(fill.filledAt);
    if (!Number.isFinite(ms)) continue;
    latest = latest == null ? ms : Math.max(latest, ms);
  }
  return latest;
}
