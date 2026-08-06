import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapControlDb,
  bootstrapLedgerDb,
  toSqliteDateTime,
  type DbConnection,
} from "@krabs/db";
import {
  createConditionId,
  createOrderId,
  createPositionId,
  createTokenId,
  DEFAULT_EXECUTION_POLICY,
  type OrderSide,
  type Position,
} from "@krabs/domain";
import { PositionConcentrationService } from "../position-concentration-service.js";

const NOW = Date.parse("2026-06-23T12:00:00.000Z");
const PROFILE = "live-lite" as const;

function createHarness(opts: { portfolioUsdc?: number | null; nowMs?: number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "krabs-position-concentration-"));
  const ledger = bootstrapLedgerDb(path.join(dir, "ledger.db"));
  const control = bootstrapControlDb(path.join(dir, "control.db"));
  const nowMs = opts.nowMs ?? NOW;
  const metrics: Array<{ name: string; labels: string | null | undefined }> = [];
  if (opts.portfolioUsdc !== null) {
    insertPortfolioSnapshot(ledger, opts.portfolioUsdc ?? 117, new Date(nowMs).toISOString());
  }
  const service = new PositionConcentrationService({
    ledgerDb: ledger.db,
    controlDb: control.db,
    profileId: PROFILE,
    log: testLogger(),
    runtimeMetrics: {
      writeCounter: (name: string, _value: number, labels?: string | null) => {
        metrics.push({ name, labels });
      },
    } as never,
    now: () => nowMs,
  });
  return {
    dir,
    ledger,
    control,
    service,
    metrics,
    close: () => {
      ledger.close();
      control.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const harnesses: Array<ReturnType<typeof createHarness>> = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.close();
  }
});

