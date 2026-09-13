import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EvidenceStore } from "../../modules/exit-evidence/store.js";
import { counters, LIMITS } from "../../modules/exit-evidence/types.js";
import { readEvidence } from "../exit-evidence-readout.js";

it("offline readout reports failed/no-sale/open denominator and uncertain credits, and refuses live lock", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "exit-evidence-readout-")));
  const path = join(dir, "exit-evidence.db");
  const now = Date.now();
  const store = new EvidenceStore(path, now);
  try {
    store.credit(now);
    const facts = {
      source: "strategy",
      side: "buy",
      clientOrderId: "client",
      commandId: "cmd",
      signalId: "sig",
      tokenId: "token",
      conditionId: "condition",
    };
    store.batch(
      [
        { slot: 1, kind: "PlaceOrderRequested", id: "cmd", source: now, received: now, facts },
        { slot: 1, kind: "OrderRejected", id: "cmd", source: now, received: now, facts },
      ],
      counters(),
      now,
    );
    store.capture(
      {
        slot: 1,
        kind: "OrderPlaced",
        id: "prepared",
        source: now,
        received: now,
        facts: {
          ...facts,
          orderId: "prepared",
          status: "pending",
          accepted: null,
          preparedShares: 9.99,
        },
      },
      "recovered",
      now,
    );
    store.credit(now);
    expect(() => readEvidence(path)).toThrow(/locked/);
    store.close();
    const result = readEvidence(path) as any;
    expect(result.unknownEnrollmentSlots).toBe(1);
    expect(result.cohortIncomplete).toBe(true);
    expect(result.episodes[0]).toMatchObject({
      hasBuy: false,
      hasSale: false,
      failedAttempts: 1,
      openOrRightCensored: true,
    });
    expect(result.episodes[0].acceptedOrderFacts).toEqual([]);
    expect(result.episodes[0].preparedSigned).toMatchObject([
      { shares: 9.99, transmitted: "unknown" },
    ]);
    expect(result.episodes[0].recoveredOrderFacts[0].status).toBe("pending");
    expect(result.comparison).toBe("comparison_unavailable");
    const expired = new EvidenceStore(path, now + LIMITS.retentionMs);
    expired.close(true);
    expect(readEvidence(path)).toMatchObject({
      evidenceExpired: true,
      unknownEnrollmentSlots: null,
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
