import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId } from "@plankton/domain";
import { RiskEventWriter } from "../risk-event-writer.js";

describe("RiskEventWriter", () => {
  let repo: { insert: ReturnType<typeof vi.fn>; countSince: ReturnType<typeof vi.fn> };
  let writer: RiskEventWriter;

  beforeEach(() => {
    repo = { insert: vi.fn(), countSince: vi.fn(() => 0) };
    writer = new RiskEventWriter(repo, {
      rejectCooldownMs: 15 * 60 * 1000,
      exposureBreachCooldownMs: 15 * 60 * 1000,
    });
  });

  describe("onSignalRejected", () => {
    const signal = {
      signalId: "sig-1",
      tokenId: String(createTokenId("tok-1")),
    };

    it("writes first rejection for a token+reason", () => {
      writer.onSignalRejected(signal, "dust positions 3 >= max 2", 1000);

      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(repo.insert.mock.calls[0]![0].eventType).toBe("signal_rejected");
      expect(repo.insert.mock.calls[0]![0].payload.reasonCode).toBe("max_dust_positions");
    });

    it("deduplicates same token+reason within cooldown", () => {
      writer.onSignalRejected(signal, "dust positions 3 >= max 2", 1000);
      writer.onSignalRejected(signal, "dust positions 4 >= max 2", 2000);

      expect(repo.insert).toHaveBeenCalledTimes(1);
    });

    it("writes again after cooldown expires", () => {
      const now = 1000;
      writer.onSignalRejected(signal, "dust positions 3 >= max 2", now);
      writer.onSignalRejected(signal, "dust positions 3 >= max 2", now + 15 * 60 * 1000 + 1);

      expect(repo.insert).toHaveBeenCalledTimes(2);
    });

    it("writes different reason codes independently", () => {
      writer.onSignalRejected(signal, "dust positions 3 >= max 2", 1000);
      writer.onSignalRejected(signal, "active markets 4 >= max 4", 1001);

      expect(repo.insert).toHaveBeenCalledTimes(2);
    });

    it("deduplicates rejections per-token, not globally", () => {
      const sigA = { signalId: "sig-a", tokenId: createTokenId("tok-a") };
      const sigB = { signalId: "sig-b", tokenId: createTokenId("tok-b") };

      writer.onSignalRejected(sigA, "dust positions 3 >= max 2", 1000);
      writer.onSignalRejected(sigB, "dust positions 3 >= max 2", 1001);

      // Both should write — different tokens
      expect(repo.insert).toHaveBeenCalledTimes(2);
    });

    it("does not update cooldown when insert throws", () => {
      repo.insert.mockImplementationOnce(() => {
        throw new Error("db error");
      });

      expect(() => writer.onSignalRejected(signal, "dust positions 3 >= max 2", 1000)).toThrow();

      // Retry should work
      writer.onSignalRejected(signal, "dust positions 3 >= max 2", 1001);
      expect(repo.insert).toHaveBeenCalledTimes(2);
    });
  });

  describe("onReconciliationDrift", () => {
    it("writes every occurrence without dedup", () => {
      writer.onReconciliationDrift("phantom order", "warn", 1000);
      writer.onReconciliationDrift("phantom order", "warn", 1001);

      expect(repo.insert).toHaveBeenCalledTimes(2);
    });
  });

  describe("onExposureBreach", () => {
    it("does not write when current exposure is at or below the cap", () => {
      writer.onExposureBreach(500, 500, 1000);
      writer.onExposureBreach(499.99, 500, 1001);

      expect(repo.insert).not.toHaveBeenCalled();
    });

    it("writes a max_exposure_breach event when exposure exceeds the cap", () => {
      writer.onExposureBreach(612.345, 500, 1000);

      expect(repo.insert).toHaveBeenCalledTimes(1);
      const call = repo.insert.mock.calls[0]![0];
      expect(call.eventType).toBe("max_exposure_breach");
      expect(call.payload.currentExposure).toBe(612.345);
      expect(call.payload.limit).toBe(500);
    });

    it("deduplicates repeat breaches within the cooldown window", () => {
      writer.onExposureBreach(550, 500, 1000);
      writer.onExposureBreach(560, 500, 1000 + 5 * 60 * 1000);

      expect(repo.insert).toHaveBeenCalledTimes(1);
    });

    it("writes again after the cooldown expires", () => {
      writer.onExposureBreach(550, 500, 1000);
      writer.onExposureBreach(560, 500, 1000 + 15 * 60 * 1000 + 1);

      expect(repo.insert).toHaveBeenCalledTimes(2);
    });
  });
});
