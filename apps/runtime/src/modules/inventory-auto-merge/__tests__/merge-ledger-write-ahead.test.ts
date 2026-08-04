import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bootstrapLedgerDb,
  openDatabase,
  SqliteMergeLedgerRepository,
  type DbConnection,
} from "@krabs/db";
import type {
  EventBus,
  ExchangeGateway,
  PositionRepository,
  OrderRepository,
  MarketRepository,
  InventoryLotRepository,
  FillRepository,
} from "@krabs/domain";
import { SettlementNotSubmittedError, SettlementUnconfirmedError } from "@krabs/exchange";
import { InventoryManagerModule } from "../inventory-manager-module.js";
import { SettlementInfraBreaker } from "../../settlement-infra-breaker.js";
import type { Logger } from "../../../logger.js";

// r26-M1: the regression guard for the write-ahead merge intent. Unlike the mocked-repository suite
// in inventory-manager-module.test.ts, these run against a REAL SQLite file through the REAL
// SqliteMergeLedgerRepository and the REAL migrations — mocking the ledger repo here would only
// prove the code calls the right method names, not that a crash actually leaves a durable,
// discoverable row on disk. Each of the last four covers one way the scheme can rot without a
// single method name changing: a row nothing reads, an UPDATE that matches nothing, an intent kept
// after a submission that never happened, and an intent dropped after one that might have.

const CONDITION_ID = "0xcond-write-ahead";
const YES_TOKEN = "tok-yes";
const NO_TOKEN = "tok-no";
// A second, independent condition — only the "lost claim" test below needs two candidates in one
// batch, to tell "the whole batch was refused" apart from "one candidate lost its claim, the OTHER
// still went through".
const OTHER_CONDITION_ID = "0xcond-other-writer";
const OTHER_YES_TOKEN = "tok-other-yes";
const OTHER_NO_TOKEN = "tok-other-no";

/** Fixtures for exactly one mergeable YES/NO position pair, sized so the merge clears the dust floor. */
function makeMergeableFixtures(): {
  positionRepo: PositionRepository;
  orderRepo: OrderRepository;
  marketRepo: MarketRepository;
  fillRepo: FillRepository;
  lotRepo: InventoryLotRepository;
} {
  const yesPos = {
    positionId: "p-yes",
    tokenId: YES_TOKEN,
    size: 100,
    status: "open",
    realizedPnl: 0,
    costBasisUsdc: 40,
    avgEntryPrice: 0.4,
  };
  const noPos = {
    positionId: "p-no",
    tokenId: NO_TOKEN,
    size: 100,
    status: "open",
    realizedPnl: 0,
    costBasisUsdc: 60,
    avgEntryPrice: 0.6,
  };
  const yesMarket = { tokenId: YES_TOKEN, conditionId: CONDITION_ID, outcome: "Yes" };
  const noMarket = { tokenId: NO_TOKEN, conditionId: CONDITION_ID, outcome: "No" };

  const positionRepo = {
    findOpen: vi.fn().mockReturnValue([yesPos, noPos]),
    findByTokenId: vi.fn((tid: string) =>
      tid === YES_TOKEN ? yesPos : tid === NO_TOKEN ? noPos : null,
    ),
    save: vi.fn(),
  } as unknown as PositionRepository;
  const orderRepo = { findByTokenId: vi.fn().mockReturnValue([]) } as unknown as OrderRepository;
  const marketRepo = {
    findByTokenId: vi.fn((tid: string) =>
      tid === YES_TOKEN ? yesMarket : tid === NO_TOKEN ? noMarket : null,
    ),
  } as unknown as MarketRepository;
  const fillRepo = { findByOrderId: vi.fn().mockReturnValue([]) } as unknown as FillRepository;
  // Distinct entry prices per leg (rather than one shared lot) so a wrong spread_pnl — e.g. reading
  // the 'pending' placeholder instead of the settlement's real total-cost math — is distinguishable
  // from a correct one instead of accidentally cancelling out to the same number either way.
  const lotRepo = {
    consumeFifo: vi.fn((positionId: string, amount: number) => {
      const entryPrice = positionId === "p-yes" ? 0.3 : 0.4;
      return [{ lot: { entryPrice }, consumed: amount }];
    }),
  } as unknown as InventoryLotRepository;

  return { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo };
}

