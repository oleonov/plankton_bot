import { describe, expect, it, vi } from "vitest";
import {
  OrderSide,
  SignalReason,
  createConditionId,
  createTokenId,
  type NormalizedMarket,
  type RiskEventRepository,
  type Signal,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import type { Logger } from "../../../logger.js";
import { DEAD_MARKET_COMPONENT_KEYS } from "../dead-market-score.js";
import {
  DEAD_MARKET_SHADOW_RISK_EVENT_TYPE,
  DeadMarketShadowModule,
} from "../dead-market-shadow-module.js";

const NOW = Date.parse("2026-06-20T12:00:00.000Z");

const silentLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => silentLog,
} as unknown as Logger;

interface MetricCall {
  name: string;
  value: number;
  labels: Record<string, unknown> | null;
}

function makeMetrics() {
  const calls: MetricCall[] = [];
  return {
    calls,
    writeCounter(name: string, value = 1, labels: string | null = null): void {
      calls.push({ name, value, labels: labels == null ? null : JSON.parse(labels) });
    },
  };
}

interface RiskEventStub extends RiskEventRepository {
  inserts: Array<{ eventType: string; payload: Record<string, unknown> }>;
}

function makeRiskEvents(): RiskEventStub {
  const inserts: RiskEventStub["inserts"] = [];
  return {
    inserts,
    insert(event) {
      inserts.push(event);
    },
    countSince() {
      return 0;
    },
  };
}

function makeMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId: createTokenId("tok-dead-1"),
    conditionId: "cond-dead-1",
    slug: "dead-market-slug",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Will the dead market resolve?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.01,
    bestAsk: 0.02,
    midPrice: 0.015,
    spread: 0.01,
    liquidity: 500,
    gammaCreatedAt: "2026-06-01T00:00:00.000Z",
    snapshotTs: NOW,
    ...overrides,
  };
}

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    signalId: "sig-dead-1",
    tokenId: createTokenId("tok-dead-1"),
    conditionId: createConditionId("cond-dead-1"),
    side: OrderSide.Buy,
    suggestedPrice: 0.5,
    suggestedSize: 10,
    suggestedSizeUsdc: 5,
    reason: SignalReason.ProbeEntry,
    strategyTick: NOW,
    sequenceInTick: 0,
    decisionRuleId: "D1",
    sizingRuleId: "B1",
    generatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

interface Harness {
  bus: InProcessEventBus;
  metrics: ReturnType<typeof makeMetrics>;
  riskEvents: RiskEventStub;
  published: { placeOrder: number; approved: number; rejected: number };
  start: () => Promise<void>;
  stop: () => Promise<void>;
  emit: (signal: Signal, market: NormalizedMarket) => Promise<void>;
}

function makeHarness(opts: { cooldownMs?: number } = {}): Harness {
  const bus = new InProcessEventBus();
  const metrics = makeMetrics();
  const riskEvents = makeRiskEvents();
  const published = { placeOrder: 0, approved: 0, rejected: 0 };
  bus.subscribe("PlaceOrderRequested", async () => {
    published.placeOrder += 1;
  });
  bus.subscribe("SignalApproved", async () => {
    published.approved += 1;
  });
  bus.subscribe("SignalRejected", async () => {
    published.rejected += 1;
  });
  const module = new DeadMarketShadowModule({
    bus,
    log: silentLog,
    metrics,
    riskEventRepo: riskEvents,
    now: () => NOW,
    ...(opts.cooldownMs !== undefined ? { riskEventCooldownMs: opts.cooldownMs } : {}),
  });
  return {
    bus,
    metrics,
    riskEvents,
    published,
    start: () => module.start(),
    stop: () => module.stop(),
    emit: (signal, market) => bus.publish("SignalProduced", { signal, market }),
  };
}

const labelsOf = (calls: MetricCall[], name: string): Array<Record<string, unknown> | null> =>
  calls.filter((c) => c.name === name).map((c) => c.labels);

