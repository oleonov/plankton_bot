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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await delay(10);
  }
}

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
    entryFreshEdgeKind: "first_entry",
    entryFreshEdgeShadowClass: "RANGE_DATA_UNAVAILABLE",
    entryFreshEdgePayloadJson: JSON.stringify({ shadowClassification: "RANGE_DATA_UNAVAILABLE" }),
    entryCategory: "geopolitics" as const,
    entryCategoryGateClass: "PRIORITIZE" as const,
    entryCategoryPayloadJson: JSON.stringify({ category: "geopolitics", gateClass: "PRIORITIZE" }),
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
        .prepare(
          "SELECT decision_rule_id, entry_fresh_edge_kind, entry_fresh_edge_shadow_class, entry_fresh_edge_payload_json, entry_category, entry_category_gate_class, entry_category_payload_json FROM decision_signal_log WHERE signal_id = ?",
        )
        .get("sig-worker") as
        | {
            decision_rule_id: string;
            entry_fresh_edge_kind: string | null;
            entry_fresh_edge_shadow_class: string | null;
            entry_fresh_edge_payload_json: string | null;
            entry_category: string | null;
            entry_category_gate_class: string | null;
            entry_category_payload_json: string | null;
          }
        | undefined;
      const riskRow = verifyConn.db
        .prepare("SELECT payload FROM risk_events WHERE event_type = ?")
        .get("signal_emitted") as { payload: string } | undefined;

      expect(signalRow?.decision_rule_id).toBe("R23_DIP_TRIGGER");
      expect(signalRow?.entry_fresh_edge_kind).toBe("first_entry");
      expect(signalRow?.entry_fresh_edge_shadow_class).toBe("RANGE_DATA_UNAVAILABLE");
      expect(JSON.parse(signalRow?.entry_fresh_edge_payload_json ?? "{}")).toMatchObject({
        shadowClassification: "RANGE_DATA_UNAVAILABLE",
      });
      expect(signalRow?.entry_category).toBe("geopolitics");
      expect(signalRow?.entry_category_gate_class).toBe("PRIORITIZE");
      expect(JSON.parse(signalRow?.entry_category_payload_json ?? "{}")).toMatchObject({
        gateClass: "PRIORITIZE",
      });
      expect(JSON.parse(riskRow?.payload ?? "{}")).toMatchObject({ tokenId: "tok-worker" });
      expect(buffer.getStats().workerFailedWrites).toBe(0);
      expect(buffer.getStats().workerPersistedWrites).toBe(2);
    } finally {
      verifyConn.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("stop() abandons a worker wedged on the ledger write lock instead of terminating it", async () => {
    // The unit tests above only ever exercise a worker that answers, so the acknowledgment bound in
    // `stop()` could be deleted and they would stay green. The only way to pin it is to wedge the
    // worker for real: a second connection holds the write lock, so the worker sits INSIDE
    // better-sqlite3 — where no message and no timer can reach it — and `stop()` has to leave
    // without it. It must leave by UNREF, not `terminate()`: terminating an isolate that is about
    // to allocate a SQLITE_BUSY error aborts the whole process (v8::ToLocalChecked Empty
    // MaybeLocal), which is exactly what this shutdown path exists to avoid.
    const tmpDir = mkdtempSync(join(tmpdir(), "krabs-decision-persistence-stop-"));
    const dbPath = join(tmpDir, "ledger.db");
    bootstrapLedgerDb(dbPath).close();

    const warnings: string[] = [];
    const capturingLog = {
      warn: (_details: unknown, message?: string) => {
        if (typeof message === "string") warnings.push(message);
      },
      error: vi.fn(),
      child: () => capturingLog,
    } as any;

    const blocker = bootstrapLedgerDb(dbPath);
    let blockerOpen = true;
    const buffer = new DecisionPersistenceBuffer(
      { log: capturingLog },
      { mode: "worker", workerDbPath: dbPath, batchSize: 1 },
    );

    try {
      // One write that CAN commit, so the wedge below is the worker blocking — not the worker
      // still booting, compiling its statements, or never having received anything at all.
      buffer.enqueueRiskEvent({ eventType: "warmup", payload: { tokenId: "tok-warmup" } });
      await waitUntil(() => buffer.getStats().workerPersistedWrites === 1);

      blocker.db.exec("BEGIN IMMEDIATE");
      for (let i = 0; i < 4; i++) {
        buffer.enqueueRiskEvent({ eventType: `blocked-${i}`, payload: { tokenId: "tok-blocked" } });
      }
      await waitUntil(() => buffer.getStats().queued === 0);
      await delay(250);

      const wedged = buffer.getStats();
      expect(wedged.workerPersistedWrites + wedged.workerFailedWrites).toBe(1);

      await buffer.stop();

      // `stop()` left WITHOUT the worker — this warning only exists on the path where the
      // acknowledgment ceiling expired, so it is also the proof that stop did not simply wait the
      // wedge out. Deliberately no wall-clock bound around `stop()`: it would assert nothing this
      // warning does not already, and an absolute ceiling a couple of seconds above a 2 s timer is
      // a coin flip on a loaded CI rather than a statement about the code.
      expect(warnings).toContain(
        "decision persistence worker did not acknowledge shutdown — abandoning the wedged thread",
      );
      // The wedged worker is never terminated, so the terminate ceiling must not have run at all.
      expect(warnings).not.toContain(
        "decision persistence worker did not exit — abandoning the thread to the process exit",
      );

      // Release the lock and let the ABANDONED thread prove it is still alive: it drains the whole
      // batch it was holding, all four blocked writes. This is what separates `unref()` from
      // `terminate()` — a terminated isolate dies the moment its native call returns, so the writes
      // behind the wedged one would never land — and it reads persisted state, not elapsed time.
      blocker.db.exec("ROLLBACK");
      blocker.close();
      blockerOpen = false;
      await waitUntil(() => {
        const stats = buffer.getStats();
        return stats.workerPersistedWrites + stats.workerFailedWrites === 5;
      });
      expect(buffer.getStats().workerPersistedWrites).toBe(5);
    } finally {
      if (blockerOpen) {
        blocker.db.exec("ROLLBACK");
        blocker.close();
        // The abandoned thread dies once its native call returns, which the rollback above allows.
        await delay(500);
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
