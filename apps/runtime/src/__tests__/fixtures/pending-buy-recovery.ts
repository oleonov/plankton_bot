import { vi } from "vitest";
import {
  bootstrapLedgerDb,
  SqliteFillRepository,
  SqliteInventoryLotRepository,
  SqliteLegStateRepository,
  SqliteMarketRepository,
  SqliteOrderRepository,
  SqlitePositionRepository,
} from "@krabs/db";
import {
  createBotRunId,
  createConditionId,
  createOrderId,
  createPositionId,
  createTokenId,
  DEFAULT_EXECUTION_POLICY,
  type ClientOrderId,
  type ExchangeFill,
  type ExchangeGateway,
  type ExchangeOrder,
  type Order,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  ExecutionModule,
  type ExecutionModuleDeps,
} from "../../modules/execution/execution-module.js";
import {
  runStartupPositionAdoption,
  type StartupPositionAdoptionDeps,
} from "../../startup-position-adoption.js";
import { resolveNewPositionExitOwner } from "../../modules/exit-ownership/resolve-new-position-exit-owner.js";
import type { NewPositionExitOwnerResolver } from "../../modules/risk-inventory/inventory-handler.js";

export const incidentIds = [
  "0x3135ceab9c3793530c5dbc6e156ff983ed46f45a3492d1d9b4d1a56f777a147b",
  "0x62e8bdcd417d92718dbfa55503da13a7ec99193404a653ad2ec79bca10f791b6",
] as const;