describe("PositionConcentrationService", () => {
  it("clamps a small-bankroll first BUY to the $5 gross cap", () => {
    const h = track(createHarness());
    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-iran"),
      conditionId: createConditionId("cond-iran"),
      candidateNotionalUsdc: 10,
      minExecutableNotionalUsdc: 1,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
    });

    expect(decision.action).toBe("clamp");
    expect(decision.reason).toBe("gross_cap");
    expect(decision.effectiveNotionalUsdc).toBeCloseTo(5);
    expect(decision.metrics?.grossCapUsdc).toBe(5);
    expect(decision.metrics?.remainingCapUsdc).toBe(5);
  });

  it("skips instead of clamping when minExecutableNotionalUsdc reflects a sellable-sizing floor above the clamp cap", () => {
    // docs/plans/2026-07-19-sellable-sizing-bounce-for-all.md, Phase 2: a caller
    // enforcing the sellable-sizing floor passes the floor's notional (instead of
    // the bare exchange minimum) as minExecutableNotionalUsdc, so a clamp can
    // never land a flat-first-entry BUY below the floor. Same fresh-token setup
    // as "clamps a small-bankroll first BUY to the $5 gross cap" above (which
    // clamps to $5 when minExecutableNotionalUsdc=1) — raising
    // minExecutableNotionalUsdc past the $5 clamp cap flips clamp -> skip.
    const h = track(createHarness());
    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-floor"),
      conditionId: createConditionId("cond-floor"),
      candidateNotionalUsdc: 10,
      minExecutableNotionalUsdc: 6,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
    });

    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("below_min_after_clamp");
  });

  it("uses the $8 exceptional gross cap for small-bankroll strong overrides", () => {
    const h = track(createHarness());
    recordBuy(h, "tok-exceptional", "cond-exceptional", 0.5, 5);
    upsertPosition(h.ledger, "tok-exceptional", "cond-exceptional", 0.5, 10, 5);
    recordSell(h, "tok-exceptional", "cond-exceptional", 0.6, 4, 0.5, "open");
    upsertPosition(h.ledger, "tok-exceptional", "cond-exceptional", 0.5, 2, 1);

    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-exceptional"),
      conditionId: createConditionId("cond-exceptional"),
      candidateNotionalUsdc: 10,
      minExecutableNotionalUsdc: 1,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
      strongOverride: true,
    });

    expect(decision.action).toBe("clamp");
    expect(decision.reason).toBe("gross_cap");
    expect(decision.effectiveNotionalUsdc).toBeCloseTo(3);
    expect(decision.metrics?.grossCapUsdc).toBe(8);
    expect(decision.metrics?.remainingCapUsdc).toBe(5);
  });

  it("allows a fresh $5 first BUY because remaining cap is not below viable entry size", () => {
    const h = track(createHarness());
    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-fresh"),
      conditionId: createConditionId("cond-fresh"),
      candidateNotionalUsdc: 5,
      minExecutableNotionalUsdc: 1,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
    });

    expect(decision.action).toBe("allow");
    expect(decision.reason).toBe("under_caps");
  });

  it("blocks Iran-style post-harvest rebuy by gross high-water, not remaining cap", () => {
    const h = track(createHarness());
    recordBuy(h, "tok-iran", "cond-iran", 0.31, 5);
    upsertPosition(h.ledger, "tok-iran", "cond-iran", 0.31, 16.129, 5);
    recordSell(h, "tok-iran", "cond-iran", 0.32, 1, 0.31, "open");
    upsertPosition(h.ledger, "tok-iran", "cond-iran", 0.31, 15.129, 4.69);

    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-iran"),
      conditionId: createConditionId("cond-iran"),
      candidateNotionalUsdc: 1,
      minExecutableNotionalUsdc: 0.2,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "scale-in",
      decisionRuleId: "EXECUTION_PROFILE_SCALE_IN",
    });

    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("gross_cap");
    expect(decision.metrics?.grossHeadroomUsdc).toBeCloseTo(0);
    expect(decision.metrics?.remainingHeadroomUsdc ?? 0).toBeGreaterThan(0);
    expect(decision.metrics?.postHarvestRefillCapUsdc).toBe(5);
  });

  it("counts accurate pending BUY residual and clamps to remaining headroom", () => {
    const h = track(createHarness());
    insertOpenBuyOrder(h.ledger, "order-pending", "tok-pending", "cond-pending", 3);
    insertFill(h.ledger, "fill-pending", "order-pending", "tok-pending", "cond-pending", "buy", 1);

    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-pending"),
      conditionId: createConditionId("cond-pending"),
      candidateNotionalUsdc: 4,
      minExecutableNotionalUsdc: 1,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
    });

    expect(decision.action).toBe("clamp");
    expect(decision.effectiveNotionalUsdc).toBeCloseTo(2);
    expect(decision.metrics?.pendingBuyUsdc).toBeCloseTo(2);
    expect(decision.metrics?.filledBuyGrossUsdc).toBeCloseTo(1);
  });

  it("does not expand an old lifecycle cap when bankroll grows", () => {
    const h = track(createHarness({ portfolioUsdc: 117 }));
    recordBuy(h, "tok-old", "cond-old", 0.5, 5);
    upsertPosition(h.ledger, "tok-old", "cond-old", 0.5, 10, 5);
    h.ledger.db.prepare("DELETE FROM portfolio_snapshots").run();
    insertPortfolioSnapshot(h.ledger, 1_000, new Date(NOW).toISOString());

    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-old"),
      conditionId: createConditionId("cond-old"),
      candidateNotionalUsdc: 1,
      minExecutableNotionalUsdc: 0.2,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "execution",
      signalReason: "scale-in",
      decisionRuleId: "D3",
    });

    expect(decision.action).toBe("skip");
    expect(decision.metrics?.capBankrollUsdc).toBe(117);
    expect(decision.metrics?.grossCapUsdc).toBe(5);
  });

  it("shrinks available headroom when current bankroll drops", () => {
    const h = track(createHarness({ portfolioUsdc: 1_000 }));
    recordBuy(h, "tok-drop", "cond-drop", 0.4, 4);
    upsertPosition(h.ledger, "tok-drop", "cond-drop", 0.4, 10, 4);
    h.ledger.db.prepare("DELETE FROM portfolio_snapshots").run();
    insertPortfolioSnapshot(h.ledger, 117, new Date(NOW).toISOString());

    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-drop"),
      conditionId: createConditionId("cond-drop"),
      candidateNotionalUsdc: 2,
      minExecutableNotionalUsdc: 0.2,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "scale-in",
      decisionRuleId: "D3",
    });

    expect(decision.action).toBe("clamp");
    expect(decision.effectiveNotionalUsdc).toBeCloseTo(1);
    expect(decision.metrics?.capBankrollUsdc).toBe(117);
  });

  it("picks the newest snapshot by instant, not by string, when renderings are mixed", () => {
    // `portfolio_snapshots.captured_at` is canonical ISO on production only because every INSERT
    // names the column; `captured_at TEXT NOT NULL DEFAULT (datetime('now'))` survives on the table
    // and SQLite has no `ALTER COLUMN … SET DEFAULT`, so the space-form writer path is permanent
    // and merely dormant. `' '` (0x20) < `'T'` (0x54), so a raw `ORDER BY captured_at DESC` sorts
    // EVERY same-day space row below EVERY same-day ISO row regardless of time-of-day: the 11:57
    // row below would lose to the 11:55 one and this per-signal read would size against a stale
    // bankroll. Migration 096's expression index is what keeps the fixed ordering a seek.
    const h = track(createHarness({ portfolioUsdc: null }));
    insertPortfolioSnapshot(h.ledger, 117, "2026-06-23T11:55:00.000Z");
    insertPortfolioSnapshot(h.ledger, 1_000, "2026-06-23 11:57:00");

    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-mixed-rendering"),
      conditionId: createConditionId("cond-mixed-rendering"),
      candidateNotionalUsdc: 5,
      minExecutableNotionalUsdc: 1,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
    });

    // Both rows are inside portfolioSnapshotMaxAgeMs (10 min at NOW=12:00:00Z), so freshness cannot
    // explain the choice — only the ordering can. 1_000 is the 11:57 row; 117 is the older 11:55.
    expect(decision.metrics?.capBankrollUsdc).toBe(1_000);
  });

  it("uses a stale stable portfolio snapshot during startup grace", () => {
    const h = track(createHarness({ portfolioUsdc: null }));
    insertPortfolioSnapshot(h.ledger, 117, new Date(NOW - 24 * 60 * 60_000).toISOString());

    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-grace"),
      conditionId: createConditionId("cond-grace"),
      candidateNotionalUsdc: 5,
      minExecutableNotionalUsdc: 1,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
    });

    expect(decision.action).toBe("allow");
    expect(decision.metrics?.capBankrollUsdc).toBe(117);
  });

  it("fails open with bounded metric when bankroll has never been available", () => {
    const h = track(createHarness({ portfolioUsdc: null }));

    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-no-bankroll"),
      conditionId: createConditionId("cond-no-bankroll"),
      candidateNotionalUsdc: 100,
      minExecutableNotionalUsdc: 1,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
    });

    expect(decision.action).toBe("allow");
    expect(decision.reason).toBe("missing_bankroll_startup_fail_open");
    expect(h.metrics.some((m) => m.name === "position_concentration_missing_bankroll_total")).toBe(
      true,
    );
  });

  it("falls back to token keys for missing condition and does not cross-block unrelated tokens", () => {
    const h = track(createHarness());
    recordBuy(h, "tok-empty-a", "", 0.5, 5);
    upsertPosition(h.ledger, "tok-empty-a", "", 0.5, 10, 5);

    const sameToken = h.service.evaluateBuy({
      tokenId: createTokenId("tok-empty-a"),
      conditionId: "",
      candidateNotionalUsdc: 1,
      minExecutableNotionalUsdc: 0.2,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "scale-in",
      decisionRuleId: "D3",
    });
    const otherToken = h.service.evaluateBuy({
      tokenId: createTokenId("tok-empty-b"),
      conditionId: "",
      candidateNotionalUsdc: 5,
      minExecutableNotionalUsdc: 0.2,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
    });

    expect(sameToken.action).toBe("skip");
    expect(sameToken.concentrationKey).toBe("token:tok-empty-a");
    expect(otherToken.action).toBe("allow");
    expect(otherToken.concentrationKey).toBe("token:tok-empty-b");
  });

  it("resets lifecycle state on full close and gives a reopen fresh gross headroom", () => {
    const h = track(createHarness());
    recordBuy(h, "tok-reset", "cond-reset", 0.5, 5);
    upsertPosition(h.ledger, "tok-reset", "cond-reset", 0.5, 10, 5);
    recordSell(h, "tok-reset", "cond-reset", 0.6, 5, 0.5, "closed");
    upsertPosition(h.ledger, "tok-reset", "cond-reset", 0, 0, 0, "closed");

    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-reset"),
      conditionId: createConditionId("cond-reset"),
      candidateNotionalUsdc: 5,
      minExecutableNotionalUsdc: 1,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
    });

    expect(decision.action).toBe("allow");
    expect(decision.metrics?.filledBuyGrossUsdc).toBe(0);
  });

  it("kill switch allows old behavior", () => {
    const h = track(createHarness());
    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-disabled"),
      conditionId: createConditionId("cond-disabled"),
      candidateNotionalUsdc: 100,
      minExecutableNotionalUsdc: 1,
      policy: { ...DEFAULT_EXECUTION_POLICY.positionConcentration, enabled: false },
      stage: "signal_to_order",
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
    });

    expect(decision.action).toBe("allow");
    expect(decision.reason).toBe("policy_disabled");
  });

  it("keeps metric labels bounded without token or condition ids", () => {
    const h = track(createHarness());
    h.service.evaluateBuy({
      tokenId: createTokenId("tok-label"),
      conditionId: createConditionId("cond-label"),
      candidateNotionalUsdc: 10,
      minExecutableNotionalUsdc: 1,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
    });

    for (const metric of h.metrics) {
      expect(metric.labels).not.toContain("tok-label");
      expect(metric.labels).not.toContain("cond-label");
    }
  });
});

