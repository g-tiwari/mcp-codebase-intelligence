import Database from "better-sqlite3";
import { createHash } from "crypto";
import { logger } from "../utils/logger.js";

export interface SymbolInfo {
  name: string;
  kind: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  colStart: number;
  colEnd: number;
  parentSymbolId?: number;
  signature?: string;
  isExported: boolean;
}

export interface ReferenceInfo {
  fromSymbolId: number;
  toSymbolName: string;
  toFileId?: number;
  kind: string;
  line: number;
  col: number;
}

export interface ImportInfo {
  sourcePath: string;
  importedName: string;
  localName: string;
  isDefault: boolean;
  isNamespace: boolean;
  line: number;
}

export class CodeGraph {
  constructor(private db: Database.Database) {}

  getDb(): Database.Database {
    return this.db;
  }

  fileHash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  getFileId(filePath: string): number | undefined {
    const row = this.db.prepare("SELECT id FROM files WHERE path = ?").get(filePath) as
      | { id: number }
      | undefined;
    return row?.id;
  }

  getFileHash(filePath: string): string | undefined {
    const row = this.db.prepare("SELECT hash FROM files WHERE path = ?").get(filePath) as
      | { hash: string }
      | undefined;
    return row?.hash;
  }

  upsertFile(filePath: string, hash: string): number {
    const existing = this.getFileId(filePath);
    if (existing) {
      this.db
        .prepare("UPDATE files SET hash = ?, indexed_at = datetime('now') WHERE id = ?")
        .run(hash, existing);
      return existing;
    }
    const result = this.db
      .prepare("INSERT INTO files (path, hash) VALUES (?, ?)")
      .run(filePath, hash);
    return result.lastInsertRowid as number;
  }

  clearFileData(fileId: number) {
    this.db.prepare("DELETE FROM symbols WHERE file_id = ?").run(fileId);
    this.db.prepare("DELETE FROM imports WHERE file_id = ?").run(fileId);
  }

