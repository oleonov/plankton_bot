import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFamilyId, createTokenId } from "@plankton/domain";
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
      familyId: createFamilyId("fam-1"),
      tokenId: createTokenId("tok-1"),
    };

    it("writes first rejection for a family+reason", () => {
      writer.onSignalRejected(signal, "dust positions 3 >= max 2", 1000);

      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(repo.insert.mock.calls[0]![0].eventType).toBe("signal_rejected");
      expect(repo.insert.mock.calls[0]![0].payload.reasonCode).toBe("max_dust_positions");
    });

    it("deduplicates same family+reason within cooldown", () => {
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

    it("deduplicates null-family rejections per-token, not globally", () => {
      const sigA = { signalId: "sig-a", familyId: null, tokenId: createTokenId("tok-a") };
      const sigB = { signalId: "sig-b", familyId: null, tokenId: createTokenId("tok-b") };

      writer.onSignalRejected(sigA, "token-in-flight-limit", 1000);
      writer.onSignalRejected(sigB, "token-in-flight-limit", 1001);

      // Both should write — different tokens despite both having null familyId
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
    it("writes family enable transitions", () => {
      writer.onOperatorCommand("family_enable", createFamilyId("fam-1"), 1, "reactivating");

      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(repo.insert.mock.calls[0]![0].eventType).toBe("family_enabled");
    });

    it("writes family disable transitions", () => {
      writer.onOperatorCommand("family_disable", createFamilyId("fam-1"), 1, "manual disable");

      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(repo.insert.mock.calls[0]![0].eventType).toBe("family_disabled");
    });

    it("ignores non-family commands", () => {
      writer.onOperatorCommand("pause", null, 1, null);

      expect(repo.insert).not.toHaveBeenCalled();
    });

    it("ignores unknown actions", () => {
      writer.onOperatorCommand("unknown_action", createFamilyId("fam-1"), 1, null);

      expect(repo.insert).not.toHaveBeenCalled();
    });

    it("skips system-initiated disable to avoid duplicate risk events", () => {
      writer.onOperatorCommand(
        "family_disable",
        createFamilyId("fam-1"),
        1,
        "auto-disable",
        "system",
      );

      expect(repo.insert).not.toHaveBeenCalled();
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
