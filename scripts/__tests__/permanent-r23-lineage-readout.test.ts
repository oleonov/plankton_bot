import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { bootstrapLedgerDb } from "@krabs/db";
import { afterEach, describe, expect, it } from "vitest";
import { analyzePermanentR23Lineages } from "../measurement/permanent-r23-lineage-readout.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const DEPLOYED_AT = "2026-08-28T10:00:00.000Z";
const ACTIVATED_AT = "2026-08-28T10:05:00.000Z";
const AS_OF = "2026-08-28T13:00:00.000Z";
const ACTIVATION_ID = "permanent-r23-production";
const GRACE_MS = 15_000;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("permanent R23 lineage aggregate readout", () => {
  it("classifies mature lineages and aggregates accepted transitions, pricing, fills, and direct PnL", () => {
    const fixture = makeFixture();
    const fillable = insertRoot(fixture.db, "fillable", {
      createdAt: "2026-08-28T10:10:00.000Z",
      updatedAt: "2026-08-28T10:20:00.000Z",
      status: "filled",
    });
    insertBuyFill(fixture.db, fillable, "2026-08-28T10:20:00.000Z", 10, 1.1);
    insertDirectPnl(fixture.db, fillable, 0.4);

    const noFill = insertRoot(fixture.db, "no-fill", {
      createdAt: "2026-08-28T10:15:00.000Z",
      updatedAt: "2026-08-28T10:30:00.000Z",
      status: "cancelled",
      cancelReason: "maker_capture_reprice",
    });
    const noFillChild = insertChild(fixture.db, noFill, 1, {
      createdAt: "2026-08-28T10:30:01.000Z",
      updatedAt: "2026-08-28T11:15:00.000Z",
      status: "cancelled",
      cancelReason: "stale_entry_ttl",
      price: 0.12,
    });
    insertIntent(fixture.db, noFill, noFillChild, 1, "completed");

    insertRoot(fixture.db, "active", {
      createdAt: "2026-08-28T12:30:00.000Z",
      updatedAt: "2026-08-28T12:30:00.000Z",
      status: "open",
    });

    const failed = insertRoot(fixture.db, "failed-transition", {
      createdAt: "2026-08-28T10:20:00.000Z",
      updatedAt: "2026-08-28T10:30:00.000Z",
      status: "cancelled",
      cancelReason: "maker_capture_reprice",
    });
    insertIntent(fixture.db, failed, null, 1, "failed", "post-cancel-no-child");

    const partial = insertRoot(fixture.db, "partial-residual", {
      createdAt: "2026-08-28T10:25:00.000Z",
      updatedAt: "2026-08-28T10:30:00.000Z",
      status: "partially-filled",
    });
    insertBuyFill(fixture.db, partial, "2026-08-28T10:30:00.000Z", 5, 0.55);

    const report = analyzePermanentR23Lineages(options(fixture));

    expect(report).toMatchObject({
      schemaVersion: 1,
      aggregateOnly: true,
      binding: {
        expectedSha: SHA,
        deployedAt: DEPLOYED_AT,
        activationId: ACTIVATION_ID,
        activatedAt: ACTIVATED_AT,
        reconciliationGraceMs: GRACE_MS,
        asOf: AS_OF,
      },
      lineages: {
        total: 5,
        classifications: { TECHNICAL: 2, ACTIVE: 1, FILLABLE: 1, NO_FILL: 1 },
      },
      orders: {
        accepted: 6,
        statuses: { open: 1, "partially-filled": 1, filled: 1, cancelled: 3 },
      },
      intents: {
        total: 2,
        statuses: { completed: 1, failed: 1 },
        acceptedTransitions: 1,
        failedTransitions: 1,
        failures: { child: 1 },
      },
      parity: { validLineages: 3, invalidLineages: 2 },
      fills: { count: 2, timely: 2, late: 0, shares: 15, notionalUsdc: 1.65 },
      directPnl: { status: "AVAILABLE", rows: 1, unavailableRows: 0, delta: 0.4 },
      pricing: {
        observations: 6,
        bidPlusOneExact: 6,
        nonCrossing: 6,
        unavailable: 0,
      },
      ceilings: {
        acceptedRootNotionalUsdc: 5.5,
        filledNotionalUsdc: 1.65,
        rootNotionalViolations: 0,
        entryPriceViolations: 0,
      },
    });
    expect(report.timing.fillLatencyMs).toMatchObject({ count: 2, min: 300_000 });
    fixture.close();
  });

  it("never accepts pending/rejected children and marks an accepted partial residual technical after grace", () => {
    const fixture = makeFixture();
    const root = insertRoot(fixture.db, "unaccepted-child", {
      createdAt: "2026-08-28T10:10:00.000Z",
      updatedAt: "2026-08-28T10:20:00.000Z",
      status: "cancelled",
      cancelReason: "maker_capture_reprice",
    });
    const rejected = insertChild(fixture.db, root, 1, {
      createdAt: "2026-08-28T10:20:01.000Z",
      updatedAt: "2026-08-28T10:20:02.000Z",
      status: "rejected",
      exchangeOrderId: null,
    });
    insertIntent(fixture.db, root, rejected, 1, "failed", "child-rejected");

    const report = analyzePermanentR23Lineages(options(fixture));

    expect(report.orders.accepted).toBe(1);
    expect(report.orders.unacceptedLineageMembers).toBe(1);
    expect(report.intents.acceptedTransitions).toBe(0);
    expect(report.lineages.classifications).toEqual({
      TECHNICAL: 1,
      ACTIVE: 0,
      FILLABLE: 0,
      NO_FILL: 0,
    });
    fixture.close();
  });

  it("fails closed on deploy, activation, grace, and as-of binding drift", () => {
    const fixture = makeFixture();
    insertRoot(fixture.db, "binding", {
      createdAt: "2026-08-28T10:10:00.000Z",
      updatedAt: "2026-08-28T10:10:00.000Z",
      status: "open",
    });

    expect(() => analyzePermanentR23Lineages({ ...options(fixture), expectedSha: "bad" })).toThrow(
      /40-character/,
    );
    expect(() =>
      analyzePermanentR23Lineages({ ...options(fixture), activationId: "wrong-activation" }),
    ).toThrow(/activation tuple/);
    expect(() =>
      analyzePermanentR23Lineages({ ...options(fixture), reconciliationGraceMs: 0 }),
    ).toThrow(/grace/);
    expect(() =>
      analyzePermanentR23Lineages({ ...options(fixture), asOf: "2026-08-28T09:59:59.000Z" }),
    ).toThrow(/as-of/);

    writeFileSync(
      fixture.deployMeta,
      JSON.stringify({ sha: "f".repeat(40), deployedAt: DEPLOYED_AT, receipt: { sha: SHA } }),
    );
    expect(() => analyzePermanentR23Lineages(options(fixture))).toThrow(/SHA/);
    fixture.close();
  });

  it("marks missing submit proof and proof/chain drift TECHNICAL", () => {
    const fixture = makeFixture();
    const missingSubmit = insertTerminalChain(fixture.db, "missing-submit");
    mutateIntentProof(fixture.db, missingSubmit, (proof) => ({ ...proof, submit: null }));
    const chainDrift = insertTerminalChain(fixture.db, "chain-drift");
    mutateIntentProof(fixture.db, chainDrift, (proof) => ({
      ...proof,
      prepared: { ...(proof.prepared as object), chainFilledUsdc: 0.01 },
      submit: { ...(proof.submit as object), chainFilledUsdc: 0.01 },
    }));
    const wrongPrice = insertTerminalChain(fixture.db, "wrong-price");
    fixture.db
      .prepare("UPDATE maker_capture_reprice_intents SET candidate_price=.13 WHERE root_order_id=?")
      .run(wrongPrice.id);

    const report = analyzePermanentR23Lineages(options(fixture));

    expect(report.lineages.classifications).toEqual({
      TECHNICAL: 3,
      ACTIVE: 0,
      FILLABLE: 0,
      NO_FILL: 0,
    });
    expect(report.intents.acceptedTransitions).toBe(0);
    expect(report.intents.invalidTransitions).toBe(3);
    fixture.close();
  });

  it("aggregates accepted-child pricing from the authoritative submit book", () => {
    const fixture = makeFixture();
    const root = insertTerminalChain(fixture.db, "submit-pricing");
    mutateIntentProof(fixture.db, root, (proof) => ({
      ...proof,
      submit: {
        ...(proof.submit as object),
        externalBestBid: 0.12,
        externalBestAsk: 0.13,
      },
    }));

    const report = analyzePermanentR23Lineages(options(fixture));

    expect(report.lineages.classifications).toEqual({
      TECHNICAL: 0,
      ACTIVE: 0,
      FILLABLE: 0,
      NO_FILL: 1,
    });
    expect(report.pricing).toMatchObject({
      observations: 2,
      bidPlusOneExact: 1,
      bidPlusOneOther: 1,
      nonCrossing: 2,
      crossingViolations: 0,
      unavailable: 0,
    });
    fixture.close();
  });

  it("bounds failure labels and never emits a persisted sensitive reason", () => {
    const fixture = makeFixture();
    const root = insertRoot(fixture.db, "sensitive-failure", {
      createdAt: "2026-08-28T10:20:00.000Z",
      updatedAt: "2026-08-28T10:30:00.000Z",
      status: "cancelled",
      cancelReason: "maker_capture_reprice",
    });
    insertIntent(fixture.db, root, null, 1, "failed", "secret-account-12345");

    const report = analyzePermanentR23Lineages(options(fixture));
    const serialized = JSON.stringify(report);

    expect(report.intents.failures).toEqual({ unknown: 1 });
    expect(serialized).not.toContain("secret-account-12345");
    fixture.close();
  });

  it("the CLI emits aggregate-only JSON without durable identifiers", () => {
    const fixture = makeFixture();
    insertRoot(fixture.db, "private-order-id", {
      createdAt: "2026-08-28T12:30:00.000Z",
      updatedAt: "2026-08-28T12:30:00.000Z",
      status: "open",
    });
    fixture.db.close();
    const script = resolve(import.meta.dirname, "../measurement/permanent-r23-lineage-readout.ts");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        script,
        "--ledger",
        fixture.path,
        "--deploy-meta",
        fixture.deployMeta,
        "--expected-sha",
        SHA,
        "--activation-id",
        ACTIVATION_ID,
        "--activated-at",
        ACTIVATED_AT,
        "--reconciliation-grace-ms",
        String(GRACE_MS),
        "--as-of",
        AS_OF,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      aggregateOnly: true,
      lineages: { total: 1 },
    });
    expect(result.stdout).not.toContain("private-order-id");
    expect(result.stdout).not.toContain("token-private-order-id");
  });
});