  insertSymbol(fileId: number, symbol: SymbolInfo): number {
    const result = this.db
      .prepare(
        `INSERT INTO symbols (name, kind, file_id, line_start, line_end, col_start, col_end, parent_symbol_id, signature, is_exported)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        symbol.name,
        symbol.kind,
        fileId,
        symbol.lineStart,
        symbol.lineEnd,
        symbol.colStart,
        symbol.colEnd,
        symbol.parentSymbolId ?? null,
        symbol.signature ?? null,
        symbol.isExported ? 1 : 0
      );
    return result.lastInsertRowid as number;
  }

  insertReference(ref: ReferenceInfo) {
    this.db
      .prepare(
        `INSERT INTO references_ (from_symbol_id, to_symbol_name, to_file_id, kind, line, col)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(ref.fromSymbolId, ref.toSymbolName, ref.toFileId ?? null, ref.kind, ref.line, ref.col);
  }

  insertImport(fileId: number, imp: ImportInfo) {
    this.db
      .prepare(
        `INSERT INTO imports (file_id, source_path, imported_name, local_name, is_default, is_namespace, line)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        fileId,
        imp.sourcePath,
        imp.importedName,
        imp.localName,
        imp.isDefault ? 1 : 0,
        imp.isNamespace ? 1 : 0,
        imp.line
      );
  }

  indexFile(filePath: string, content: string, symbols: SymbolInfo[], references: ReferenceInfo[], imports: ImportInfo[]) {
    const hash = this.fileHash(content);
    const existingHash = this.getFileHash(filePath);
    if (existingHash === hash) {
      logger.debug(`Skipping unchanged file: ${filePath}`);
      return;
    }

    const tx = this.db.transaction(() => {
      const fileId = this.upsertFile(filePath, hash);
      this.clearFileData(fileId);

      // First pass: insert all symbols without parent references
      const symbolIdMap = new Map<number, number>();
      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        // Temporarily clear parent — we'll set it in the second pass
        const savedParent = sym.parentSymbolId;
        sym.parentSymbolId = undefined;
        const id = this.insertSymbol(fileId, sym);
        symbolIdMap.set(i, id);
        sym.parentSymbolId = savedParent;
      }

      // Second pass: update parent references now that all symbols have real IDs
      const updateParent = this.db.prepare(
        "UPDATE symbols SET parent_symbol_id = ? WHERE id = ?"
      );
      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        if (sym.parentSymbolId !== undefined) {
          const realParentId = symbolIdMap.get(sym.parentSymbolId);
          const realId = symbolIdMap.get(i);
          if (realParentId !== undefined && realId !== undefined) {
            updateParent.run(realParentId, realId);
          }
        }
      }

      for (const ref of references) {
        const mappedFromId = symbolIdMap.get(ref.fromSymbolId) ?? ref.fromSymbolId;
        this.insertReference({ ...ref, fromSymbolId: mappedFromId });
      }

      for (const imp of imports) {
        this.insertImport(fileId, imp);
      }

      logger.info(`Indexed ${filePath}: ${symbols.length} symbols, ${references.length} refs, ${imports.length} imports`);
    });

    tx();
  }

  removeFile(filePath: string) {
    const fileId = this.getFileId(filePath);
    if (fileId) {
      this.db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
      logger.info(`Removed file from index: ${filePath}`);
    }
  }

  // --- Query methods ---

  findSymbols(query: {
    name?: string;
    kind?: string;
    scope?: string;
    limit?: number;
  }): Array<{
    name: string;
    kind: string;
    filePath: string;
    lineStart: number;
    lineEnd: number;
    colStart: number;
    colEnd: number;
    signature: string | null;
    isExported: boolean;
  }> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.name) {
      conditions.push("s.name LIKE ?");
      params.push(`%${query.name}%`);
    }
    if (query.kind) {
      conditions.push("s.kind = ?");
      params.push(query.kind);
    }
    if (query.scope) {
      conditions.push("f.path LIKE ?");
      params.push(`${query.scope}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ?? 50;

    const sql = `
      SELECT s.name, s.kind, f.path as filePath, s.line_start as lineStart, s.line_end as lineEnd,
             s.col_start as colStart, s.col_end as colEnd, s.signature, s.is_exported as isExported
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      ${where}
      ORDER BY
        CASE WHEN s.name = ? THEN 0 ELSE 1 END,
        s.is_exported DESC,
        f.path
      LIMIT ?
    `;

    params.push(query.name ?? "", limit);

    return this.db.prepare(sql).all(...params) as Array<{
      name: string;
      kind: string;
      filePath: string;
      lineStart: number;
      lineEnd: number;
      colStart: number;
      colEnd: number;
      signature: string | null;
      isExported: boolean;
    }>;
  }

  getReferences(symbolName: string, depth: number = 1): Array<{
    fromSymbol: string;
    fromKind: string;
    fromFile: string;
    fromLine: number;
    toSymbol: string;
    refKind: string;
    refLine: number;
    refCol: number;
    depth: number;
  }> {
    if (depth < 1) depth = 1;
    if (depth > 10) depth = 10;

    const sql = `
      WITH RECURSIVE ref_chain(from_symbol_name, from_kind, from_file, from_line, to_name, ref_kind, ref_line, ref_col, depth) AS (
        -- Base case: direct references to the target symbol
        SELECT s.name, s.kind, f.path, s.line_start, r.to_symbol_name, r.kind, r.line, r.col, 1
        FROM references_ r
        JOIN symbols s ON r.from_symbol_id = s.id
        JOIN files f ON s.file_id = f.id
        WHERE r.to_symbol_name = ?

        UNION ALL

        -- Recursive case: who references the symbols that reference our target
        SELECT s.name, s.kind, f.path, s.line_start, r.to_symbol_name, r.kind, r.line, r.col, rc.depth + 1
        FROM references_ r
        JOIN symbols s ON r.from_symbol_id = s.id
        JOIN files f ON s.file_id = f.id
        JOIN ref_chain rc ON r.to_symbol_name = rc.from_symbol_name
        WHERE rc.depth < ?
      )
      SELECT from_symbol_name as fromSymbol, from_kind as fromKind, from_file as fromFile,
             from_line as fromLine, to_name as toSymbol, ref_kind as refKind,
             ref_line as refLine, ref_col as refCol, depth
      FROM ref_chain
      ORDER BY depth, from_file, ref_line
      LIMIT 200
    `;

    return this.db.prepare(sql).all(symbolName, depth) as Array<{
      fromSymbol: string;
      fromKind: string;
      fromFile: string;
      fromLine: number;
      toSymbol: string;
      refKind: string;
      refLine: number;
      refCol: number;
      depth: number;
    }>;
  }

  getExports(filePath: string): Array<{
    name: string;
    kind: string;
    lineStart: number;
    signature: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT s.name, s.kind, s.line_start as lineStart, s.signature
         FROM symbols s
         JOIN files f ON s.file_id = f.id
         WHERE f.path = ? AND s.is_exported = 1
         ORDER BY s.line_start`
      )
      .all(filePath) as Array<{
      name: string;
      kind: string;
      lineStart: number;
      signature: string | null;
    }>;
  }

  getImports(filePath: string): Array<{
    sourcePath: string;
    importedName: string;
    localName: string;
    isDefault: boolean;
    isNamespace: boolean;
    line: number;
  }> {
    return this.db
      .prepare(
        `SELECT source_path as sourcePath, imported_name as importedName, local_name as localName,
                is_default as isDefault, is_namespace as isNamespace, line
         FROM imports
         JOIN files f ON imports.file_id = f.id
         WHERE f.path = ?
         ORDER BY line`
      )
      .all(filePath) as Array<{
      sourcePath: string;
      importedName: string;
      localName: string;
      isDefault: boolean;
      isNamespace: boolean;
      line: number;
    }>;
  }

  getDependencyGraph(filePath: string, depth: number = 2): Array<{
    file: string;
    imports: string;
    depth: number;
  }> {
    const sql = `
      WITH RECURSIVE dep_tree(file_path, imports_from, depth) AS (
        SELECT f.path, i.source_path, 1
        FROM imports i
        JOIN files f ON i.file_id = f.id
        WHERE f.path = ?

        UNION ALL

        SELECT f.path, i.source_path, dt.depth + 1
        FROM imports i
        JOIN files f ON i.file_id = f.id
        JOIN dep_tree dt ON f.path LIKE ('%' || dt.imports_from || '%')
        WHERE dt.depth < ?
      )
      SELECT file_path as file, imports_from as imports, depth
      FROM dep_tree
      ORDER BY depth, file_path
      LIMIT 100
    `;

    return this.db.prepare(sql).all(filePath, depth) as Array<{
      file: string;
      imports: string;
      depth: number;
    }>;
  }

  getStats(): { files: number; symbols: number; references: number; imports: number } {
    const files = (this.db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number }).c;
    const symbols = (this.db.prepare("SELECT COUNT(*) as c FROM symbols").get() as { c: number }).c;
    const references = (this.db.prepare("SELECT COUNT(*) as c FROM references_").get() as { c: number }).c;
    const imports = (this.db.prepare("SELECT COUNT(*) as c FROM imports").get() as { c: number }).c;
    return { files, symbols, references, imports };
  }
}