/**
 * Same shape as `makeMergeableFixtures`, but wired for TWO independent mergeable pairs
 * (`CONDITION_ID` and `OTHER_CONDITION_ID`) in a single `findMergeCandidates()` batch — needed only
 * by the lost-claim test, where the assertion is about one candidate in the batch, not the batch.
 */
function makeTwoConditionFixtures(): {
  positionRepo: PositionRepository;
  orderRepo: OrderRepository;
  marketRepo: MarketRepository;
  fillRepo: FillRepository;
  lotRepo: InventoryLotRepository;
} {
  const positions = [
    {
      positionId: "p-yes-x",
      tokenId: YES_TOKEN,
      size: 100,
      status: "open",
      realizedPnl: 0,
      costBasisUsdc: 40,
      avgEntryPrice: 0.4,
    },
    {
      positionId: "p-no-x",
      tokenId: NO_TOKEN,
      size: 100,
      status: "open",
      realizedPnl: 0,
      costBasisUsdc: 60,
      avgEntryPrice: 0.6,
    },
    {
      positionId: "p-yes-y",
      tokenId: OTHER_YES_TOKEN,
      size: 100,
      status: "open",
      realizedPnl: 0,
      costBasisUsdc: 40,
      avgEntryPrice: 0.4,
    },
    {
      positionId: "p-no-y",
      tokenId: OTHER_NO_TOKEN,
      size: 100,
      status: "open",
      realizedPnl: 0,
      costBasisUsdc: 60,
      avgEntryPrice: 0.6,
    },
  ];
  const markets = new Map([
    [YES_TOKEN, { tokenId: YES_TOKEN, conditionId: CONDITION_ID, outcome: "Yes" }],
    [NO_TOKEN, { tokenId: NO_TOKEN, conditionId: CONDITION_ID, outcome: "No" }],
    [
      OTHER_YES_TOKEN,
      { tokenId: OTHER_YES_TOKEN, conditionId: OTHER_CONDITION_ID, outcome: "Yes" },
    ],
    [OTHER_NO_TOKEN, { tokenId: OTHER_NO_TOKEN, conditionId: OTHER_CONDITION_ID, outcome: "No" }],
  ]);

  const positionRepo = {
    findOpen: vi.fn().mockReturnValue(positions),
    findByTokenId: vi.fn((tid: string) => positions.find((p) => p.tokenId === tid) ?? null),
    save: vi.fn(),
  } as unknown as PositionRepository;
  const orderRepo = { findByTokenId: vi.fn().mockReturnValue([]) } as unknown as OrderRepository;
  const marketRepo = {
    findByTokenId: vi.fn((tid: string) => markets.get(tid) ?? null),
  } as unknown as MarketRepository;
  const fillRepo = { findByOrderId: vi.fn().mockReturnValue([]) } as unknown as FillRepository;
  const lotRepo = {
    consumeFifo: vi.fn((positionId: string, amount: number) => {
      const entryPrice = positionId.startsWith("p-yes") ? 0.3 : 0.4;
      return [{ lot: { entryPrice }, consumed: amount }];
    }),
  } as unknown as InventoryLotRepository;

  return { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo };
}