describe("DeadMarketShadowModule", () => {
  it("evaluates an entry BUY candidate and emits shadow metrics without publishing trading events", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(
      makeSignal({ decisionRuleId: "R23_DIP_TRIGGER", suggestedPrice: 0.01 }),
      makeMarket({ liquidity: 50 }),
    );

    const evaluated = labelsOf(h.metrics.calls, "dead_market_shadow_evaluated_total");
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]).toMatchObject({
      decisionType: "entry",
      sourceGroup: "r23",
      classification: "block_candidate",
      scoreBucket: "3",
      scoreVersion: "dead_market_v1",
      featureSet: "live_3of6",
    });
    // The module is a pure observer: it must never drive the trading pipeline.
    expect(h.published).toEqual({ placeOrder: 0, approved: 0, rejected: 0 });

    await h.stop();
  });

  it("evaluates an add/scale-in BUY candidate as decisionType=add without blocking", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(
      makeSignal({ decisionRuleId: "EXECUTION_PROFILE_SCALE_IN", reason: SignalReason.ScaleIn }),
      makeMarket(),
    );

    const evaluated = labelsOf(h.metrics.calls, "dead_market_shadow_evaluated_total");
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]).toMatchObject({ decisionType: "add", sourceGroup: "scale_in" });
    expect(h.published).toEqual({ placeOrder: 0, approved: 0, rejected: 0 });

    await h.stop();
  });

  // decisionType is an entry/add semantic that must come from signal.reason, not
  // from the sourceGroup label. A D3/FALLBACK rule firing a scale reason is an
  // ADD, even though its source group historically labelled it an "entry".
  it("classifies a D3 scale-in as decisionType=add while keeping sourceGroup=d1_d3", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(
      makeSignal({ decisionRuleId: "D3", reason: SignalReason.ScaleIn }),
      makeMarket(),
    );

    const evaluated = labelsOf(h.metrics.calls, "dead_market_shadow_evaluated_total");
    expect(evaluated[0]).toMatchObject({ decisionType: "add", sourceGroup: "d1_d3" });

    await h.stop();
  });

  it("classifies a FALLBACK confirm-scale as decisionType=add while keeping sourceGroup=fallback", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(
      makeSignal({ decisionRuleId: "FALLBACK", reason: SignalReason.ConfirmScale }),
      makeMarket(),
    );

    const evaluated = labelsOf(h.metrics.calls, "dead_market_shadow_evaluated_total");
    expect(evaluated[0]).toMatchObject({ decisionType: "add", sourceGroup: "fallback" });

    await h.stop();
  });

  it("classifies a heavy-scale on a D1 source as decisionType=add", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(
      makeSignal({ decisionRuleId: "D1", reason: SignalReason.HeavyScale }),
      makeMarket(),
    );

    const evaluated = labelsOf(h.metrics.calls, "dead_market_shadow_evaluated_total");
    expect(evaluated[0]).toMatchObject({ decisionType: "add", sourceGroup: "d1_d3" });

    await h.stop();
  });

  it("classifies a probe-entry as decisionType=entry regardless of source group", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(
      makeSignal({ decisionRuleId: "D3", reason: SignalReason.ProbeEntry }),
      makeMarket(),
    );

    const evaluated = labelsOf(h.metrics.calls, "dead_market_shadow_evaluated_total");
    expect(evaluated[0]).toMatchObject({ decisionType: "entry", sourceGroup: "d1_d3" });

    await h.stop();
  });

  it("classifies a nonstandard reason (operator) as decisionType=unknown", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(
      makeSignal({ decisionRuleId: "D3", reason: SignalReason.Operator }),
      makeMarket(),
    );

    const evaluated = labelsOf(h.metrics.calls, "dead_market_shadow_evaluated_total");
    expect(evaluated[0]).toMatchObject({ decisionType: "unknown", sourceGroup: "d1_d3" });

    await h.stop();
  });

  it("stamps the score-bucket counter with the same scoreVersion/featureSet as evaluated", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(
      makeSignal({ decisionRuleId: "R23_DIP_TRIGGER", suggestedPrice: 0.01 }),
      makeMarket({ liquidity: 50 }),
    );

    const bucket = labelsOf(h.metrics.calls, "dead_market_shadow_score_bucket_total");
    expect(bucket).toHaveLength(1);
    expect(bucket[0]).toMatchObject({
      decisionType: "entry",
      scoreBucket: "3",
      scoreVersion: "dead_market_v1",
      featureSet: "live_3of6",
    });

    await h.stop();
  });

  it("ignores SELL signals entirely", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(makeSignal({ side: OrderSide.Sell }), makeMarket());

    expect(h.metrics.calls).toHaveLength(0);
    expect(h.riskEvents.inserts).toHaveLength(0);

    await h.stop();
  });

  it("emits a missing-component counter for every live-unavailable feature", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(makeSignal(), makeMarket());

    const missing = labelsOf(h.metrics.calls, "dead_market_shadow_missing_component_total")
      .map((l) => l?.component)
      .filter(Boolean);
    expect(missing).toContain("planktonNotActive24h");
    expect(missing).toContain("planktonNeverTouched");
    expect(missing).toContain("observerDead");

    await h.stop();
  });

  it("records a sampled risk event for a downweight/block candidate with full payload", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(
      makeSignal({ decisionRuleId: "R23_DIP_TRIGGER", suggestedPrice: 0.01 }),
      makeMarket({ liquidity: 50, question: "Dead?" }),
    );

    expect(h.riskEvents.inserts).toHaveLength(1);
    const event = h.riskEvents.inserts[0];
    if (!event) throw new Error("expected one sampled risk event");
    expect(event.eventType).toBe(DEAD_MARKET_SHADOW_RISK_EVENT_TYPE);
    expect(event.payload).toMatchObject({
      tokenId: "tok-dead-1",
      conditionId: "cond-dead-1",
      marketTitle: "Dead?",
      price: 0.01,
      score: 3,
      classification: "shadow_block_candidate",
    });
    expect(event.payload.components).toBeDefined();

    await h.stop();
  });

  it("does not record a risk event for a shadow_allow candidate (metrics only)", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(makeSignal({ suggestedPrice: 0.5 }), makeMarket({ liquidity: 500 }));

    expect(h.riskEvents.inserts).toHaveLength(0);
    expect(labelsOf(h.metrics.calls, "dead_market_shadow_evaluated_total")).toHaveLength(1);

    await h.stop();
  });

  it("rate-limits duplicate risk events by token+bucket+classification but still counts metrics", async () => {
    const h = makeHarness({ cooldownMs: 600_000 });
    await h.start();

    const signal = makeSignal({ decisionRuleId: "R23_DIP_TRIGGER", suggestedPrice: 0.01 });
    const market = makeMarket({ liquidity: 50 });
    await h.emit(signal, market);
    await h.emit(signal, market);

    expect(h.riskEvents.inserts).toHaveLength(1);
    expect(labelsOf(h.metrics.calls, "dead_market_shadow_evaluated_total")).toHaveLength(2);

    await h.stop();
  });

  it("only ever emits bounded, low-cardinality metric labels", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(
      makeSignal({ decisionRuleId: "R23_DIP_TRIGGER", suggestedPrice: 0.01 }),
      makeMarket({ liquidity: 50 }),
    );

    const allowedValues: Record<string, ReadonlySet<string | boolean>> = {
      decisionType: new Set(["entry", "add", "unknown"]),
      classification: new Set([
        "allow",
        "downweight_candidate",
        "block_candidate",
        "hard_block_candidate",
      ]),
      scoreBucket: new Set(["0", "1", "2", "3", "4", "5", "6", "unknown"]),
      sourceGroup: new Set(["r23", "fallback", "scale_in", "ladder", "d1_d3", "other", "unknown"]),
      component: new Set(DEAD_MARKET_COMPONENT_KEYS),
      present: new Set([true, false]),
      available: new Set([true, false]),
      scoreVersion: new Set(["dead_market_v1"]),
      featureSet: new Set(["live_3of6"]),
    };

    for (const call of h.metrics.calls) {
      if (call.labels === null) continue;
      for (const [key, value] of Object.entries(call.labels)) {
        const domain = allowedValues[key];
        if (!domain) throw new Error(`unexpected label key "${key}" on ${call.name}`);
        expect(
          domain.has(value as string | boolean),
          `unbounded label value ${JSON.stringify(value)} for "${key}" on ${call.name}`,
        ).toBe(true);
      }
    }

    await h.stop();
  });

  it("emits the BBO-availability counter (available=true) and never the old depth metric", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(makeSignal(), makeMarket({ bestBid: 0.01, bestAsk: 0.02 }));

    const bbo = labelsOf(h.metrics.calls, "dead_market_shadow_bbo_available_total");
    expect(bbo).toEqual([{ available: true }]);
    expect(labelsOf(h.metrics.calls, "dead_market_shadow_depth_available_total")).toHaveLength(0);

    await h.stop();
  });

  it("reports BBO unavailable when either side of the book is missing", async () => {
    const h = makeHarness();
    await h.start();

    await h.emit(makeSignal(), makeMarket({ bestBid: null }));

    const bbo = labelsOf(h.metrics.calls, "dead_market_shadow_bbo_available_total");
    expect(bbo).toEqual([{ available: false }]);

    await h.stop();
  });

  it("stops cleanly and no longer reacts to signals after stop()", async () => {
    const h = makeHarness();
    await h.start();
    await h.stop();

    await h.emit(makeSignal(), makeMarket());

    expect(h.metrics.calls).toHaveLength(0);
  });
});
