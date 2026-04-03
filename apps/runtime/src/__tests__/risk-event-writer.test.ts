import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFamilyId, createTokenId } from "@plankton/domain";
import { RiskEventWriter } from "../risk-event-writer.js";

describe("RiskEventWriter", () => {
  let repo: { insert: ReturnType<typeof vi.fn> };
  let writer: RiskEventWriter;

  beforeEach(() => {
    repo = { insert: vi.fn() };
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
    it("writes family mode transitions", () => {
      writer.onOperatorCommand("family_quarantine", createFamilyId("fam-1"), 1, "max loss");

      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(repo.insert.mock.calls[0]![0].eventType).toBe("family_quarantined");
    });

    it("ignores non-family commands", () => {
      writer.onOperatorCommand("pause", null, 1, null);

      expect(repo.insert).not.toHaveBeenCalled();
    });

    it("ignores unknown actions", () => {
      writer.onOperatorCommand("unknown_action", createFamilyId("fam-1"), 1, null);

      expect(repo.insert).not.toHaveBeenCalled();
    });

    it("skips system demotion commands to avoid duplicate risk events", () => {
      writer.onOperatorCommand(
        "family_reduce_only",
        createFamilyId("fam-1"),
        1,
        "auto-demotion",
        "system",
      );

      expect(repo.insert).not.toHaveBeenCalled();
    });
  });

  describe("onFamilyDemotionApplied", () => {
    it("writes system family demotions as risk events", () => {
      writer.onFamilyDemotionApplied(
        createFamilyId("fam-1"),
        "scaled",
        "reduce-only",
        "Auto-demotion: execution canary breach",
      );

      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(repo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "family_reduce_only",
          familyId: createFamilyId("fam-1"),
          payload: expect.objectContaining({
            previousState: "scaled",
            newState: "reduce-only",
            source: "system",
          }),
        }),
      );
    });

    it("ignores non-demotion states", () => {
      writer.onFamilyDemotionApplied(createFamilyId("fam-1"), "probe-only", "active", "recovered");

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
