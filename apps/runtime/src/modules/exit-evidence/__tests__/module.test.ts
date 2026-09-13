import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  type ClientOrderId,
  createCommandId,
  createTokenId,
  createConditionId,
  createOrderId,
  createFillId,
  createPositionId,
  ExchangeErrorCode,
  type PlaceOrderCommand,
  type RuntimeEventMap,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  bootstrapLedgerDb,
  SqlitePositionRepository,
  SqliteInventoryLotRepository,
  SqliteOrderRepository,
  SqliteFillRepository,
} from "@krabs/db";
import { expect, it, vi } from "vitest";
import { ExitEvidenceModule, type EvidenceDeps } from "../module.js";
import { EvidenceTransport, copyBook, copyFacts } from "../transport.js";
import { LIMITS, counters, type MainMessage, type Packet } from "../types.js";
import { RiskInventoryModule } from "../../risk-inventory/risk-inventory-module.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
class Port extends EventEmitter {
  sent: MainMessage[] = [];
  unref = vi.fn();
  kill = vi.fn(() => {
    this.emit("exit", null, "SIGKILL");
    return true;
  });
  send(message: MainMessage): void {
    this.sent.push(message);
    if (message.type === "shutdown") {
      this.emit("message", { type: "stopped" });
      this.emit("exit", 0);
    }
    if (message.type === "batch")
      setImmediate(() =>
        this.emit("message", {
          type: "ack",
          credit: null,
          episodes: [],
          quality: counters(),
          run: { last_seen: Date.now(), deadline: Date.now() + LIMITS.captureMs, disabled: 0 },
        }),
      );
  }
}
const command: PlaceOrderCommand = {
  type: "PlaceOrderCommand",
  source: "strategy",
  side: "buy",
  clientOrderId: "client" as ClientOrderId,
  commandId: createCommandId("command"),
  signalId: "signal",
  tokenId: createTokenId("token"),
  conditionId: createConditionId("condition"),
  price: 0.1,
  size: 10,
  orderType: "GTC",
  tickSize: 0.01,
  negRisk: false,
  sequenceInTick: 0,
  signalReason: null,
};
function fixture(book: EvidenceDeps["book"] = () => ({ book: null, fresh: false })) {
  const bus = new InProcessEventBus();
  const port = new Port();
  const log = { info: vi.fn(), warn: vi.fn() } as any;
  const module = new ExitEvidenceModule({
    bus,
    ledgerPath: "/unused/ledger.db",
    log,
    book,
    workerFactory: () => port as unknown as ChildProcess,
  });
  const now = Date.now();
  const ready = () =>
    port.emit("message", {
      type: "ready",
      quality: counters(),
      credit: 1,
      episodes: [],
      run: {
        started: now,
        deadline: now + LIMITS.captureMs,
        expires: now + LIMITS.retentionMs,
        last_seen: now,
        spent: 1,
        event_count: 0,
        book_count: 0,
        disabled: 0,
      },
    });
  return { bus, port, module, ready, log };
}
it("bounds both port and local queues without ACK; optional books yield capacity to lifecycle", async () => {
  const sent: Packet[][] = [];
  const transport = new EvidenceTransport((batch) => sent.push(batch));
  const packet: Packet = {
    slot: 1,
    kind: "Book",
    id: "book",
    source: Date.now(),
    received: Date.now(),
    facts: {},
  };
  for (let i = 0; i < 128; i++) transport.enqueue(packet);
  await turn();
  for (let i = 0; i < 1_000; i++) transport.enqueue({ ...packet, kind: "FillReceived" });
  expect(transport.size).toBe(128);
  expect(transport.bytes).toBe(1_048_576);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toHaveLength(16);
  expect(transport.drops.book_drop).toBe(112);
  expect(transport.drops.lifecycle_drop).toBe(888);
  transport.acknowledge();
  await turn();
  expect(sent).toHaveLength(2);
  transport.close();
});
it("uses bounded UTF8 allowlisting and never reads deep oversized books or metadata", () => {
  const input = {
    ...command,
    metadata: {
      get secret() {
        throw new Error("read");
      },
    },
  };
  expect(copyFacts(input)).not.toHaveProperty("metadata");
  expect(copyFacts({ tokenId: createTokenId("界").repeat(160) })).toBeNull();
  const side = Array.from({ length: 129 }, () => ({
    get price(): number {
      throw new Error("deep read");
    },
    size: 1,
  }));
  const result = copyBook(
    { bids: side, asks: side, bestBid: 0.1, bestAsk: 0.2, timestamp: 1 } as any,
    false,
  )!;
  expect(result.oversize).toBe(true);
  expect(result.bids).toHaveLength(0);
  expect(result.bestBid).toBe(0.1);
});
it("observes nested FillReceived → PositionUpdated before outer publication returns", async () => {
  const { bus, module, port, ready } = fixture();
  await module.start();
  ready();
  await bus.publish("PlaceOrderRequested", { command, timestamp: Date.now() });
  const trace: string[] = [];
  bus.subscribe("FillReceived", async () => {
    trace.push("inventory");
    await bus.publish("PositionUpdated", {
      position: {
        tokenId: createTokenId("token"),
        conditionId: createConditionId("condition"),
        positionId: createPositionId("position"),
        updatedAt: new Date().toISOString(),
        status: "open",
        size: 3,
      } as any,
    });
    trace.push("nested-complete");
  });
  await bus.publish("FillReceived", {
    ...command,
    fillId: createFillId("fill"),
    orderId: createOrderId("order"),
    sizeUsdc: 1,
    liquidityRole: "maker",
    fee: 0,
    feeRateBps: 0,
    timestamp: Date.now(),
  });
  expect(trace).toEqual(["inventory", "nested-complete"]);
  await turn();
  const batch = port.sent.find((m) => m.type === "batch")!;
  expect(
    batch.type === "batch" && batch.packets.filter((p) => p.kind !== "Book").map((p) => p.kind),
  ).toEqual(["PlaceOrderRequested", "FillReceived", "PositionUpdated"]);
  await module.stop();
});
it("collector off/on/failure produces the identical gateway commands and no pause", async () => {
  const runs: unknown[][] = [];
  for (const mode of ["off", "on", "error"]) {
    const { bus, module, port, ready } = fixture();
    const gateway: unknown[] = [];
    const pause = vi.fn();
    if (mode !== "off") {
      await module.start();
      ready();
    }
    bus.subscribe("PlaceOrderRequested", async (event) => {
      gateway.push(structuredClone(event.command));
    });
    bus.subscribe("PauseRequested" as any, pause);
    if (mode === "error") port.emit("error", new Error("collector only"));
    await bus.publish("PlaceOrderRequested", { command, timestamp: Date.now() });
    await bus.publish("PlaceOrderRequested", {
      command: {
        ...command,
        side: "sell",
        positionId: createPositionId("position"),
        price: 0.2,
        size: 3,
      },
      timestamp: Date.now(),
    });
    expect(pause).not.toHaveBeenCalled();
    runs.push(gateway);
    await module.stop();
  }
  expect(runs[1]).toEqual(runs[0]);
  expect(runs[2]).toEqual(runs[0]);
});
it("does not enroll existing-position BUYs, readiness gaps, or more than one locally granted chain", async () => {
  const { bus, module, port, ready } = fixture();
  await module.start();
  await bus.publish("PlaceOrderRequested", { command, timestamp: Date.now() });
  ready();
  await bus.publish("PlaceOrderRequested", {
    command: { ...command, positionId: createPositionId("existing") },
    timestamp: Date.now(),
  });
  expect((module.stats() as any).episodes).toBe(0);
  for (let i = 0; i < 35; i++)
    await bus.publish("PlaceOrderRequested", {
      command: {
        ...command,
        clientOrderId: `client-${i}` as ClientOrderId,
        commandId: createCommandId(`cmd-${i}`),
      },
      timestamp: Date.now(),
    });
  expect((module.stats() as any).episodes).toBe(1);
  expect((module.stats() as any).drops.enrollment_drop).toBe(34);
  await turn();
  expect(port.sent.filter((m) => m.type === "batch")).toHaveLength(1);
  await module.stop();
});
it("captures the real RiskInventory nested publication and deterministic lot before outer fill returns", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "exit-evidence-inventory-")));
  const ledger = bootstrapLedgerDb(join(dir, "ledger.db"));
  const { bus, module, port, ready } = fixture();
  const log = {
    child: () => log,
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
  const risk = new RiskInventoryModule({
    bus,
    db: ledger.db,
    log,
    positionRepo: new SqlitePositionRepository(ledger.db),
    inventoryLotRepo: new SqliteInventoryLotRepository(ledger.db),
    orderRepo: new SqliteOrderRepository(ledger.db),
    fillRepo: new SqliteFillRepository(ledger.db),
    emitStrandedFillAlert: vi.fn(),
  });
  try {
    await module.start();
    ready();
    await risk.start();
    ledger.db
      .exec(`INSERT INTO orders(order_id,client_order_id,token_id,condition_id,side,order_type,price,size,size_usdc,bot_run_id)
      VALUES('order','client','token','condition','buy','GTC',.1,10,1,'run');
      INSERT INTO fills(fill_id,order_id,token_id,condition_id,side,price,size,size_usdc)
      VALUES('fill','order','token','condition','buy',.1,10,1);`);
    await bus.publish("PlaceOrderRequested", { command, timestamp: Date.now() });
    let nested = false;
    bus.subscribe("PositionUpdated", async () => {
      nested = true;
    });
    await bus.publish("FillReceived", {
      ...command,
      fillId: createFillId("fill"),
      orderId: createOrderId("order"),
      timestamp: Date.now(),
      fee: 0,
      feeRateBps: 0,
      sizeUsdc: 1,
      liquidityRole: "maker",
    });
    expect(nested).toBe(true);
    const lot = ledger.db
      .prepare("SELECT position_id,fill_id,token_id FROM inventory_lots WHERE lot_id='lot-fill'")
      .get() as any;
    expect(lot).toMatchObject({ fill_id: "fill", token_id: "token" });
    await turn();
    const batch = port.sent.find((m) => m.type === "batch")!;
    expect(
      batch.type === "batch" &&
        batch.packets.some(
          (p) => p.kind === "PositionUpdated" && p.facts.positionId === lot.position_id,
        ),
    ).toBe(true);
  } finally {
    await risk.stop();
    await module.stop();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("selects a newer existing heartbeat book only for enrolled targets and records bounded failure codes", async () => {
  const now = Date.now();
  const candidate = {
    bestBid: 0.1,
    bestAsk: 0.2,
    timestamp: now - 1000,
    bids: [{ price: 0.1, size: 1 }],
    asks: [{ price: 0.2, size: 1 }],
  } as any;
  const heartbeat = { ...candidate, bestBid: 0.15, timestamp: now - 10 };
  const { bus, module, port, ready } = fixture(() => ({ book: candidate, fresh: false }));
  await module.start();
  ready();
  await bus.publish("PlaceOrderRequested", { command, timestamp: now });
  const books = new Map([
    ["token", heartbeat],
    [
      "unselected",
      {
        get bids() {
          throw new Error("unselected read");
        },
      },
    ],
  ]) as any;
  await bus.publish("MarketSnapshotHeartbeat", {
    markets: [],
    booksByToken: books,
    timestamp: now,
    reason: "full_lifetime_active_position",
    source: "market-data",
  });
  const rejected: RuntimeEventMap["OrderRejected"] = {
    commandId: command.commandId,
    clientOrderId: command.clientOrderId,
    tokenId: command.tokenId,
    conditionId: command.conditionId,
    timestamp: now,
    reason: "runtime-paused",
    errorCode: ExchangeErrorCode.RuntimePaused,
    signalReason: "probe-entry",
    exchangeErrorMessage: "secret raw message",
    exchangeErrorDetails: { secret: "secret" },
  };
  await bus.publish("OrderRejected", rejected);
  await bus.publish("OrderRejected", {
    ...rejected,
    reason: "exchange-insufficient-balance-or-allowance: secret wallet",
    errorCode: ExchangeErrorCode.InsufficientBalance,
  });
  await bus.publish("OrderSkipped", {
    commandId: command.commandId,
    clientOrderId: command.clientOrderId,
    tokenId: command.tokenId,
    conditionId: command.conditionId,
    side: command.side,
    price: command.price,
    size: command.size,
    timestamp: now,
    reasonCode: "post-only-cross-pre-submit",
    signalReason: "probe-entry",
    signalId: "signal",
    decisionRuleId: null,
    signalTimestamp: null,
    details: { secret: "secret" },
  });
  await bus.publish("OrderCancelled", {
    commandId: command.commandId,
    orderId: createOrderId("order"),
    tokenId: command.tokenId,
    conditionId: command.conditionId,
    timestamp: now,
    reason: "stale_exit_ttl",
    signalReason: "repricing-exit",
  });
  await bus.publish("PlaceOrderRequested", {
    command: {
      ...command,
      side: "sell",
      positionId: createPositionId("position"),
      signalReason: "profile-ladder-exit",
    },
    timestamp: now,
  });
  await turn();
  const packets = port.sent.flatMap((m) => (m.type === "batch" ? m.packets : []));
  const failures = packets.filter((p) => p.kind === "OrderRejected" || p.kind === "OrderSkipped");
  expect(failures).toHaveLength(3);
  expect(failures.map((p) => p.facts)).toMatchObject([
    { reason: "runtime-paused", errorCode: "RUNTIME_PAUSED", signalReason: "probe-entry" },
    { reason: null, errorCode: "INSUFFICIENT_BALANCE" },
    { reasonCode: "post-only-cross-pre-submit" },
  ]);
  expect(JSON.stringify(failures)).not.toContain("secret");
  expect(packets.find((p) => p.kind === "OrderCancelled")?.facts).toMatchObject({
    reason: "stale_exit_ttl",
    signalReason: "repricing-exit",
  });
  expect(packets.find((p) => p.facts.side === "sell")?.facts.signalReason).toBe(
    "profile-ladder-exit",
  );
  expect(
    copyFacts({
      reason: "stale_exit_ttl secret",
      signalReason: "secret",
      errorCode: "secret",
      reasonCode: "secret",
    }),
  ).toEqual({ reason: null, signalReason: null, errorCode: null, reasonCode: null });
  expect(
    packets.every((p) => Buffer.byteLength(JSON.stringify(p.facts)) <= LIMITS.eventBytes),
  ).toBe(true);
  const sample = packets.find((p) => p.kind === "Book" && p.facts.trigger === "OrderRejected")!;
  expect(sample.book).toMatchObject({ bestBid: 0.15, time: now - 10, fresh: false });
  await module.stop();
});

it.each(["terminal", "ambiguous"] as const)(
  "background progress stops %s periodic samples and bounded logs expose counts",
  async (state) => {
    const { bus, module, port, ready, log } = fixture();
    await module.start();
    ready();
    await bus.publish("PlaceOrderRequested", { command, timestamp: Date.now() });
    await turn();
    await turn();
    const now = Date.now();
    port.emit("message", {
      type: "progress",
      credit: null,
      quality: { ...counters(), book_stale: 5 },
      episodes: [
        {
          slot: 1,
          token: "token",
          condition: "condition",
          client: "client",
          position: "position",
          terminal: state === "terminal",
          ambiguous: state === "ambiguous",
        },
      ],
      run: {
        started: now,
        deadline: now + LIMITS.captureMs,
        last_seen: now,
        spent: 2,
        event_count: 7,
        book_count: 3,
        disabled: 0,
      },
    });
    const before = port.sent.filter((m) => m.type === "batch").length;
    (module as any).periodic();
    await turn();
    expect(port.sent.filter((m) => m.type === "batch")).toHaveLength(before);
    expect(port.sent.some((m) => m.type === "progressAck")).toBe(true);
    const summary = log.info.mock.calls.at(-1)[0];
    expect(summary.exitEvidence).toMatchObject({
      persistedEvents: 7,
      persistedBooks: 3,
      active: 0,
      bookStale: 5,
    });
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(1024);
    expect(log.info.mock.calls.some((call: any[]) => call[1] === "exit evidence ready")).toBe(true);
    await module.stop();
  },
);
