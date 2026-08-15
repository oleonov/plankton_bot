import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bootstrapLedgerDb,
  openDatabase,
  SqliteInventoryLotRepository,
  SqliteLegStateRepository,
  SqliteMergeLedgerRepository,
  SqlitePositionRepository,
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
  MergeLedgerRepository,
  MergeRecord,
  Position,
  PositionId,
  TokenId,
} from "@krabs/domain";
import { createPositionId, createTokenId } from "@krabs/domain";
import { SettlementNotSubmittedError, SettlementUnconfirmedError } from "@krabs/exchange";
import { InventoryManagerModule } from "../inventory-manager-module.js";
import {
  recoverConfirmedOnchainMerges,
  republishMergeLegs,
  resolveAppliedMergeReplacementRepairs,
  resolveCurrentMergeRecoveryReplayPosition,
  resolveMergeRecoveryReplayPositions,
} from "../recover-onchain-merges.js";
import { MergeSettler } from "../merge-settler.js";
import { SettlementInfraBreaker } from "../../settlement-infra-breaker.js";
import type { Logger } from "../../../logger.js";
import type { RuntimeMetricWriter } from "../../../runtime-metric-writer.js";
import {
  cleanupPriorStartupAdoptionArtifacts,
  rebuildLegStatesFromLedger,
} from "../../../startup-position-adoption.js";

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
// Fixture positions "opened" this long before any test's real-clock `merge_ledger.merged_at` that
// the freshness fence in `recover-onchain-merges.ts` never mistakes a fixture leg for a same-token
// replacement opened after the write-ahead row.
const OPENED_AT_PAST = "2020-01-01T00:00:00.000Z";

function recordPending(
  repo: MergeLedgerRepository,
  record: { conditionId: string } & Record<string, unknown>,
): void {
  repo.recordPending({ ...recordedIdentity(record.conditionId), ...record } as Parameters<
    MergeLedgerRepository["recordPending"]
  >[0]);
}

function recordedIdentity(conditionId: string) {
  return conditionId === OTHER_CONDITION_ID
    ? {
        yesTokenId: createTokenId(OTHER_YES_TOKEN),
        noTokenId: createTokenId(OTHER_NO_TOKEN),
        yesPositionId: createPositionId("p-yes-y"),
        noPositionId: createPositionId("p-no-y"),
      }
    : {
        yesTokenId: createTokenId(YES_TOKEN),
        noTokenId: createTokenId(NO_TOKEN),
        yesPositionId: createPositionId("p-yes"),
        noPositionId: createPositionId("p-no"),
      };
}

/**
 * A position repository that behaves like the real SQLite one in the ONE respect these tests turn
 * on: `save` is visible to later reads, and `findByTokenId` filters out closed positions exactly as
 * `SqliteMergeLedgerRepository`'s sibling does (`WHERE token_id = ? AND status != 'closed'`). A mock
 * that always returned the original open objects would let a merge publish a leg it had just closed
 * — the r7-M2 defect — and still pass.
 */
function makeStatefulPositionRepo(
  initial: Array<{ positionId: string; tokenId: string; status: string; conditionId?: string }>,
): PositionRepository {
  const store = new Map(initial.map((p) => [p.positionId, p as Record<string, unknown>]));
  return {
    findOpen: vi.fn(() => [...store.values()].filter((p) => p.status === "open")),
    findByTokenId: vi.fn(
      (tid: string) =>
        [...store.values()].find((p) => p.tokenId === tid && p.status !== "closed") ?? null,
    ),
    // Deliberately NOT status-filtered, mirroring the real `SELECT * FROM positions WHERE
    // position_id = ?`. That difference from `findByTokenId` is the whole reason the failed-apply
    // republish reads by id: a leg a merge consumed entirely is 'closed', and it is precisely the
    // leg subscribers must hear about.
    findById: vi.fn((positionId: string) => store.get(positionId) ?? null),
    save: vi.fn((p: { positionId: string }) => {
      store.set(p.positionId, p as Record<string, unknown>);
    }),
  } as unknown as PositionRepository;
}

/**
 * The REAL repository with only its fence reads scripted, call by call — the one thing a second
 * process's interleaving changes that a single-process test cannot otherwise stage. Every write
 * still goes to SQLite, so the CAS these tests race against is the real one. Reads past the end of
 * the script fall through to the live table.
 */
