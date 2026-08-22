import { describe, expect, it, vi } from "vitest";
import type {
  AlgoRulesRepository,
  ClientOrderId,
  Fill,
  LegStateRepository,
  NormalizedMarket,
  Order,
  OrderRepository,
  RuntimeEventMap,
  Signal,
  MakerCaptureRepriceIntent,
} from "@krabs/domain";
import {
  DEFAULT_EXECUTION_POLICY,
  createBotRunId,
  createConditionId,
  createFillId,
  createOrderId,
  createPositionId,
  createTokenId,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { EntryLifecycleModule } from "../entry-lifecycle-module.js";
import type { Logger } from "../../../logger.js";
import { buildMakerCaptureRepriceIdentity } from "../../../maker-capture-reprice.js";

const TOKEN = createTokenId("tok-entry-life");
const CONDITION = createConditionId("cond-entry-life");
const ENABLED_ENTRY_LIFECYCLE_POLICY = {
  ...DEFAULT_EXECUTION_POLICY,
  repriceOnOutbid: { ...DEFAULT_EXECUTION_POLICY.repriceOnOutbid, enabled: true },
  multiBuyLadder: { ...DEFAULT_EXECUTION_POLICY.multiBuyLadder, enabled: true },
};

describe("EntryLifecycleModule", () => {
  it("publishes startup cancellation for an expired frozen maker capture", async () => {
    const bus = new InProcessEventBus();
    const order = makeOrder({
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
      entryStyle: "maker",
      createdAt: new Date(1_000).toISOString(),
      metadata: {
        makerMicroLiveLifecycle: {
          kind: "r23_capture",
          activatedAtUtc: new Date(0).toISOString(),
          expiresAtUtc: new Date(20_000).toISOString(),
          fillWaitMs: 5_000,
        },
      },
    });
    const cancellations: RuntimeEventMap["CancelOrderRequested"][] = [];
    bus.subscribe("CancelOrderRequested", async (event) => {
      cancellations.push(event);
    });
    const module = buildModule({
      bus,
      orderRepo: makeOrderRepo(order),
      now: () => 10_000,
    });

    await module.start();
    await bus.drain();

    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]?.command).toMatchObject({
      orderId: order.orderId,
      reason: "stale_entry_ttl",
    });
    await module.stop();
  });

  it("reissues BUY signal after an outbid cancel using the current best bid", async () => {
    const bus = new InProcessEventBus();
    const order = makeOrder({ signalId: "sig-original", price: 0.3, sizeUsdc: 0.99 });
    const module = buildModule({
      bus,
      orderRepo: makeOrderRepo(order),
      fillRepo: makeFillRepo([]),
    });
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async (payload) => {
      signals.push(payload.signal);
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.31, midPrice: 0.32 }));
    await bus.publish("OrderCancelled", {
      commandId: "cmd-1" as never,
      orderId: order.orderId,
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      reason: "outbid_repriced",
      signalReason: order.signalReason,
      timestamp: 1_000,
    });
    await bus.drain();

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      tokenId: TOKEN,
      side: "buy",
      suggestedPrice: 0.31,
      reason: "confirm-scale",
      sequenceInTick: 1,
      decisionRuleId: "OUTBID_REPRICE",
    });
    expect(signals[0]!.suggestedSize).toBeCloseTo(3);
    expect(signals[0]!.suggestedSizeUsdc).toBeCloseTo(0.93);
    expect(signals[0]!.signalId).toMatch(/^outbid-reprice:1:/);
    expect(module.getRepriceCount(signals[0]!.signalId)).toBe(1);

    await module.stop();
  });

  it("reissues only the unfilled residual after a partial BUY fill", async () => {
    const bus = new InProcessEventBus();
    const order = makeOrder({ signalId: "sig-original", price: 0.3, size: 10, sizeUsdc: 3 });
    const fill = makeFill({ orderId: order.orderId, price: 0.3, size: 4, sizeUsdc: 1.2 });
    const module = buildModule({
      bus,
      orderRepo: makeOrderRepo(order),
      fillRepo: makeFillRepo([fill]),
    });
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async (payload) => {
      signals.push(payload.signal);
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.31, midPrice: 0.32 }));
    await bus.publish("OrderCancelled", {
      commandId: "cmd-1" as never,
      orderId: order.orderId,
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      reason: "outbid_repriced",
      signalReason: order.signalReason,
      timestamp: 1_000,
    });
    await bus.drain();

    expect(signals).toHaveLength(1);
    expect(signals[0]!.suggestedSize).toBeCloseTo(6);
    expect(signals[0]!.suggestedSizeUsdc).toBeCloseTo(1.86);

    await module.stop();
  });

  it("copies exact R23 attribution through a relationally proven outbid chain", async () => {
    const bus = new InProcessEventBus();
    const attribution = freshEdgeAttribution();
    const origin = makeOrder({
      orderId: createOrderId("ord-origin"),
      signalId: attribution.originSignalId,
      decisionRuleId: "R23_DIP_TRIGGER",
      metadata: { entryFreshEdgeAttribution: attribution },
    });
    const repriced = makeOrder({
      orderId: createOrderId("ord-repriced"),
      signalId: "outbid-reprice:1:x",
      decisionRuleId: "OUTBID_REPRICE",
      metadata: { entryFreshEdgeAttribution: attribution },
    });
    const repo = makeOrderRepo(repriced);
    vi.mocked(repo.findByTokenId).mockReturnValue([origin, repriced]);
    const module = buildModule({ bus, orderRepo: repo });
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });

    await module.start();
    await publishMarket(bus, makeMarket());
    await publishOutbidCancel(bus, repriced);
    await bus.drain();

    expect(signals[0]?.entryFreshEdgeAttribution).toEqual(attribution);
    await module.stop();
  });

  it("omits malformed or unproven attribution without blocking outbid reprice", async () => {
    const bus = new InProcessEventBus();
    const order = makeOrder({
      decisionRuleId: "OUTBID_REPRICE",
      metadata: { entryFreshEdgeAttribution: { ...freshEdgeAttribution(), version: 2 } },
    });
    const module = buildModule({ bus, orderRepo: makeOrderRepo(order) });
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });

    await module.start();
    await publishMarket(bus, makeMarket());
    await publishOutbidCancel(bus, order);
    await bus.drain();

    expect(signals).toHaveLength(1);
    expect(signals[0]?.entryFreshEdgeAttribution).toBeUndefined();
    await module.stop();
  });

  it("does not reissue an outbid BUY when the residual is below min order size", async () => {
    const bus = new InProcessEventBus();
    const order = makeOrder({ signalId: "sig-original", price: 0.3, size: 10, sizeUsdc: 3 });
    const fill = makeFill({ orderId: order.orderId, price: 0.3, size: 7, sizeUsdc: 2.1 });
    const module = buildModule({
      bus,
      orderRepo: makeOrderRepo(order),
      fillRepo: makeFillRepo([fill]),
    });
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async (payload) => {
      signals.push(payload.signal);
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.31, midPrice: 0.32, minOrderSize: 5 }));
    await bus.publish("OrderCancelled", {
      commandId: "cmd-1" as never,
      orderId: order.orderId,
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      reason: "outbid_repriced",
      signalReason: order.signalReason,
      timestamp: 1_000,
    });
    await bus.drain();

    expect(signals).toHaveLength(0);

    await module.stop();
  });

  it("does not reissue outbid BUYs when reprice is disabled", async () => {
    const bus = new InProcessEventBus();
    const order = makeOrder({ signalId: "sig-original", price: 0.3, sizeUsdc: 0.99 });
    const module = buildModule({
      bus,
      orderRepo: makeOrderRepo(order),
      fillRepo: makeFillRepo([]),
      policy: () => ({
        ...ENABLED_ENTRY_LIFECYCLE_POLICY,
        repriceOnOutbid: { ...ENABLED_ENTRY_LIFECYCLE_POLICY.repriceOnOutbid, enabled: false },
      }),
    });
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async (payload) => {
      signals.push(payload.signal);
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.31, midPrice: 0.32 }));
    await bus.publish("OrderCancelled", {
      commandId: "cmd-1" as never,
      orderId: order.orderId,
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      reason: "outbid_repriced",
      signalReason: order.signalReason,
      timestamp: 1_000,
    });
    await bus.drain();

    expect(signals).toHaveLength(0);

    await module.stop();
  });

  it("recovers outbid reprice count from the persisted signal id after restart", async () => {
    const firstBus = new InProcessEventBus();
    const firstOrder = makeOrder({ signalId: "sig-original", price: 0.3, sizeUsdc: 0.99 });
    const firstModule = buildModule({
      bus: firstBus,
      orderRepo: makeOrderRepo(firstOrder),
      fillRepo: makeFillRepo([]),
    });
    const firstSignals: Signal[] = [];
    firstBus.subscribe("SignalProduced", async (payload) => {
      firstSignals.push(payload.signal);
    });

    await firstModule.start();
    await publishMarket(firstBus, makeMarket({ bestBid: 0.31, midPrice: 0.32 }));
    await firstBus.publish("OrderCancelled", {
      commandId: "cmd-1" as never,
      orderId: firstOrder.orderId,
      tokenId: firstOrder.tokenId,
      conditionId: firstOrder.conditionId,
      reason: "outbid_repriced",
      signalReason: firstOrder.signalReason,
      timestamp: 1_000,
    });
    await firstBus.drain();
    await firstModule.stop();

    const secondBus = new InProcessEventBus();
    const secondOrder = makeOrder({ signalId: firstSignals[0]!.signalId, price: 0.31 });
    const secondModule = buildModule({
      bus: secondBus,
      orderRepo: makeOrderRepo(secondOrder),
      fillRepo: makeFillRepo([]),
    });
    const secondSignals: Signal[] = [];
    secondBus.subscribe("SignalProduced", async (payload) => {
      secondSignals.push(payload.signal);
    });

    await secondModule.start();
    await publishMarket(secondBus, makeMarket({ bestBid: 0.32, midPrice: 0.33 }));
    await secondBus.publish("OrderCancelled", {
      commandId: "cmd-2" as never,
      orderId: secondOrder.orderId,
      tokenId: secondOrder.tokenId,
      conditionId: secondOrder.conditionId,
      reason: "outbid_repriced",
      signalReason: secondOrder.signalReason,
      timestamp: 2_000,
    });
    await secondBus.drain();

    expect(secondSignals).toHaveLength(1);
    expect(secondSignals[0]!.sequenceInTick).toBe(2);
    expect(secondSignals[0]!.signalId).toMatch(/^outbid-reprice:2:/);
    expect(secondModule.getRepriceCount(secondSignals[0]!.signalId)).toBe(2);

    await secondModule.stop();
  });

  it("does not reissue outbid BUYs when the persisted count reached maxRepriceCount", async () => {
    const bus = new InProcessEventBus();
    const order = makeOrder({ signalId: "outbid-reprice:5:existing", price: 0.3 });
    const module = buildModule({
      bus,
      orderRepo: makeOrderRepo(order),
      fillRepo: makeFillRepo([]),
    });
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async (payload) => {
      signals.push(payload.signal);
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.31, midPrice: 0.32 }));
    await bus.publish("OrderCancelled", {
      commandId: "cmd-1" as never,
      orderId: order.orderId,
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      reason: "outbid_repriced",
      signalReason: order.signalReason,
      timestamp: 1_000,
    });
    await bus.drain();

    expect(signals).toHaveLength(0);

    await module.stop();
  });

  it("schedules the next ladder BUY 60s after a BUY fill", async () => {
    const bus = new InProcessEventBus();
    const fill = makeFill({ price: 0.1, sizeUsdc: 1 });
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const module = buildModule({
      bus,
      fillRepo: makeFillRepo([fill]),
      setTimer: (fn, delayMs) => {
        scheduled.push({ fn, delayMs });
        return scheduled.length as never;
      },
    });
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async (payload) => {
      signals.push(payload.signal);
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.1, midPrice: 0.11 }));
    await bus.publish("FillReceived", fillToEvent(fill));
    await bus.drain();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delayMs).toBe(60_000);

    scheduled[0]!.fn();
    await bus.drain();

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      tokenId: TOKEN,
      side: "buy",
      suggestedPrice: 0.1,
      ladderTargetPrice: 0.1,
      reason: "confirm-scale",
      decisionRuleId: "LADDER",
    });

    await module.stop();
  });

  it("keeps ladder BUYs on the first fill price when best bid moves 4 ticks below the 5-tick drift guard", async () => {
    const bus = new InProcessEventBus();
    const fill = makeFill({ price: 0.1, sizeUsdc: 1 });
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const module = buildModule({
      bus,
      fillRepo: makeFillRepo([fill]),
      setTimer: (fn, delayMs) => {
        scheduled.push({ fn, delayMs });
        return scheduled.length as never;
      },
    });
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async (payload) => {
      signals.push(payload.signal);
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.14, midPrice: 0.15, tickSize: 0.01 }));
    await bus.publish("FillReceived", fillToEvent(fill));
    await bus.drain();

    expect(scheduled).toHaveLength(1);
    scheduled[0]!.fn();
    await bus.drain();

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      suggestedPrice: 0.1,
      ladderTargetPrice: 0.1,
      decisionRuleId: "LADDER",
    });

    await module.stop();
  });

  it("does not schedule ladder buys when ladder is disabled", async () => {
    const bus = new InProcessEventBus();
    const fill = makeFill({ price: 0.1, sizeUsdc: 1 });
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const module = buildModule({
      bus,
      fillRepo: makeFillRepo([fill]),
      policy: () => ({
        ...ENABLED_ENTRY_LIFECYCLE_POLICY,
        multiBuyLadder: { ...ENABLED_ENTRY_LIFECYCLE_POLICY.multiBuyLadder, enabled: false },
      }),
      setTimer: (fn, delayMs) => {
        scheduled.push({ fn, delayMs });
        return scheduled.length as never;
      },
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.1, midPrice: 0.11 }));
    await bus.publish("FillReceived", fillToEvent(fill));
    await bus.drain();

    expect(scheduled).toHaveLength(0);

    await module.stop();
  });

  it("does not fire a ready ladder timer after the module stops", async () => {
    const bus = new InProcessEventBus();
    const fill = makeFill({ price: 0.1, sizeUsdc: 1 });
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const module = buildModule({
      bus,
      fillRepo: makeFillRepo([fill]),
      setTimer: (fn, delayMs) => {
        scheduled.push({ fn, delayMs });
        return scheduled.length as never;
      },
    });
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async (payload) => {
      signals.push(payload.signal);
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.1, midPrice: 0.11 }));
    await bus.publish("FillReceived", fillToEvent(fill));
    await bus.drain();
    await module.stop();

    scheduled[0]!.fn();
    await bus.drain();

    expect(signals).toHaveLength(0);
  });

  it("does not schedule ladder buys for non-strategy imported BUY fills", async () => {
    const bus = new InProcessEventBus();
    const fill = makeFill({ price: 0.1, sizeUsdc: 1, signalId: null });
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const module = buildModule({
      bus,
      fillRepo: makeFillRepo([fill]),
      setTimer: (fn, delayMs) => {
        scheduled.push({ fn, delayMs });
        return scheduled.length as never;
      },
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.1, midPrice: 0.11 }));
    await bus.publish("FillReceived", fillToEvent(fill, { signalId: null, signalReason: null }));
    await bus.drain();

    expect(scheduled).toHaveLength(0);

    await module.stop();
  });

  it("allows ladder continuation when totalUsdc is just under perTokenUsdcCap", async () => {
    const bus = new InProcessEventBus();
    const fill = makeFill({ price: 0.1, sizeUsdc: 24 });
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const module = buildModule({
      bus,
      fillRepo: makeFillRepo([fill]),
      policy: () => ({
        ...ENABLED_ENTRY_LIFECYCLE_POLICY,
        multiBuyLadder: {
          ...ENABLED_ENTRY_LIFECYCLE_POLICY.multiBuyLadder,
          perTokenUsdcCap: 25,
        },
      }),
      setTimer: (fn, delayMs) => {
        scheduled.push({ fn, delayMs });
        return scheduled.length as never;
      },
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.1, midPrice: 0.11 }));
    await bus.publish("FillReceived", fillToEvent(fill));
    await bus.drain();

    expect(scheduled).toHaveLength(1);

    await module.stop();
  });

  it("rejects ladder continuation when totalUsdc meets perTokenUsdcCap", async () => {
    const bus = new InProcessEventBus();
    const fill = makeFill({ price: 0.1, sizeUsdc: 26 });
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const module = buildModule({
      bus,
      fillRepo: makeFillRepo([fill]),
      policy: () => ({
        ...ENABLED_ENTRY_LIFECYCLE_POLICY,
        multiBuyLadder: {
          ...ENABLED_ENTRY_LIFECYCLE_POLICY.multiBuyLadder,
          perTokenUsdcCap: 25,
        },
      }),
      setTimer: (fn, delayMs) => {
        scheduled.push({ fn, delayMs });
        return scheduled.length as never;
      },
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.1, midPrice: 0.11 }));
    await bus.publish("FillReceived", fillToEvent(fill));
    await bus.drain();

    expect(scheduled).toHaveLength(0);

    await module.stop();
  });

  it("continues ladder scheduling at 14 fills when max ladder fills is 15", async () => {
    const bus = new InProcessEventBus();
    const fills = Array.from({ length: 14 }, (_, idx) =>
      makeFill({ fillId: createFillId(`fill-${idx}`), price: 0.1, sizeUsdc: 1 }),
    );
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const module = buildModule({
      bus,
      fillRepo: makeFillRepo(fills),
      policy: () => ({
        ...ENABLED_ENTRY_LIFECYCLE_POLICY,
        multiBuyLadder: {
          ...ENABLED_ENTRY_LIFECYCLE_POLICY.multiBuyLadder,
          maxLadderFillsPerToken: 15,
          perTokenUsdcCap: 100,
        },
      }),
      setTimer: (fn, delayMs) => {
        scheduled.push({ fn, delayMs });
        return scheduled.length as never;
      },
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.1, midPrice: 0.11 }));
    await bus.publish("FillReceived", fillToEvent(fills[13]!));
    await bus.drain();

    expect(scheduled).toHaveLength(1);

    await module.stop();
  });

  it("stops ladder scheduling at 15 fills when max ladder fills is 15", async () => {
    const bus = new InProcessEventBus();
    const fills = Array.from({ length: 15 }, (_, idx) =>
      makeFill({ fillId: createFillId(`fill-${idx}`), price: 0.1, sizeUsdc: 1 }),
    );
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const module = buildModule({
      bus,
      fillRepo: makeFillRepo(fills),
      policy: () => ({
        ...ENABLED_ENTRY_LIFECYCLE_POLICY,
        multiBuyLadder: {
          ...ENABLED_ENTRY_LIFECYCLE_POLICY.multiBuyLadder,
          maxLadderFillsPerToken: 15,
          perTokenUsdcCap: 100,
        },
      }),
      setTimer: (fn, delayMs) => {
        scheduled.push({ fn, delayMs });
        return scheduled.length as never;
      },
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.1, midPrice: 0.11 }));
    await bus.publish("FillReceived", fillToEvent(fills[14]!));
    await bus.drain();

    expect(scheduled).toHaveLength(0);

    await module.stop();
  });

  it("stops ladder scheduling when upward price drift reaches five ticks", async () => {
    const bus = new InProcessEventBus();
    const fill = makeFill({ price: 0.1, sizeUsdc: 1 });
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const module = buildModule({
      bus,
      fillRepo: makeFillRepo([fill]),
      setTimer: (fn, delayMs) => {
        scheduled.push({ fn, delayMs });
        return scheduled.length as never;
      },
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.15, midPrice: 0.16, tickSize: 0.01 }));
    await bus.publish("FillReceived", fillToEvent(fill));
    await bus.drain();

    expect(scheduled).toHaveLength(0);

    await module.stop();
  });

  it("stops later ladder steps when price drift reaches five ticks", async () => {
    const bus = new InProcessEventBus();
    const fill = makeFill({ price: 0.1, sizeUsdc: 1 });
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const module = buildModule({
      bus,
      fillRepo: makeFillRepo([fill]),
      setTimer: (fn, delayMs) => {
        scheduled.push({ fn, delayMs });
        return scheduled.length as never;
      },
    });
    let ladderSignal: Signal | null = null;
    bus.subscribe("SignalProduced", async (payload) => {
      ladderSignal = payload.signal;
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.1, midPrice: 0.11, tickSize: 0.01 }));
    await bus.publish("FillReceived", fillToEvent(fill));
    await bus.drain();
    scheduled[0]!.fn();
    await bus.drain();

    expect(ladderSignal).not.toBeNull();
    await bus.publish(
      "FillReceived",
      fillToEvent(
        makeFill({
          fillId: createFillId("ladder-fill-step-1"),
          signalId: ladderSignal!.signalId,
          price: 0.1,
          sizeUsdc: 1,
          filledAt: new Date(2_000).toISOString(),
        }),
      ),
    );
    await bus.drain();

    expect(scheduled).toHaveLength(2);
    await publishMarket(bus, makeMarket({ bestBid: 0.15, midPrice: 0.16, tickSize: 0.01 }));
    scheduled[1]!.fn();
    await bus.drain();

    expect(ladderSignal).not.toBeNull();
    expect(scheduled).toHaveLength(2);

    await module.stop();
  });

  it("records ladder cooldown pause when the bridge skips a ladder signal", async () => {
    const bus = new InProcessEventBus();
    const metrics = { writeLatest: vi.fn(), writeEvent: vi.fn() };
    const fill = makeFill({ price: 0.1, sizeUsdc: 1 });
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const module = buildModule({
      bus,
      fillRepo: makeFillRepo([fill]),
      runtimeMetrics: metrics as never,
      setTimer: (fn, delayMs) => {
        scheduled.push({ fn, delayMs });
        return scheduled.length as never;
      },
    });
    let ladderSignal: Signal | null = null;
    bus.subscribe("SignalProduced", async (payload) => {
      ladderSignal = payload.signal;
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.1, midPrice: 0.11 }));
    await bus.publish("FillReceived", fillToEvent(fill));
    await bus.drain();
    scheduled[0]!.fn();
    await bus.drain();

    expect(ladderSignal).not.toBeNull();
    await bus.publish("SignalConversionSkipped", {
      signal: ladderSignal!,
      stage: "execution-terms",
      reasons: ["same-price-cooldown"],
      diagnostics: { cooldownUntilTsUtc: 121_000 },
      skippedAt: 2_000,
    });
    await bus.drain();

    const latestPayload = vi.mocked(metrics.writeLatest).mock.calls.at(-1)?.[2] as string;
    expect(JSON.parse(latestPayload).ladderCooldownPaused).toBe(1);
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]!.delayMs).toBe(120_000);

    await module.stop();
  });

  it("prunes stale signal-keyed lifecycle state on later activity", async () => {
    const bus = new InProcessEventBus();
    const fill = makeFill({ price: 0.1, sizeUsdc: 1 });
    const order = makeOrder({
      orderId: createOrderId("ord-reprice-gc"),
      signalId: "sig-original",
      price: 0.3,
      sizeUsdc: 0.99,
    });
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const module = buildModule({
      bus,
      orderRepo: makeOrderRepo(order),
      fillRepo: makeFillRepo([fill]),
      setTimer: (fn, delayMs) => {
        scheduled.push({ fn, delayMs });
        return scheduled.length as never;
      },
    });
    let ladderSignalId: string | null = null;
    bus.subscribe("SignalProduced", async (payload) => {
      if (payload.signal.decisionRuleId === "LADDER") ladderSignalId = payload.signal.signalId;
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.1, midPrice: 0.11 }));
    await bus.publish("FillReceived", fillToEvent(fill));
    await bus.drain();
    scheduled[0]!.fn();
    await bus.drain();

    expect(ladderSignalId).not.toBeNull();
    const internals = module as unknown as {
      ladderSignalSteps: Map<string, number>;
      signalStateTouchedAt: Map<string, number>;
    };
    expect(internals.ladderSignalSteps.has(ladderSignalId!)).toBe(true);

    await publishMarket(bus, makeMarket({ bestBid: 0.31, midPrice: 0.32 }));
    await bus.publish("OrderCancelled", {
      commandId: "cmd-gc" as never,
      orderId: order.orderId,
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      reason: "outbid_repriced",
      signalReason: order.signalReason,
      timestamp: 24 * 60 * 60_000 + 10 * 60_000,
    });
    await bus.drain();

    expect(internals.ladderSignalSteps.has(ladderSignalId!)).toBe(false);
    expect(internals.signalStateTouchedAt.has(ladderSignalId!)).toBe(false);

    await module.stop();
  });

  it("clears ladder reset anchors when the market resolves", async () => {
    const bus = new InProcessEventBus();
    const module = buildModule({ bus });
    const internals = module as unknown as {
      ladderResetAnchorByToken: Map<string, number>;
    };

    await module.start();
    await bus.publish("PositionUpdated", {
      position: makePosition({ status: "closed", size: 0 }),
    });
    await bus.drain();

    expect(internals.ladderResetAnchorByToken.has(String(TOKEN))).toBe(true);

    await bus.publish("MarketResolvedHint", {
      conditionId: CONDITION,
      marketId: "market-entry-life",
      slug: "entry-life-market",
      tokenIds: [TOKEN],
      winningTokenId: TOKEN,
      timestamp: 2_000,
    });
    await bus.drain();

    expect(internals.ladderResetAnchorByToken.has(String(TOKEN))).toBe(false);

    await module.stop();
  });

  it("ignores pre-reset fills when a token reopens after being closed", async () => {
    const bus = new InProcessEventBus();
    let now = 10_000;
    const oldFills = [0, 1, 2, 3, 4].map((idx) =>
      makeFill({
        fillId: createFillId(`old-fill-${idx}`),
        price: 0.1,
        sizeUsdc: 1,
        filledAt: new Date(idx * 1_000).toISOString(),
      }),
    );
    const currentFill = makeFill({
      fillId: createFillId("current-fill"),
      price: 0.1,
      sizeUsdc: 1,
      filledAt: new Date(11_000).toISOString(),
    });
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    const module = buildModule({
      bus,
      fillRepo: makeFillRepo([...oldFills, currentFill]),
      now: () => now,
      setTimer: (fn, delayMs) => {
        scheduled.push({ fn, delayMs });
        return scheduled.length as never;
      },
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.1, midPrice: 0.11 }));
    await bus.publish("PositionUpdated", {
      position: makePosition({ status: "closed", size: 0 }),
    });
    await bus.drain();

    now = 11_000;
    await bus.publish("FillReceived", fillToEvent(currentFill));
    await bus.drain();

    expect(scheduled).toHaveLength(1);

    await module.stop();
  });
  it("claims before cancel and emits one fill-aware deterministic capture replacement", async () => {
    const now = 1_000;
    const window = {
      activatedAtUtc: new Date(0).toISOString(),
      expiresAtUtc: new Date(10_000).toISOString(),
      maxCumulativeAcceptedPendingUsdc: 1,
      captureNextR23: true,
    };
    const root = makeOrder({
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
      entryStyle: "maker",
      price: 0.3,
      size: 3,
      sizeUsdc: 0.9,
      createdAt: new Date(0).toISOString(),
      metadata: {
        makerMicroLiveLifecycle: {
          kind: "r23_capture",
          activatedAtUtc: window.activatedAtUtc,
          expiresAtUtc: window.expiresAtUtc,
          fillWaitMs: 7_200_000,
        },
        makerCaptureLineageV1: {
          version: 1,
          rootOrderId: createOrderId("ord-entry-life"),
          predecessorOrderId: null,
          replacementIndex: 0,
          rootNotionalUsdc: 0.9,
        },
        quoteMotionV1: {
          version: 1,
          kind: "r23_capture",
          cohortId: window.activatedAtUtc,
          originalSuggestedPrice: 0.4,
          originalTargetPrice: null,
          entryPriceCeiling: 0.45,
          policySchemaVersion: DEFAULT_EXECUTION_POLICY.version,
          policyControlRevision: 7,
          initialBook: {
            depthStatus: "full",
            bestBid: 0.3,
            bestAsk: 0.36,
            tickSize: 0.01,
            snapshotTs: now,
            source: "test",
          },
        },
      },
    });
    let current = root;
    let intent: MakerCaptureRepriceIntent | null = null;
    const repo = makeOrderRepo(root);
    vi.mocked(repo.findById).mockImplementation(() => current);
    vi.mocked(repo.findOpen).mockImplementation(() =>
      current.status === "open" || current.status === "partially-filled" ? [current] : [],
    );
    repo.getMakerCaptureChainUsage = vi.fn(() => ({
      trusted: true,
      rootOrderId: root.orderId,
      rootNotionalUsdc: 0.9,
      chainFilledUsdc: 0.2,
      predecessorRemainingShares: 2.3,
      replacementIndex: 0,
      orderIds: [root.orderId],
    }));
    repo.claimMakerCaptureRepriceIntent = vi.fn((claimed) => {
      intent = claimed;
      return true;
    });
    repo.findRecoverableMakerCaptureRepriceIntents = vi.fn(() => (intent ? [intent] : []));
    repo.findMakerCaptureRepriceIntentByPredecessor = vi.fn(() => intent);
    repo.findMakerCaptureRepriceIntentBySignal = vi.fn(() => intent);
    repo.markMakerCaptureRepriceReady = vi.fn((_id, price, size) => {
      intent = { ...intent!, status: "ready", candidatePrice: price, replacementSize: size };
      return true;
    });
    const book = {
      tokenId: TOKEN,
      bids: [
        { price: 0.32, size: 10 },
        { price: 0.3, size: 2.3 },
      ],
      asks: [{ price: 0.36, size: 10 }],
      bestBid: 0.32,
      bestAsk: 0.36,
      midPrice: 0.34,
      spread: 0.04,
      minOrderSize: 1,
      timestamp: now,
    };
    const bus = new InProcessEventBus();
    const cancels: RuntimeEventMap["CancelOrderRequested"][] = [];
    const signals: Signal[] = [];
    let downstreamFails = true;
    bus.subscribe("CancelOrderRequested", async (event) => {
      cancels.push(event);
    });
    bus.subscribe("SignalProduced", async () => {
      if (downstreamFails) throw new Error("downstream failed");
    });
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const policy = {
      ...DEFAULT_EXECUTION_POLICY,
      makerEntry: {
        ...DEFAULT_EXECUTION_POLICY.makerEntry,
        mode: "micro_live" as const,
        microLiveWindow: window,
        captureBookReprice: { enabled: true, maxRepricesPerRoot: 5 },
      },
    };
    const module = buildModule({
      bus,
      orderRepo: repo,
      now: () => now,
      policy: () => policy,
      policySnapshot: () => ({ policy, controlRevision: 7 }),
      candidateBookCache: {
        prime: vi.fn().mockResolvedValue(
          new Map([
            [
              String(TOKEN),
              {
                tokenId: String(TOKEN),
                snapshotTs: now,
                cachedAtMs: now,
                sourcePolledAtMs: now,
                bookSource: "clob",
                sourceKind: "rest",
                book,
              },
            ],
          ]),
        ),
      },
    });

    await module.start();
    await publishMarket(bus, makeMarket({ bestBid: 0.31 }));
    expect(cancels[0]?.command.commandId).toBe(
      buildMakerCaptureRepriceIdentity(root.orderId, root.orderId, 1).cancelCommandId,
    );
    current = { ...root, status: "cancelled" };
    await bus.publish("OrderCancelled", {
      commandId: cancels[0]!.command.commandId,
      orderId: root.orderId,
      tokenId: TOKEN,
      conditionId: CONDITION,
      reason: "maker_capture_reprice",
      signalReason: "probe-entry",
      timestamp: now,
    });
    await bus.drain();

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      suggestedPrice: 0.33,
      makerCaptureReprice: { replacementIndex: 1 },
    });
    expect(signals[0]!.suggestedSize).toBeCloseTo(0.7 / 0.33);
    downstreamFails = false;
    await publishMarket(bus, makeMarket({ bestBid: 0.32 }));
    expect(signals.map((signal) => signal.signalId)).toEqual([
      intent!.lifecycleSignalId,
      intent!.lifecycleSignalId,
    ]);
    intent = null;
    current = { ...root, price: 0.4 };
    vi.mocked(repo.claimMakerCaptureRepriceIntent!).mockClear();
    cancels.length = 0;
    await publishMarket(bus, makeMarket({ bestBid: 0.41, bestAsk: 0.43 }));
    expect(repo.claimMakerCaptureRepriceIntent).not.toHaveBeenCalled();
    expect(cancels).toEqual([]);
    await module.stop();
  });

  it("fails a submitted intent whose deterministic child row is missing at restart", async () => {
    const root = makeOrder();
    const intent: MakerCaptureRepriceIntent = {
      intentId: "intent-missing-child",
      predecessorOrderId: root.orderId,
      lifecycleSignalId: "signal-missing-child",
      rootOrderId: root.orderId,
      tokenId: TOKEN,
      conditionId: CONDITION,
      replacementIndex: 1,
      status: "submitted",
      candidatePrice: 0.31,
      replacementSize: 2,
      childOrderId: createOrderId("missing-child"),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      failure: null,
    };
    const repo = makeOrderRepo(root);
    vi.mocked(repo.findById).mockImplementation((id) => (id === root.orderId ? root : null));
    repo.findRecoverableMakerCaptureRepriceIntents = vi.fn(() => [intent]);
    repo.markMakerCaptureRepriceTerminal = vi.fn(() => true);

    const module = buildModule({ orderRepo: repo });
    await module.start();

    expect(repo.markMakerCaptureRepriceTerminal).toHaveBeenCalledWith(
      intent.intentId,
      "failed",
      "submitted-child-missing",
    );
    await module.stop();
  });

  it("fails a disabled recoverable capture intent without re-cancelling", async () => {
    const predecessor = makeOrder();
    const identity = buildMakerCaptureRepriceIdentity(predecessor.orderId, predecessor.orderId, 1);
    const intent: MakerCaptureRepriceIntent = {
      ...identity,
      predecessorOrderId: predecessor.orderId,
      rootOrderId: predecessor.orderId,
      tokenId: TOKEN,
      conditionId: CONDITION,
      replacementIndex: 1,
      status: "cancel_pending",
      candidatePrice: null,
      replacementSize: null,
      childOrderId: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      failure: null,
    };
    const repo = makeOrderRepo(predecessor);
    repo.findRecoverableMakerCaptureRepriceIntents = vi.fn(() => [intent]);
    repo.markMakerCaptureRepriceTerminal = vi.fn(() => true);
    const bus = new InProcessEventBus();
    const cancels = vi.fn();
    bus.subscribe("CancelOrderRequested", cancels);
    const module = buildModule({
      bus,
      orderRepo: repo,
      policySnapshot: () => ({ policy: DEFAULT_EXECUTION_POLICY, controlRevision: 7 }),
    });
    await module.start();
    expect(cancels).not.toHaveBeenCalled();
    expect(repo.markMakerCaptureRepriceTerminal).toHaveBeenCalledWith(
      intent.intentId,
      "failed",
      "policy-or-lineage-drift",
    );
    await module.stop();
  });

  it("adopts a ready intent's deterministically identified child after restart", async () => {
    const root = makeOrder();
    const child = makeOrder({ orderId: createOrderId("recovered-child"), status: "open" });
    const intent: MakerCaptureRepriceIntent = {
      intentId: "ready-intent",
      predecessorOrderId: root.orderId,
      lifecycleSignalId: "ready-signal",
      rootOrderId: root.orderId,
      tokenId: TOKEN,
      conditionId: CONDITION,
      replacementIndex: 1,
      status: "ready",
      candidatePrice: 0.31,
      replacementSize: 2,
      childOrderId: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      failure: null,
    };
    const repo = makeOrderRepo(root);
    repo.findRecoverableMakerCaptureRepriceIntents = vi.fn(() => [intent]);
    vi.mocked(repo.findByClientOrderId).mockReturnValue(child);
    repo.markMakerCaptureRepriceSubmitted = vi.fn(() => true);
    repo.markMakerCaptureRepriceTerminal = vi.fn(() => true);

    const module = buildModule({ orderRepo: repo });
    await module.start();

    expect(repo.markMakerCaptureRepriceSubmitted).toHaveBeenCalledWith(
      intent.intentId,
      child.orderId,
    );
    expect(repo.markMakerCaptureRepriceTerminal).toHaveBeenCalledWith(intent.intentId, "completed");
    await module.stop();
  });
});

