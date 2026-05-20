import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConditionId, createTokenId } from "@krabs/domain";
import type { DecisionSignalLog } from "@krabs/domain";
import { bootstrapLedgerDb } from "@krabs/db";
import { DecisionPersistenceBuffer } from "../async-decision-persistence.js";

const silentLog = {
  warn: vi.fn(),
  error: vi.fn(),
  child: () => silentLog,
} as any;

function makeSignal(signalId = "sig-1"): DecisionSignalLog {
  return {
    signalId,
    tokenId: createTokenId("tok-1"),
    conditionId: createConditionId("cond-1"),
    side: "BUY",
    decisionRuleId: "R23_DIP_TRIGGER",
    price: 0.1,
    state: "OTHER",
    buyCount: 0,
    timeSinceLastSeconds: null,
    isAdd: 0,
    addAgeMs: null,
    addAgeBucket: null,
    addPriceChangePct: null,
    addPriceChangeBucket: null,
    nthBuyAtEmit: 1,
    signalTimestamp: "2026-05-19T00:00:00.000Z",
    sizingRuleId: "B5",
    notionalBucket: "$1-$2",
    isExit: 0,
    isFirstSell: null,
    holdingTimeMs: null,
    holdingTimeBucket: null,
    exitPnlPct: null,
    exitPnlBucket: null,
    soldBoughtRatio: null,
    soldBoughtRatioBucket: null,
  };
}

describe("DecisionPersistenceBuffer", () => {
  it("buffers async decision telemetry and flushes it off the caller stack", async () => {
    const decisionSignalLogRepo = { insert: vi.fn() };
    const riskEventRepo = { insert: vi.fn(), countSince: vi.fn() };
    const buffer = new DecisionPersistenceBuffer(
      { decisionSignalLogRepo, riskEventRepo, log: silentLog },
      { mode: "async", batchSize: 10 },
    );

    buffer.enqueueDecisionSignal(makeSignal());
    buffer.enqueueRiskEvent({ eventType: "signal_emitted", payload: { tokenId: "tok-1" } });

    expect(decisionSignalLogRepo.insert).not.toHaveBeenCalled();
    expect(riskEventRepo.insert).not.toHaveBeenCalled();

    await new Promise((resolve) => setImmediate(resolve));

    expect(decisionSignalLogRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ decisionRuleId: "R23_DIP_TRIGGER" }),
    );
    expect(riskEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "signal_emitted" }),
    );
  });

  it("drops oldest writes when the async queue is full", async () => {
    const decisionSignalLogRepo = { insert: vi.fn() };
    const buffer = new DecisionPersistenceBuffer(
      { decisionSignalLogRepo, log: silentLog },
      { mode: "async", maxQueueSize: 1, batchSize: 10 },
    );

    buffer.enqueueDecisionSignal(makeSignal("sig-old"));
    buffer.enqueueDecisionSignal(makeSignal("sig-new"));

    await new Promise((resolve) => setImmediate(resolve));

    expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
    expect(decisionSignalLogRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ signalId: "sig-new" }),
    );
    expect(buffer.getStats().droppedWrites).toBe(1);
  });

  it("persists telemetry through the dedicated SQLite worker", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "krabs-decision-persistence-"));
    const dbPath = join(tmpDir, "ledger.db");
    const conn = bootstrapLedgerDb(dbPath);
    conn.close();

    const buffer = new DecisionPersistenceBuffer(
      { log: silentLog },
      { mode: "worker", workerDbPath: dbPath, batchSize: 10 },
    );

    buffer.enqueueDecisionSignal(makeSignal("sig-worker"));
    buffer.enqueueRiskEvent({ eventType: "signal_emitted", payload: { tokenId: "tok-worker" } });
    await buffer.stop();

    const verifyConn = bootstrapLedgerDb(dbPath);
    try {
      const signalRow = verifyConn.db
        .prepare("SELECT decision_rule_id FROM decision_signal_log WHERE signal_id = ?")
        .get("sig-worker") as { decision_rule_id: string } | undefined;
      const riskRow = verifyConn.db
        .prepare("SELECT payload FROM risk_events WHERE event_type = ?")
        .get("signal_emitted") as { payload: string } | undefined;

      expect(signalRow?.decision_rule_id).toBe("R23_DIP_TRIGGER");
      expect(JSON.parse(riskRow?.payload ?? "{}")).toMatchObject({ tokenId: "tok-worker" });
      expect(buffer.getStats().workerFailedWrites).toBe(0);
      expect(buffer.getStats().workerPersistedWrites).toBe(2);
    } finally {
      verifyConn.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
