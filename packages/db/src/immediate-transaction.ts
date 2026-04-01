import type Database from "better-sqlite3";

/**
 * Run a callback inside a BEGIN IMMEDIATE transaction.
 *
 * Why IMMEDIATE instead of DEFERRED (the better-sqlite3 default):
 * - DEFERRED transactions that read then write cause "upgrade deadlocks"
 *   where busy_timeout is bypassed and SQLITE_BUSY fires immediately.
 * - IMMEDIATE acquires the write lock upfront, so busy_timeout works
 *   correctly when another process holds the lock.
 *
 * Use this for any multi-statement write operation.
 */
export function withImmediate<T>(db: Database.Database, fn: (db: Database.Database) => T): T {
  return db.transaction(fn).immediate(db);
}