describe("PositionConcentrationService — SQLite space-format profile-summary staleness (non-UTC host)", () => {
  // `readProfileSummaryBankroll` parses `profile_summaries.updated_at` via `parseLedgerInstantMs`
  // rather than bare `Date.parse` for the same reason as mark-staleness-timestamp.test.ts:
  // `updated_at TEXT NOT NULL DEFAULT (datetime('now'))` renders SQLite's zone-less space form,
  // and bare `Date.parse` would read that as HOST-LOCAL time. A UTC test host would let a
  // `Date.parse` regression pass by accident, so the TZ switch below is required to make it
  // observable at all.
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("uses a fresh profile-summary bankroll when updated_at is the zone-less SQLite space rendering", () => {
    process.env.TZ = "Asia/Bangkok";

    // 30s old, against a 120s profileSummaryMaxAgeMs threshold — fresh under either sign of the
    // bug's absence. Regressed to bare `Date.parse`, the space rendering is misread as
    // Bangkok-local (UTC+7) time: the mark looks ~7h stale, there is no portfolio snapshot to
    // fall back on, and evaluateBuy fails open instead of sizing against the real bankroll.
    const h = track(createHarness({ portfolioUsdc: null }));
    insertProfileSummary(h.control, PROFILE, 250, toSqliteDateTime(NOW - 30_000));

    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-tz-fresh"),
      conditionId: createConditionId("cond-tz-fresh"),
      candidateNotionalUsdc: 5,
      minExecutableNotionalUsdc: 1,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
    });

    expect(decision.reason).not.toBe("missing_bankroll_startup_fail_open");
    expect(decision.metrics?.capBankrollUsdc).toBe(250);
  });

  it("falls open when the space-rendered updated_at is genuinely past profileSummaryMaxAgeMs", () => {
    process.env.TZ = "Asia/Bangkok";

    // Positive control for the assertion above: same TZ and fixture shape, differing only in the
    // mark's age (300s, past the 120s threshold regardless of parsing) — proves the profile-summary
    // path is actually read and correctly judged stale in general, not merely dead code.
    const h = track(createHarness({ portfolioUsdc: null }));
    insertProfileSummary(h.control, PROFILE, 250, toSqliteDateTime(NOW - 300_000));

    const decision = h.service.evaluateBuy({
      tokenId: createTokenId("tok-tz-stale"),
      conditionId: createConditionId("cond-tz-stale"),
      candidateNotionalUsdc: 5,
      minExecutableNotionalUsdc: 1,
      policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
      stage: "signal_to_order",
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
    });

    expect(decision.reason).toBe("missing_bankroll_startup_fail_open");
  });
});

