import Database from "better-sqlite3";

export interface DbConnection {
  db: Database.Database;
  close(): void;
}

export function openDatabase(dbPath: string): DbConnection {
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  return {
    db,
    close() {
      db.close();
    },
  };
}