interface Fixture {
  readonly db: Database.Database;
  readonly path: string;
  readonly deployMeta: string;
  close(): void;
}

interface OrderRef {
  readonly id: string;
  readonly token: string;
  readonly condition: string;
  readonly createdAt: string;
  readonly rootNotionalUsdc: number;
  readonly price: number;
  readonly size: number;
}

function options(fixture: Fixture) {
  return {
    ledger: fixture.path,
    deployMeta: fixture.deployMeta,
    expectedSha: SHA,
    activationId: ACTIVATION_ID,
    activatedAt: ACTIVATED_AT,
    reconciliationGraceMs: GRACE_MS,
    asOf: AS_OF,
  };
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "permanent-r23-readout-"));
  dirs.push(dir);
  const path = join(dir, "ledger.db");
  const deployMeta = join(dir, "deploy-meta.json");
  bootstrapLedgerDb(path).close();
  writeFileSync(
    deployMeta,
    JSON.stringify({ sha: SHA, deployedAt: "2026-08-28T10:00:00.000000Z", receipt: { sha: SHA } }),
  );
  const db = new Database(path);
  return { db, path, deployMeta, close: () => db.close() };
}

function insertRoot(
  db: Database.Database,
  suffix: string,
  values: {
    createdAt: string;
    updatedAt: string;
    status: string;
    cancelReason?: string;
  },
): OrderRef {
  const ref = {
    id: `order-${suffix}`,
    token: `token-${suffix}`,
    condition: `condition-${suffix}`,
    createdAt: values.createdAt,
    rootNotionalUsdc: 1.1,
    price: 0.11,
    size: 10,
  };
  insertOrder(db, ref, 0, {
    ...values,
    price: 0.11,
    metadata: rootMetadata(ref),
  });
  return ref;
}