function track(harness: ReturnType<typeof createHarness>): ReturnType<typeof createHarness> {
  harnesses.push(harness);
  return harness;
}

function insertPortfolioSnapshot(conn: DbConnection, value: number, capturedAt: string): void {
  conn.db
    .prepare(
      `INSERT INTO portfolio_snapshots
       (profile, equity_usdc, wallet_usdc, position_value_usdc,
        liquidation_value_usdc, total_equity_liquidation_usdc, realized_pnl_usdc,
        open_value_usdc, captured_at)
       VALUES (?, ?, ?, 0, 0, ?, 0, 0, ?)`,
    )
    .run(PROFILE, value, value, value, capturedAt);
}

function insertProfileSummary(
  conn: DbConnection,
  profileId: string,
  walletBalanceUsdc: number,
  updatedAt: string,
): void {
  conn.db
    .prepare(
      `INSERT INTO profile_summaries (profile_id, wallet_balance_usdc, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET
         wallet_balance_usdc = excluded.wallet_balance_usdc,
         updated_at = excluded.updated_at`,
    )
    .run(profileId, walletBalanceUsdc, updatedAt);
}

function recordBuy(
  h: ReturnType<typeof createHarness>,
  token: string,
  condition: string,
  price: number,
  notional: number,
): void {
  h.service.recordFill({
    fill: {
      tokenId: createTokenId(token),
      conditionId: createConditionId(condition),
      side: "buy",
      price,
      sizeUsdc: notional,
      filledAt: new Date(NOW).toISOString(),
      orderId: createOrderId(`order-${token}-buy-${notional}`),
    },
    policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
    positionBefore: null,
    positionAfter: makePosition(token, condition, price, notional / price, notional),
  });
}

