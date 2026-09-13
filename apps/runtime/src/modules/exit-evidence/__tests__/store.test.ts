import { mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { bootstrapLedgerDb } from "@krabs/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EvidenceStore, RECOVERY_SQL } from "../store.js";
import { readEvidence } from "../../../scripts/exit-evidence-readout.js";
import { LIMITS, counters, type Packet } from "../types.js";

const NOW = Date.now();
let dir: string;
let store: EvidenceStore;
const intent = (slot = 1): Packet => ({
  slot,
  kind: "PlaceOrderRequested",
  id: `cmd-${slot}`,
  source: NOW,
  received: NOW,
  facts: {
    source: "strategy",
    side: "buy",
    clientOrderId: `client-${slot}`,
    commandId: `cmd-${slot}`,
    signalId: `sig-${slot}`,
    tokenId: "token",
    conditionId: "condition",
    price: 0.1,
    size: 10,
  },
});
function capture(p: Packet): void {
  store.batch([p], counters(), NOW);
}
function count(table: string): number {
  return (store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function quality(key: string): number {
  return (
    store.db.prepare("SELECT count FROM quality WHERE reason=?").get(key) as { count: number }
  ).count;
}
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "exit-evidence-store-")));
  store = new EvidenceStore(join(dir, "exit-evidence.db"), NOW);
});
afterEach(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

it("spends credits durably before grant, never reissues uncertain credits, caps all restarts at 32", () => {
  expect(store.credit(NOW)).toBe(1);
  expect(store.credit(NOW)).toBeNull();
  capture(intent());
  capture(intent());
  expect(count("episodes")).toBe(1);
  expect(count("events")).toBe(1);
  for (let i = 2; i <= 32; i++) {
    store.close();
    store = new EvidenceStore(join(dir, "exit-evidence.db"), NOW);
    expect(store.credit(NOW)).toBe(i);
  }
  store.close();
  store = new EvidenceStore(join(dir, "exit-evidence.db"), NOW);
  expect(store.credit(NOW)).toBeNull();
  expect(store.run().spent).toBe(32);
  expect(store.run().spent - count("episodes")).toBe(31);
});

it("keeps cancelled/partial/duplicate/late fills without fake flatness and refuses ambiguous identity", () => {
  store.credit(NOW);
  capture(intent());
  const base = { ...intent().facts, orderId: "order" };
  capture({ ...intent(), kind: "OrderPlaced", facts: base });
  capture({ ...intent(), kind: "OrderCancelled", id: "cancel", facts: base });
  expect(store.episodes()[0]!.terminal).toBe(0);
  const fill: Packet = {
    ...intent(),
    kind: "FillReceived",
    id: "fill",
    facts: { ...base, fillId: "fill", size: 3 },
  };
  capture(fill);
  capture(fill);
  expect(count("events")).toBe(4);
  capture({ ...fill, id: "fill-2", facts: { ...fill.facts, fillId: "fill-2", size: 7 } });
  expect(count("events")).toBe(5);
  capture({ ...fill, id: "foreign", facts: { ...fill.facts, tokenId: "foreign" } });
  expect(count("events")).toBe(5);
  expect(quality("link_unknown")).toBe(1);
});

it("retains early closed cases until uniform day 21, never slides deadline and expires only own rows", () => {
  store.credit(NOW);
  capture(intent());
  store.db.prepare("UPDATE episodes SET terminal=1").run();
  const original = store.run();
  expect(store.advance(NOW + LIMITS.captureMs)).toBe(false);
  expect(count("events")).toBe(1);
  store.close();
  store = new EvidenceStore(join(dir, "exit-evidence.db"), NOW + LIMITS.captureMs);
  expect(store.credit(NOW + LIMITS.captureMs)).toBeNull();
  expect(store.run().deadline).toBe(original.deadline);
  store.advance(NOW + LIMITS.retentionMs - 1);
  expect(count("episodes")).toBe(1);
  store.batch([], counters(), NOW + LIMITS.retentionMs);
  expect(count("events")).toBe(0);
  expect(count("episodes")).toBe(0);
  expect(store.run().spent).toBe(1);
});

it("records bad/future source time only as quality and permanently degrades a backwards clock", () => {
  store.credit(NOW);
  capture(intent());
  capture({ ...intent(), id: "bad", source: NaN });
  capture({ ...intent(), id: "future", source: NOW + 1 });
  expect(count("events")).toBe(1);
  expect(quality("invalid_time")).toBe(1);
  expect(quality("future_time")).toBe(1);
  expect(store.advance(NOW - 1)).toBe(false);
  expect(store.credit(NOW + 1)).toBeNull();
});

it("preserves newer/foreign/WAL databases and rejects an independent writer", () => {
  expect(() => new EvidenceStore(store.path, NOW)).toThrow();
  const newer = join(dir, "newer.db");
  const db = new Database(newer);
  db.exec("CREATE TABLE untouched(x); INSERT INTO untouched VALUES(42); PRAGMA user_version=2;");
  db.close();
  const before = readFileSync(newer);
  expect(() => new EvidenceStore(newer, NOW)).toThrow("unsupported_schema");
  expect(readFileSync(newer)).toEqual(before);
  writeFileSync(join(dir, "other.db-wal"), "foreign");
  expect(() => new EvidenceStore(join(dir, "other.db"), NOW)).toThrow("unexpected_wal");
  expect(readFileSync(join(dir, "other.db-wal"), "utf8")).toBe("foreign");
});

it("bounds book depth, flags post-fill/stale/oversize, and applies shared event/book quotas", () => {
  store.credit(NOW);
  capture(intent());
  for (const id of ["cmd-1", "oversize"])
    capture({ ...intent(), kind: "FillReceived", id, facts: { ...intent().facts, fillId: id } });
  const book: Packet = {
    ...intent(),
    kind: "Book",
    facts: { trigger: "FillReceived" },
    book: {
      time: NOW,
      fresh: false,
      oversize: false,
      bestBid: 0.1,
      bestAsk: 0.2,
      bids: new Float64Array([0.09, 4, 0.1, 2]),
      asks: new Float64Array([0.2, 4]),
    },
  };
  capture(book);
  const payload = JSON.parse(
    (store.db.prepare("SELECT payload FROM book_samples").get() as { payload: string }).payload,
  );
  expect(payload.bids.levels).toEqual([
    [0.1, 2],
    [0.09, 4],
  ]);
  expect(payload.prior).toBe(false);
  expect(quality("post_fill")).toBe(1);
  expect(quality("book_stale")).toBe(1);
  capture({
    ...book,
    id: "oversize",
    book: { ...book.book!, oversize: true, bids: new Float64Array(), asks: new Float64Array() },
  });
  expect(quality("depth_oversize")).toBe(1);
  capture({ ...book, book: undefined } as unknown as Packet);
  expect(quality("book_missing")).toBe(1);
  store.db
    .prepare("UPDATE run_state SET book_count=?,event_count=?")
    .run(LIMITS.books, LIMITS.events);
  capture(book);
  capture({ ...intent(), id: "extra" });
  expect(quality("book_quota")).toBe(1);
  expect(quality("event_quota")).toBe(1);
  expect(count("book_samples")).toBe(2);
});

it.each(["open", "pending"])(
  "primary-key recovery restores signed and lot facts, and distinguishes %s acceptance",
  (status) => {
    const ledgerPath = join(dir, "ledger.db");
    const ledger = bootstrapLedgerDb(ledgerPath);
    try {
      for (const sql of Object.values(RECOVERY_SQL)) {
        const plans = ledger.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("missing") as {
          detail: string;
        }[];
        expect(plans.every((p) => p.detail.includes("SEARCH") && !p.detail.includes("SCAN"))).toBe(
          true,
        );
        expect(ledger.db.prepare(sql).get("missing")).toBeUndefined();
      }
      const time = new Date(NOW).toISOString();
      ledger.db
        .prepare(
          `INSERT INTO orders(order_id,client_order_id,token_id,condition_id,side,order_type,price,size,size_usdc,status,bot_run_id,updated_at,metadata_json)
      VALUES('order','client-1','token','condition','buy','GTC',.1,10,1,?,'run',?,?)`,
        )
        .run(
          status,
          time,
          JSON.stringify({
            signedOrderFactsV1: {
              version: 1,
              orderId: "order",
              tokenId: "token",
              side: "buy",
              shares: 9.99,
              logicalSize: 10,
            },
            ignored: "not exported",
          }),
        );
      ledger.db
        .prepare(
          `INSERT INTO positions(position_id,token_id,condition_id,side,size,status,opened_at,updated_at)
      VALUES('position','token','condition','buy',10,'open',?,?)`,
        )
        .run(time, time);
      ledger.db
        .prepare(
          `INSERT INTO fills(fill_id,order_id,token_id,condition_id,side,price,size,size_usdc,filled_at)
      VALUES('fill','order','token','condition','buy',.1,10,1,?)`,
        )
        .run(time);
      ledger.db
        .exec(`INSERT INTO inventory_lots(lot_id,position_id,token_id,side,size,remaining_size,entry_price,cost_usdc,fill_id)
      VALUES('lot-fill','position','token','buy',10,10,.1,1,'fill')`);
      store.credit(NOW);
      capture(intent());
      capture({
        ...intent(),
        kind: "FillReceived",
        id: "fill",
        facts: { ...intent().facts, orderId: "order", fillId: "fill" },
      });
      store.recover(ledgerPath, NOW);
      expect(store.episodes()[0]!.position).toBe("position");
      const rows = store.db
        .prepare("SELECT payload FROM events WHERE origin='recovered'")
        .all() as {
        payload: string;
      }[];
      expect(rows.some((r) => JSON.parse(r.payload).preparedShares === 9.99)).toBe(true);
      expect(rows.some((r) => JSON.parse(r.payload).preparedLogicalSize === 10)).toBe(true);
      expect(
        rows.map((r) => JSON.parse(r.payload)).find((f) => f.preparedShares === 9.99).accepted,
      ).toBe(status === "open" ? true : null);
      expect(JSON.stringify(rows)).not.toContain("not exported");
      ledger.db.exec("UPDATE positions SET status='closed',size=0");
      store.recover(ledgerPath, NOW);
      store.recover(ledgerPath, NOW);
      expect(store.episodes()[0]!.terminal).toBe(1);
    } finally {
      ledger.close();
    }
  },
);

function recoveryFixture(): { ledger: ReturnType<typeof bootstrapLedgerDb>; path: string } {
  const path = join(dir, "ledger.db");
  const ledger = bootstrapLedgerDb(path);
  const time = new Date(NOW).toISOString();
  ledger.db
    .prepare(
      `INSERT INTO positions(position_id,token_id,condition_id,side,size,status,opened_at,updated_at)
    VALUES('position','token','condition','buy',20,'closed',?,?)`,
    )
    .run(time, time);
  for (let slot = 1; slot <= 2; slot++) {
    ledger.db
      .prepare(
        `INSERT INTO orders(order_id,client_order_id,token_id,condition_id,side,order_type,price,size,size_usdc,status,bot_run_id,updated_at)
      VALUES(?,?,'token','condition','buy','GTC',.1,10,1,'filled','run',?)`,
      )
      .run(`order-${slot}`, `client-${slot}`, time);
    ledger.db
      .prepare(
        `INSERT INTO fills(fill_id,order_id,token_id,condition_id,side,price,size,size_usdc,filled_at)
      VALUES(?,?,'token','condition','buy',.1,10,1,?)`,
      )
      .run(`fill-${slot}`, `order-${slot}`, time);
    ledger.db
      .prepare(
        `INSERT INTO inventory_lots(lot_id,position_id,token_id,side,size,remaining_size,entry_price,cost_usdc,fill_id)
      VALUES(?,'position','token','buy',10,10,.1,1,?)`,
      )
      .run(`lot-fill-${slot}`, `fill-${slot}`);
  }
  return { ledger, path };
}
function observedFill(slot: number): Packet {
  return {
    ...intent(slot),
    kind: "FillReceived",
    id: `fill-${slot}`,
    facts: { ...intent(slot).facts, orderId: `order-${slot}`, fillId: `fill-${slot}` },
  };
}

it("excludes every shared-position claimant from clean readout and periodic capture while preserving exact fills", () => {
  const { ledger, path } = recoveryFixture();
  try {
    ledger.db.exec("UPDATE positions SET status='open'");
    // Both prospective intents exist before late fills reach the same inventory position.
    for (const slot of [1, 2]) {
      store.credit(NOW);
      capture(intent(slot));
    }
    for (const slot of [1, 2]) {
      const fill = observedFill(slot);
      capture(fill);
      store.recover(path, NOW, [fill]);
    }
    expect(store.episodes().map((e) => e.ambiguous)).toEqual([1, 1]);
    expect(store.episodes().map((e) => e.position)).toEqual(["position", null]);
    const before = count("events");
    for (const slot of [1, 2]) {
      capture({
        ...intent(slot),
        kind: "PlaceOrderRequested",
        id: `shared-exit-${slot}`,
        facts: {
          tokenId: "token",
          conditionId: "condition",
          positionId: "position",
          side: "sell",
          clientOrderId: "shared-exit",
        },
      });
      capture({
        ...intent(slot),
        kind: "Book",
        facts: { trigger: "periodic" },
        book: {
          bestBid: 0.1,
          bestAsk: 0.2,
          time: NOW,
          fresh: true,
          oversize: false,
          bids: new Float64Array(),
          asks: new Float64Array(),
        },
      });
    }
    expect(count("events")).toBe(before);
    expect(count("book_samples")).toBe(0);
    // Retrying the first claimant must not restore a clean link.
    store.recover(path, NOW, [observedFill(1)]);
    store.close(true);
    expect(readEvidence(store.path)).toMatchObject({
      episodes: [
        { slot: 1, cleanLink: false, actualFills: [{ fillId: "fill-1", buyOrigin: "original" }] },
        { slot: 2, cleanLink: false, actualFills: [{ fillId: "fill-2", buyOrigin: "original" }] },
      ],
    });
  } finally {
    ledger.close();
  }
});

it.each(["counter", "lineage"])(
  "rolls back recovered %s interruption and retries once after restart",
  (boundary) => {
    const { ledger, path } = recoveryFixture();
    try {
      store.credit(NOW);
      capture(intent());
      capture(observedFill(1));
      const before = store.run().event_count;
      const prepare = store.db.prepare.bind(store.db);
      const fault = vi.spyOn(store.db, "prepare").mockImplementation((sql) => {
        const interrupted =
          boundary === "counter"
            ? sql.includes("event_count=event_count+1")
            : sql.includes("UPDATE episodes SET terminal") &&
              store.episodes()[0]?.position !== null;
        if (interrupted) throw new Error("recovery interruption");
        return prepare(sql);
      });
      try {
        expect(() => store.recover(path, NOW, [observedFill(1)])).toThrow("recovery interruption");
      } finally {
        fault.mockRestore();
      }
      expect(store.run().event_count).toBe(before);
      expect(count("events")).toBe(before);
      expect(store.episodes()[0]).toMatchObject({ position: null, terminal: 0, ambiguous: 0 });
      store.close();
      store = new EvidenceStore(store.path, NOW);
      store.recover(path, NOW, [observedFill(1)]);
      expect(store.episodes()[0]).toMatchObject({ position: "position", terminal: 1 });
      expect(store.run().event_count).toBe(before + 3);
      expect(count("events")).toBe(before + 3);
      store.recover(path, NOW, [observedFill(1)]);
      expect(store.run().event_count).toBe(before + 3);
      expect(count("events")).toBe(before + 3);
    } finally {
      ledger.close();
    }
  },
);
