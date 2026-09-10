import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTokenId, DEFAULT_EXECUTION_POLICY, type Market } from "@krabs/domain";
import { EntryFollowupObserver, type EntryFollowupEvaluation } from "../entry-followup-observer.js";
import { RuntimeMetricWriter } from "../runtime-metric-writer.js";

const START = Date.parse("2026-09-10T00:00:00.000Z");
let dir: string;
let dbPath: string;
let seed: Database.Database;
let now: number;
let whitelist: string[];

function market(tokenId: string, conditionId = `condition-${tokenId}`): Market {
  return {
    tokenId: createTokenId(tokenId),
    conditionId,
    outcome: tokenId.endsWith("no") ? "NO" : "YES",
    outcomeIndex: tokenId.endsWith("no") ? 1 : 0,
    active: true,
    tradable: true,
  } as Market;
}

function tier(discovery: Market[], capacity = discovery.length) {
  return {
    executionCritical: [],
    planktonSignature: [],
    entryCandidates: [],
    discoveryOnly: discovery,
    discoveryCapacityCount: capacity,
    signatureOverflow: 0,
  };
}

function observer(): EntryFollowupObserver {
  return new EntryFollowupObserver({
    dbPath,
    now: () => now,
    policy: () => ({
      ...DEFAULT_EXECUTION_POLICY,
      gateEntry: {
        ...DEFAULT_EXECUTION_POLICY.gateEntry,
        enabled: true,
        mode: "micro_live",
        whitelistConditionIds: whitelist,
      },
    }),
  });
}

function snapshot(subject: EntryFollowupObserver) {
  return subject.snapshot() as {
    discoveryActive: Array<Record<string, unknown>>;
    discoveryCompleted: Array<Record<string, unknown>>;
    gate: Array<Record<string, unknown>>;
    transitions: EntryFollowupEvaluation[];
    amendments: Array<Record<string, unknown>>;
    coverage: Record<string, unknown>;
    durableBucketNumber: number | null;
  };
}

function stored(name: string) {
  const row = seed
    .prepare("SELECT labels FROM runtime_metrics WHERE metric_name = ?")
    .get(name) as { labels: string };
  return JSON.parse(row.labels);
}

function seedGate() {
  seed.prepare("INSERT INTO markets VALUES (?,?,?,?,?,?)").run("gate", "condition", "YES", 0, 1, 1);
  whitelist = ["condition"];
  return createTokenId("gate");
}

function budgetTransition(
  subject: EntryFollowupObserver,
  token: ReturnType<typeof createTokenId>,
  result: "true" | "false",
  at: number,
  cause?: "minimum_change" | "retry",
): void {
  if (cause) subject.markCause(token, cause);
  const pass = subject.capturePass([token]);
  subject.observeVisit(pass, token, at);
  subject.observeEvaluation(token, "planner_result", {
    type: "signal",
    side: "buy",
    candidateNotionalUsdc: 2,
  });
  subject.observePreflight(token, result, result === "false" ? "wallet" : null, 0, at);
  subject.observeEvaluation(token, "postplanner_guard", {
    guardReason: result === "true" ? "publish_attempted" : "buy_budget",
  });
  subject.finishPass(pass, "completed");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "entry-followup-"));
  dbPath = join(dir, "ledger.db");
  seed = new Database(dbPath);
  seed.pragma("journal_mode = WAL");
  seed.exec(`
    CREATE TABLE runtime_metrics (
      id INTEGER PRIMARY KEY, metric_name TEXT NOT NULL, value REAL NOT NULL,
      labels TEXT, captured_at TEXT NOT NULL
    );
    CREATE TABLE markets (
      token_id TEXT PRIMARY KEY, condition_id TEXT NOT NULL, outcome TEXT NOT NULL,
      outcome_index INTEGER, active INTEGER NOT NULL, tradable INTEGER NOT NULL
    );
    CREATE TABLE leg_states (token_id TEXT PRIMARY KEY);
    CREATE TABLE positions (token_id TEXT, status TEXT);
  `);
  now = START;
  whitelist = [];
});

