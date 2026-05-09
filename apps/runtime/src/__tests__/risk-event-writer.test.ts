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
      side: "sell",
      decisionRuleId: "D5",
    };

    it("writes first rejection for a token+reason", () => {
      writer.onSignalRejected(signal, "dust positions 3 >= max 2", 1000);

      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(repo.insert.mock.calls[0]![0].eventType).toBe("signal_rejected");
      expect(repo.insert.mock.calls[0]![0].payload.reasonCode).toBe("max_dust_positions");
      expect(repo.insert.mock.calls[0]![0].payload.reason).toBe("dust positions 3 >= max 2");
      expect(repo.insert.mock.calls[0]![0].payload.side).toBe("sell");
      expect(repo.insert.mock.calls[0]![0].payload.decisionRuleId).toBe("D5");
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

  describe("onOrderRejected", () => {
    it("writes every rejected order with exchange diagnostics", () => {
      writer.onOrderRejected({
        commandId: "cmd-1",
        clientOrderId: "cloid-1",
        tokenId: "tok-1",
        conditionId: "cond-1",
        reason: "exchange-insufficient-balance-or-allowance",
        errorCode: "INSUFFICIENT_BALANCE",
        signalReason: "repricing-exit",
        side: "sell",
        signalId: "sig-1",
        decisionRuleId: "D5",
        signalTimestamp: "2026-04-26T00:00:00.000Z",
        exchangeErrorMessage: "not enough balance",
        exchangeErrorDetails: { status: 400, responseBody: { error: "not enough balance" } },
        timestamp: 1000,
      });

      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(repo.insert.mock.calls[0]![0]).toMatchObject({
        eventType: "order_rejected",
        payload: {
          errorCode: "INSUFFICIENT_BALANCE",
          side: "sell",
          decisionRuleId: "D5",
          exchangeErrorDetails: { status: 400 },
        },
      });
    });

    it("deduplicates repeated internal order rejects by token and reason", () => {
      const event = {
        commandId: "cmd-1",
        clientOrderId: "cloid-1",
        tokenId: "tok-1",
        conditionId: "cond-1",
        reason: "sell-residual-below-min-order-size",
        errorCode: "INVALID_SIZE",
        signalReason: "repricing-exit",
        side: "sell",
        signalId: "sig-1",
        decisionRuleId: "D5",
        signalTimestamp: "2026-04-26T00:00:00.000Z",
        exchangeErrorMessage: null,
        exchangeErrorDetails: null,
        timestamp: 1000,
      };

      writer.onOrderRejected(event);
      writer.onOrderRejected({
        ...event,
        commandId: "cmd-2",
        clientOrderId: "cloid-2",
        timestamp: 2000,
      });

      expect(repo.insert).toHaveBeenCalledTimes(1);
    });

    it("does not deduplicate exchange order rejects", () => {
      const event = {
        commandId: "cmd-1",
        clientOrderId: "cloid-1",
        tokenId: "tok-1",
        conditionId: "cond-1",
        reason: "exchange-insufficient-balance-or-allowance",
        errorCode: "INSUFFICIENT_BALANCE",
        signalReason: "repricing-exit",
        side: "sell",
        signalId: "sig-1",
        decisionRuleId: "D5",
        signalTimestamp: "2026-04-26T00:00:00.000Z",
        exchangeErrorMessage: "not enough balance",
        exchangeErrorDetails: { status: 400 },
        timestamp: 1000,
      };

      writer.onOrderRejected(event);
      writer.onOrderRejected({
        ...event,
        commandId: "cmd-2",
        clientOrderId: "cloid-2",
        timestamp: 2000,
      });

      expect(repo.insert).toHaveBeenCalledTimes(2);
    });

    it("writes internal order rejects again after cooldown expires", () => {
      const event = {
        commandId: "cmd-1",
        clientOrderId: "cloid-1",
        tokenId: "tok-1",
        conditionId: "cond-1",
        reason: "wallet_buy_capacity_exhausted",
        errorCode: "INSUFFICIENT_BALANCE",
        signalReason: "probe-entry",
        side: "buy",
        signalId: "sig-1",
        decisionRuleId: "FALLBACK",
        signalTimestamp: "2026-04-26T00:00:00.000Z",
        exchangeErrorMessage: null,
        exchangeErrorDetails: null,
        timestamp: 1000,
      };

      writer.onOrderRejected(event);
      writer.onOrderRejected({
        ...event,
        commandId: "cmd-2",
        clientOrderId: "cloid-2",
        timestamp: 1000 + 15 * 60 * 1000 + 1,
      });

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
