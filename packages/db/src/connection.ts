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

  return {
    db,
    close() {
      db.close();
    },
  };
}

export function openDatabaseWithSchema(
  dbPath: string,
  schemaSql: string,
): DbConnection {
  const conn = openDatabase(dbPath);
  conn.db.exec(schemaSql);
  return conn;
}
