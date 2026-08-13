/**
 * Mark-to-market staleness — timestamp-format regression guard.
 *
 * `shouldApplyMarketDataMark` (risk-inventory-module.ts) parses `positions.updated_at`
 * via `parseLedgerInstantMs` rather than bare `Date.parse` specifically because the
 * ledger can carry the SQLite space rendering (`"2026-08-05 05:53:26"`, no zone)
 * alongside ISO. Bare `Date.parse` reads that zone-less shape as HOST-LOCAL time; under
 * a non-UTC host such as `Asia/Bangkok` (UTC+7) a 30-second-old mark is misread as ~7h
 * old, `nowMs - updatedAtMs > W4_STALENESS_FALLBACK_MS` flips true, and a CURRENT wallet
 * mark gets clobbered by a market-data mark. The TZ switch below is required to make the
 * regression observable at all — a UTC test host would let a `Date.parse` regression pass
 * by accident. Mechanism follows packages/db/src/__tests__/timestamp-format-consistency.test.ts
 * ("pins the SQLite space rendering to UTC instead of the host-local timezone").
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConditionId, createPositionId, createTokenId } from "@krabs/domain";
import type {
  InventoryLotRepository,
  NormalizedMarket,
  OrderRepository,
  Position,
  PositionRepository,
} from "@krabs/domain";
import { toSqliteDateTime } from "@krabs/db";
import { InProcessEventBus } from "@krabs/event-bus";
import type { Logger } from "../../../logger.js";
import { discardStrandedFillAlert } from "../../../stranded-fill-alert.js";
import { RiskInventoryModule } from "../risk-inventory-module.js";

const TOK_ID = createTokenId("tok-tz-staleness");
/** Shared by both cases on purpose — the mark's age must be the ONLY difference between them. */
const POSITION_ID = "pos-tz-staleness";
const COND_ID = createConditionId("cond-tz-staleness");
const NOW_MS = Date.parse("2026-05-14T12:00:00.000Z");

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as unknown as Logger;

function immediateTransaction<T extends (...args: any[]) => any>(fn: T): T & { immediate: T } {
  const tx = ((...args: Parameters<T>) => fn(...args)) as T & { immediate: T };
  tx.immediate = tx;
  return tx;
}

const mockDb = {
  prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
  transaction: vi.fn((fn: any) => immediateTransaction(fn)),
} as any;

function makePositionRepo(position: Position): PositionRepository {
  const positions = [position];
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(position),
    findOpen: vi.fn().mockReturnValue(positions.filter((p) => p.status === "open")),
    findDust: vi.fn().mockReturnValue(positions.filter((p) => p.status === "dust")),
    findAll: vi.fn().mockReturnValue(positions),
    findOpenByEntryStyle: vi.fn().mockReturnValue([]),
    findById: vi.fn(() => null),
    findActiveByTokenId: vi.fn(() => []),
  };
}

function makeLotRepo(): InventoryLotRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue([]),
    findOpen: vi.fn().mockReturnValue([]),
    consumeFifo: vi.fn().mockReturnValue([]),
    settleAll: vi.fn(),
  };
}

function makeOrderRepo(): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findByClientOrderId: vi.fn().mockReturnValue(null),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
  };
}

function makeMarket(overrides?: Partial<NormalizedMarket>): NormalizedMarket {
  return {
    tokenId: TOK_ID,
    conditionId: String(COND_ID),
    slug: "test",
    eventSlug: null,
    question: "test?",
    outcome: "YES",
    regime: "threshold" as any,
    horizon: "daily",
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    gammaCreatedAt: null,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.049,
    bestAsk: 0.051,
    midPrice: 0.05,
    spread: 0.002,
    snapshotTs: Date.now(),
    eventMarketCount: 1,
    ...overrides,
  } as NormalizedMarket;
}

/**
 * A position whose only variable is how old its mark is. `currentValueUsdc` is non-null and
 * plausible (size 28.37 * price 0.074 ~= costBasis 2.0993), so `needsStartupCurrentValueBackfill()`
 * is false and the code actually reaches the staleness comparison under test.
 */
function makePosition(id: string, updatedAtMs: number): Position {
  return {
    positionId: createPositionId(id),
    tokenId: TOK_ID,
    conditionId: COND_ID,
    side: "buy",
    size: 28.37,
    avgEntryPrice: 0.074,
    costBasisUsdc: 2.0993,
    currentValueUsdc: 2.1135,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: new Date(NOW_MS - 3_600_000).toISOString(),
    closedAt: null,
    updatedAt: toSqliteDateTime(updatedAtMs),
  };
}

async function publishMarkUpdate(position: Position): Promise<PositionRepository> {
  const bus = new InProcessEventBus();
  const positionRepo = makePositionRepo(position);
  const mod = new RiskInventoryModule({
    bus,
    positionRepo,
    inventoryLotRepo: makeLotRepo(),
    orderRepo: makeOrderRepo(),
    fillRepo: {
      claimForReconciliation: vi.fn().mockReturnValue(true),
      findUnreconciled: vi.fn().mockReturnValue([]),
    },
    log: silentLog,
    db: mockDb,
    now: () => NOW_MS,
    emitStrandedFillAlert: discardStrandedFillAlert,
  });
  await mod.start();
  // `start()` runs `backfillStaleCurrentValues()` and `replayUnreconciledFills()`, which read and
  // can save on their own. Clearing here scopes every assertion below to the mark-update handler,
  // so `findOpen` having been called is proof THIS event reached the position enumeration.
  for (const value of Object.values(positionRepo)) {
    if (vi.isMockFunction(value)) value.mockClear();
  }

  await bus.publish("NormalizedMarketUpdated", {
    markets: [makeMarket({ bestBid: 0.057, bestAsk: 0.058, midPrice: 0.0575 })],
    timestamp: NOW_MS,
  });
  await bus.drain();
  await mod.stop();

  return positionRepo;
}

describe("RiskInventoryModule mark-to-market — SQLite space-format staleness (non-UTC host)", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("keeps a fresh wallet mark when updatedAt is the zone-less SQLite space rendering", async () => {
    process.env.TZ = "Asia/Bangkok";

    // 30s old, against a 60s threshold — fresh under either sign of the bug's absence.
    // Regressed to bare `Date.parse`, the space rendering is misread as Bangkok-local
    // (UTC+7) time: the mark looks ~7h stale and the fresh wallet mark gets overwritten.
    const positionRepo = await publishMarkUpdate(makePosition(POSITION_ID, NOW_MS - 30_000));

    // `not.toHaveBeenCalled()` on its own is also satisfied by a handler that never ran at all.
    // Startup calls are cleared before the publish, so this enumeration can only have come from
    // `handleMarketUpdate` — which is what makes the silence below mean "judged fresh".
    expect(positionRepo.findOpen).toHaveBeenCalled();
    expect(positionRepo.save).not.toHaveBeenCalled();
  });

  it("still applies the mark when the space-rendered updatedAt is genuinely past the threshold", async () => {
    process.env.TZ = "Asia/Bangkok";

    // Positive control for the assertion above. It shares every fixture, the same TZ and the same
    // position ID, and differs ONLY in the mark's age — so no keyed early-skip can explain the
    // first test's silence while this one still saves.
    const positionRepo = await publishMarkUpdate(makePosition(POSITION_ID, NOW_MS - 5 * 60_000));

    expect(positionRepo.save).toHaveBeenCalledTimes(1);
  });
});
