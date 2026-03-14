import Database from "better-sqlite3";

export function initializeDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      col_start INTEGER NOT NULL,
      col_end INTEGER NOT NULL,
      parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
      signature TEXT,
      is_exported INTEGER NOT NULL DEFAULT 0,
      UNIQUE(name, kind, file_id, line_start)
    );

    CREATE TABLE IF NOT EXISTS references_ (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      to_symbol_name TEXT NOT NULL,
      to_file_id INTEGER,
      kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      col INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      source_path TEXT NOT NULL,
      imported_name TEXT NOT NULL,
      local_name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_namespace INTEGER NOT NULL DEFAULT 0,
      line INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
    CREATE INDEX IF NOT EXISTS idx_refs_from ON references_(from_symbol_id);
    CREATE INDEX IF NOT EXISTS idx_refs_to_name ON references_(to_symbol_name);
    CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
    CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source_path);
  `);

  return db;
}
