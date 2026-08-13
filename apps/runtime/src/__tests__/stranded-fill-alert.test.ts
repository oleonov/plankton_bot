import { describe, expect, it, vi } from "vitest";
import { bootstrapLedgerDb, SqliteRiskEventRepository } from "@krabs/db";
import {
  STRANDED_FILL_ALERT_CODE,
  composeStrandedFillAlertEmitter,
} from "../stranded-fill-alert.js";

describe("stranded fill alert emitter", () => {
  it("T15 — stale fills reach both durable risk-event and infrastructure-alert sinks without poisoning cooldown on failure", () => {
    const conn = bootstrapLedgerDb(":memory:");
    const riskEventRepo = new SqliteRiskEventRepository(conn.db);
    const recordInfraAlert = vi.fn();
    const log = { warn: vi.fn() };
    try {
      const emit = composeStrandedFillAlertEmitter({
        riskEventRepo,
        recordInfraAlert,
        log: log as any,
      });
      const stale = { count: 2, oldestAgeMs: 900_000, stale: true };
      emit(stale, 1_000);
      emit({ ...stale, oldestAgeMs: 900_100 }, 2_000);

      const rows = conn.db
        .prepare("SELECT event_type, payload FROM risk_events ORDER BY id")
        .all() as Array<{ event_type: string; payload: string }>;
      expect(rows).toEqual([
        {
          event_type: "unreconciled_fills_stranded",
          payload: JSON.stringify({ count: 2, oldestAgeMs: 900_000, nowMs: 1_000 }),
        },
      ]);
      expect(recordInfraAlert).toHaveBeenCalledTimes(1);
      expect(recordInfraAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          code: STRANDED_FILL_ALERT_CODE,
          severity: "error",
          details: { count: 2, oldestAgeMs: 900_000 },
        }),
      );

      const infraFails = vi.fn().mockImplementationOnce(() => {
        throw new Error("metrics down");
      });
      const retry = composeStrandedFillAlertEmitter({
        riskEventRepo,
        recordInfraAlert: infraFails,
        log: log as any,
      });
      retry(stale, 10_000);
      retry(stale, 10_000 + 5 * 60_000);
      expect(infraFails).toHaveBeenCalledTimes(2);
      expect(conn.db.prepare("SELECT COUNT(*) AS count FROM risk_events").get()).toEqual({
        count: 3,
      });

      const failingRisk = {
        insert: vi.fn(() => {
          throw new Error("ledger down");
        }),
      };
      const deliveredInfra = vi.fn();
      const retryRisk = composeStrandedFillAlertEmitter({
        riskEventRepo: failingRisk as any,
        recordInfraAlert: deliveredInfra,
        log: log as any,
      });
      retryRisk(stale, 20_000);
      retryRisk(stale, 20_000 + 5 * 60_000);
      expect(failingRisk.insert).toHaveBeenCalledTimes(2);
      expect(deliveredInfra).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalled();
    } finally {
      conn.close();
    }
  });
});
