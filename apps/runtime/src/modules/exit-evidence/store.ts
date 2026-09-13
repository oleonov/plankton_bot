import Database from "better-sqlite3";
import { existsSync, lstatSync, realpathSync, statfsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { copyFacts } from "./transport.js";
import {
  LIMITS,
  KINDS,
  QUALITY,
  identifier,
  validTime,
  type Episode,
  type Facts,
  type Packet,
  type Quality,
  type Counters,
  type Run,
  type Book,
} from "./types.js";

function depth(input: Float64Array, sign: number): { levels: number[][]; total: number } {
  const pairs = Array.from({ length: input.length / 2 }, (_, i) => [
    input[i * 2]!,
    input[i * 2 + 1]!,
  ]);
  if (pairs.some(([p, s]) => !Number.isFinite(p) || !Number.isFinite(s) || p! < 0 || s! < 0))
    throw new Error("book_number");
  pairs.sort((a, b) => sign * (a[0]! - b[0]!));
  return { levels: pairs.slice(0, 10), total: pairs.reduce((n, row) => n + row[1]!, 0) };
}
function validateBook(b: Book, trigger: Facts[string] | undefined): void {
  if (
    b.bids.length > 256 ||
    b.asks.length > 256 ||
    b.bids.length % 2 ||
    b.asks.length % 2 ||
    ![b.bestBid, b.bestAsk].every(
      (v) => v === null || (typeof v === "number" && Number.isFinite(v)),
    ) ||
    (trigger !== "periodic" && !KINDS.some((kind) => kind === trigger))
  )
    throw new Error("book_transport");
}
type RecoveryRow = { id: number; slot: number; order_id: string | null; fill_id: string | null };
function bookPayload(p: Packet, b: Book, prior: boolean): string {
  return JSON.stringify({
    bestBid: b.bestBid,
    bestAsk: b.bestAsk,
    bids: depth(b.bids, -1),
    asks: depth(b.asks, 1),
    age: p.received - b.time!,
    fresh: b.fresh,
    prior,
    source_complete: !b.oversize,
    stored_truncated: b.oversize || b.bids.length > 20 || b.asks.length > 20,
    trigger: p.facts.trigger,
  });
}

const SCHEMA = `
CREATE TABLE run_state (id INTEGER PRIMARY KEY CHECK(id=1), started INTEGER NOT NULL,
 deadline INTEGER NOT NULL, expires INTEGER NOT NULL, last_seen INTEGER NOT NULL,
 spent INTEGER NOT NULL DEFAULT 0 CHECK(spent BETWEEN 0 AND 32),
 event_count INTEGER NOT NULL DEFAULT 0, book_count INTEGER NOT NULL DEFAULT 0,
 disabled INTEGER NOT NULL DEFAULT 0, clean_shutdown INTEGER NOT NULL DEFAULT 0);
CREATE TABLE episodes (slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND 32),
 client TEXT UNIQUE NOT NULL, command TEXT NOT NULL, signal TEXT NOT NULL, token TEXT NOT NULL,
 condition TEXT NOT NULL, position TEXT, terminal INTEGER NOT NULL DEFAULT 0,
 ambiguous INTEGER NOT NULL DEFAULT 0);
CREATE TABLE events (id INTEGER PRIMARY KEY, slot INTEGER NOT NULL, kind TEXT NOT NULL,
 stable_id TEXT NOT NULL, origin TEXT NOT NULL, received INTEGER NOT NULL, source REAL,
 client TEXT, order_id TEXT, fill_id TEXT, position TEXT,
 payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=2048),
 UNIQUE(kind, stable_id, origin));
CREATE INDEX event_order ON events(slot,order_id);
CREATE INDEX event_client ON events(slot,client);
CREATE TABLE book_samples (id INTEGER PRIMARY KEY, event_key TEXT UNIQUE, slot INTEGER NOT NULL,
 received INTEGER NOT NULL, source REAL, payload TEXT NOT NULL
 CHECK(length(CAST(payload AS BLOB))<=1024));
CREATE TABLE quality (reason TEXT PRIMARY KEY, count INTEGER NOT NULL);
PRAGMA user_version=1;`;

export function familyBytes(path: string): number {
  return ["", "-journal", "-wal", "-shm"].reduce(
    (n, suffix) => n + (existsSync(path + suffix) ? statSync(path + suffix).size : 0),
    0,
  );
}
function safePath(path: string): string {
  const full = resolve(path);
  if (realpathSync(dirname(full)) !== dirname(full)) throw new Error("path_alias");
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const name = full + suffix;
    if (existsSync(name) && (!lstatSync(name).isFile() || lstatSync(name).nlink !== 1))
      throw new Error("unexpected_file");
  }
  if (existsSync(full + "-wal") || existsSync(full + "-shm")) throw new Error("unexpected_wal");
  return full;
}
export function hasDiskBudget(path: string): boolean {
  const fs = statfsSync(dirname(path));
  return (
    fs.bavail * fs.bsize >= LIMITS.diskFloor + Math.max(0, LIMITS.familyBytes - familyBytes(path))
  );
}
function configure(db: Database.Database, path: string): void {
  if (db.pragma("journal_mode", { simple: true }) !== "delete") throw new Error("journal_mode");
  db.pragma("busy_timeout=0");
  db.pragma("page_size=4096");
  db.pragma("max_page_count=65536");
  db.pragma("locking_mode=EXCLUSIVE");
  const main = db.pragma("database_list") as { name: string; file: string }[];
  if (
    main.length !== 1 ||
    main[0]?.file !== path ||
    db.pragma("page_size", { simple: true }) !== LIMITS.pageSize ||
    db.pragma("max_page_count", { simple: true }) !== LIMITS.pages ||
    db.pragma("locking_mode", { simple: true }) !== "exclusive"
  )
    throw new Error("pragmas");
}