export function pendingBuyFixture(dbPath = ":memory:") {
  const conn = bootstrapLedgerDb(dbPath);
  const tokenId = createTokenId(
    "60439806692871734282263527699857865985707456979301205077689278354683462925765",
  );
  const conditionId = createConditionId("incident-condition");
  const ownerId = createPositionId(`pos-${tokenId}-1789717777463`);
  const now = new Date().toISOString();
  const orderRepo = new SqliteOrderRepository(conn.db);
  const fillRepo = new SqliteFillRepository(conn.db);
  const marketRepo = new SqliteMarketRepository(conn.db);
  const positionRepo = new SqlitePositionRepository(conn.db);
  const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  conn.db
    .prepare(
      `INSERT INTO positions (position_id, token_id, condition_id, side, size,
    avg_entry_price, cost_basis_usdc, status, opened_at, updated_at)
    VALUES (?, ?, ?, 'buy', 0, .006, 0, 'closed', ?, ?)`,
    )
    .run(ownerId, tokenId, conditionId, now, now);
  marketRepo.save({
    tokenId,
    conditionId,
    slug: "incident",
    eventSlug: "incident",
    question: "Incident?",
    outcome: "YES",
    regime: "threshold",
    horizon: "daily",
    endDate: new Date(Date.now() + 86_400_000).toISOString(),
    active: true,
    tradable: true,
    tickSize: 0.001,
    negRisk: false,
    eventMarketCount: 1,
    gammaCreatedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const orders = incidentIds.map(
    (id, index): Order => ({
      orderId: createOrderId(id),
      clientOrderId: id as ClientOrderId,
      exchangeOrderId: id,
      tokenId,
      conditionId,
      positionId: ownerId,
      side: "buy",
      orderType: "GTC",
      postOnly: true,
      price: 0.006,
      size: 114.99999999999999,
      sizeUsdc: 0.69,
      status: index ? "open" : "pending",
      signalId: null,
      signalReason: null,
      entryStyle: null,
      decisionRuleId: "EXECUTION_PROFILE_SCALE_IN",
      metadata: null,
      botRunId: createBotRunId("incident-run"),
      createdAt: now,
      updatedAt: now,
    }),
  );
  orders.forEach((order) => orderRepo.save(order));
  const remote = (
    index: number,
    status: ExchangeOrder["status"] = "OPEN",
    sizeFilled = 0,
  ): ExchangeOrder => ({
    orderId: incidentIds[index]!,
    clientOrderId: null,
    tokenId,
    side: "buy",
    price: 0.006,
    sizeTotal: 114.99,
    sizeFilled,
    sizeRemaining: 114.99 - sizeFilled,
    status,
    createdAt: Date.parse(now),
  });
  const observations = new Map<string, ExchangeOrder | null>([
    [incidentIds[0], null],
    [incidentIds[1], remote(1)],
  ]);
  let history: ExchangeFill[] = [];
  const gateway = {
    getOrderResult: vi.fn(async (id: string) => ({
      ok: true as const,
      data: observations.get(id) ?? null,
    })),
    getOpenOrdersResult: vi.fn(async () => ({
      ok: true as const,
      data: [...observations.values()].filter(
        (order): order is ExchangeOrder =>
          !!order && ["OPEN", "PARTIALLY_FILLED"].includes(order.status),
      ),
    })),
    getFillsResult: vi.fn(async () => ({ ok: true as const, data: [...history] })),
    getFills: vi.fn(async () => [...history]),
    cancelOrder: vi.fn(async () => ({ success: false })),
    placeOrder: vi.fn(),
    prepareOrder: vi.fn(),
    submitPreparedOrder: vi.fn(),
  } as unknown as ExchangeGateway & {
    cancelOrder: ReturnType<typeof vi.fn>;
    placeOrder: ReturnType<typeof vi.fn>;
  };
  const deps: StartupPositionAdoptionDeps & {
    orderRepo: SqliteOrderRepository;
    resolveNewExitOwner: ReturnType<typeof vi.fn<NewPositionExitOwnerResolver>>;
  } = {
    gateway: gateway as Parameters<typeof runStartupPositionAdoption>[0]["gateway"],
    orderRepo,
    fillRepo,
    marketRepo,
    positionRepo,
    inventoryLotRepo,
    legStateRepo: new SqliteLegStateRepository(conn.db),
    db: conn.db,
    botRunId: createBotRunId("incident-run"),
    log: log as any,
    resolveNewExitOwner: vi.fn<NewPositionExitOwnerResolver>((fill, entryLane, openedAt) =>
      resolveNewPositionExitOwner(
        {
          entryLane,
          conditionId: String(fill.conditionId),
          openedAt,
          firstTradeAt: new Date(fill.timestamp).toISOString(),
        },
        {
          ...DEFAULT_EXECUTION_POLICY,
          sellableFlow: {
            ...DEFAULT_EXECUTION_POLICY.sellableFlow,
            enabled: true,
            appliesFromMs: 0,
          },
          bounceExit: {
            ...DEFAULT_EXECUTION_POLICY.bounceExit,
            enabled: true,
            mode: "micro_live",
            applyToAllMarkets: true,
          },
        },
      ),
    ),
  };
  const bus = new InProcessEventBus();
  const executions: ExecutionModule[] = [];
  const execution = (overrides: Partial<ExecutionModuleDeps> = {}) => {
    const module = new ExecutionModule({
      ...deps,
      gateway,
      bus,
      runtimeMode: "live-lite",
      runtimeControl: { isPaused: () => true } as any,
      ...overrides,
    });
    executions.push(module);
    return module;
  };
  const fill = (index: number, size: number, id = `fill-${index}`): ExchangeFill => ({
    fillId: id,
    orderId: incidentIds[index]!,
    clientOrderId: null,
    tokenId,
    side: "buy",
    price: 0.006,
    size,
    sizeUsdc: size * 0.006,
    liquidityRole: "maker",
    fee: 0,
    feeRateBps: 0,
    timestamp: Date.parse(now) + 1_000,
  });
  return {
    conn,
    deps,
    bus,
    gateway,
    orders,
    observations,
    remote,
    fill,
    execution,
    history: (fills: ExchangeFill[]) => {
      history = fills;
    },
    adopt: () => runStartupPositionAdoption(deps),
    close: async () => {
      for (const module of executions) await module.stop();
      conn.close();
    },
  };
}