describe("InventoryManagerModule merge-ledger write-ahead intent (r26-M1)", () => {
  let tmpDir: string;
  let dbPath: string;
  let conn: DbConnection;
  let bus: EventBus;
  let log: Logger;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-merge-ledger-"));
    dbPath = path.join(tmpDir, "ledger.db");
    conn = bootstrapLedgerDb(dbPath);
    // subscribe must hand back a real unsubscribe: stop() calls every handle it was given.
    bus = {
      subscribe: vi.fn().mockReturnValue(() => {}),
      publish: vi.fn(),
    } as unknown as EventBus;
    log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  });

  afterEach(() => {
    conn.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("commits the 'pending' row — visible from a SEPARATE connection — before mergePositions is called", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);

    // The fake gateway reads through its OWN connection to the same file. If the row is visible
    // there, autocommit already flushed it to disk — a same-connection read (or a mocked repo)
    // could not tell that apart from mere transaction-local visibility.
    let seenFromSeparateConnection: { status: string } | undefined;
    const gateway = {
      mergePositions: vi.fn().mockImplementation(async () => {
        const reader = openDatabase(dbPath);
        try {
          seenFromSeparateConnection = reader.db
            .prepare(`SELECT status FROM merge_ledger WHERE condition_id = ?`)
            .get(CONDITION_ID) as { status: string } | undefined;
        } finally {
          reader.close();
        }
      }),
    } as unknown as ExchangeGateway;

    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    await mod.sweep();

    expect(gateway.mergePositions).toHaveBeenCalledTimes(1);
    expect(seenFromSeparateConnection?.status).toBe("pending");
  });

  it("leaves exactly one 'onchain' row when settlement fails right after the on-chain call resolves", async () => {
    // Stands in for a process crash between the on-chain submission and applyMerge's transaction:
    // the gateway call has already resolved (irrevocable on chain) and lotRepo then throws inside
    // that transaction, so it rolls back exactly like a killed process would leave things — onchain,
    // never applied.
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    (lotRepo.consumeFifo as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("simulated crash between submission and settlement");
    });
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    const gateway = {
      mergePositions: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExchangeGateway;

    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    await mod.sweep();

    expect(gateway.mergePositions).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ conditionId: CONDITION_ID }),
      "failed to apply merge to ledger",
    );

    const rows = conn.db.prepare(`SELECT status FROM merge_ledger`).all() as Array<{
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("onchain");
  });

  it("the happy path ends at 'applied' with the settlement's real numbers, not the pending placeholders", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    const gateway = {
      mergePositions: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExchangeGateway;

    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    await mod.sweep();

    const rows = conn.db
      .prepare(`SELECT status, merged_amount, spread_pnl FROM merge_ledger`)
      .all() as Array<{ status: string; merged_amount: number; spread_pnl: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("applied");
    expect(rows[0]?.merged_amount).toBe(100);
    // Total cost = 100*0.3 (yes leg) + 100*0.4 (no leg) = 70; merge value = 100 * 1.0 = 100;
    // spread = 30. recordPending never has this number (it writes spread_pnl = 0 as a placeholder),
    // so a nonzero, non-round match here proves the row was overwritten by markApplied's real math.
    expect(rows[0]?.spread_pnl).toBe(30);
  });

  it("start() reports the rows a previous run left non-terminal AND fails healthCheck, keeping 'pending' and 'onchain' apart", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    // Two survivors of an earlier process: one that never got past submission, one the chain took.
    mergeLedgerRepo.recordPending({
      mergeId: "merge-stale-pending",
      conditionId: "0xcond-a",
      mergedAmount: 5,
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    mergeLedgerRepo.recordPending({
      mergeId: "merge-stale-onchain",
      conditionId: "0xcond-b",
      mergedAmount: 7,
      recordedAt: "2026-07-30T00:00:01.000Z",
    });
    mergeLedgerRepo.markOnchain("merge-stale-onchain");

    const gateway = {
      mergePositions: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExchangeGateway;
    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    await mod.start();
    // Read the health BEFORE stop(): an operator polling /health is what turns this from a line
    // buried in the boot log into something anyone actually notices.
    const health = await mod.healthCheck();
    await mod.stop();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 2,
        merges: expect.arrayContaining([
          expect.objectContaining({ mergeId: "merge-stale-pending", status: "pending" }),
          expect.objectContaining({ mergeId: "merge-stale-onchain", status: "onchain" }),
        ]),
      }),
      "merge ledger has non-terminal rows — those conditions are FENCED from further merges until an operator reconciles them on chain with scripts/merge-ledger-reconcile.ts",
    );
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("fenced_conditions=2");
  });

  // r5-M1. The operator CLI can no longer manufacture an 'applied' row, because settling means
  // consuming lots and booking P&L, not flipping a column. That work moved HERE — and only for a
  // row the chain already proved, which is exactly the state `mergePositions` resolving implies.
  it("settles a confirmed 'onchain' row a previous run left unapplied, consuming lots and lifting the fence — while a 'pending' row for another condition stays fenced", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeTwoConditionFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    // The crash survivor: the merge went out, the chain took it, the process died before the local
    // half committed. Its recorded amount is deliberately SMALLER than the 100 shares on each leg —
    // recovery must move the amount that actually went on chain, not one recomputed from today's book.
    mergeLedgerRepo.recordPending({
      mergeId: "merge-confirmed",
      conditionId: CONDITION_ID,
      mergedAmount: 40,
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    mergeLedgerRepo.markOnchain("merge-confirmed");
    // A 'pending' row is NOT the same evidence: nothing distinguishes it from "never broadcast", so
    // it must survive untouched, still fencing its own condition.
    mergeLedgerRepo.recordPending({
      mergeId: "merge-ambiguous",
      conditionId: OTHER_CONDITION_ID,
      mergedAmount: 9,
      recordedAt: "2026-07-30T00:00:01.000Z",
    });

    const gateway = {
      mergePositions: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExchangeGateway;
    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
      sweepIntervalMs: 60 * 60 * 1000,
    });

    await mod.start();
    const health = await mod.healthCheck();
    await mod.stop();

    // Nothing was re-broadcast: recovery is a local repair, never a retry.
    expect(gateway.mergePositions).not.toHaveBeenCalled();

    const rows = conn.db
      .prepare(
        `SELECT merge_id, status, merged_amount, spread_pnl FROM merge_ledger ORDER BY merge_id`,
      )
      .all() as Array<{
      merge_id: string;
      status: string;
      merged_amount: number;
      spread_pnl: number;
    }>;
    expect(rows).toEqual([
      // Cost of 40 merged shares = 40*0.3 + 40*0.4 = 28; value = 40; spread = 12. A placeholder
      // flip would have left spread_pnl at recordPending's 0, so this number is the proof that the
      // real settle transaction ran rather than a status update.
      { merge_id: "merge-ambiguous", status: "pending", merged_amount: 9, spread_pnl: 0 },
      { merge_id: "merge-confirmed", status: "applied", merged_amount: 40, spread_pnl: 12 },
    ]);

    // The legs really moved: 100 - 40 on each side, still open, cost basis reduced by exactly the
    // consumed lots. A status-only repair would have saved nothing at all.
    expect(positionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: "p-yes-x",
        size: 60,
        status: "open",
        costBasisUsdc: 28,
      }),
    );
    expect(positionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: "p-no-x",
        size: 60,
        status: "open",
        costBasisUsdc: 44,
      }),
    );
    // ...and only that condition's legs — the ambiguous condition's positions are untouched.
    expect(positionRepo.save).toHaveBeenCalledTimes(2);

    // One condition is free again; the ambiguous one is still fenced and still reported.
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("fenced_conditions=1");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        merges: [expect.objectContaining({ mergeId: "merge-ambiguous", status: "pending" })],
      }),
      "merge ledger has non-terminal rows — those conditions are FENCED from further merges until an operator reconciles them on chain with scripts/merge-ledger-reconcile.ts",
    );
  });

  it("leaves a confirmed 'onchain' row fenced when its legs are gone — a repair it cannot make is not a repair it may skip", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    // No YES/NO pair exists for this condition, so there is nothing to consume: wallet
    // reconciliation may already have closed the legs. Guessing here would book P&L twice.
    mergeLedgerRepo.recordPending({
      mergeId: "merge-orphan",
      conditionId: "0xcond-no-legs",
      mergedAmount: 5,
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    mergeLedgerRepo.markOnchain("merge-orphan");

    const gateway = {
      mergePositions: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExchangeGateway;
    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
      sweepIntervalMs: 60 * 60 * 1000,
    });

    await mod.start();
    const health = await mod.healthCheck();
    await mod.stop();

    expect(conn.db.prepare(`SELECT status FROM merge_ledger`).all()).toEqual([
      { status: "onchain" },
    ]);
    expect(health.ok).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      { mergeId: "merge-orphan", conditionId: "0xcond-no-legs" },
      "confirmed on-chain merge cannot be settled locally — no open YES/NO pair for the condition; the row stays fenced",
    );
  });

  // r3-M1: the startup report above only NAMES the divergence. These two pin that it also STOPS the
  // resubmission — the case the report alone cannot cover, because it fires once at boot and the
  // sweeps that would resubmit come after it. Both use the same mergeable candidate as every other
  // test here, so the only thing keeping mergePositions from being called is the fence.
  it("a sweep does not resubmit a condition a previous process left non-terminal", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    // The survivor of an earlier process, for the very condition findMergeCandidates still returns:
    // the YES/NO legs were never consumed, so nothing in local state distinguishes "the merge never
    // landed" from "it landed and we never saw the receipt".
    mergeLedgerRepo.recordPending({
      mergeId: "merge-survivor",
      conditionId: CONDITION_ID,
      mergedAmount: 100,
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    mergeLedgerRepo.markOnchain("merge-survivor");

    const gateway = {
      mergePositions: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExchangeGateway;
    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    // sweep() directly, NOT start()+stop(): a module that stops immediately can never reach the
    // sweep that resubmits, which is why the startup-report test cannot stand in for this one.
    await mod.sweep();

    expect(gateway.mergePositions).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      { suppressed: [CONDITION_ID] },
      "merge candidates suppressed — a previous merge for them is still non-terminal and needs operator reconciliation",
    );
    // Untouched: the fence must not manufacture a second intent row for a merge it just refused.
    const rows = conn.db.prepare(`SELECT merge_id, status FROM merge_ledger`).all();
    expect(rows).toEqual([{ merge_id: "merge-survivor", status: "onchain" }]);
  });

  it("stops resubmitting after a broadcast-but-unconfirmed merge, without any breaker or restart", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    // The gateway's honest answer for a batch it broadcast and could not confirm. It is deliberately
    // NOT a rate limit, so the settlement breaker stays shut and cannot be mistaken for the thing
    // that suppressed the second sweep — the fence is the only candidate left.
    const gateway = {
      mergePositions: vi
        .fn()
        .mockRejectedValue(new SettlementUnconfirmedError("merge", "submitted", [CONDITION_ID])),
    } as unknown as ExchangeGateway;
    const breaker = new SettlementInfraBreaker();
    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
      settlementInfraBreaker: breaker,
    });

    await mod.sweep();
    expect(gateway.mergePositions).toHaveBeenCalledTimes(1);
    expect(breaker.current()).toBeNull();

    // Same process, same module instance, breaker shut, positions still unconsumed — every reason a
    // resubmission could be suppressed by accident is absent, and the candidate is offered again.
    await mod.sweep();

    expect(gateway.mergePositions).toHaveBeenCalledTimes(1);
    const health = await mod.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("fenced_conditions=1");
  });

  // A-r28-1, found by revert-checking the fence above. Two sweeps for the same condition inside one
  // millisecond used to mint the SAME merge id, and the duplicate failed `recordPending` on the
  // primary key BEFORE submission — which routes into the "nothing was broadcast" branch and lets
  // `discardUnsubmittedIntents` delete the earlier pass's row. The clock is pinned rather than raced:
  // with a real `Date.now()` the two sweeps usually land in different milliseconds and the test would
  // pass with or without the fix.
  it("mints a distinct merge id for two sweeps in the same millisecond", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
      const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
      const gateway = {
        mergePositions: vi.fn().mockResolvedValue(undefined),
      } as unknown as ExchangeGateway;
      const mod = new InventoryManagerModule({
        bus,
        gateway,
        positionRepo,
        orderRepo,
        marketRepo,
        fillRepo,
        lotRepo,
        mergeLedgerRepo,
        db: conn.db,
        log,
      });

      // Both passes settle to 'applied', so the fence is empty for the second one and cannot be
      // what lets it through — the only thing under test here is id uniqueness.
      await mod.sweep();
      await mod.sweep();

      expect(gateway.mergePositions).toHaveBeenCalledTimes(2);
      const rows = conn.db.prepare(`SELECT merge_id, status FROM merge_ledger`).all() as Array<{
        merge_id: string;
        status: string;
      }>;
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.merge_id)).size).toBe(2);
      expect(rows.every((r) => r.status === "applied")).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rolls the position mutations back when the intent row is gone instead of applying a merge the ledger cannot see", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    // Stands in for any way the intent row can be missing by the time settlement runs. The point is
    // the DIRECTION of the failure: a silently no-op UPDATE would let applyMerge's transaction
    // commit the position and lot mutations with nothing in merge_ledger behind them — recreating
    // the untracked divergence the three states exist to prevent.
    const gateway = {
      mergePositions: vi.fn().mockImplementation(async () => {
        conn.db.prepare(`DELETE FROM merge_ledger`).run();
      }),
    } as unknown as ExchangeGateway;

    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    await mod.sweep();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ mergeId: expect.stringContaining("merge-") }),
      "failed to mark merge 'onchain'",
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ conditionId: CONDITION_ID }),
      "failed to apply merge to ledger",
    );
    expect(positionRepo.save).not.toHaveBeenCalled();
    expect(conn.db.prepare(`SELECT status FROM merge_ledger`).all()).toHaveLength(0);
  });

  it("discards the intent rows when the RPC rate-limits the submission itself", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    const gateway = {
      mergePositions: vi.fn().mockRejectedValue(new Error("429 Too Many Requests")),
    } as unknown as ExchangeGateway;

    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    await mod.sweep();

    // The submission was rejected, so nothing reached the chain and the row records something that
    // never happened. Leaving it would put one false alarm per throttled sweep into the start-up
    // report the previous test asserts — burying the 'onchain' rows that are real divergence.
    expect(conn.db.prepare(`SELECT status FROM merge_ledger`).all()).toHaveLength(0);
  });

  it("leaves the intent row 'pending' when the submission fails for an unknown reason", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    const gateway = {
      mergePositions: vi.fn().mockRejectedValue(new Error("socket hang up")),
    } as unknown as ExchangeGateway;

    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    await mod.sweep();

    // A dropped socket says nothing about whether the transaction was broadcast, so the row must
    // survive: 'pending' is the honest "we do not know", and deleting it here would be the same
    // silent loss the write-ahead intent exists to prevent.
    const rows = conn.db.prepare(`SELECT status FROM merge_ledger`).all() as Array<{
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ mergeIds: expect.arrayContaining([expect.any(String)]) }),
      "merge sweep failed after recording intent — ledger rows left 'pending' (the submission may or may not have landed)",
    );
  });

  it("discards the intent rows when the gateway refuses the batch before submitting it", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    // r27-r2-m4: the gateway's own pre-submission refusals — an unsupported client, or a batch it
    // could not build in full. These are NOT transient: an unsupported client throws on every
    // sweep, so keeping the rows files one false divergence report per candidate per sweep forever.
    const gateway = {
      mergePositions: vi
        .fn()
        .mockRejectedValue(
          new SettlementNotSubmittedError(`could not build merge requests for ${CONDITION_ID}`),
        ),
    } as unknown as ExchangeGateway;

    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    await mod.sweep();

    expect(conn.db.prepare(`SELECT status FROM merge_ledger`).all()).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mergeIds: expect.arrayContaining([expect.any(String)]) }),
      "merge sweep failed before submission — ledger rows discarded (nothing was broadcast)",
    );
  });

  it("discards the intent rows when the sweep throws before it ever reaches the gateway", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    // The partial case the discard path has to survive: the row COMMITS and then recordPending
    // throws, so the ledger holds an intent for a submission that is now impossible. Distinguishing
    // this from a post-submission failure is the whole job of the submissionAttempted flag — the
    // error itself carries no evidence either way.
    const realRecordPending = mergeLedgerRepo.recordPending.bind(mergeLedgerRepo);
    vi.spyOn(mergeLedgerRepo, "recordPending").mockImplementation((intent) => {
      realRecordPending(intent);
      throw new Error("ledger write failed after the row committed");
    });
    const gateway = {
      mergePositions: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExchangeGateway;

    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    await mod.sweep();

    expect(gateway.mergePositions).not.toHaveBeenCalled();
    expect(conn.db.prepare(`SELECT status FROM merge_ledger`).all()).toHaveLength(0);
  });

  it("opens the settlement breaker when the merge batch is rejected by a rate limit", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    // r27-r2-m5: opening the breaker is what stops the very next position event from resubmitting
    // the same batch into a known-throttled RPC. Merging goes out as ONE relayer batch, so a
    // rejection here provably broadcast nothing — the rows go with it.
    const breaker = new SettlementInfraBreaker({ now: () => 1_000 });
    const gateway = {
      mergePositions: vi
        .fn()
        .mockRejectedValue(new Error("429 Too Many Requests: exceeded its compute units")),
    } as unknown as ExchangeGateway;

    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
      settlementInfraBreaker: breaker,
    });

    await mod.sweep();

    expect(breaker.current()?.code).toBe("POLYGON_RPC_RATE_LIMITED");
    expect(conn.db.prepare(`SELECT status FROM merge_ledger`).all()).toHaveLength(0);
  });

  // r4-M1: migration 093's partial unique index turns the fence from an OBSERVATION into an ATOMIC
  // CLAIM. A read-then-write fence (read `findNonTerminal`, then insert) cannot arbitrate across
  // processes: two writers can both read an empty fence and both submit the same merge. This pins
  // the CLAIM path itself, not the pre-filter that already skips conditions the fence-read sees —
  // the pre-filter alone would miss a row that lands in the gap AFTER that read.
  it("drops a candidate whose claim collides with another writer's row — without touching that row — while the rest of the batch still merges", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeTwoConditionFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    const FOREIGN_MERGE_ID = "merge-foreign-writer";

    // Reproduces the real race end-to-end through the real SQLite constraint: the module's OWN
    // pre-filter read (`findNonTerminal`) sees an empty table (so CONDITION_ID is NOT skipped before
    // claiming, same as every other candidate) — then, in the gap between that read and this
    // process's own `recordPending` for CONDITION_ID, another writer's row lands. Only the atomic
    // `INSERT ... ON CONFLICT` inside `recordPending` (not a second fence check) can catch that.
    vi.spyOn(mergeLedgerRepo, "findNonTerminal").mockImplementationOnce(() => {
      conn.db
        .prepare(
          `INSERT INTO merge_ledger (merge_id, condition_id, merged_amount, spread_pnl, merged_at, status)
           VALUES (?, ?, 5, 0, ?, 'pending')`,
        )
        .run(FOREIGN_MERGE_ID, CONDITION_ID, "2026-07-30T00:00:00.000Z");
      return [];
    });

    const gateway = {
      mergePositions: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExchangeGateway;
    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    await mod.sweep();

    // (a) Only the candidate that actually claimed its condition reaches the gateway.
    expect(gateway.mergePositions).toHaveBeenCalledTimes(1);
    expect(gateway.mergePositions).toHaveBeenCalledWith([
      { conditionId: OTHER_CONDITION_ID, amount: 100 },
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      { lostClaims: [CONDITION_ID] },
      "merge candidates dropped — another writer already has a non-terminal merge for them",
    );

    // (b) The foreign writer's row is untouched: same merge_id, still 'pending'. A lost claim must
    // never delete or alter a row it does not own.
    const foreignRow = conn.db
      .prepare(`SELECT merge_id, status FROM merge_ledger WHERE condition_id = ?`)
      .get(CONDITION_ID) as { merge_id: string; status: string } | undefined;
    expect(foreignRow).toEqual({ merge_id: FOREIGN_MERGE_ID, status: "pending" });

    // (c) The candidate that DID claim its condition completes normally.
    const otherRow = conn.db
      .prepare(`SELECT status FROM merge_ledger WHERE condition_id = ?`)
      .get(OTHER_CONDITION_ID) as { status: string } | undefined;
    expect(otherRow?.status).toBe("applied");
  });

  // r4-m1: `healthCheck` used to read a cached `fencedConditionIds` set that only a sweep/start()
  // populated. The old suite only ever asserted health AFTER `start()` had run, so a cache that was
  // stale or never populated (this exact scenario — a row another process wrote before THIS process
  // ever swept) would have passed unnoticed. `healthCheck` now reads `findNonTerminal()` fresh on
  // every call, so the fence must be visible with zero prior sweeps, and "unreadable" must report
  // "unknown" rather than silently falling back to "ok".
  it("healthCheck sees a pre-existing fenced row before any sweep ever runs, and fails closed when the ledger read itself throws", async () => {
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    mergeLedgerRepo.recordPending({
      mergeId: "merge-pre-existing",
      conditionId: CONDITION_ID,
      mergedAmount: 5,
      recordedAt: "2026-07-30T00:00:00.000Z",
    });

    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const gateway = { mergePositions: vi.fn() } as unknown as ExchangeGateway;
    const mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    // Neither start() nor sweep() has run — the row is visible only because healthCheck reads the
    // ledger directly, not because something populated a cache first.
    const healthBeforeAnySweep = await mod.healthCheck();
    expect(gateway.mergePositions).not.toHaveBeenCalled();
    expect(healthBeforeAnySweep.ok).toBe(false);
    expect(healthBeforeAnySweep.detail).toContain("fenced_conditions=1");

    vi.spyOn(mergeLedgerRepo, "findNonTerminal").mockImplementation(() => {
      throw new Error("disk read error");
    });
    const healthOnReadFailure = await mod.healthCheck();
    expect(healthOnReadFailure.ok).toBe(false);
    expect(healthOnReadFailure.detail).toContain("fenced_conditions=unknown");
  });
});
