import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  assertBounceForAllOwnershipInvariant,
  BounceForAllNullOwnerError,
  countActiveNullOwnerPositions,
} from "../assert-bounce-for-all-invariant.js";

describe("assertBounceForAllOwnershipInvariant (Release A Phase 5 startup guard)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE positions (position_id TEXT PRIMARY KEY, status TEXT, exit_owner TEXT)`);
  });
  afterEach(() => db.close());

  function insert(rows: { id: string; status: string; exitOwner: string | null }[]) {
    const stmt = db.prepare(
      "INSERT INTO positions (position_id, status, exit_owner) VALUES (?, ?, ?)",
    );
    for (const r of rows) stmt.run(r.id, r.status, r.exitOwner);
  }

  it("is a no-op when applyToAllMarkets is false, even with a NULL-owner open position", () => {
    insert([{ id: "p1", status: "open", exitOwner: null }]);
    expect(() => assertBounceForAllOwnershipInvariant(db, false)).not.toThrow();
  });

  it("passes when applyToAllMarkets is true and every active/dust position has an owner", () => {
    insert([
      { id: "p1", status: "open", exitOwner: "bounce" },
      { id: "p2", status: "dust", exitOwner: "profile" },
      { id: "p3", status: "closed", exitOwner: null }, // closed NULL owner does not count
    ]);
    expect(() => assertBounceForAllOwnershipInvariant(db, true)).not.toThrow();
  });

  it("throws when applyToAllMarkets is true and an OPEN NULL-owner position exists", () => {
    insert([{ id: "p1", status: "open", exitOwner: null }]);
    expect(() => assertBounceForAllOwnershipInvariant(db, true)).toThrow(
      BounceForAllNullOwnerError,
    );
  });

  it("throws when applyToAllMarkets is true and a DUST NULL-owner position exists", () => {
    insert([{ id: "p1", status: "dust", exitOwner: null }]);
    let thrown: unknown;
    try {
      assertBounceForAllOwnershipInvariant(db, true);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BounceForAllNullOwnerError);
    expect((thrown as BounceForAllNullOwnerError).nullOwners).toBe(1);
  });

  it("counts only active/dust NULL owners", () => {
    insert([
      { id: "p1", status: "open", exitOwner: null },
      { id: "p2", status: "dust", exitOwner: null },
      { id: "p3", status: "closed", exitOwner: null },
      { id: "p4", status: "open", exitOwner: "bounce" },
    ]);
    expect(countActiveNullOwnerPositions(db)).toBe(2);
  });
});