function withScriptedFenceReads(
  repo: MergeLedgerRepository,
  reads: Array<() => MergeRecord[]>,
): MergeLedgerRepository {
  let call = 0;
  return {
    recordPending: (m) => repo.recordPending(m),
    markOnchain: (id) => repo.markOnchain(id),
    markApplied: (m) => repo.markApplied(m),
    deletePending: (id) => repo.deletePending(id),
    findNonTerminal: () => reads[call++]?.() ?? repo.findNonTerminal(),
  };
}

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
    conditionId: CONDITION_ID,
    size: 100,
    status: "open",
    realizedPnl: 0,
    costBasisUsdc: 40,
    avgEntryPrice: 0.4,
    openedAt: OPENED_AT_PAST,
  };
  const noPos = {
    positionId: "p-no",
    tokenId: NO_TOKEN,
    conditionId: CONDITION_ID,
    size: 100,
    status: "open",
    realizedPnl: 0,
    costBasisUsdc: 60,
    avgEntryPrice: 0.6,
    openedAt: OPENED_AT_PAST,
  };
  const yesMarket = { tokenId: YES_TOKEN, conditionId: CONDITION_ID, outcome: "Yes" };
  const noMarket = { tokenId: NO_TOKEN, conditionId: CONDITION_ID, outcome: "No" };

  const positionRepo = makeStatefulPositionRepo([yesPos, noPos]);
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
    // The `lot-after` fence reads this. Empty by default = every lot predates the merge intent, the
    // ordinary case; the consolidation test below overrides it.
    findOpen: vi.fn().mockReturnValue([]),
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
      conditionId: CONDITION_ID,
      size: 100,
      status: "open",
      realizedPnl: 0,
      costBasisUsdc: 40,
      avgEntryPrice: 0.4,
      openedAt: OPENED_AT_PAST,
    },
    {
      positionId: "p-no-x",
      tokenId: NO_TOKEN,
      conditionId: CONDITION_ID,
      size: 100,
      status: "open",
      realizedPnl: 0,
      costBasisUsdc: 60,
      avgEntryPrice: 0.6,
      openedAt: OPENED_AT_PAST,
    },
    {
      positionId: "p-yes-y",
      tokenId: OTHER_YES_TOKEN,
      conditionId: OTHER_CONDITION_ID,
      size: 100,
      status: "open",
      realizedPnl: 0,
      costBasisUsdc: 40,
      avgEntryPrice: 0.4,
      openedAt: OPENED_AT_PAST,
    },
    {
      positionId: "p-no-y",
      tokenId: OTHER_NO_TOKEN,
      conditionId: OTHER_CONDITION_ID,
      size: 100,
      status: "open",
      realizedPnl: 0,
      costBasisUsdc: 60,
      avgEntryPrice: 0.6,
      openedAt: OPENED_AT_PAST,
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

  const positionRepo = makeStatefulPositionRepo(positions);
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
    findOpen: vi.fn().mockReturnValue([]),
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
    let seenFromSeparateConnection:
      | {
          status: string;
          yes_token_id: string;
          no_token_id: string;
          yes_position_id: string;
          no_position_id: string;
        }
      | undefined;
    const gateway = {
      mergePositions: vi.fn().mockImplementation(async () => {
        const reader = openDatabase(dbPath);
        try {
          seenFromSeparateConnection = reader.db
            .prepare(
              `SELECT status, yes_token_id, no_token_id, yes_position_id, no_position_id
               FROM merge_ledger WHERE condition_id = ?`,
            )
            .get(CONDITION_ID) as typeof seenFromSeparateConnection;
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
    expect(seenFromSeparateConnection).toEqual({
      status: "pending",
      yes_token_id: YES_TOKEN,
      no_token_id: NO_TOKEN,
      yes_position_id: "p-yes",
      no_position_id: "p-no",
    });
  });

  it.each([
    ["blank", { yesTokenId: createTokenId("") }, "incomplete-identity"],
    ["same token", { noTokenId: createTokenId(YES_TOKEN) }, "same-token"],
    ["same position", { noPositionId: createPositionId("p-yes") }, "same-position"],
    ["cross-bound", { yesTokenId: createTokenId("p-no") }, "cross-bound-identity"],
  ])(
    "drops a %s leg identity before recordPending or the gateway",
    async (_label, mutation, reason) => {
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
      const candidate = {
        conditionId: CONDITION_ID,
        mergeAmount: 40,
        yesTokenId: createTokenId(YES_TOKEN),
        noTokenId: createTokenId(NO_TOKEN),
        yesPositionId: createPositionId("p-yes"),
        noPositionId: createPositionId("p-no"),
        ...mutation,
      };
      (
        mod as unknown as {
          candidateService: { findMergeCandidates(): Array<typeof candidate> };
        }
      ).candidateService.findMergeCandidates = vi.fn(() => [candidate]);

      await mod.sweep();

      expect(gateway.mergePositions).not.toHaveBeenCalled();
      expect(conn.db.prepare("SELECT 1 FROM merge_ledger").all()).toEqual([]);
      expect(log.error).toHaveBeenCalledWith(
        { conditionId: CONDITION_ID, reason },
        "merge candidate has invalid recorded leg identity — candidate dropped",
      );
    },
  );

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

  // r9-P1. The gateway resolved, so the merge IS on chain — but the row never left 'pending'.
  // Settling anyway would fail `markApplied`'s CAS and report a race that never happened, while
  // start-up recovery deliberately ignores 'pending' rows: the merge would stay unapplied forever
  // behind a misleading message.
  it("skips local settlement when the 'onchain' flip failed and left the row 'pending', naming the real condition", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const real = new SqliteMergeLedgerRepository(conn.db);
    const mergeLedgerRepo: MergeLedgerRepository = {
      recordPending: (m) => real.recordPending(m),
      markOnchain: () => {
        throw new Error("disk I/O error");
      },
      markApplied: (m) => real.markApplied(m),
      deletePending: (id) => real.deletePending(id),
      findNonTerminal: () => real.findNonTerminal(),
    };
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
    // No local settlement was attempted at all — not attempted-and-rolled-back.
    expect(lotRepo.consumeFifo).not.toHaveBeenCalled();
    expect(positionRepo.save).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ conditionId: CONDITION_ID }),
      expect.stringContaining("CONFIRMED on chain but its ledger row could not be advanced"),
    );

    const rows = conn.db.prepare(`SELECT status FROM merge_ledger`).all() as Array<{
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  // The other half of the same throw: `markOnchain` also throws when the row is ALREADY 'onchain'
  // because the reconcile CLI promoted it. That row is exactly the one `applyMerge` can advance —
  // a blanket skip on a failed flip would strand it.
  it("still settles when the failed 'onchain' flip was a no-op because another writer promoted the row", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const real = new SqliteMergeLedgerRepository(conn.db);
    const mergeLedgerRepo: MergeLedgerRepository = {
      recordPending: (m) => real.recordPending(m),
      markOnchain: (id) => {
        real.markOnchain(id); // the operator CLI's promotion...
        real.markOnchain(id); // ...so ours finds nothing left to advance and throws
      },
      markApplied: (m) => real.markApplied(m),
      deletePending: (id) => real.deletePending(id),
      findNonTerminal: () => real.findNonTerminal(),
    };
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

    expect(lotRepo.consumeFifo).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ conditionId: CONDITION_ID }),
      "inventory merge applied to ledger",
    );
    const rows = conn.db.prepare(`SELECT status FROM merge_ledger`).all() as Array<{
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("applied");
  });

  // r11-P1. The third way that same throw arrives: an operator promotion plus another runtime's
  // recovery carried the row all the way to 'applied' before our re-read. `findNonTerminal()` omits
  // applied rows, so the candidate is 'unappliable' and its SETTLEMENT is correctly skipped — but
  // the winner moved the shared positions on a different bus, and skipping the PUBLISH too would
  // leave this runtime stale while its health check sees no fence at all.
  it("republishes both legs when the row is skipped as unappliable because another runtime already applied it", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const real = new SqliteMergeLedgerRepository(conn.db);
    const winnerLegs = [
      {
        positionId: "p-yes",
        tokenId: YES_TOKEN,
        conditionId: CONDITION_ID,
        size: 0,
        status: "closed",
        realizedPnl: 15,
      },
      {
        positionId: "p-no",
        tokenId: NO_TOKEN,
        conditionId: CONDITION_ID,
        size: 0,
        status: "closed",
        realizedPnl: 15,
      },
    ];
    const mergeLedgerRepo: MergeLedgerRepository = {
      recordPending: (m) => real.recordPending(m),
      markOnchain: (id) => {
        // The other runtime promotes AND settles the row while our on-chain call is in flight...
        real.markOnchain(id);
        real.markApplied({
          mergeId: id,
          conditionId: CONDITION_ID,
          mergedAmount: 100,
          spreadPnl: 30,
          mergedAt: "2026-08-04T00:00:01.000Z",
          status: "applied",
        });
        for (const leg of winnerLegs) positionRepo.save(leg as unknown as Position);
        // ...so our flip finds nothing left to advance, and the re-read finds no non-terminal row.
        throw new Error("merge_ledger row is 'applied', not 'pending'");
      },
      markApplied: (m) => real.markApplied(m),
      deletePending: (id) => real.deletePending(id),
      findNonTerminal: () => real.findNonTerminal(),
    };
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

    // The settlement really was skipped — this is the unappliable branch, not the apply-failed one.
    expect(lotRepo.consumeFifo).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ conditionId: CONDITION_ID }),
      expect.stringContaining("CONFIRMED on chain but its ledger row could not be advanced"),
    );
    // ...and the caches still hear about the legs the winner moved.
    expect(positionRepo.findById).toHaveBeenCalledWith("p-yes");
    expect(positionRepo.findById).toHaveBeenCalledWith("p-no");
    const published = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([topic]) => topic === "PositionUpdated")
      .map(
        ([, payload]) => (payload as { position: { positionId: string; status: string } }).position,
      );
    expect(published.map((p) => p.positionId).sort()).toEqual(["p-no", "p-yes"]);
    expect(published.every((p) => p.status === "closed")).toBe(true);
  });

  // r12-P2. `isMergeRowAppliable` used to collapse "pending" and "absent" into the SAME `unappliable`
  // signal, and the old code republished for both. That is wrong for "pending": the flip itself just
  // failed, nothing moved, and there is no proven new state to announce. This pins the split, in one
  // sweep with two candidates so both kinds are exercised at once: "pending" (CONDITION_ID, the row
  // survives untouched) must NOT publish; "absent" (OTHER_CONDITION_ID, another writer applied it
  // first) MUST publish. It also pins that BOTH conditions are excluded from the next sweep's
  // submissions — "pending" via its own surviving ledger row, "absent" via the process-local
  // `unresolvedOnchainMerges` fail-safe, since its ledger row is now terminal and proves nothing — and
  // that healthCheck surfaces the fail-safe's count and turns unhealthy while it is non-empty.
  it("republishes only the 'absent' unappliable row, never the 'pending' one, and fences both from the next sweep", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeTwoConditionFixtures();
    const real = new SqliteMergeLedgerRepository(conn.db);
    const mergeLedgerRepo: MergeLedgerRepository = {
      recordPending: (m) => real.recordPending(m),
      markOnchain: (id) => {
        if (id.includes(OTHER_CONDITION_ID)) {
          // Another writer promotes AND applies this row before our own flip lands — "absent" next:
          // `findNonTerminal` will have nothing left for this mergeId.
          real.markOnchain(id);
          real.markApplied({
            mergeId: id,
            conditionId: OTHER_CONDITION_ID,
            mergedAmount: 100,
            spreadPnl: 30,
            mergedAt: "2026-08-04T00:00:01.000Z",
            status: "applied",
          });
          throw new Error("merge_ledger row is 'applied', not 'pending'");
        }
        // CONDITION_ID: the flip itself fails and the row is left exactly as recordPending wrote it
        // — "pending" next.
        throw new Error("simulated disk I/O error — the flip itself never landed");
      },
      markApplied: (m) => real.markApplied(m),
      deletePending: (id) => real.deletePending(id),
      findNonTerminal: () => real.findNonTerminal(),
    };
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
    const publishedAfterFirstSweep = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([topic]) => topic === "PositionUpdated")
      .map(([, payload]) => (payload as { position: { positionId: string } }).position.positionId);
    // "pending": no publish for CONDITION_ID's legs — nothing here proves they moved.
    expect(publishedAfterFirstSweep).not.toContain("p-yes-x");
    expect(publishedAfterFirstSweep).not.toContain("p-no-x");
    // "absent": DOES publish for OTHER_CONDITION_ID's legs — the winner's state must converge here.
    expect(publishedAfterFirstSweep).toEqual(expect.arrayContaining(["p-yes-y", "p-no-y"]));

    // Neither condition's shares were actually merged locally, so both remain valid candidates on the
    // next sweep — the only thing that may suppress them is the fence.
    await mod.sweep();
    // Still exactly one call, from the first sweep: neither condition was resubmitted.
    expect(gateway.mergePositions).toHaveBeenCalledTimes(1);

    const health = await mod.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("unresolved_onchain_merges=2");
  });

  // r9-P2. A lost `markApplied` CAS is not a no-op: the WINNER already committed both merged legs to
  // the shared ledger, and it published them on its own bus before this process's subscribers
  // existed. Without a republish here, every event-driven cache in this still-running process keeps
  // the pre-merge legs forever.
  it("republishes both legs from the ledger when the apply fails, including legs a closed status hides from findByTokenId", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const real = new SqliteMergeLedgerRepository(conn.db);
    // The 100-vs-100 merge consumes BOTH legs entirely, so the winner's rows are both 'closed' —
    // the exact shape `findByTokenId` filters away and only a by-id re-read can see.
    const winnerLegs = [
      {
        positionId: "p-yes",
        tokenId: YES_TOKEN,
        conditionId: CONDITION_ID,
        size: 0,
        status: "closed",
        realizedPnl: 15,
      },
      {
        positionId: "p-no",
        tokenId: NO_TOKEN,
        conditionId: CONDITION_ID,
        size: 0,
        status: "closed",
        realizedPnl: 15,
      },
    ];
    const mergeLedgerRepo: MergeLedgerRepository = {
      recordPending: (m) => real.recordPending(m),
      markOnchain: (id) => real.markOnchain(id),
      markApplied: () => {
        // The winning process's transaction committed while ours was still open.
        for (const leg of winnerLegs) positionRepo.save(leg as unknown as Position);
        throw new Error("merge_ledger row is 'applied', not 'onchain'");
      },
      deletePending: (id) => real.deletePending(id),
      findNonTerminal: () => real.findNonTerminal(),
    };
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

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ conditionId: CONDITION_ID }),
      "failed to apply merge to ledger",
    );
    // Read by id, never by token: a by-token read would have returned null for both closed legs and
    // published nothing at all.
    expect(positionRepo.findById).toHaveBeenCalledWith("p-yes");
    expect(positionRepo.findById).toHaveBeenCalledWith("p-no");
    const published = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([topic]) => topic === "PositionUpdated")
      .map(
        ([, payload]) => (payload as { position: { positionId: string; status: string } }).position,
      );
    expect(published.map((p) => p.positionId).sort()).toEqual(["p-no", "p-yes"]);
    expect(published.every((p) => p.status === "closed")).toBe(true);
  });

  // r12-P1. The snapshot ids a candidate carries can go stale between being captured and this call:
  // a concurrent process can open a brand-new position cycle on the same token (unrelated to this
  // merge) before the republish runs. `findById` alone would announce only the old, closed row and
  // leave the token's real current row unannounced — this pins that `findByTokenId` closes that gap
  // WITHOUT duplicating a row both lookups agree on.
  it("republishes the current by-token position in addition to the snapshot row when the token's active row was replaced", async () => {
    const positionRepo = makeStatefulPositionRepo([
      { positionId: "p-yes", tokenId: YES_TOKEN, conditionId: CONDITION_ID, status: "closed" },
      { positionId: "p-no", tokenId: NO_TOKEN, conditionId: CONDITION_ID, status: "closed" },
    ]);
    // A concurrent process opens a brand-new position cycle on the same tokens, unrelated to this
    // merge — the snapshot ids above are what the candidate captured BEFORE that happened.
    positionRepo.save({
      positionId: "p-yes-v2",
      tokenId: YES_TOKEN,
      conditionId: CONDITION_ID,
      status: "open",
    } as unknown as Position);
    positionRepo.save({
      positionId: "p-no-v2",
      tokenId: NO_TOKEN,
      conditionId: CONDITION_ID,
      status: "open",
    } as unknown as Position);

    await republishMergeLegs(
      { bus, positionRepo, log },
      {
        conditionId: CONDITION_ID,
        yesPositionId: "p-yes" as PositionId,
        noPositionId: "p-no" as PositionId,
        yesTokenId: YES_TOKEN as TokenId,
        noTokenId: NO_TOKEN as TokenId,
      },
    );

    const published = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([topic]) => topic === "PositionUpdated")
      .map(([, payload]) => (payload as { position: { positionId: string } }).position.positionId);
    // Both the closed snapshot row (findById) AND the new current row (findByTokenId) are announced.
    expect(published.sort()).toEqual(["p-no", "p-no-v2", "p-yes", "p-yes-v2"]);

    // Dedup half: when the snapshot ids already ARE the current rows, the two lookups agree and each
    // row must publish exactly once, never twice.
    (bus.publish as ReturnType<typeof vi.fn>).mockClear();
    await republishMergeLegs(
      { bus, positionRepo, log },
      {
        conditionId: CONDITION_ID,
        yesPositionId: "p-yes-v2" as PositionId,
        noPositionId: "p-no-v2" as PositionId,
        yesTokenId: YES_TOKEN as TokenId,
        noTokenId: NO_TOKEN as TokenId,
      },
    );
    expect(bus.publish).toHaveBeenCalledTimes(2);
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
    recordPending(mergeLedgerRepo, {
      mergeId: "merge-stale-pending",
      conditionId: "0xcond-a",
      mergedAmount: 5,
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    recordPending(mergeLedgerRepo, {
      mergeId: "merge-stale-onchain",
      conditionId: "0xcond-b",
      mergedAmount: 7,
      recordedAt: "2026-07-30T00:00:01.000Z",
      yesTokenId: createTokenId("tok-stale-yes"),
      noTokenId: createTokenId("tok-stale-no"),
      yesPositionId: createPositionId("p-stale-yes"),
      noPositionId: createPositionId("p-stale-no"),
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

  // r10-P1. The pre-supervisor recovery in index.ts takes ONE snapshot. A row that was still
  // 'pending' when that snapshot was taken is skipped there — correctly, because a 'pending' row
  // cannot be told apart from "never broadcast" — but the process that owned it can confirm it and
  // advance it to 'onchain' in the window before this module starts. From that moment it is
  // provably settleable, and nothing looks again until the next process restart: a start() that
  // only REPORTS leaves this runtime trading on positions and FIFO lots whose shares the chain has
  // already merged away. Settling here is what closes the window.
  it("start() settles a row that turned 'onchain' after the pre-supervisor snapshot instead of only reporting it", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    recordPending(mergeLedgerRepo, {
      mergeId: "merge-raced-onchain",
      conditionId: CONDITION_ID,
      mergedAmount: 40,
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    // The window itself: the owning process got its on-chain confirmation and advanced the row
    // AFTER the pre-supervisor pass had already seen it as 'pending', then died before applying it.
    mergeLedgerRepo.markOnchain("merge-raced-onchain");

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
    const health = await mod.healthCheck();
    await mod.stop();

    // Settled, not reported — and by the amount the CHAIN moved (40), not the 100 on each leg.
    expect(lotRepo.consumeFifo).toHaveBeenCalledWith("p-yes", 40);
    expect(lotRepo.consumeFifo).toHaveBeenCalledWith("p-no", 40);
    expect(
      conn.db
        .prepare(`SELECT status FROM merge_ledger WHERE merge_id = ?`)
        .get("merge-raced-onchain"),
    ).toEqual({ status: "applied" });
    // Nothing is submitted: this repairs a merge that already happened on chain.
    expect(gateway.mergePositions).not.toHaveBeenCalled();
    // Every module that hydrated before this one must hear about both legs, or its cache still
    // holds the pre-merge sizes this settlement just wrote away.
    expect(bus.publish).toHaveBeenCalledWith("PositionUpdated", expect.anything());
    // The fence is genuinely lifted rather than merely re-announced.
    expect(health.ok).toBe(true);
  });

  // r12-P1. start()'s own repair only takes ONE snapshot, at the moment it runs. A row that is still
  // 'pending' at that instant is correctly left alone — but the owning process can confirm it on
  // chain and advance it to 'onchain' any time AFTER start() returns, and nothing looked again until
  // the next process restart. This pins the fix: the PERIODIC sweep repairs it too, without waiting
  // for a restart.
  it("a later sweep settles a row that turned 'onchain' only after start()'s own repair already ran", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    // Full leg size (100), not a partial amount: a partial repair would leave a genuine residual
    // balance open on both legs, and the SAME sweep's own candidate pass would then legitimately
    // submit a fresh merge for it — a real behavior, but not what this test is pinning. Consuming
    // the whole leg closes both positions, so nothing is left to re-candidate.
    recordPending(mergeLedgerRepo, {
      mergeId: "merge-raced-post-start",
      conditionId: CONDITION_ID,
      mergedAmount: 100,
      recordedAt: "2026-07-30T00:00:00.000Z",
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

    await mod.start();
    // start()'s own repair snapshot found the row still 'pending' — nothing settleable yet.
    expect(lotRepo.consumeFifo).not.toHaveBeenCalled();

    // The owning process confirms on chain and advances the row AFTER start()'s snapshot — the exact
    // post-startup window this fix closes. Nothing but the next periodic sweep looks again.
    mergeLedgerRepo.markOnchain("merge-raced-post-start");

    await mod.sweep();
    const health = await mod.healthCheck();
    await mod.stop();

    // Settled by the periodic sweep's own repair call, not merely reported.
    expect(lotRepo.consumeFifo).toHaveBeenCalledWith("p-yes", 100);
    expect(lotRepo.consumeFifo).toHaveBeenCalledWith("p-no", 100);
    expect(
      conn.db
        .prepare(`SELECT status FROM merge_ledger WHERE merge_id = ?`)
        .get("merge-raced-post-start"),
    ).toEqual({ status: "applied" });
    // Nothing is submitted: this repairs a merge that already happened on chain, and consuming the
    // full leg size leaves no residual balance for the sweep's own candidate pass to re-submit.
    expect(gateway.mergePositions).not.toHaveBeenCalled();
    expect(health.ok).toBe(true);
  });

  // r5-M1. The operator CLI can no longer manufacture an 'applied' row, because settling means
  // consuming lots and booking P&L, not flipping a column. That work moved HERE — and only for a
  // row the chain already proved, which is exactly the state `mergePositions` resolving implies.
  //
  // r6-M2: it then moved OUT of the module. These two call the recovery the way index.ts does —
  // standalone, with no gateway, no feature flag and no module in sight — because repairing a merge
  // that ALREADY happened must not vanish when auto-merge submission is switched off.
  it("settles a confirmed 'onchain' row a previous run left unapplied, consuming lots and lifting the fence — while a 'pending' row for another condition stays fenced", async () => {
    const { positionRepo, orderRepo, marketRepo, fillRepo, lotRepo } = makeTwoConditionFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    // The crash survivor: the merge went out, the chain took it, the process died before the local
    // half committed. Its recorded amount is deliberately SMALLER than the 100 shares on each leg —
    // recovery must move the amount that actually went on chain, not one recomputed from today's book.
    recordPending(mergeLedgerRepo, {
      mergeId: "merge-confirmed",
      conditionId: CONDITION_ID,
      mergedAmount: 40,
      recordedAt: "2026-07-30T00:00:00.000Z",
      yesPositionId: createPositionId("p-yes-x"),
      noPositionId: createPositionId("p-no-x"),
    });
    mergeLedgerRepo.markOnchain("merge-confirmed");
    // A 'pending' row is NOT the same evidence: nothing distinguishes it from "never broadcast", so
    // it must survive untouched, still fencing its own condition.
    recordPending(mergeLedgerRepo, {
      mergeId: "merge-ambiguous",
      conditionId: OTHER_CONDITION_ID,
      mergedAmount: 9,
      recordedAt: "2026-07-30T00:00:01.000Z",
    });

    const { recovered, remaining, settled } = await recoverConfirmedOnchainMerges({
      bus,
      positionRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    expect(recovered).toBe(1);
    expect(remaining.map((r) => r.mergeId)).toEqual(["merge-ambiguous"]);
    // r12-P2: `settled` is what the pre-supervisor caller in index.ts replays once subscribers
    // actually exist — its own publishes above land before anything has subscribed. Only the
    // SUCCESSFUL apply's positions belong here, in their post-merge shape; the still-fenced
    // "merge-ambiguous" condition contributed nothing, so it must not appear.
    expect(settled.map((p) => p.positionId).sort()).toEqual(["p-no-x", "p-yes-x"]);
    expect(settled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ positionId: "p-yes-x", size: 60, costBasisUsdc: 28 }),
        expect.objectContaining({ positionId: "p-no-x", size: 60, costBasisUsdc: 44 }),
      ]),
    );

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

    // r6-M2: BOTH legs are announced. A repair that consumed shares without publishing would leave
    // every PositionUpdated-driven cache — leg state, exposure, S1 ownership — sizing against
    // inventory this run just spent.
    //
    // r7-M2: and the announced payload must be the POST-merge leg. Asserting only positionId let a
    // publish of the pre-merge object pass, which is worse than silence: a subscriber would then
    // cache 100 shares at a 40 cost basis as freshly confirmed.
    expect(bus.publish).toHaveBeenCalledWith("PositionUpdated", {
      position: expect.objectContaining({
        positionId: "p-yes-x",
        size: 60,
        status: "open",
        costBasisUsdc: 28,
      }),
    });
    expect(bus.publish).toHaveBeenCalledWith("PositionUpdated", {
      position: expect.objectContaining({
        positionId: "p-no-x",
        size: 60,
        status: "open",
        costBasisUsdc: 44,
      }),
    });

    // One condition is free again; the ambiguous one is still fenced and still reported.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        merges: [expect.objectContaining({ mergeId: "merge-ambiguous", status: "pending" })],
      }),
      "merge ledger has non-terminal rows — those conditions are FENCED from further merges until an operator reconciles them on chain with scripts/merge-ledger-reconcile.ts",
    );

    // The module that starts AFTER the repair — production's order — sees one fenced condition,
    // not two, and still re-broadcasts nothing.
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

    expect(gateway.mergePositions).not.toHaveBeenCalled();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("fenced_conditions=1");
  });

  it("keeps merge-bound synthetic history through cleanup and replays a post-hydration current row", async () => {
    const positionRepo = new SqlitePositionRepository(conn.db);
    const lotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    for (const [tokenId, positionId, price] of [
      [YES_TOKEN, "p-yes", 0.4],
      [NO_TOKEN, "p-no", 0.6],
    ] as const) {
      conn.db.exec(
        `INSERT INTO positions (position_id, token_id, condition_id, side, size, avg_entry_price, cost_basis_usdc, status, opened_at, updated_at) VALUES ('${positionId}', '${tokenId}', '${CONDITION_ID}', 'buy', 10, ${price}, ${price * 10}, 'open', '${OPENED_AT_PAST}', '${OPENED_AT_PAST}'); INSERT INTO orders (order_id, client_order_id, token_id, condition_id, side, order_type, price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at) VALUES ('ord-${tokenId}', 'coid-${tokenId}', '${tokenId}', '${CONDITION_ID}', 'buy', 'GTC', ${price}, 10, ${price * 10}, 'filled', 'startup-adoption', 'run-1', '${OPENED_AT_PAST}', '${OPENED_AT_PAST}'); INSERT INTO fills (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at) VALUES ('fill-${tokenId}', 'ord-${tokenId}', '${tokenId}', '${CONDITION_ID}', 'buy', ${price}, 10, ${price * 10}, '${OPENED_AT_PAST}'); INSERT INTO inventory_lots (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at) VALUES ('lot-${tokenId}', '${positionId}', '${tokenId}', 'buy', 10, 10, ${price}, ${price * 10}, 'fill-${tokenId}', '${OPENED_AT_PAST}');`,
      );
    }
    recordPending(mergeLedgerRepo, {
      mergeId: "merge-synthetic-restart",
      conditionId: CONDITION_ID,
      mergedAmount: 10,
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    mergeLedgerRepo.markOnchain("merge-synthetic-restart");
    const recoveryDeps = { bus, positionRepo, lotRepo, mergeLedgerRepo, db: conn.db, log };
    const recovery = await recoverConfirmedOnchainMerges(recoveryDeps);
    const cleanup = () => cleanupPriorStartupAdoptionArtifacts({ db: conn.db, log } as never);
    expect(cleanup().orderIds).toEqual([]);
    expect(cleanup().orderIds).toEqual([]);
    const adoptedAt = "2026-08-14T00:00:00.000Z";
    conn.db.exec(
      `INSERT INTO leg_states (token_id, buy_count, sell_count, last_action, first_trade_price, first_trade_at, last_trade_at, updated_at) VALUES ('${YES_TOKEN}', 9, 0, 'BUY', 0.01, '${OPENED_AT_PAST}', '${OPENED_AT_PAST}', '${OPENED_AT_PAST}'); INSERT INTO positions (position_id, token_id, condition_id, side, size, avg_entry_price, cost_basis_usdc, status, opened_at, updated_at) VALUES ('p-yes-adopted', '${YES_TOKEN}', '${CONDITION_ID}', 'buy', 2, .45, .9, 'open', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'); INSERT INTO fills (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at) VALUES ('fill-yes-adopted', 'ord-tok-yes', '${YES_TOKEN}', '${CONDITION_ID}', 'buy', .45, 2, .9, '${adoptedAt}'); INSERT INTO inventory_lots (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at) VALUES ('lot-yes-adopted', 'p-yes-adopted', '${YES_TOKEN}', 'buy', 2, 2, .45, .9, 'fill-yes-adopted', '${adoptedAt}'); UPDATE positions SET status = 'open', size = 3, avg_entry_price = .7, cost_basis_usdc = 2.1, closed_at = NULL WHERE position_id = 'p-no';`,
    );
    const replacementRepairs = resolveAppliedMergeReplacementRepairs(conn.db, positionRepo);
    const replacementTokens = new Set(replacementRepairs.map((position) => position.tokenId));
    for (const tokenId of replacementTokens) legStateRepo.delete(tokenId);
    const rebuiltLegStates = rebuildLegStatesFromLedger(
      { db: conn.db, positionRepo, legStateRepo, log } as never,
      { seededLegStates: 0, alreadyPresentLegStates: 0, positionsWithoutFills: [] } as never,
      log,
      replacementTokens,
    );
    const replaySnapshot = [
      ...resolveMergeRecoveryReplayPositions(positionRepo, recovery.settled, replacementTokens),
      ...replacementRepairs,
    ];
    conn.db.exec("UPDATE positions SET status = 'closed', size = 0 WHERE position_id = 'p-no'");
    const published: Position[] = [];
    const postHydrationLegStates = new Map<string, unknown>();
    bus.publish = vi.fn(async (event, payload) => {
      if (event === "LegStateUpdated") {
        const legState = (payload as { legState: { tokenId: string } }).legState;
        postHydrationLegStates.set(legState.tokenId, legState);
      }
      if (event === "PositionUpdated") published.push((payload as { position: Position }).position);
    });
    for (const legState of rebuiltLegStates) {
      await bus.publish("LegStateUpdated", { legState, timestamp: Date.now() });
    }
    for (const snapshot of replaySnapshot) {
      const current = resolveCurrentMergeRecoveryReplayPosition(positionRepo, snapshot);
      if (current) await bus.publish("PositionUpdated", { position: current });
    }
    expect(postHydrationLegStates).toEqual(new Map([[YES_TOKEN, rebuiltLegStates[0]]]));
    expect(published).toEqual([
      expect.objectContaining({ positionId: "p-no", status: "closed", size: 0 }),
      expect.objectContaining({ positionId: "p-yes-adopted", status: "open", size: 2 }),
    ]);
    expect(published.map((position) => position.positionId)).not.toContain("p-yes");
  });

  it("repairs a stale applied replacement once on a later boot", async () => {
    const positionRepo = new SqlitePositionRepository(conn.db);
    const lotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    recordPending(mergeLedgerRepo, {
      mergeId: "merge-later-boot",
      conditionId: CONDITION_ID,
      mergedAmount: 1,
      recordedAt: "2026-08-14T00:00:00.000Z",
    });
    mergeLedgerRepo.markOnchain("merge-later-boot");
    conn.db.exec(
      `INSERT INTO positions (position_id, token_id, condition_id, side, size, avg_entry_price, cost_basis_usdc, status, opened_at, updated_at) VALUES ('p-yes', '${YES_TOKEN}', '${CONDITION_ID}', 'buy', 1, .4, .4, 'open', '${OPENED_AT_PAST}', '${OPENED_AT_PAST}'), ('p-no', '${NO_TOKEN}', '${CONDITION_ID}', 'buy', 1, .5, .5, 'open', '${OPENED_AT_PAST}', '${OPENED_AT_PAST}'); INSERT INTO orders (order_id, client_order_id, token_id, condition_id, side, order_type, price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at) VALUES ('order-yes', 'client-yes', '${YES_TOKEN}', '${CONDITION_ID}', 'buy', 'GTC', .4, 1, .4, 'filled', 'test', 'run', '${OPENED_AT_PAST}', '${OPENED_AT_PAST}'), ('order-no', 'client-no', '${NO_TOKEN}', '${CONDITION_ID}', 'buy', 'GTC', .5, 1, .5, 'filled', 'test', 'run', '${OPENED_AT_PAST}', '${OPENED_AT_PAST}'), ('order-realized', 'client-realized', '${YES_TOKEN}', '${CONDITION_ID}', 'sell', 'GTC', .6, 1, .6, 'filled', 'test', 'run', '${OPENED_AT_PAST}', '${OPENED_AT_PAST}'); INSERT INTO fills (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at) VALUES ('fill-yes', 'order-yes', '${YES_TOKEN}', '${CONDITION_ID}', 'buy', .4, 1, .4, '${OPENED_AT_PAST}'), ('fill-no', 'order-no', '${NO_TOKEN}', '${CONDITION_ID}', 'buy', .5, 1, .5, '${OPENED_AT_PAST}'), ('fill-realized', 'order-realized', '${YES_TOKEN}', '${CONDITION_ID}', 'sell', .6, 1, .6, '${OPENED_AT_PAST}'); INSERT INTO inventory_lots (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at) VALUES ('lot-yes', 'p-yes', '${YES_TOKEN}', 'buy', 1, 1, .4, .4, 'fill-yes', '${OPENED_AT_PAST}'), ('lot-no', 'p-no', '${NO_TOKEN}', 'buy', 1, 1, .5, .5, 'fill-no', '${OPENED_AT_PAST}'); INSERT INTO pnl_ledger (fill_id, position_id, delta, filled_at) VALUES ('fill-realized', 'p-yes', .2, '${OPENED_AT_PAST}');`,
    );
    // prettier-ignore
    const accounting = () => conn.db.prepare("SELECT lot_id AS id, remaining_size AS value FROM inventory_lots UNION ALL SELECT CAST(id AS TEXT), delta FROM pnl_ledger ORDER BY id").all();
    // prettier-ignore
    const recover = () => recoverConfirmedOnchainMerges({ bus, positionRepo, lotRepo, mergeLedgerRepo, db: conn.db, log });
    const firstRecovery = await recover();
    expect(firstRecovery).toMatchObject({
      recovered: 1,
      remaining: [],
      settled: expect.any(Array),
    });
    expect(firstRecovery.settled.map((position) => position.realizedPnl)).toEqual([
      expect.closeTo(0.05),
      expect.closeTo(0.05),
    ]);
    conn.db.exec(
      `INSERT INTO positions (position_id, token_id, condition_id, side, size, avg_entry_price, cost_basis_usdc, status, opened_at, updated_at) VALUES ('p-yes-current', '${YES_TOKEN}', '${CONDITION_ID}', 'buy', 1, .4, .4, 'open', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'); INSERT INTO orders (order_id, client_order_id, token_id, condition_id, side, order_type, price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at) VALUES ('order-current', 'client-current', '${YES_TOKEN}', '${CONDITION_ID}', 'buy', 'GTC', .4, 1, .4, 'filled', 'test', 'run', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'); INSERT INTO fills (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at) VALUES ('fill-current', 'order-current', '${YES_TOKEN}', '${CONDITION_ID}', 'buy', .4, 1, .4, '2026-08-14T00:00:00.000Z'); INSERT INTO inventory_lots (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at) VALUES ('lot-current', 'p-yes-current', '${YES_TOKEN}', 'buy', 1, 1, .4, .4, 'fill-current', '2026-08-14T00:00:00.000Z'); INSERT INTO leg_states (token_id, buy_count, sell_count, last_action, first_trade_price, first_trade_at, last_trade_at, updated_at) VALUES ('${YES_TOKEN}', 9, 0, 'BUY', .01, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');`,
    );
    const postFirstApplyAccounting = accounting();
    expect((await recover()).settled).toEqual([]);
    const repairs = resolveAppliedMergeReplacementRepairs(conn.db, positionRepo);
    expect(repairs).toEqual([expect.objectContaining({ positionId: "p-yes-current" })]);
    for (const position of repairs) legStateRepo.delete(position.tokenId);
    rebuildLegStatesFromLedger(
      { db: conn.db, positionRepo, legStateRepo, log } as never,
      { seededLegStates: 0, alreadyPresentLegStates: 0, positionsWithoutFills: [] } as never,
      log,
      new Set(repairs.map((position) => position.tokenId)),
    );
    expect(resolveAppliedMergeReplacementRepairs(conn.db, positionRepo)).toEqual([]);
    expect((await recover()).settled).toEqual([]);
    expect(resolveAppliedMergeReplacementRepairs(conn.db, positionRepo)).toEqual([]);
    expect(accounting()).toEqual(postFirstApplyAccounting);
  });

  it("leaves a confirmed 'onchain' row fenced when its legs are gone — a repair it cannot make is not a repair it may skip", async () => {
    const { positionRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    // No YES/NO pair exists for this condition, so there is nothing to consume: wallet
    // reconciliation may already have closed the legs. Guessing here would book P&L twice.
    recordPending(mergeLedgerRepo, {
      mergeId: "merge-orphan",
      conditionId: "0xcond-no-legs",
      mergedAmount: 5,
      recordedAt: "2026-07-30T00:00:00.000Z",
      yesTokenId: createTokenId("tok-orphan-yes"),
      noTokenId: createTokenId("tok-orphan-no"),
      yesPositionId: createPositionId("p-orphan-yes"),
      noPositionId: createPositionId("p-orphan-no"),
    });
    mergeLedgerRepo.markOnchain("merge-orphan");

    const { recovered, remaining } = await recoverConfirmedOnchainMerges({
      bus,
      positionRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    expect(recovered).toBe(0);
    expect(remaining.map((r) => r.mergeId)).toEqual(["merge-orphan"]);
    expect(conn.db.prepare(`SELECT status FROM merge_ledger`).all()).toEqual([
      { status: "onchain" },
    ]);
    // Nothing was half-done: no lots consumed, no position written, nothing announced.
    expect(positionRepo.save).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      {
        mergeId: "merge-orphan",
        conditionId: "0xcond-no-legs",
        reason: "yes-missing-or-closed",
      },
      "confirmed on-chain merge cannot be settled locally — recorded leg validation failed; row stays fenced",
    );
  });

  // r7-M2. The case a re-read can never announce: a merge that consumes a leg ENTIRELY closes it,
  // and the real `findByTokenId` filters closed rows out. Both legs are 100 here and the merge is
  // 100, so a re-reading implementation publishes NOTHING at all while both positions go to zero.
  it("announces both legs even when the merge closes them outright", async () => {
    const { positionRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    recordPending(mergeLedgerRepo, {
      mergeId: "merge-full",
      conditionId: CONDITION_ID,
      mergedAmount: 100,
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    mergeLedgerRepo.markOnchain("merge-full");

    const { recovered } = await recoverConfirmedOnchainMerges({
      bus,
      positionRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    expect(recovered).toBe(1);
    // Spread = 100 - (100*0.3 + 100*0.4) = 30, split evenly, so realizedPnl 15 a leg is proof the
    // published object came out of the settle transaction rather than from anywhere else.
    expect(bus.publish).toHaveBeenCalledWith("PositionUpdated", {
      position: expect.objectContaining({
        positionId: "p-yes",
        size: 0,
        status: "closed",
        realizedPnl: 15,
      }),
    });
    expect(bus.publish).toHaveBeenCalledWith("PositionUpdated", {
      position: expect.objectContaining({
        positionId: "p-no",
        size: 0,
        status: "closed",
        realizedPnl: 15,
      }),
    });
    // Why the re-read had to go: after this settle the repository cannot hand either leg back.
    expect(positionRepo.findByTokenId(YES_TOKEN as TokenId)).toBeNull();
    expect(positionRepo.findByTokenId(NO_TOKEN as TokenId)).toBeNull();
  });

  describe("recorded merge-leg recovery fence", () => {
    async function recover(
      mergeId: string,
      positionRepo: PositionRepository,
      lotRepo: InventoryLotRepository,
      mergeLedgerRepo: MergeLedgerRepository,
      runtimeMetrics?: RuntimeMetricWriter,
    ) {
      return recoverConfirmedOnchainMerges({
        bus,
        positionRepo,
        lotRepo,
        mergeLedgerRepo,
        db: conn.db,
        log,
        runtimeMetrics,
      });
    }

    function createOnchainRow(
      mergeLedgerRepo: MergeLedgerRepository,
      mergeId: string,
      recordedAt = "2026-07-30T00:00:00.750Z",
    ): MergeRecord {
      recordPending(mergeLedgerRepo, {
        mergeId,
        conditionId: CONDITION_ID,
        mergedAmount: 40,
        recordedAt,
      });
      mergeLedgerRepo.markOnchain(mergeId);
      return mergeLedgerRepo.findNonTerminal()[0]!;
    }

    it("settles the recorded positions after an actual catalog condition/outcome rewrite", async () => {
      const { positionRepo, marketRepo, lotRepo } = makeMergeableFixtures();
      const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
      createOnchainRow(mergeLedgerRepo, "merge-recorded-legs");
      const insertMarket = conn.db.prepare(
        `INSERT INTO markets
           (token_id, condition_id, slug, question, outcome, outcome_index, tick_size)
         VALUES (?, ?, ?, ?, ?, ?, 0.01)`,
      );
      insertMarket.run(YES_TOKEN, CONDITION_ID, "yes-before", "yes before", "Yes", 0);
      insertMarket.run(NO_TOKEN, CONDITION_ID, "no-before", "no before", "No", 1);
      conn.db
        .prepare(
          `UPDATE markets
              SET condition_id = 'remapped-condition',
                  outcome = CASE token_id WHEN ? THEN 'No' ELSE 'Yes' END,
                  outcome_index = CASE token_id WHEN ? THEN 1 ELSE 0 END
            WHERE token_id IN (?, ?)`,
        )
        .run(YES_TOKEN, YES_TOKEN, YES_TOKEN, NO_TOKEN);

      const result = await recover("merge-recorded-legs", positionRepo, lotRepo, mergeLedgerRepo);

      expect(result.recovered).toBe(1);
      expect(result.remaining).toEqual([]);
      expect(lotRepo.consumeFifo).toHaveBeenCalledWith("p-yes", 40);
      expect(lotRepo.consumeFifo).toHaveBeenCalledWith("p-no", 40);
      expect(marketRepo.findByTokenId).not.toHaveBeenCalled();
      expect(
        conn.db
          .prepare(
            "SELECT token_id, condition_id, outcome, outcome_index FROM markets ORDER BY token_id",
          )
          .all(),
      ).toEqual([
        {
          token_id: NO_TOKEN,
          condition_id: "remapped-condition",
          outcome: "Yes",
          outcome_index: 0,
        },
        {
          token_id: YES_TOKEN,
          condition_id: "remapped-condition",
          outcome: "No",
          outcome_index: 1,
        },
      ]);
    });

    it("never substitutes a newer same-token position for a closed recorded position", async () => {
      const { positionRepo, lotRepo } = makeMergeableFixtures();
      const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
      createOnchainRow(mergeLedgerRepo, "merge-no-substitution");
      const original = positionRepo.findById(createPositionId("p-yes"))!;
      positionRepo.save({ ...original, status: "closed", size: 0 });
      positionRepo.save({
        ...original,
        positionId: createPositionId("p-yes-replacement"),
        status: "open",
        openedAt: "2026-08-01T00:00:00.000Z",
      });

      const result = await recover("merge-no-substitution", positionRepo, lotRepo, mergeLedgerRepo);

      expect(result.recovered).toBe(0);
      expect(result.remaining.map((row) => row.mergeId)).toEqual(["merge-no-substitution"]);
      expect(positionRepo.findByTokenId).not.toHaveBeenCalled();
      expect(lotRepo.consumeFifo).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({
          mergeId: "merge-no-substitution",
          reason: "yes-missing-or-closed",
        }),
        "confirmed on-chain merge cannot be settled locally — recorded leg validation failed; row stays fenced",
      );
    });

    it("fails closed when an exact position no longer carries its recorded token", async () => {
      const { positionRepo, lotRepo } = makeMergeableFixtures();
      const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
      createOnchainRow(mergeLedgerRepo, "merge-token-mismatch");
      const yes = positionRepo.findById(createPositionId("p-yes"))!;
      positionRepo.save({ ...yes, tokenId: createTokenId("wrong-token") });
      const runtimeMetrics = { writeCounter: vi.fn() } as unknown as RuntimeMetricWriter;

      const result = await recover(
        "merge-token-mismatch",
        positionRepo,
        lotRepo,
        mergeLedgerRepo,
        runtimeMetrics,
      );

      expect(result.recovered).toBe(0);
      expect(lotRepo.consumeFifo).not.toHaveBeenCalled();
      expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
        "inventory_merge_recovery_fenced_total",
        1,
        JSON.stringify({ reason: "yes-token-mismatch" }),
      );
    });

    it.each([
      ["after", "2026-08-01T00:00:00.000Z", "yes-opened-after"],
      ["equal", "2026-07-30T00:00:00.750Z", "yes-opened-after"],
      ["unreadable", "not-a-timestamp", "yes-unreadable-opened-at"],
    ])("fences an exact leg whose openedAt is %s the intent", async (_label, openedAt, reason) => {
      const { positionRepo, lotRepo } = makeMergeableFixtures();
      const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
      createOnchainRow(mergeLedgerRepo, `merge-opened-${_label}`);
      const yes = positionRepo.findById(createPositionId("p-yes"))!;
      positionRepo.save({ ...yes, openedAt });
      const runtimeMetrics = { writeCounter: vi.fn() } as unknown as RuntimeMetricWriter;

      const result = await recover(
        `merge-opened-${_label}`,
        positionRepo,
        lotRepo,
        mergeLedgerRepo,
        runtimeMetrics,
      );

      expect(result.recovered).toBe(0);
      expect(lotRepo.consumeFifo).not.toHaveBeenCalled();
      expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
        "inventory_merge_recovery_fenced_total",
        1,
        JSON.stringify({ reason }),
      );
    });

    it.each([
      ["after", "2026-07-30T00:00:02.000Z"],
      ["same second", "2026-07-30 00:00:00"],
      ["unreadable", "not-a-timestamp"],
    ])("fences a live lot created %s the intent's second floor", async (_label, createdAt) => {
      const { positionRepo, lotRepo } = makeMergeableFixtures();
      const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
      createOnchainRow(mergeLedgerRepo, `merge-lot-${_label.replace(" ", "-")}`);
      (lotRepo.findOpen as ReturnType<typeof vi.fn>).mockImplementation((positionId: string) =>
        positionId === "p-yes" ? [{ createdAt }] : [],
      );
      const runtimeMetrics = { writeCounter: vi.fn() } as unknown as RuntimeMetricWriter;

      const result = await recover(
        `merge-lot-${_label.replace(" ", "-")}`,
        positionRepo,
        lotRepo,
        mergeLedgerRepo,
        runtimeMetrics,
      );

      expect(result.recovered).toBe(0);
      expect(lotRepo.consumeFifo).not.toHaveBeenCalled();
      expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
        "inventory_merge_recovery_fenced_total",
        1,
        JSON.stringify({ reason: "yes-lot-after" }),
      );
    });

    it("settles when every exact-position live lot predates the intent's second", async () => {
      const { positionRepo, lotRepo } = makeMergeableFixtures();
      const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
      createOnchainRow(mergeLedgerRepo, "merge-old-lots");
      (lotRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
        { createdAt: "2026-07-29T23:59:59.999Z" },
      ]);

      const result = await recover("merge-old-lots", positionRepo, lotRepo, mergeLedgerRepo);

      expect(result.recovered).toBe(1);
      expect(result.remaining).toEqual([]);
    });

    it("keeps an unidentified legacy onchain row fenced", async () => {
      const { positionRepo, lotRepo } = makeMergeableFixtures();
      const real = new SqliteMergeLedgerRepository(conn.db);
      const legacy = {
        mergeId: "merge-legacy-null",
        conditionId: CONDITION_ID,
        mergedAmount: 40,
        spreadPnl: 0,
        mergedAt: "2026-07-30T00:00:00.000Z",
        status: "onchain" as const,
        yesTokenId: null,
        noTokenId: null,
        yesPositionId: null,
        noPositionId: null,
      };
      const mergeLedgerRepo = {
        ...real,
        findNonTerminal: vi.fn(() => [legacy]),
      } as unknown as MergeLedgerRepository;

      const result = await recover("merge-legacy-null", positionRepo, lotRepo, mergeLedgerRepo);

      expect(result.recovered).toBe(0);
      expect(result.remaining).toEqual([legacy]);
      expect(lotRepo.consumeFifo).not.toHaveBeenCalled();
    });

    it.each([
      ["blank", { yesTokenId: createTokenId("") }, "incomplete-identity"],
      ["same token", { noTokenId: createTokenId(YES_TOKEN) }, "same-token"],
      ["same position", { noPositionId: createPositionId("p-yes") }, "same-position"],
      ["cross-bound", { yesTokenId: createTokenId("p-no") }, "cross-bound-identity"],
    ])("keeps a corrupt %s recorded row fenced", async (_label, mutation, reason) => {
      const { positionRepo, lotRepo } = makeMergeableFixtures();
      const real = new SqliteMergeLedgerRepository(conn.db);
      const base = {
        mergeId: `merge-corrupt-${_label.replace(" ", "-")}`,
        conditionId: CONDITION_ID,
        mergedAmount: 40,
        spreadPnl: 0,
        mergedAt: "2026-07-30T00:00:00.750Z",
        status: "onchain" as const,
        ...recordedIdentity(CONDITION_ID),
        ...mutation,
      };
      const mergeLedgerRepo = {
        ...real,
        findNonTerminal: vi.fn(() => [base]),
      } as unknown as MergeLedgerRepository;
      const runtimeMetrics = { writeCounter: vi.fn() } as unknown as RuntimeMetricWriter;

      const result = await recover(
        base.mergeId,
        positionRepo,
        lotRepo,
        mergeLedgerRepo,
        runtimeMetrics,
      );

      expect(result.recovered).toBe(0);
      expect(result.remaining).toEqual([base]);
      expect(lotRepo.consumeFifo).not.toHaveBeenCalled();
      expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
        "inventory_merge_recovery_fenced_total",
        1,
        JSON.stringify({ reason }),
      );
    });
  });
  // r8-minor. Moving the repair ahead of the preflight moved it ahead of everything that records a
  // boot as failed: `publishFailed()` does not exist yet and the preflight report is not written,
  // so an error escaping the per-row catch would reach only the top-level handler — which exits
  // leaving `running, paused=0` for the next deploy's resume-intent to act on. The repair must
  // therefore persist the failed/paused state itself, exactly like the adoption abort above it.
  it("records the boot as failed when the merge recovery itself aborts", () => {
    const indexSource = readFileSync(new URL("../../../index.ts", import.meta.url), "utf-8");
    const recovery = indexSource.indexOf("await recoverConfirmedOnchainMerges({");
    const persist = indexSource.indexOf(
      'persistFailedStartupState(controlConn.db, log, "on-chain merge recovery abort")',
    );
    const ownershipGate = indexSource.indexOf("runOwnershipInvariantStartupGate({");

    expect(recovery).toBeGreaterThan(-1);
    // The persist belongs to THIS call's catch: after the call, and before the next startup step.
    expect(persist).toBeGreaterThan(recovery);
    expect(persist).toBeLessThan(ownershipGate);
  });

  // r11-P1. The pre-supervisor pass above is not the only one: `start()` re-runs the repair, and a
  // row that turned 'onchain' after the snapshot gets settled there — publishing PositionUpdated
  // into a HALF-STARTED runtime. profile-ladder answers that event with PlaceOrderRequested /
  // CancelOrderRequested, and a command published before ExecutionModule subscribed is dropped with
  // NO terminal event, while the ladder has already written the pending rung that event would have
  // cleared. Registering inventory-manager last is what guarantees a subscriber exists: the startup
  // fence still refuses the placement, but it refuses it with an OrderRejected the ladder can act on.
  it("registers inventory-manager after every module that must hear or answer its recovery events", () => {
    const indexSource = readFileSync(new URL("../../../index.ts", import.meta.url), "utf-8");
    const inventoryManager = indexSource.indexOf('["inventory-manager", inventoryManagerModule]');
    const execution = indexSource.indexOf('["execution", executionModule]');
    const profileLadder = indexSource.indexOf('["profile-ladder", profileLadderModule]');

    expect(inventoryManager).toBeGreaterThan(-1);
    expect(execution).toBeGreaterThan(-1);
    expect(profileLadder).toBeGreaterThan(-1);
    // The ladder publishes the commands; execution is the only thing that can answer them. Start
    // before EITHER and a settled merge produces a command with no subscriber at all.
    expect(inventoryManager).toBeGreaterThan(profileLadder);
    expect(inventoryManager).toBeGreaterThan(execution);
  });

  // r7-minor. Losing the CAS is a NORMAL outcome of two processes starting together, so what this
  // process REPORTS afterwards has to be true. These two pin the two ways the report could lie.
  it("reports a clean fence after losing the settle race, instead of the pre-race snapshot", async () => {
    const { positionRepo, lotRepo } = makeMergeableFixtures();
    const real = new SqliteMergeLedgerRepository(conn.db);
    recordPending(real, {
      mergeId: "merge-lost",
      conditionId: CONDITION_ID,
      mergedAmount: 40,
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    real.markOnchain("merge-lost");
    const stale = real.findNonTerminal();
    // The other process wins the race between our fence read and our settle transaction.
    real.markApplied({
      mergeId: "merge-lost",
      conditionId: CONDITION_ID,
      mergedAmount: 40,
      spreadPnl: 12,
      mergedAt: "2026-07-30T00:00:01.000Z",
      status: "applied",
    });

    const { recovered, remaining } = await recoverConfirmedOnchainMerges({
      bus,
      positionRepo,
      lotRepo,
      mergeLedgerRepo: withScriptedFenceReads(real, [() => stale]),
      db: conn.db,
      log,
    });

    expect(recovered).toBe(0);
    // The row IS healed — by the winner. Reporting the pre-attempt snapshot would fence a condition
    // that is free, and an operator following that report would reconcile a merge already applied.
    expect(remaining).toEqual([]);
    expect(log.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "merge ledger has non-terminal rows — those conditions are FENCED from further merges until an operator reconciles them on chain with scripts/merge-ledger-reconcile.ts",
    );
    // The loser's transaction rolled back before it could touch a position.
    expect(positionRepo.save).not.toHaveBeenCalled();
  });

  // r11-P1. The clean fence above is TRUE but not sufficient. This helper also runs from
  // `InventoryManagerModule.start()`, i.e. inside an already-hydrated process: the winner moved the
  // shared positions and published them on its OWN bus, the re-read then drops the now-'applied'
  // row, and the report says "nothing is fenced" — so a loser that only logged would keep pre-merge
  // sizes in every event-driven cache and trade phantom inventory behind a fence that looks lifted.
  it("republishes both legs after losing the settle race, so the loser's caches converge on the winner's rows", async () => {
    const { positionRepo, lotRepo } = makeMergeableFixtures();
    const real = new SqliteMergeLedgerRepository(conn.db);
    recordPending(real, {
      mergeId: "merge-lost-republish",
      conditionId: CONDITION_ID,
      mergedAmount: 100,
      recordedAt: "2026-08-04T00:00:00.000Z",
    });
    real.markOnchain("merge-lost-republish");
    const stale = real.findNonTerminal();
    // The winner's LEDGER half commits after our snapshot — so our `markApplied` hits the real CAS
    // and the real rejection, rather than a thrown stand-in for one.
    real.markApplied({
      mergeId: "merge-lost-republish",
      conditionId: CONDITION_ID,
      mergedAmount: 100,
      spreadPnl: 30,
      mergedAt: "2026-08-04T00:00:01.000Z",
      status: "applied",
    });
    // Its POSITION half lands while our settler is mid-transaction — after it read both legs open,
    // before its CAS runs. The 100-vs-100 merge consumes both entirely, so the winner's committed
    // rows are 'closed': the shape `findByTokenId` filters away and only a by-id re-read can see.
    const winnerLegs = [
      {
        positionId: "p-yes",
        tokenId: YES_TOKEN,
        conditionId: CONDITION_ID,
        size: 0,
        status: "closed",
        realizedPnl: 15,
      },
      {
        positionId: "p-no",
        tokenId: NO_TOKEN,
        conditionId: CONDITION_ID,
        size: 0,
        status: "closed",
        realizedPnl: 15,
      },
    ];
    (lotRepo.consumeFifo as ReturnType<typeof vi.fn>).mockImplementation(
      (positionId: string, amount: number) => {
        for (const leg of winnerLegs) positionRepo.save(leg as unknown as Position);
        return [{ lot: { entryPrice: positionId === "p-yes" ? 0.3 : 0.4 }, consumed: amount }];
      },
    );

    const { recovered, remaining } = await recoverConfirmedOnchainMerges({
      bus,
      positionRepo,
      lotRepo,
      mergeLedgerRepo: withScriptedFenceReads(real, [() => stale]),
      db: conn.db,
      log,
    });

    // Nothing was settled BY US, and the fence really is clear — which is exactly why the republish
    // is the only thing left that can converge this process.
    expect(recovered).toBe(0);
    expect(remaining).toEqual([]);
    expect(positionRepo.findById).toHaveBeenCalledWith("p-yes");
    expect(positionRepo.findById).toHaveBeenCalledWith("p-no");
    const published = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([topic]) => topic === "PositionUpdated")
      .map(
        ([, payload]) => (payload as { position: { positionId: string; status: string } }).position,
      );
    expect(published.map((p) => p.positionId).sort()).toEqual(["p-no", "p-yes"]);
    expect(published.every((p) => p.status === "closed")).toBe(true);
  });

  // r9-P1. The re-read below may fall back to a known set; the FIRST read may not. Reporting
  // `{ recovered: 0, remaining: [] }` there is indistinguishable from "the fence is clear", and the
  // caller boots on — with auto-merge disabled nothing ever checks again, so an unapplied on-chain
  // merge would be handed to the trading runtime as if both legs were sound.
  it("throws instead of reporting a clear fence when the INITIAL fence read fails", async () => {
    const { positionRepo, lotRepo } = makeMergeableFixtures();
    const real = new SqliteMergeLedgerRepository(conn.db);
    recordPending(real, {
      mergeId: "merge-hidden-by-the-unreadable-fence",
      conditionId: CONDITION_ID,
      mergedAmount: 100,
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    real.markOnchain("merge-hidden-by-the-unreadable-fence");

    await expect(
      recoverConfirmedOnchainMerges({
        bus,
        positionRepo,
        lotRepo,
        mergeLedgerRepo: withScriptedFenceReads(real, [
          () => {
            throw new Error("database is locked");
          },
        ]),
        db: conn.db,
        log,
      }),
    ).rejects.toThrow("database is locked");

    // Nothing was settled, and the row the unreadable fence hid is still fenced.
    expect(lotRepo.consumeFifo).not.toHaveBeenCalled();
    const rows = conn.db.prepare(`SELECT status FROM merge_ledger`).all() as Array<{
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("onchain");
  });

  it("falls back to the rows it did not settle when the fence re-read fails, never to an empty fence", async () => {
    const { positionRepo, lotRepo } = makeTwoConditionFixtures();
    const real = new SqliteMergeLedgerRepository(conn.db);
    recordPending(real, {
      mergeId: "merge-confirmed",
      conditionId: CONDITION_ID,
      mergedAmount: 40,
      recordedAt: "2026-07-30T00:00:00.000Z",
      yesPositionId: createPositionId("p-yes-x"),
      noPositionId: createPositionId("p-no-x"),
    });
    real.markOnchain("merge-confirmed");
    recordPending(real, {
      mergeId: "merge-ambiguous",
      conditionId: OTHER_CONDITION_ID,
      mergedAmount: 9,
      recordedAt: "2026-07-30T00:00:01.000Z",
    });
    const initial = real.findNonTerminal();

    const { recovered, remaining } = await recoverConfirmedOnchainMerges({
      bus,
      positionRepo,
      lotRepo,
      mergeLedgerRepo: withScriptedFenceReads(real, [
        () => initial,
        () => {
          throw new Error("ledger unreadable");
        },
      ]),
      db: conn.db,
      log,
    });

    expect(recovered).toBe(1);
    // "The fence could not be read" is not "the fence is clear": the pending row must still be
    // reported, and only the row this run provably settled may drop off the list.
    expect(remaining.map((r) => r.mergeId)).toEqual(["merge-ambiguous"]);
  });

  // r6-M1. Every ledger transition is a compare-and-swap on the status it advances FROM. These two
  // pin the reason: two processes CAN both read the same 'onchain' row at start-up (a rolling
  // deploy, an overlapping restart) and both decide to settle it locally.
  it("refuses a second settle of the same 'onchain' row and rolls the loser's lot consumption back", () => {
    const { positionRepo, lotRepo } = makeMergeableFixtures();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    // The lot mock writes through the SAME connection applyMerge's transaction runs on, so what
    // survives in this table is exactly what SQLite committed — a mock's call count could not tell
    // "consumed and rolled back" apart from "consumed and kept".
    conn.db.exec(`CREATE TABLE test_lot_consumption (position_id TEXT, amount REAL)`);
    (lotRepo.consumeFifo as ReturnType<typeof vi.fn>).mockImplementation(
      (positionId: string, amount: number) => {
        conn.db
          .prepare(`INSERT INTO test_lot_consumption (position_id, amount) VALUES (?, ?)`)
          .run(positionId, amount);
        return [{ lot: { entryPrice: positionId === "p-yes" ? 0.3 : 0.4 }, consumed: amount }];
      },
    );
    recordPending(mergeLedgerRepo, {
      mergeId: "merge-race",
      conditionId: CONDITION_ID,
      mergedAmount: 40,
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    mergeLedgerRepo.markOnchain("merge-race");

    const candidate = {
      conditionId: CONDITION_ID,
      mergeAmount: 40,
      yesTokenId: YES_TOKEN,
      noTokenId: NO_TOKEN,
      yesPositionId: "p-yes",
      noPositionId: "p-no",
    } as unknown as Parameters<MergeSettler["applyMerge"]>[0];
    const settler = new MergeSettler(positionRepo, lotRepo, mergeLedgerRepo, conn.db);

    settler.applyMerge(candidate, "merge-race");
    expect(() => settler.applyMerge(candidate, "merge-race")).toThrow(
      /is 'applied', not 'onchain'/,
    );

    // Two legs, from the winner only. Without the CAS the second settle would have committed too
    // and spent 80 shares of inventory the chain only ever moved 40 of.
    expect(conn.db.prepare(`SELECT COUNT(*) AS n FROM test_lot_consumption`).get()).toEqual({
      n: 2,
    });
    expect(
      conn.db.prepare(`SELECT status, merged_amount, spread_pnl FROM merge_ledger`).all(),
    ).toEqual([{ status: "applied", merged_amount: 40, spread_pnl: 12 }]);
  });

  it("refuses to drag an already-'applied' row back to 'onchain', and names a row that is simply gone", () => {
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    recordPending(mergeLedgerRepo, {
      mergeId: "merge-cas",
      conditionId: "0xcond-cas",
      mergedAmount: 10,
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    mergeLedgerRepo.markOnchain("merge-cas");
    const applied = {
      mergeId: "merge-cas",
      conditionId: "0xcond-cas",
      mergedAmount: 10,
      spreadPnl: 2,
      mergedAt: "2026-07-30T00:00:02.000Z",
      status: "applied" as const,
    };
    mergeLedgerRepo.markApplied(applied);

    // A re-fenced 'applied' row is worse than a stuck one: recovery would then settle a merge whose
    // lots are already consumed.
    expect(() => mergeLedgerRepo.markOnchain("merge-cas")).toThrow(/is 'applied', not 'pending'/);
    // The two zero-row cases must stay distinguishable — they call for opposite operator responses.
    expect(() => mergeLedgerRepo.markOnchain("merge-missing")).toThrow(
      /no row for mergeId=merge-missing/,
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
    // Left 'pending', not 'onchain': r12-P1 makes runSweep() repair-and-settle any already-'onchain'
    // row before the fence/candidate check below ever runs, which would settle this row instead of
    // suppressing it — 'pending' is the one non-terminal state repair leaves untouched.
    recordPending(mergeLedgerRepo, {
      mergeId: "merge-survivor",
      conditionId: CONDITION_ID,
      mergedAmount: 100,
      recordedAt: "2026-07-30T00:00:00.000Z",
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
    expect(rows).toEqual([{ merge_id: "merge-survivor", status: "pending" }]);
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
      // The first pass would otherwise consume the whole pair and leave the second nothing to
      // merge. Dropping the writes keeps the book identical for both passes, so the only variable
      // left is the id.
      (positionRepo.save as ReturnType<typeof vi.fn>).mockImplementation(() => {});
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

  it("refuses to settle at all when the intent row is gone, instead of applying a merge the ledger cannot see", async () => {
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
    // r9-P1: skipped up front rather than attempted-and-rolled-back. An absent row is not in the one
    // state `applyMerge`'s CAS advances FROM, so attempting it would only fail inside the
    // transaction and report "another process moved it" — a race that never happened.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ conditionId: CONDITION_ID }),
      expect.stringContaining("CONFIRMED on chain but its ledger row could not be advanced"),
    );
    expect(lotRepo.consumeFifo).not.toHaveBeenCalled();
    expect(positionRepo.save).not.toHaveBeenCalled();
    // r11-P1: this branch cannot tell "nothing moved" apart from "another runtime moved it" — both
    // leave a row `findNonTerminal()` no longer returns. So it converges the caches with what the
    // ledger DURABLY holds, which here is exactly the untouched pre-merge pair subscribers already
    // have: a no-op announcement, never a fabricated one.
    const published = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([topic]) => topic === "PositionUpdated")
      .map(([, payload]) => (payload as { position: Position }).position);
    expect(published.map((p) => p.positionId).sort()).toEqual(["p-no", "p-yes"]);
    expect(published.every((p) => p.status === "open" && p.size === 100)).toBe(true);
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
    //
    // r12-P1 added a REPAIR read (`repairAndReportFencedMerges`) at the very top of `runSweep()`,
    // ahead of the sweep's own fence check — so `findNonTerminal` is now called TWICE per sweep
    // before `recordPending` ever runs. The first call is the repair's; scripting the race into it
    // would settle nothing (the ledger has zero 'onchain' rows) and would make the sweep's own fence
    // check see the just-inserted foreign row for real, fencing CONDITION_ID as "suppressed" instead
    // of exercising the claim-collision path this test is pinning. Chaining a harmless empty first
    // response keeps the repair a no-op, and the race — insert-then-report-empty — lands on the
    // SECOND call, which is the sweep's own fence check, exactly as before r12-P1.
    vi.spyOn(mergeLedgerRepo, "findNonTerminal")
      .mockImplementationOnce(() => [])
      .mockImplementationOnce(() => {
        conn.db
          .prepare(
            `INSERT INTO merge_ledger (
               merge_id, condition_id, merged_amount, spread_pnl, merged_at, status,
               yes_token_id, no_token_id, yes_position_id, no_position_id
             ) VALUES (?, ?, 5, 0, ?, 'pending', ?, ?, ?, ?)`,
          )
          .run(
            FOREIGN_MERGE_ID,
            CONDITION_ID,
            "2026-07-30T00:00:00.000Z",
            YES_TOKEN,
            NO_TOKEN,
            "p-yes-x",
            "p-no-x",
          );
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
    recordPending(mergeLedgerRepo, {
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

  it("settles the recorded position even when another current row exists for the same token", async () => {
    const { positionRepo, lotRepo } = makeMergeableFixtures();
    const duplicateYes = {
      ...(positionRepo.findByTokenId(createTokenId(YES_TOKEN)) as Position),
      positionId: createPositionId("p-yes-duplicate"),
    };
    positionRepo.save(duplicateYes);
    (positionRepo.findByTokenId as ReturnType<typeof vi.fn>).mockClear();
    const mergeLedgerRepo = new SqliteMergeLedgerRepository(conn.db);
    recordPending(mergeLedgerRepo, {
      mergeId: "ambiguous-recovery",
      conditionId: CONDITION_ID,
      mergedAmount: 5,
      recordedAt: "2026-07-30T00:00:00.000Z",
    });
    mergeLedgerRepo.markOnchain("ambiguous-recovery");

    const result = await recoverConfirmedOnchainMerges({
      bus,
      positionRepo,
      lotRepo,
      mergeLedgerRepo,
      db: conn.db,
      log,
    });

    expect(result.recovered).toBe(1);
    expect(result.remaining).toEqual([]);
    expect(lotRepo.consumeFifo).toHaveBeenCalledWith("p-yes", 5);
    expect(lotRepo.consumeFifo).toHaveBeenCalledWith("p-no", 5);
    expect(positionRepo.findByTokenId).not.toHaveBeenCalled();
    expect(
      conn.db
        .prepare("SELECT status FROM merge_ledger WHERE merge_id = ?")
        .get("ambiguous-recovery"),
    ).toEqual({ status: "applied" });
  });
});
