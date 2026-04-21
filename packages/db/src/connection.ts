import Database from "better-sqlite3";

export interface DbConnection {
  db: Database.Database;
  close(): void;
}

export function openDatabase(dbPath: string): DbConnection {
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 15000");
  db.pragma("synchronous = NORMAL");
  // -2048 = 2 MiB per connection (negative = KiB). Default is 2000 pages ≈ 8 MiB.
  // Runtime + API each open this DB, so the default adds ~16 MiB of resident
  // RSS that the working set doesn't need. 2 MiB is plenty for our query shape.
  db.pragma("cache_size = -2048");

  return {
    db,
    close() {
      db.close();
    },
  };
}

export function openDatabaseWithSchema(dbPath: string, schemaSql: string): DbConnection {
  const conn = openDatabase(dbPath);
  conn.db.exec(schemaSql);
  return conn;
}