function buildModule(
  overrides: Partial<ConstructorParameters<typeof EntryLifecycleModule>[0]> = {},
): EntryLifecycleModule {
  return new EntryLifecycleModule({
    bus: new InProcessEventBus(),
    orderRepo: makeOrderRepo(null),
    positionRepo: { findByTokenId: vi.fn(() => null) },
    fillRepo: makeFillRepo([]),
    legStateRepo: makeLegStateRepo(),
    algoRulesRepo: makeRulesRepo(),
    policy: () => ENABLED_ENTRY_LIFECYCLE_POLICY,
    log: makeLog(),
    now: () => 1_000,
    ...overrides,
  });
}

function makeOrderRepo(order: Order | null): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn(() => order),
    findByClientOrderId: vi.fn(() => null),
    findByExchangeOrderId: vi.fn(() => null),
    findOpen: vi.fn(() => (order ? [order] : [])),
    findByTokenId: vi.fn(() => []),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn(() => 0),
  };
}

function makeFillRepo(fills: Fill[]): {
  findByOrderId(orderId: (typeof fills)[number]["orderId"]): Fill[];
  findByTokenId(tokenId: typeof TOKEN): Fill[];
} {
  return {
    findByOrderId: vi.fn((orderId) => fills.filter((fill) => fill.orderId === orderId)),
    findByTokenId: vi.fn(() => fills),
  };
}