function insertChild(
  db: Database.Database,
  root: OrderRef,
  replacementIndex: number,
  values: {
    createdAt: string;
    updatedAt: string;
    status: string;
    cancelReason?: string;
    exchangeOrderId?: string | null;
    price?: number;
    size?: number;
  },
): OrderRef {
  const child = {
    ...root,
    id: `${root.id}-child-${replacementIndex}`,
    createdAt: values.createdAt,
    price: values.price ?? 0.12,
    size: values.size ?? 9,
  };
  insertOrder(db, child, replacementIndex, {
    ...values,
    price: child.price,
    size: child.size,
    metadata: childMetadata(root, replacementIndex),
  });
  return child;
}

function insertOrder(
  db: Database.Database,
  ref: OrderRef,
  replacementIndex: number,
  values: {
    createdAt: string;
    updatedAt: string;
    status: string;
    cancelReason?: string;
    exchangeOrderId?: string | null;
    price: number;
    size?: number;
    metadata: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO orders(order_id,client_order_id,token_id,condition_id,side,order_type,post_only,
      price,size,size_usdc,status,cancel_reason,exchange_order_id,signal_id,signal_reason,
      decision_rule_id,entry_style,metadata_json,bot_run_id,created_at,updated_at)
     VALUES (?,?,?,?,'buy','GTC',1,?,?,?, ?,?,?,?,'probe-entry','R23_DIP_TRIGGER','maker',?,
      'run',?,?)`,
  ).run(
    ref.id,
    `client-${ref.id}`,
    ref.token,
    ref.condition,
    values.price,
    values.size ?? ref.size,
    values.price * (values.size ?? ref.size),
    values.status,
    values.cancelReason ?? null,
    values.exchangeOrderId === undefined ? `exchange-${ref.id}` : values.exchangeOrderId,
    replacementIndex === 0 ? `signal-${ref.id}` : `signal-${ref.id}-reprice`,
    JSON.stringify(values.metadata),
    values.createdAt,
    values.updatedAt,
  );
}

function rootMetadata(root: OrderRef): Record<string, unknown> {
  return {
    makerMicroLiveLifecycle: {
      kind: "permanent_r23",
      activationId: ACTIVATION_ID,
      activatedAtUtc: ACTIVATED_AT,
      fillWaitMs: 60 * 60_000,
    },
    makerCaptureLineageV1: {
      version: 1,
      rootOrderId: root.id,
      predecessorOrderId: null,
      replacementIndex: 0,
      rootNotionalUsdc: root.rootNotionalUsdc,
    },
    quoteMotionV1: {
      version: 1,
      kind: "r23_capture",
      cohortId: ACTIVATED_AT,
      originalSuggestedPrice: 0.15,
      originalTargetPrice: null,
      entryPriceCeiling: 0.15,
      policySchemaVersion: 1,
      policyControlRevision: 1,
      permanentR23ActivationId: ACTIVATION_ID,
      permanentR23ActivatedAtUtc: ACTIVATED_AT,
      initialBook: {
        depthStatus: "full",
        bestBid: 0.1,
        bestAsk: 0.2,
        tickSize: 0.01,
        snapshotTs: Date.parse(root.createdAt),
        source: "rest",
      },
    },
  };
}

function childMetadata(root: OrderRef, replacementIndex: number): Record<string, unknown> {
  return {
    makerMicroLiveLifecycle: {
      kind: "permanent_r23",
      activationId: ACTIVATION_ID,
      activatedAtUtc: ACTIVATED_AT,
      fillWaitMs: 30 * 60_000,
    },
    makerCaptureLineageV1: {
      version: 1,
      rootOrderId: root.id,
      predecessorOrderId:
        replacementIndex === 1 ? root.id : `${root.id}-child-${replacementIndex - 1}`,
      replacementIndex,
      rootNotionalUsdc: root.rootNotionalUsdc,
    },
  };
}

function insertIntent(
  db: Database.Database,
  root: OrderRef,
  child: OrderRef | null,
  replacementIndex: number,
  status: string,
  failure: string | null = null,
): void {
  const predecessor = replacementIndex === 1 ? root.id : `${root.id}-child-${replacementIndex - 1}`;
  const candidatePrice = child?.price ?? null;
  const proof = captureProof(root, child);
  db.prepare(
    `INSERT INTO maker_capture_reprice_intents(intent_id,predecessor_order_id,lifecycle_signal_id,
      root_order_id,token_id,condition_id,replacement_index,status,candidate_price,replacement_size,
      child_order_id,failure,proof_json,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `intent-${root.id}-${replacementIndex}`,
    predecessor,
    `signal-${child?.id ?? root.id}-reprice`,
    root.id,
    root.token,
    root.condition,
    replacementIndex,
    status,
    candidatePrice,
    child?.size ?? null,
    child?.id ?? null,
    failure,
    JSON.stringify(proof),
    "2026-08-28T10:30:00.000Z",
    "2026-08-28T10:30:01.000Z",
  );
}

function insertTerminalChain(db: Database.Database, suffix: string): OrderRef {
  const root = insertRoot(db, suffix, {
    createdAt: "2026-08-28T10:10:00.000Z",
    updatedAt: "2026-08-28T10:20:00.000Z",
    status: "cancelled",
    cancelReason: "maker_capture_reprice",
  });
  const child = insertChild(db, root, 1, {
    createdAt: "2026-08-28T10:20:01.000Z",
    updatedAt: "2026-08-28T11:15:00.000Z",
    status: "cancelled",
    cancelReason: "stale_entry_ttl",
  });
  insertIntent(db, root, child, 1, "completed");
  return root;
}

function mutateIntentProof(
  db: Database.Database,
  root: OrderRef,
  mutate: (proof: Record<string, unknown>) => Record<string, unknown>,
): void {
  const row = db
    .prepare("SELECT proof_json FROM maker_capture_reprice_intents WHERE root_order_id=?")
    .get(root.id) as { proof_json: string };
  const proof = mutate(JSON.parse(row.proof_json) as Record<string, unknown>);
  db.prepare("UPDATE maker_capture_reprice_intents SET proof_json=? WHERE root_order_id=?").run(
    JSON.stringify(proof),
    root.id,
  );
}

function captureProof(root: OrderRef, child: OrderRef | null) {
  const evaluatedAtMs = Date.parse("2026-08-28T10:30:00.000Z");
  const expiresAtUtc = new Date(Date.parse(root.createdAt) + 60 * 60_000).toISOString();
  const trigger = {
    eventTimestampMs: evaluatedAtMs,
    evaluatedAtMs,
    bestBid: child ? child.price - 0.01 : 0.11,
    bestAsk: 0.2,
    tickSize: 0.01,
    bookSource: "clob",
    policySchemaVersion: 1,
    policyControlRevision: 1,
    activatedAtUtc: ACTIVATED_AT,
    expiresAtUtc,
    originalSuggestedPrice: 0.15,
    entryPriceCeiling: 0.15,
    rootNotionalUsdc: root.rootNotionalUsdc,
    chainFilledUsdc: 0,
    predecessorRemainingShares: 10,
  };
  if (!child) return { version: 1, trigger, prepared: null, submit: null };
  const prepared = {
    evaluatedAtMs,
    snapshotTs: evaluatedAtMs,
    cachedAtMs: evaluatedAtMs,
    sourcePolledAtMs: evaluatedAtMs,
    sourceKind: "rest",
    bookSource: "clob",
    tickSize: 0.01,
    predecessorPrice: 0.11,
    predecessorRemainingShares: 10,
    predecessorLevelBookShares: null,
    predecessorSharesSubtracted: 0,
    predecessorLevelExternalShares: null,
    externalBestBid: child.price - 0.01,
    externalBestAsk: 0.2,
    originalSuggestedPrice: 0.15,
    entryPriceCeiling: 0.15,
    rootNotionalUsdc: root.rootNotionalUsdc,
    chainFilledUsdc: 0,
    rootRemainingUsdc: root.rootNotionalUsdc,
    candidatePrice: child.price,
    replacementSize: child.size,
    minOrderSize: 1,
    policySchemaVersion: 1,
    policyControlRevision: 1,
    activatedAtUtc: ACTIVATED_AT,
    expiresAtUtc,
  };
  return {
    version: 1,
    trigger,
    prepared,
    submit: {
      ...prepared,
      childOrderId: child.id,
      clientOrderId: `client-${child.id}`,
    },
  };
}

function insertBuyFill(
  db: Database.Database,
  order: OrderRef,
  filledAt: string,
  size: number,
  sizeUsdc: number,
): void {
  db.prepare(
    `INSERT INTO fills(fill_id,order_id,token_id,condition_id,side,price,size,size_usdc,filled_at)
     VALUES (?,?,?,?,'buy',?,?,?,?)`,
  ).run(
    `fill-${order.id}`,
    order.id,
    order.token,
    order.condition,
    sizeUsdc / size,
    size,
    sizeUsdc,
    filledAt,
  );
}

function insertDirectPnl(db: Database.Database, root: OrderRef, delta: number): void {
  const positionId = `position-${root.id}`;
  db.prepare(
    `INSERT INTO positions(position_id,token_id,condition_id,side,status,opened_at)
     VALUES (?,?,?,'buy','closed',?)`,
  ).run(positionId, root.token, root.condition, root.createdAt);
  db.prepare(
    `INSERT INTO inventory_lots(lot_id,position_id,token_id,side,size,remaining_size,entry_price,
      cost_usdc,fill_id) VALUES (?,?,?,'buy',10,0,.11,1.1,?)`,
  ).run(`lot-${root.id}`, positionId, root.token, `fill-${root.id}`);
  db.prepare(
    `INSERT INTO orders(order_id,client_order_id,token_id,condition_id,side,order_type,price,size,
      size_usdc,status,exchange_order_id,position_id,bot_run_id,created_at,updated_at)
     VALUES (?,?,?,?,'sell','GTC',.15,10,1.5,'filled',?,?,'run',?,?)`,
  ).run(
    `sell-${root.id}`,
    `client-sell-${root.id}`,
    root.token,
    root.condition,
    `exchange-sell-${root.id}`,
    positionId,
    "2026-08-28T11:00:00.000Z",
    "2026-08-28T11:01:00.000Z",
  );
  db.prepare(
    `INSERT INTO fills(fill_id,order_id,token_id,condition_id,side,price,size,size_usdc,filled_at)
     VALUES (?,?,?,?,'sell',.15,10,1.5,'2026-08-28T11:01:00.000Z')`,
  ).run(`fill-sell-${root.id}`, `sell-${root.id}`, root.token, root.condition);
  db.prepare("INSERT INTO pnl_ledger(fill_id,position_id,delta,filled_at) VALUES (?,?,?,?)").run(
    `fill-sell-${root.id}`,
    positionId,
    delta,
    "2026-08-28T11:01:00.000Z",
  );
}