export class EvidenceStore {
  readonly db: Database.Database;
  readonly path: string;
  private grant: number | null = null;
  private recoveryCursor = 0;
  constructor(path: string, now: number) {
    this.path = safePath(path);
    if (!hasDiskBudget(this.path)) throw new Error("disk_pressure");
    const existed = existsSync(this.path);
    this.db = new Database(this.path, { timeout: 0 });
    try {
      this.initialize(existed, now);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private initialize(existed: boolean, now: number): void {
    const version = this.db.pragma("user_version", { simple: true });
    if (existed && version !== 1) throw new Error("unsupported_schema");
    configure(this.db, this.path);
    this.db.exec("BEGIN EXCLUSIVE");
    try {
      if (!existed) this.create(now);
      this.validateSchema();
      this.db.prepare("UPDATE run_state SET clean_shutdown=0 WHERE id=1").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (existed) this.quality("restart_gap");
    this.advance(now);
  }
  private create(now: number): void {
    if (!validTime(now)) throw new Error("invalid_time");
    this.db.exec(SCHEMA);
    this.db
      .prepare("INSERT INTO run_state(id,started,deadline,expires,last_seen) VALUES(1,?,?,?,?)")
      .run(now, now + LIMITS.captureMs, now + LIMITS.retentionMs, now);
    const insert = this.db.prepare("INSERT INTO quality VALUES (?,0)");
    for (const key of QUALITY) insert.run(key);
    this.quality("comparison_unavailable");
  }
  private validateSchema(): void {
    const actual = this.db
      .prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
      .all();
    const expected = new Database(":memory:");
    try {
      expected.exec(SCHEMA);
      const rows = expected
        .prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
        .all();
      if (JSON.stringify(actual) !== JSON.stringify(rows)) throw new Error("schema_mismatch");
    } finally {
      expected.close();
    }
    const run = this.run();
    if (
      !run ||
      run.deadline !== run.started + LIMITS.captureMs ||
      run.expires !== run.started + LIMITS.retentionMs ||
      run.event_count > LIMITS.events ||
      run.book_count > LIMITS.books
    )
      throw new Error("invalid_run");
  }
  run(): Run {
    return this.db
      .prepare(
        "SELECT started,deadline,expires,last_seen,spent,event_count,book_count,disabled,clean_shutdown FROM run_state WHERE id=1",
      )
      .get() as Run;
  }
  episodes(): Episode[] {
    return this.db
      .prepare(
        "SELECT slot,client,command,signal,token,condition,position,terminal,ambiguous FROM episodes ORDER BY slot LIMIT 32",
      )
      .all() as Episode[];
  }
  close(clean = false): void {
    if (!this.db.open) return;
    try {
      if (clean) this.db.prepare("UPDATE run_state SET clean_shutdown=1 WHERE id=1").run();
    } finally {
      this.db.close();
    }
  }
  counts(): Counters {
    return Object.fromEntries(
      this.db
        .prepare("SELECT reason,count FROM quality LIMIT 32")
        .all()
        .map((row) => {
          const r = row as { reason: string; count: number };
          return [r.reason, r.count];
        }),
    ) as Counters;
  }
  quality(key: Quality, amount = 1): void {
    this.db
      .prepare("UPDATE quality SET count=min(9007199254740991,count+?) WHERE reason=?")
      .run(amount, key);
  }
  advance(now: number): boolean {
    const run = this.run();
    if (run.disabled === 2) return false;
    if (validTime(now) && now >= run.expires) {
      this.expire();
      return false;
    }
    if (run.disabled) return false;
    if (!validTime(now) || now < run.last_seen) {
      this.quality("clock_backwards");
      this.db.prepare("UPDATE run_state SET disabled=1 WHERE id=1").run();
      return false;
    }
    if (now >= run.deadline) return false;
    this.db.prepare("UPDATE run_state SET last_seen=? WHERE id=1").run(now);
    return true;
  }
  private expire(): void {
    const remove = () => {
      this.db.exec("DELETE FROM events; DELETE FROM book_samples; DELETE FROM episodes;");
      this.db.prepare("UPDATE run_state SET disabled=2 WHERE id=1").run();
    };
    // Expiry inside a batch must not create a second rollback subjournal.
    if (this.db.inTransaction) remove();
    else this.db.transaction(remove)();
  }
  credit(now: number): number | null {
    if (this.grant !== null || !this.advance(now)) return null;
    const result = this.db
      .prepare("UPDATE run_state SET spent=spent+1 WHERE id=1 AND spent<32 RETURNING spent")
      .get() as { spent: number } | undefined;
    this.grant = result?.spent ?? null;
    return this.grant;
  }
  batch(packets: Packet[], drops: Counters, now: number, defer = false): Packet[] {
    const deferred: Packet[] = [];
    if (packets.length > LIMITS.batch) throw new Error("batch_limit");
    if (!hasDiskBudget(this.path) || familyBytes(this.path) >= LIMITS.familyBytes) {
      this.quality("disk_pressure");
      throw new Error("disk_pressure");
    }
    this.db.transaction(() => {
      for (const key of QUALITY) {
        const n = drops[key];
        if (Number.isSafeInteger(n) && n > 0) this.quality(key, n);
      }
      if (!this.advance(now)) return;
      for (const packet of packets) {
        const e = this.episodes().find((e) => e.slot === packet.slot);
        if (defer && e && (packet.kind === "Book" || !this.matches(e, packet.facts)))
          deferred.push(packet);
        else this.capture(packet, "live", now);
      }
    })();
    return deferred;
  }
  private enroll(packet: Packet): Episode | undefined {
    if (packet.slot !== this.grant || packet.kind !== "PlaceOrderRequested") return;
    this.grant = null;
    const f = packet.facts;
    if (
      f.source !== "strategy" ||
      f.side !== "buy" ||
      f.positionId ||
      ![f.clientOrderId, f.commandId, f.signalId, f.tokenId, f.conditionId].every(identifier)
    ) {
      this.quality("link_unknown");
      return;
    }
    this.db
      .prepare(
        "INSERT OR IGNORE INTO episodes(slot,client,command,signal,token,condition) VALUES(?,?,?,?,?,?)",
      )
      .run(packet.slot, f.clientOrderId, f.commandId, f.signalId, f.tokenId, f.conditionId);
    return this.episodes().find((e) => e.slot === packet.slot);
  }
  capture(packet: Packet, origin: "live" | "recovered", now: number): void {
    if (packet.kind !== "Book" && !KINDS.includes(packet.kind)) {
      this.quality("invalid_field");
      return;
    }
    if (origin === "live" && packet.kind !== "Book") {
      const facts = copyFacts(packet.facts);
      if (!facts) {
        this.quality("invalid_field");
        return;
      }
      packet = { ...packet, facts };
    }
    if (!this.packetTime(packet, now)) {
      if (packet.slot === this.grant) this.grant = null;
      return;
    }
    const episode = this.episodes().find((e) => e.slot === packet.slot) ?? this.enroll(packet);
    if (!episode || !identifier(packet.id)) {
      this.quality("link_unknown");
      return;
    }
    if (packet.kind === "Book") {
      if (packet.facts.trigger !== "periodic" || (!episode.terminal && !episode.ambiguous))
        this.book(packet);
      return;
    }
    this.lifecycle(episode, packet, origin);
  }
  private packetTime(packet: Packet, now: number): boolean {
    const issue =
      !validTime(packet.received) || !validTime(packet.source)
        ? "invalid_time"
        : packet.source > now || packet.received > now
          ? "future_time"
          : packet.received < this.run().started
            ? "left_censored"
            : null;
    if (issue) this.quality(issue);
    return issue === null;
  }
  private lifecycle(episode: Episode, packet: Packet, origin: "live" | "recovered"): void {
    if (!this.matches(episode, packet.facts)) {
      this.quality("link_unknown");
      return;
    }
    const payload = JSON.stringify(packet.facts);
    if (Buffer.byteLength(payload) > LIMITS.eventBytes) {
      this.quality("payload_quota");
      return;
    }
    if (this.run().event_count >= LIMITS.events) {
      this.quality("event_quota");
      return;
    }
    this.insertEvent(packet, origin, payload);
    if (packet.kind === "FillReceived") this.setTerminal(episode.slot, false);
    if (packet.kind === "PositionUpdated" && episode.position === packet.facts.positionId)
      this.setTerminal(
        episode.slot,
        ["closed", "resolved", "redeemed"].includes(String(packet.facts.status)),
      );
  }
  private matches(e: Episode, f: Facts): boolean {
    if (f.tokenId !== e.token || f.conditionId !== e.condition) return false;
    if (f.clientOrderId === e.client) return true;
    if (e.position && !e.ambiguous && f.positionId === e.position) return true;
    if (!identifier(f.orderId) && !identifier(f.clientOrderId)) return false;
    return Boolean(
      this.db
        .prepare("SELECT id FROM events WHERE slot=? AND order_id=? LIMIT 1")
        .get(e.slot, f.orderId ?? null) ??
      this.db
        .prepare("SELECT id FROM events WHERE slot=? AND client=? LIMIT 1")
        .get(e.slot, f.clientOrderId ?? null),
    );
  }
  private insertEvent(p: Packet, origin: string, payload: string): void {
    const f = p.facts;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO events
      (slot,kind,stable_id,origin,received,source,client,order_id,fill_id,position,payload)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.slot,
        p.kind,
        p.id,
        origin,
        p.received,
        p.source,
        f.clientOrderId ?? null,
        f.orderId ?? null,
        f.fillId ?? null,
        f.positionId ?? null,
        payload,
      );
    if (result.changes)
      this.db.prepare("UPDATE run_state SET event_count=event_count+1 WHERE id=1").run();
  }
  private setTerminal(slot: number, terminal: boolean): void {
    this.db.prepare("UPDATE episodes SET terminal=? WHERE slot=?").run(Number(terminal), slot);
    if (terminal) this.quality("settlement_detail_unavailable");
  }
  private book(p: Packet): void {
    if (
      p.facts.trigger !== "periodic" &&
      !this.db
        .prepare("SELECT id FROM events WHERE slot=? AND kind=? AND stable_id=? LIMIT 1")
        .get(p.slot, p.facts.trigger, p.id)
    ) {
      this.quality("book_drop");
      return;
    }
    const b = p.book;
    if (!b) {
      this.quality("book_missing");
      return;
    }
    if (!validTime(b.time) || b.time > p.received) {
      this.quality("invalid_time");
      return;
    }
    validateBook(b, p.facts.trigger);
    if (b.oversize) this.quality("depth_oversize");
    if (!b.fresh) this.quality("book_stale");
    const prior = p.facts.trigger !== "FillReceived" || b.time < p.source!;
    if (!prior) this.quality("post_fill");
    if (this.run().book_count >= LIMITS.books) {
      this.quality("book_quota");
      return;
    }
    this.insertBook(p, bookPayload(p, b, prior));
  }
  private insertBook(p: Packet, payload: string): void {
    if (Buffer.byteLength(payload) > LIMITS.bookBytes) {
      this.quality("payload_quota");
      return;
    }
    const key = createHash("sha256").update(`${p.slot}:${p.facts.trigger}:${p.id}`).digest("hex");
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO book_samples(event_key,slot,received,source,payload) VALUES(?,?,?,?,?)",
      )
      .run(key, p.slot, p.received, p.book!.time, payload);
    if (result.changes)
      this.db.prepare("UPDATE run_state SET book_count=book_count+1 WHERE id=1").run();
  }
  recover(ledgerPath: string, now: number, observed?: Packet[]): void {
    if (!this.advance(now) || this.run().event_count >= LIMITS.events) return;
    const rows = observed
      ? this.observedFills(observed)
      : (this.db
          .prepare(
            `SELECT id,slot,order_id,fill_id FROM events
      WHERE id>? AND origin='live' ORDER BY id LIMIT 4`,
          )
          .all(this.recoveryCursor) as RecoveryRow[]);
    if (!rows.length) {
      this.recoveryCursor = 0;
      return;
    }
    const ledger = new Database(ledgerPath, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      ledger.pragma("query_only=ON");
      ledger.pragma("busy_timeout=0");
      const until = performance.now() + 10;
      for (const row of rows) {
        if (performance.now() >= until) {
          this.quality("catchup_incomplete");
          break;
        }
        this.recoverRow(ledger, row, now, until);
        this.recoveryCursor = row.id;
      }
    } finally {
      ledger.close();
    }
  }
  private observedFills(packets: Packet[]): RecoveryRow[] {
    const find = this.db.prepare(
      "SELECT id,slot,order_id,fill_id FROM events WHERE kind='FillReceived' AND stable_id=? AND origin='live' AND slot=?",
    );
    const rows = packets
      .filter((p) => p.kind === "FillReceived")
      .map((p) => find.get(p.id, p.slot) as RecoveryRow | undefined)
      .filter((r) => r !== undefined);
    if (rows.length > 4) this.quality("catchup_incomplete");
    return rows.slice(0, 4);
  }
  private recoverRow(
    ledger: Database.Database,
    row: { slot: number; order_id: string | null; fill_id: string | null },
    now: number,
    until: number,
  ): void {
    const read = (kind: keyof typeof RECOVERY_SQL, key: string | null): Facts | undefined => {
      if (!key || performance.now() >= until) {
        this.quality("catchup_incomplete");
        return;
      }
      return ledger.prepare(RECOVERY_SQL[kind]).get(key) as Facts | undefined;
    };
    const order = read("order", row.order_id);
    const fill = read("fill", row.fill_id);
    const lot = fill ? read("lot", `lot-${fill.fillId}`) : undefined;
    const position = identifier(lot?.positionId)
      ? read("position", String(lot!.positionId))
      : undefined;
    // Ledger reads finish in autocommit before taking the short sidecar write transaction.
    this.db.transaction(() => this.applyRecovery(row.slot, order, fill, lot, position, now))();
  }
  private applyRecovery(
    slot: number,
    order: Facts | undefined,
    fill: Facts | undefined,
    lot: Facts | undefined,
    position: Facts | undefined,
    now: number,
  ): void {
    if (order) this.recovered(slot, "OrderPlaced", this.signedFacts(order), now);
    if (!fill) return;
    this.recovered(slot, "FillReceived", fill, now);
    const e = this.episodes().find((episode) => episode.slot === slot)!;
    if (lot?.fillId !== fill.fillId || lot?.tokenId !== e.token || !identifier(lot?.positionId)) {
      this.quality("link_unknown");
      return;
    }
    if (!position || position.tokenId !== e.token || position.conditionId !== e.condition) {
      this.quality("link_unknown");
      return;
    }
    this.bind(e, position, now);
  }
  private bind(e: Episode, position: Facts, now: number): void {
    const opened = Date.parse(String(position.openedAt));
    const intent = this.db
      .prepare(
        "SELECT received FROM events WHERE slot=? AND client=? AND kind='PlaceOrderRequested' ORDER BY id LIMIT 1",
      )
      .get(e.slot, e.client) as { received: number } | undefined;
    const duplicate = this.episodes().some(
      (other) => other.slot !== e.slot && other.position === position.positionId,
    );
    if (duplicate) {
      this.quality("link_ambiguous");
      this.db
        .prepare("UPDATE episodes SET ambiguous=1 WHERE slot=? OR position=?")
        .run(e.slot, position.positionId);
      return;
    }
    if (e.ambiguous) return;
    if (
      !intent ||
      !Number.isFinite(opened) ||
      opened < intent.received ||
      (e.position && e.position !== position.positionId)
    ) {
      this.quality("left_censored");
      this.db.prepare("UPDATE episodes SET ambiguous=1 WHERE slot=?").run(e.slot);
      return;
    }
    this.db.prepare("UPDATE episodes SET position=? WHERE slot=?").run(position.positionId, e.slot);
    this.recovered(e.slot, "PositionUpdated", position, now);
  }
  private recovered(slot: number, kind: Packet["kind"], facts: Facts, now: number): void {
    const source = Date.parse(String(facts.filledAt ?? facts.updatedAt));
    const id =
      kind === "FillReceived"
        ? String(facts.fillId)
        : createHash("sha256").update(JSON.stringify(facts)).digest("hex");
    this.capture({ slot, kind, facts, source, received: now, id }, "recovered", now);
  }
  private signedFacts(order: Facts): Facts {
    const signed = order.signed;
    delete order.signed;
    order.accepted = ["open", "partially-filled", "filled"].includes(String(order.status))
      ? true
      : null;
    order.preparedShares = null;
    order.submitAttempt = "unknown";
    if (typeof signed !== "string") return order;
    try {
      const value = JSON.parse(signed) as Facts;
      if (
        value.version === 1 &&
        value.orderId === order.orderId &&
        value.tokenId === order.tokenId &&
        value.side === order.side &&
        typeof value.shares === "number" &&
        Number.isFinite(value.shares)
      ) {
        order.preparedShares = value.shares;
        order.preparedLogicalSize =
          typeof value.logicalSize === "number" && Number.isFinite(value.logicalSize)
            ? value.logicalSize
            : null;
      }
    } catch {
      this.quality("invalid_field");
    }
    return order;
  }
}

// Every ledger statement has a known key, capped columns and a fully consumed result.
export const RECOVERY_SQL = {
  order: `SELECT substr(order_id,1,160) AS orderId, substr(client_order_id,1,160) AS clientOrderId,
    substr(token_id,1,160) AS tokenId, substr(condition_id,1,160) AS conditionId,
    substr(side,1,16) AS side, price, size, substr(status,1,32) AS status, substr(position_id,1,160) AS positionId,
    substr(updated_at,1,40) AS updatedAt,
    CASE WHEN length(metadata_json)<=32768 AND json_valid(metadata_json)
      THEN substr(json_extract(metadata_json,'$.signedOrderFactsV1'),1,1024) END AS signed
    FROM orders WHERE order_id=?`,
  fill: `SELECT substr(fill_id,1,160) AS fillId, substr(order_id,1,160) AS orderId,
    substr(token_id,1,160) AS tokenId, substr(condition_id,1,160) AS conditionId,
    substr(side,1,16) AS side,price,size,size_usdc AS sizeUsdc,fee,substr(filled_at,1,40) AS filledAt FROM fills WHERE fill_id=?`,
  lot: `SELECT substr(position_id,1,160) AS positionId,substr(token_id,1,160) AS tokenId,
    substr(fill_id,1,160) AS fillId FROM inventory_lots WHERE lot_id=?`,
  position: `SELECT substr(position_id,1,160) AS positionId,substr(token_id,1,160) AS tokenId,
    substr(condition_id,1,160) AS conditionId,size,substr(status,1,32) AS status,substr(opened_at,1,40) AS openedAt,
    substr(updated_at,1,40) AS updatedAt FROM positions WHERE position_id=?`,
} as const;