function makeLegStateRepo(): LegStateRepository {
  return {
    get: vi.fn(() => ({
      tokenId: TOKEN,
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY" as const,
      firstTradePrice: 0.1,
      firstTradeAt: new Date(0).toISOString(),
      lastTradeAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    })),
    upsert: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn(() => []),
    incrementSellResidualReject: vi.fn(() => ({ count: 0, markedAbandoned: false })),
    markAbandoned: vi.fn(),
    resetAbandoned: vi.fn(),
    applyRepriceChainEvent: vi.fn(),
  };
}

function makeRulesRepo(): AlgoRulesRepository {
  return {
    getDecisionRules: vi.fn(() => []),
    getSizeRules: vi.fn(() => [
      {
        id: 99,
        actionType: "BUY",
        priority: 99,
        ruleId: "FALLBACK-BUY",
        stateCondition: "ANY",
        priceOperator: null,
        priceValue: null,
        nthBuy: null,
        buyCountMin: null,
        buyCountMax: null,
        sizeUsdc: 0.99,
      },
    ]),
  };
}

function freshEdgeAttribution() {
  return {
    version: 1 as const,
    originSignalId: "sig-r23-origin",
    originDecisionRuleId: "R23_DIP_TRIGGER" as const,
    entryKind: "first_entry" as const,
    shadowClass: "FALLING_WITHOUT_RECOVERY" as const,
  };
}