afterEach(() => {
  if (seed.open) seed.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("EntryFollowupObserver discovery", () => {
  it.each([false, true])(
    "attributes a departed request's later visit and downstream failure after sealing (reentry=%s)",
    (reentry) => {
      const subject = observer();
      const a = market("late");
      subject.observeDiscoveryTier(tier([a]), now);
      const request = subject.beginDiscoveryRequest([a], now);
      subject.completeDiscoveryRequest(request, new Map([["late", "returned"]]), now);
      subject.observeDiscoveryTier(tier([]), ++now);
      now += 6 * 60_000;
      subject.flush();
      if (reentry) subject.observeDiscoveryTier(tier([a]), now);
      subject.markCause(a.tokenId, "market_update");
      const pass = subject.capturePass([a.tokenId]);
      subject.observeVisit(pass, a.tokenId, now);
      subject.observeEvaluation(a.tokenId, "not_selected", {});
      subject.finishPass(pass, "completed");
      subject.observeDiscoveryDownstreamFailure(request, ++now);
      const state = snapshot(subject);
      expect(state.amendments).toEqual([
        expect.objectContaining({
          generation: 1,
          requestId: request,
          result: "first_algo",
          firstAlgo: expect.objectContaining({ preplanner: "not_selected", observedAt: now - 1 }),
        }),
        expect.objectContaining({ generation: 1, requestId: request, result: "downstream_failed" }),
      ]);
      if (reentry) {
        expect(state.discoveryActive[0]).toMatchObject({ generation: 2 });
        expect(state.discoveryActive[0]!.firstAlgo).toBeUndefined();
      } else expect(state.discoveryActive).toEqual([]);
      subject.stop();
    },
  );

  it("retains sampled generations through reorder and attributes requests, departures and reentry", () => {
    const subject = observer();
    const a = market("a");
    const b = market("b");
    const c = market("c");
    subject.observeDiscoveryTier(tier([a, b, c]), now);
    now += 30.2 * 60_000;
    expect(snapshot(subject).discoveryActive[0]!.lastFreshConfirmedAt).toBe(START);

    subject.observeDiscoveryTier(tier([c, b, a]), now);
    const request = subject.beginDiscoveryRequest([a, b], now + 1);
    const overlap = subject.beginDiscoveryRequest([a], now + 2);
    subject.completeDiscoveryRequest(overlap, "request_failed", now + 3);
    subject.observeDiscoveryTier({ ...tier([b, c], 1), entryCandidates: [a] }, now + 4);
    subject.completeDiscoveryRequest(
      request,
      new Map([
        ["a", "returned" as const],
        ["b", "missing" as const],
      ]),
      now + 5,
    );

    const departed = snapshot(subject).discoveryCompleted.find((row) => row.tokenId === "a")!;
    expect(departed).toMatchObject({ generation: 1, censorReason: "ws_promotion" });
    expect(departed.response).toMatchObject({ result: "returned", observedAt: now + 5 });

    subject.observeDiscoveryTier(tier([a, b]), now + 6);
    expect(snapshot(subject).discoveryActive.find((row) => row.tokenId === "a")).toMatchObject({
      generation: 4,
      sampleMethod: "evenly_spaced_stable_50",
      denominator: 2,
    });
    subject.stop();
  });

  it("seals by event time and records a late response as an amendment", () => {
    const subject = observer();
    const a = market("late-a");
    subject.observeDiscoveryTier(tier([a]), now);
    const request = subject.beginDiscoveryRequest([a], now + 1);
    subject.observeDiscoveryTier(tier([]), now + 2);
    now += 6 * 60_000;
    subject.flush(now);
    subject.completeDiscoveryRequest(request, "request_failed", now + 1);
    expect(snapshot(subject).amendments).toEqual([
      expect.objectContaining({ tokenId: "late-a", generation: 1, result: "request_failed" }),
    ]);
    const expired = market("expired");
    subject.observeDiscoveryTier(tier([expired]), now + 2);
    const expiredRequest = subject.beginDiscoveryRequest([expired], now + 3);
    subject.observeDiscoveryTier(tier([]), now + 4);
    now += 72 * 60 * 60_000 + 5 * 60_000;
    subject.completeDiscoveryRequest(expiredRequest, "request_failed", now);
    expect(snapshot(subject).coverage.lateExpired).toBe(1);
    subject.stop();
  });
});

describe("EntryFollowupObserver GATE and evaluation journal", () => {
  it.each([false, true])(
    "retains an in-flight captured generation until completion (visit after departure=%s)",
    async (visitAfterDeparture) => {
      const token = seedGate();
      const subject = observer();
      subject.markCause(token, "market_update");
      const pass = subject.capturePass([token]);
      expect(pass).toBeGreaterThan(0);
      if (!visitAfterDeparture) subject.observeVisit(pass, token, now);
      let release!: () => void;
      const planning = new Promise<void>((resolve) => {
        release = resolve;
      });
      const outcome = (async () => {
        await planning;
        subject.observeEvaluation(token, "planner_result", { type: "hold", reasons: [] });
      })();
      subject.markCause(token, "minimum_change");
      whitelist = [];
      subject.flush();
      if (visitAfterDeparture) subject.observeVisit(pass, token, now);
      subject.markCause(token, "lifecycle");
      subject.flush();
      expect(subject["pendingCauses"].has(token)).toBe(false);
      expect(subject.capturePass([token])).toBe(0);
      expect(subject["latestEvaluations"].get(token)).toMatchObject({
        cohortGeneration: 1,
        causeMask: 1,
      });
      release();
      await outcome;
      subject.finishPass(pass, "completed");
      expect(subject["latestEvaluations"].has(token)).toBe(false);
      expect(snapshot(subject).transitions).toEqual([
        expect.objectContaining({ cohortGeneration: 1, plannerOutcome: "hold", causeMask: 1 }),
      ]);
      whitelist = ["condition"];
      budgetTransition(subject, token, "true", ++now, "retry");
      expect(snapshot(subject).transitions.map((row) => row.cohortGeneration)).toEqual([1, 2]);
      expect(snapshot(subject).gate[0]).toMatchObject({ cohortGeneration: 2 });

      subject.observeVisit(0, token, ++now);
      whitelist = [];
      subject.flush();
      expect(subject["latestEvaluations"].has(token)).toBe(false);
      whitelist = ["condition"];
      subject.observeVisit(0, token, ++now);
      subject.markCause(token, "retry");
      const unvisited = subject.capturePass([token]);
      expect(unvisited).toBeGreaterThan(0);
      whitelist = [];
      subject.flush();
      expect(subject["latestEvaluations"].has(token)).toBe(false);
      subject.finishPass(unvisited, "completed");
      subject.stop();
    },
  );

  it("ignores non-visits and observes policy departure/reentry between flushes", () => {
    const token = seedGate();
    const subject = observer();
    budgetTransition(subject, token, "false", now);
    subject.observeEvaluation(token, "overlap", {});
    subject.observeEvaluation(token, "paused", {});
    expect(snapshot(subject).transitions).toHaveLength(1);
    expect(snapshot(subject).transitions[0]!.repeats).toBe(1);
    whitelist = [];
    subject.markCause(token, "lifecycle");
    whitelist = ["condition"];
    budgetTransition(subject, token, "false", ++now, "retry");
    const journal = snapshot(subject).transitions;
    expect(journal.map((row) => row.cohortGeneration)).toEqual([1, 2]);
    expect(journal.map((row) => row.repeats)).toEqual([1, 1]);
    subject.stop();
  });

  it("keeps raw budget evidence and historical cooldown distinct from current passive state", () => {
    const token = seedGate();
    const subject = observer();
    let cooldown = now + 60_000;
    subject.setGateStateReader((ids) =>
      ids.map((id) => ({
        tokenId: id,
        selected: true,
        bypass: false,
        marketCache: "missing",
        marketFreshAt: null,
        leg: "unknown",
        position: "unknown",
        minimum: { remembered: null, observedAt: null, result: null },
        cooldownUntilMs: cooldown,
        cooldownElapsed: now >= cooldown,
      })),
    );
    subject.observeVisit(0, token, now);
    subject.observeEvaluation(token, "planner_result", {
      type: "signal",
      side: "buy",
      candidateNotionalUsdc: 2,
    });
    subject.observePreflight(token, "unknown", "breaker_unknown", cooldown, now);
    subject.observeEvaluation(token, "postplanner_guard", {
      guardReason: "buy_budget",
      budgetReason: "buy_budget_cooldown",
      cooldownUntilMs: cooldown,
    });
    now += 70_000;
    cooldown = now + 120_000;
    const state = snapshot(subject);
    expect(state.transitions[0]).toMatchObject({
      rawReason: "breaker_unknown",
      effectiveSuppression: "buy_budget",
      effectiveReason: "buy_budget_cooldown",
    });
    expect(state.gate[0]!.lastEvaluation).toMatchObject({
      cooldownUntilMs: START + 60_000,
      cooldownElapsed: false,
    });
    expect(state.gate[0]!.state).toMatchObject({
      cooldownUntilMs: cooldown,
      cooldownElapsed: false,
    });
    subject.stop();
  });

  it("reports condition omissions separately from the bounded token-row lower bound", () => {
    const insert = seed.prepare("INSERT INTO markets VALUES (?,?,?,?,?,?)");
    whitelist = Array.from({ length: 51 }, (_, i) => `condition-${i}`);
    for (const condition of whitelist) {
      insert.run(`${condition}-yes`, condition, "YES", 0, 1, 1);
      insert.run(`${condition}-no`, condition, "NO", 1, 1, 0);
    }
    const subject = observer();
    expect(snapshot(subject).gate).toHaveLength(50);
    expect(snapshot(subject).coverage).toMatchObject({
      omittedGateConditions: 1,
      omittedGateRowsLowerBound: 1,
    });
    // These census counts describe coverage, rather than growing on repeated reads.
    expect(snapshot(subject).coverage).toMatchObject({
      omittedGateConditions: 1,
      omittedGateRowsLowerBound: 1,
    });
    subject.stop();
  });

  it("snapshots quiet known outcomes without evaluation and resets cohort generation on reentry", () => {
    seed
      .prepare("INSERT INTO markets VALUES (?,?,?,?,?,?)")
      .run("gate-yes", "gate-condition", "YES", 0, 1, 1);
    seed
      .prepare("INSERT INTO markets VALUES (?,?,?,?,?,?)")
      .run("gate-no", "gate-condition", "NO", 1, 1, 0);
    whitelist = ["gate-condition"];
    const subject = observer();
    expect(snapshot(subject).gate).toEqual([
      expect.objectContaining({ tokenId: "gate-yes", tradable: true, cohortGeneration: 1 }),
      expect.objectContaining({ tokenId: "gate-no", tradable: false, cohortGeneration: 2 }),
    ]);
    expect(snapshot(subject).transitions).toHaveLength(0);
    whitelist = [];
    expect(snapshot(subject).gate).toHaveLength(0);
    whitelist = ["gate-condition"];
    expect(snapshot(subject).gate[0]).toMatchObject({ cohortGeneration: 3 });
    subject.stop();
  });

  it("preserves false-to-true-to-false transitions and pass-cause interleaving", () => {
    const subject = observer();
    const token = createTokenId("gate-token");
    subject.observeDiscoveryTier(tier([market("gate-token")]), now);
    subject.markCause(token, "market_update");
    const firstPass = subject.capturePass([token]);
    subject.markCause(token, "minimum_change");
    subject.observeVisit(firstPass, token, now + 1);
    subject.observeEvaluation(token, "planner_result", {
      type: "signal",
      side: "buy",
      candidateNotionalUsdc: 2,
    });
    subject.observePreflight(token, "false", "wallet", now + 60_000, now + 2);
    subject.observeEvaluation(token, "postplanner_guard", {
      guardReason: "buy_budget",
      budgetReason: "wallet",
      cooldownUntilMs: now + 60_000,
    });
    subject.finishPass(firstPass, "completed");
    budgetTransition(subject, token, "true", now + 3, "minimum_change");
    budgetTransition(subject, token, "false", now + 5, "retry");

    const journal = snapshot(subject).transitions;
    expect(
      journal.filter((row) => row.preflight !== "unavailable").map((row) => row.preflight),
    ).toEqual(["false", "true", "false"]);
    expect(journal.find((row) => row.evalId === 1)?.causeMask).toBe(1);
    expect(journal.find((row) => row.evalId === 2)?.causeMask).toBe(2);
    now += 31_000;
    for (const [index, result] of (["false", "true", "false"] as const).entries())
      budgetTransition(subject, token, result, now + index, "retry");
    expect(
      snapshot(subject)
        .transitions.slice(-3)
        .map((row) => row.preflight),
    ).toEqual(["false", "true", "false"]);
    subject.stop();
  });
});

describe("EntryFollowupObserver persistence", () => {
  it("fails open on an initial census read error and records the gap", () => {
    whitelist = ["condition"];
    seed.exec("DROP TABLE markets");
    const subject = observer();
    expect(snapshot(subject).coverage.recoveryGap).toContain("gate_census_read_failed");
    subject.flush();
    expect(stored("entry_followup_current").coverage.incomplete).toBe(true);
    subject.stop();
  });

  it("persists quiet GATE and waiting discovery checkpoints with their original observation times", () => {
    seedGate();
    const subject = observer();
    subject.observeDiscoveryTier(tier([market("waiting")]), now);
    subject.flush();
    now += 6 * 60_000;
    subject.flush();
    const historyName = `entry_followup_history_${Math.floor(START / 300_000) % 865}`;
    const history = stored(historyName);
    expect(history.discoveryActive).toEqual([
      expect.objectContaining({ tokenId: "waiting", lastFreshConfirmedAt: START }),
    ]);
    expect(history.gate).toEqual([expect.objectContaining({ tokenId: "gate", observedAt: START })]);
    expect(history.transitions).toEqual([]);
    subject.stop();
    const restarted = observer();
    restarted.flush();
    expect(stored("entry_followup_current").priorSnapshot.gate[0]).toMatchObject({
      tokenId: "gate",
      observedAt: now,
    });
    expect(stored(historyName)).toEqual(history);
    restarted.stop();
  });

  it("counts a first multi-bucket jump and journals delayed outcomes in their actual event bucket", () => {
    const token = seedGate();
    const subject = observer();
    subject.observeVisit(0, token, now);
    subject.flush();
    now += 16 * 60_000;
    subject.observeEvaluation(token, "not_selected", {});
    subject.flush();
    const current = stored("entry_followup_current");
    expect(current.coverage.gapBuckets).toBe(2);
    expect(current.transitions).toEqual([
      expect.objectContaining({ visitedAt: START, outcomeAt: now }),
    ]);
    const history = stored(`entry_followup_history_${Math.floor(START / 300_000) % 865}`);
    expect(history.transitions).toEqual([]);
    subject.stop();
  });

  it("atomically retries a failed bucket pair and restart-censors durable active records", () => {
    const subject = observer();
    subject.observeDiscoveryTier(tier([market("durable")]), now);
    subject.flush(now);
    now += 6 * 60_000;
    const original = RuntimeMetricWriter.prototype.replaceLatest;
    const spy = vi
      .spyOn(RuntimeMetricWriter.prototype, "replaceLatest")
      .mockImplementationOnce(function (this: RuntimeMetricWriter, ...args) {
        return original.apply(this, args);
      })
      .mockImplementationOnce(() => {
        throw new Error("second replacement failed");
      });
    subject.flush(now);
    expect(
      seed
        .prepare(
          "SELECT COUNT(*) count FROM runtime_metrics WHERE metric_name LIKE 'entry_followup_history_%'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(snapshot(subject).durableBucketNumber).toBeNull();
    spy.mockRestore();
    subject.flush(now + 1);
    expect(
      seed
        .prepare(
          "SELECT COUNT(*) count FROM runtime_metrics WHERE metric_name LIKE 'entry_followup_history_%'",
        )
        .get(),
    ).toEqual({ count: 1 });
    subject.stop();

    const history = seed
      .prepare(
        "SELECT id, labels FROM runtime_metrics WHERE metric_name LIKE 'entry_followup_history_%'",
      )
      .get() as { id: number; labels: string };
    const wrongSlot = JSON.parse(history.labels);
    wrongSlot.bucketNumber -= 865;
    wrongSlot.bucketStart = wrongSlot.bucketNumber * 5 * 60_000;
    wrongSlot.bucketEnd = (wrongSlot.bucketNumber + 1) * 5 * 60_000;
    seed
      .prepare("UPDATE runtime_metrics SET labels=? WHERE id=?")
      .run(JSON.stringify(wrongSlot), history.id);
    const restarted = observer();
    expect(snapshot(restarted).discoveryCompleted).toEqual([
      expect.objectContaining({ tokenId: "durable", censorReason: "restart", endedAt: START }),
    ]);
    expect(String(snapshot(restarted).coverage.recoveryGap)).toContain("recovery_slot_identity");
    restarted.observeDiscoveryTier(tier([market("durable"), market("lost-final")]), now);
    restarted.flush(now);
    restarted.observeDiscoveryTier(
      tier([market("durable"), market("lost-final"), market("not-durable")]),
      now + 1,
    );
    seed.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    restarted.stop();
    expect(performance.now() - started).toBeLessThan(100);
    seed.exec("ROLLBACK");
    const afterFailure = observer();
    expect(
      snapshot(afterFailure).discoveryCompleted.some((row) => row.tokenId === "not-durable"),
    ).toBe(false);
    afterFailure.stop();

    const current = seed
      .prepare("SELECT id, labels FROM runtime_metrics WHERE metric_name='entry_followup_current'")
      .get() as { id: number; labels: string };
    const oversized = JSON.parse(current.labels);
    oversized.discoveryActive = Array(51).fill({ tokenId: "invalid" });
    seed
      .prepare("UPDATE runtime_metrics SET labels=? WHERE id=?")
      .run(JSON.stringify(oversized), current.id);
    const capped = observer();
    expect(snapshot(capped).coverage.recoveryGap).toBe("invalid_current");
    capped.stop();

    const latest = JSON.parse(
      (
        seed
          .prepare("SELECT labels FROM runtime_metrics WHERE metric_name='entry_followup_current'")
          .get() as { labels: string }
      ).labels,
    );
    latest.bucketNumber -= 865;
    latest.bucketStart = latest.bucketNumber * 5 * 60_000;
    latest.bucketEnd = (latest.bucketNumber + 1) * 5 * 60_000;
    seed
      .prepare("UPDATE runtime_metrics SET labels=? WHERE metric_name='entry_followup_current'")
      .run(JSON.stringify(latest));
    const aged = observer();
    expect(snapshot(aged).coverage.recoveryGap).toBe("invalid_current");
    aged.stop();
  });

  it("bounds transition overflow and records multi-bucket gaps without persisting sensitive objects", () => {
    whitelist = ["large-condition"];
    const insert = seed.prepare("INSERT INTO markets VALUES (?,?,?,?,?,?)");
    for (let index = 0; index < 50; index++) {
      insert.run(`large-${index}`, "large-condition", "x".repeat(4_000), index, 1, 1);
    }
    const subject = observer();
    subject.observeDiscoveryTier(
      tier(Array.from({ length: 30 }, (_, index) => market(`token-${index}`))),
      now,
    );
    for (let index = 0; index < 30; index++) {
      const token = createTokenId(`token-${index}`);
      const pass = subject.capturePass([token]);
      subject.observeVisit(pass, token, now);
      subject.observeEvaluation(token, "not_selected", { error: { walletBalance: "secret" } });
      subject.observeEvaluation(token, "planner_result", { type: "hold", reasons: [] });
      subject.finishPass(pass, "completed");
    }
    expect(snapshot(subject).transitions).toHaveLength(50);
    expect(snapshot(subject).coverage).toMatchObject({ incomplete: true, droppedTransitions: 10 });
    now += 6 * 60_000;
    vi.spyOn(RuntimeMetricWriter.prototype, "replaceLatest").mockImplementation(() => {
      throw new Error("locked");
    });
    subject.flush(now);
    now += 12 * 60_000;
    subject.markCause("after-gap", "retry");
    const payload = JSON.stringify(snapshot(subject));
    expect(payload).not.toContain("walletBalance");
    expect(snapshot(subject).gate.map((row) => row.tokenId)).toHaveLength(50);
    expect(Number(snapshot(subject).coverage.gatePayloadElided)).toBeGreaterThan(0);
    expect(snapshot(subject).coverage.gapBuckets).toBeGreaterThan(0);
    subject.stop();
  });
});
