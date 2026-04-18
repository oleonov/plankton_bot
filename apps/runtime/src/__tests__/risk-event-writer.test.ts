import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId } from "@plankton/domain";
import { RiskEventWriter } from "../risk-event-writer.js";

describe("RiskEventWriter", () => {
  let repo: { insert: ReturnType<typeof vi.fn>; countSince: ReturnType<typeof vi.fn> };
  let writer: RiskEventWriter;

  beforeEach(() => {
    repo = { insert: vi.fn(), countSince: vi.fn(() => 0) };
    writer = new RiskEventWriter(repo, { rejectCooldownMs: 15 * 60 * 1000 });
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
      writer.onSignalRejected(signal, "family-in-flight-limit", 1001);

      expect(repo.insert).toHaveBeenCalledTimes(2);
    });

    it("deduplicates rejections per-token, not globally", () => {
      const sigA = { signalId: "sig-a", tokenId: createTokenId("tok-a") };
      const sigB = { signalId: "sig-b", tokenId: createTokenId("tok-b") };

      writer.onSignalRejected(sigA, "token-in-flight-limit", 1000);
      writer.onSignalRejected(sigB, "token-in-flight-limit", 1001);

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

  describe("onOperatorCommand", () => {
    it("writes operator_command event", () => {
      writer.onOperatorCommand("family_enable", null, 1, "reactivating");

      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(repo.insert.mock.calls[0]![0].eventType).toBe("operator_command");
      expect(repo.insert.mock.calls[0]![0].payload.action).toBe("family_enable");
    });

    it("writes for any action including pause", () => {
      writer.onOperatorCommand("pause", null, 1, null);

      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(repo.insert.mock.calls[0]![0].eventType).toBe("operator_command");
    });
  });

  describe("onReconciliationDrift", () => {
    it("writes every occurrence without dedup", () => {
      writer.onReconciliationDrift("phantom order", "warn", 1000);
      writer.onReconciliationDrift("phantom order", "warn", 1001);

      expect(repo.insert).toHaveBeenCalledTimes(2);
    });
  });
});