function recordSell(
  h: ReturnType<typeof createHarness>,
  token: string,
  condition: string,
  price: number,
  notional: number,
  preSellAvgEntry: number,
  nextStatus: Position["status"],
): void {
  h.service.recordFill({
    fill: {
      tokenId: createTokenId(token),
      conditionId: createConditionId(condition),
      side: "sell",
      price,
      sizeUsdc: notional,
      filledAt: new Date(NOW + 1_000).toISOString(),
      orderId: createOrderId(`order-${token}-sell-${notional}`),
    },
    policy: DEFAULT_EXECUTION_POLICY.positionConcentration,
    positionBefore: makePosition(token, condition, preSellAvgEntry, 10, 10 * preSellAvgEntry),
    positionAfter: makePosition(
      token,
      condition,
      preSellAvgEntry,
      nextStatus === "closed" ? 0 : 5,
      1,
      {
        status: nextStatus,
      },
    ),
  });
}

function makePosition(
  token: string,
  condition: string,
  avgEntryPrice: number,
  size: number,
  costBasisUsdc: number,
  overrides: Partial<Position> = {},
): Position {
  return {
    positionId: createPositionId(`pos-${token}`),
    tokenId: createTokenId(token),
    conditionId: createConditionId(condition),
    side: "buy",
    size,
    avgEntryPrice,
    costBasisUsdc,
    currentValueUsdc: costBasisUsdc,
    realizedPnl: 0,
    status: "open",
    entryStyle: "probe",
    openedAt: new Date(NOW).toISOString(),
    closedAt: null,
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function upsertPosition(
  conn: DbConnection,
  token: string,
  condition: string,
  avgEntryPrice: number,
  size: number,
  costBasisUsdc: number,
  status: Position["status"] = "open",
): void {
  conn.db
    .prepare(
      `INSERT INTO positions
       (position_id, token_id, condition_id, side, size, avg_entry_price,
        cost_basis_usdc, current_value_usdc, realized_pnl, status, entry_style,
        opened_at, closed_at, updated_at)
       VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, 0, ?, 'probe', ?, ?, ?)
       ON CONFLICT(position_id) DO UPDATE SET
         size = excluded.size,
         avg_entry_price = excluded.avg_entry_price,
         cost_basis_usdc = excluded.cost_basis_usdc,
         current_value_usdc = excluded.current_value_usdc,
         status = excluded.status,
         closed_at = excluded.closed_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      `pos-${token}`,
      token,
      condition,
      size,
      avgEntryPrice,
      costBasisUsdc,
      status === "closed" ? null : costBasisUsdc,
      status,
      new Date(NOW).toISOString(),
      status === "closed" ? new Date(NOW + 1_000).toISOString() : null,
      new Date(NOW + 1_000).toISOString(),
    );
}

function insertOpenBuyOrder(
  conn: DbConnection,
  orderId: string,
  token: string,
  condition: string,
  notional: number,
): void {
  conn.db
    .prepare(
      `INSERT INTO orders
       (order_id, client_order_id, token_id, condition_id, side, order_type, price, size,
        size_usdc, status, bot_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'buy', 'GTC', 0.5, ?, ?, 'open', 'bot', ?, ?)`,
    )
    .run(
      orderId,
      `client-${orderId}`,
      token,
      condition,
      notional / 0.5,
      notional,
      new Date(NOW).toISOString(),
      new Date(NOW).toISOString(),
    );
}

function insertFill(
  conn: DbConnection,
  fillId: string,
  orderId: string,
  token: string,
  condition: string,
  side: OrderSide,
  notional: number,
): void {
  conn.db
    .prepare(
      `INSERT INTO fills
       (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc,
        liquidity_role, fee, filled_at)
       VALUES (?, ?, ?, ?, ?, 0.5, ?, ?, 'maker', 0, ?)`,
    )
    .run(
      fillId,
      orderId,
      token,
      condition,
      side,
      notional / 0.5,
      notional,
      new Date(NOW).toISOString(),
    );
}

function testLogger() {
  const noop = () => undefined;
  return {
    child: () => testLogger(),
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  } as never;
}