async function publishOutbidCancel(bus: InProcessEventBus, order: Order): Promise<void> {
  await bus.publish("OrderCancelled", {
    commandId: "cmd-outbid" as never,
    orderId: order.orderId,
    tokenId: order.tokenId,
    conditionId: order.conditionId,
    reason: "outbid_repriced",
    signalReason: order.signalReason,
    timestamp: 1_000,
  });
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId: createOrderId("ord-entry-life"),
    clientOrderId: "client-entry-life" as ClientOrderId,
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "buy",
    orderType: "GTC",
    postOnly: true,
    price: 0.3,
    size: 3,
    sizeUsdc: 0.99,
    status: "open",
    exchangeOrderId: "exchange-entry-life",
    signalId: "sig-entry-life",
    signalReason: "confirm-scale",
    botRunId: createBotRunId("run-entry-life"),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeFill(overrides: Partial<Fill> = {}): Fill {
  return {
    fillId: createFillId("fill-entry-life"),
    orderId: createOrderId("ord-entry-life"),
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "buy",
    price: 0.1,
    size: 10,
    sizeUsdc: 1,
    liquidityRole: "maker",
    fee: 0,
    feeRateBps: 0,
    signalId: "sig-fill",
    decisionRuleId: "FALLBACK",
    signalTimestamp: new Date(0).toISOString(),
    filledAt: new Date(1_000).toISOString(),
    ...overrides,
  };
}

function fillToEvent(
  fill: Fill,
  overrides: Partial<RuntimeEventMap["FillReceived"]> = {},
): RuntimeEventMap["FillReceived"] {
  return {
    fillId: fill.fillId,
    orderId: fill.orderId,
    clientOrderId: "client-entry-life" as ClientOrderId,
    tokenId: fill.tokenId,
    conditionId: fill.conditionId,
    side: fill.side,
    price: fill.price,
    size: fill.size,
    sizeUsdc: fill.sizeUsdc,
    liquidityRole: fill.liquidityRole,
    fee: fill.fee,
    feeRateBps: fill.feeRateBps,
    signalReason: "confirm-scale",
    signalId: fill.signalId ?? null,
    decisionRuleId: fill.decisionRuleId ?? null,
    signalTimestamp: fill.signalTimestamp ?? null,
    timestamp: Date.parse(fill.filledAt),
    ...overrides,
  };
}

function makePosition(
  overrides: Partial<RuntimeEventMap["PositionUpdated"]["position"]> = {},
): RuntimeEventMap["PositionUpdated"]["position"] {
  return {
    positionId: createPositionId("pos-entry-life"),
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "buy",
    size: 10,
    avgEntryPrice: 0.1,
    costBasisUsdc: 1,
    currentValueUsdc: 1,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: new Date(0).toISOString(),
    closedAt: null,
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

async function publishMarket(bus: InProcessEventBus, market: NormalizedMarket): Promise<void> {
  await bus.publish("NormalizedMarketUpdated", { markets: [market], timestamp: 1_000 });
  await bus.drain();
}

function makeMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId: TOKEN,
    conditionId: CONDITION,
    slug: "entry-life-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Entry lifecycle?",
    outcome: "Yes",
    outcomeIndex: 0,
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.1,
    bestAsk: 0.12,
    midPrice: 0.11,
    spread: 0.02,
    gammaCreatedAt: null,
    snapshotTs: 1_000,
    ...overrides,
  };
}

function makeLog(): Logger {
  const log = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  log.child.mockReturnValue(log);
  return log as unknown as Logger;
}
