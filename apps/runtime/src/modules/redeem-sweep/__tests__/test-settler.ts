import { vi } from "vitest";

/**
 * Lightweight stand-in for PositionSettler used by the mock-repo orchestration
 * tests. It performs only the close side-effect (settleAll + save closed) so the
 * existing "closes local state" assertions stay valid. Real settlement accounting
 * (settlement_ledger rows, realized_pnl deltas) is covered by the real-DB suite
 * in redeem-sweep-module.test.ts.
 */
export function makeMockSettler(positionRepo: any, lotRepo: any, now: () => number) {
  return {
    settle: vi.fn((detected: { resolution: string; candidates: { tokenId: unknown }[] }) => {
      const at = new Date(now()).toISOString();
      const out: unknown[] = [];
      for (const candidate of detected.candidates) {
        const position = positionRepo.findByTokenId(candidate.tokenId);
        if (!position || position.status === "closed") continue;
        lotRepo.settleAll(position.positionId);
        positionRepo.save({
          ...position,
          status: "closed",
          size: 0,
          currentValueUsdc: 0,
          closedAt: at,
          updatedAt: at,
        });
        out.push({ positionId: position.positionId, tokenId: candidate.tokenId });
      }
      return out;
    }),
  };
}

/**
 * Stub MarketResolutionRepository that always reports a known (non-"unknown")
 * resolution, so resolution-gated closes proceed to the settler in orchestration
 * tests that assert the local-close side-effect.
 */
export function makeResolvedResolutionRepo(resolution = "Yes", at = new Date().toISOString()) {
  return {
    findByConditionId: vi.fn((conditionId: string) => ({
      conditionId,
      resolution,
      resolvedAt: at,
      detectedAt: at,
      source: "gamma-api" as const,
      rawResponse: null,
      status: "detected" as const,
    })),
  };
}
