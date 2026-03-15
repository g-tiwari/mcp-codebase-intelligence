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
  docstring?: string;
}

export interface ReferenceInfo {
  fromSymbolId: number;
  toSymbolName: string;
  toSymbolBareName: string;
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
  // Prepared statement cache — avoids re-preparing on every call
  private stmts!: ReturnType<CodeGraph["prepareStatements"]>;
  // In-memory hash cache — avoids DB lookup on unchanged files
  private hashCache = new Map<string, string>();

  constructor(private db: Database.Database) {
    this.stmts = this.prepareStatements();
  }

  private prepareStatements() {
    return {
      getFileId: this.db.prepare("SELECT id FROM files WHERE path = ?"),
      getFileHash: this.db.prepare("SELECT hash FROM files WHERE path = ?"),
      updateFile: this.db.prepare("UPDATE files SET hash = ?, indexed_at = datetime('now') WHERE id = ?"),
      insertFile: this.db.prepare("INSERT INTO files (path, hash) VALUES (?, ?)"),
      deleteSymbols: this.db.prepare("DELETE FROM symbols WHERE file_id = ?"),
      deleteImports: this.db.prepare("DELETE FROM imports WHERE file_id = ?"),
      insertSymbol: this.db.prepare(
        `INSERT INTO symbols (name, kind, file_id, line_start, line_end, col_start, col_end, parent_symbol_id, signature, is_exported, docstring)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      updateParent: this.db.prepare("UPDATE symbols SET parent_symbol_id = ? WHERE id = ?"),
      insertRef: this.db.prepare(
        `INSERT INTO references_ (from_symbol_id, to_symbol_name, to_symbol_bare_name, to_file_id, kind, line, col)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ),
      insertImport: this.db.prepare(
        `INSERT INTO imports (file_id, source_path, imported_name, local_name, is_default, is_namespace, line)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ),
      deleteFile: this.db.prepare("DELETE FROM files WHERE id = ?"),
      countFiles: this.db.prepare("SELECT COUNT(*) as c FROM files"),
      countSymbols: this.db.prepare("SELECT COUNT(*) as c FROM symbols"),
      countRefs: this.db.prepare("SELECT COUNT(*) as c FROM references_"),
      countImports: this.db.prepare("SELECT COUNT(*) as c FROM imports"),
    };
  }

  getDb(): Database.Database {
    return this.db;
  }

  fileHash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  getFileId(filePath: string): number | undefined {
    const row = this.stmts.getFileId.get(filePath) as { id: number } | undefined;
    return row?.id;
  }

  getFileHash(filePath: string): string | undefined {
    // Check in-memory cache first
    const cached = this.hashCache.get(filePath);
    if (cached) return cached;
    const row = this.stmts.getFileHash.get(filePath) as { hash: string } | undefined;
    if (row) this.hashCache.set(filePath, row.hash);
    return row?.hash;
  }

  upsertFile(filePath: string, hash: string): number {
    const existing = this.getFileId(filePath);
    if (existing) {
      this.stmts.updateFile.run(hash, existing);
      this.hashCache.set(filePath, hash);
      return existing;
    }
    const result = this.stmts.insertFile.run(filePath, hash);
    this.hashCache.set(filePath, hash);
    return result.lastInsertRowid as number;
  }

  clearFileData(fileId: number) {
    this.stmts.deleteSymbols.run(fileId);
    this.stmts.deleteImports.run(fileId);
  }

  insertSymbol(fileId: number, symbol: SymbolInfo): number {
    const result = this.stmts.insertSymbol.run(
      symbol.name,
      symbol.kind,
      fileId,
      symbol.lineStart,
      symbol.lineEnd,
      symbol.colStart,
      symbol.colEnd,
      symbol.parentSymbolId ?? null,
      symbol.signature ?? null,
      symbol.isExported ? 1 : 0,
      symbol.docstring ?? null
    );
    return result.lastInsertRowid as number;
  }

  insertReference(ref: ReferenceInfo) {
    this.stmts.insertRef.run(
      ref.fromSymbolId, ref.toSymbolName, ref.toSymbolBareName,
      ref.toFileId ?? null, ref.kind, ref.line, ref.col
    );
  }

  insertImport(fileId: number, imp: ImportInfo) {
    this.stmts.insertImport.run(
      fileId, imp.sourcePath, imp.importedName, imp.localName,
      imp.isDefault ? 1 : 0, imp.isNamespace ? 1 : 0, imp.line
    );
  }

  /**
   * Index a single file. Wraps in a transaction.
   * For batch indexing many files, use indexFileBatch() instead.
   */
  indexFile(filePath: string, content: string, symbols: SymbolInfo[], references: ReferenceInfo[], imports: ImportInfo[]) {
    const hash = this.fileHash(content);
    const existingHash = this.getFileHash(filePath);
    if (existingHash === hash) {
      logger.debug(`Skipping unchanged file: ${filePath}`);
      return;
    }

    const tx = this.db.transaction(() => {
      this._indexFileInner(filePath, hash, symbols, references, imports);
    });

    tx();
  }

  /**
   * Batch-index many files in a single transaction.
   * Much faster for initial indexing of large repos.
   */
  indexFileBatch(files: Array<{ filePath: string; content: string; symbols: SymbolInfo[]; references: ReferenceInfo[]; imports: ImportInfo[] }>) {
    let indexed = 0;
    let skipped = 0;

    const tx = this.db.transaction(() => {
      for (const file of files) {
        const hash = this.fileHash(file.content);
        const existingHash = this.getFileHash(file.filePath);
        if (existingHash === hash) {
          skipped++;
          continue;
        }
        this._indexFileInner(file.filePath, hash, file.symbols, file.references, file.imports);
        indexed++;
      }
    });

    tx();
    return { indexed, skipped };
  }

  private _indexFileInner(filePath: string, hash: string, symbols: SymbolInfo[], references: ReferenceInfo[], imports: ImportInfo[]) {
    const fileId = this.upsertFile(filePath, hash);
    this.clearFileData(fileId);

    // First pass: insert all symbols without parent references
    const symbolIdMap = new Map<number, number>();
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      const savedParent = sym.parentSymbolId;
      sym.parentSymbolId = undefined;
      const id = this.insertSymbol(fileId, sym);
      symbolIdMap.set(i, id);
      sym.parentSymbolId = savedParent;
    }

    // Second pass: update parent references now that all symbols have real IDs
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      if (sym.parentSymbolId !== undefined) {
        const realParentId = symbolIdMap.get(sym.parentSymbolId);
        const realId = symbolIdMap.get(i);
        if (realParentId !== undefined && realId !== undefined) {
          this.stmts.updateParent.run(realParentId, realId);
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
  }

  removeFile(filePath: string) {
    const fileId = this.getFileId(filePath);
    if (fileId) {
      this.stmts.deleteFile.run(fileId);
      this.hashCache.delete(filePath);
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
    docstring: string | null;
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
             s.col_start as colStart, s.col_end as colEnd, s.signature, s.is_exported as isExported,
             s.docstring
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
      docstring: string | null;
    }>;
  }

  searchByDocstring(query: string, options?: {
    kind?: string;
    scope?: string;
    limit?: number;
  }): Array<{
    name: string;
    kind: string;
    filePath: string;
    lineStart: number;
    lineEnd: number;
    signature: string | null;
    docstring: string | null;
    isExported: boolean;
  }> {
    const conditions: string[] = ["s.docstring IS NOT NULL AND s.docstring LIKE ?"];
    const params: unknown[] = [`%${query}%`];

    if (options?.kind) {
      conditions.push("s.kind = ?");
      params.push(options.kind);
    }
    if (options?.scope) {
      conditions.push("f.path LIKE ?");
      params.push(`${options.scope}%`);
    }

    const limit = options?.limit ?? 50;
    const where = `WHERE ${conditions.join(" AND ")}`;

    const sql = `
      SELECT s.name, s.kind, f.path as filePath, s.line_start as lineStart, s.line_end as lineEnd,
             s.signature, s.docstring, s.is_exported as isExported
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      ${where}
      ORDER BY s.is_exported DESC, f.path
      LIMIT ?
    `;

    params.push(limit);

    return this.db.prepare(sql).all(...params) as Array<{
      name: string;
      kind: string;
      filePath: string;
      lineStart: number;
      lineEnd: number;
      signature: string | null;
      docstring: string | null;
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
        -- Match against both full qualified name and bare name
        SELECT s.name, s.kind, f.path, s.line_start, r.to_symbol_name, r.kind, r.line, r.col, 1
        FROM references_ r
        JOIN symbols s ON r.from_symbol_id = s.id
        JOIN files f ON s.file_id = f.id
        WHERE r.to_symbol_name = ?
           OR r.to_symbol_bare_name = ?
           OR r.to_symbol_name LIKE (? || '.%')

        UNION ALL

        -- Recursive case: who references the symbols that reference our target
        SELECT s.name, s.kind, f.path, s.line_start, r.to_symbol_name, r.kind, r.line, r.col, rc.depth + 1
        FROM references_ r
        JOIN symbols s ON r.from_symbol_id = s.id
        JOIN files f ON s.file_id = f.id
        JOIN ref_chain rc ON r.to_symbol_name = rc.from_symbol_name
                          OR r.to_symbol_bare_name = rc.from_symbol_name
                          OR r.to_symbol_name LIKE (rc.from_symbol_name || '.%')
        WHERE rc.depth < ?
      )
      SELECT from_symbol_name as fromSymbol, from_kind as fromKind, from_file as fromFile,
             from_line as fromLine, to_name as toSymbol, ref_kind as refKind,
             ref_line as refLine, ref_col as refCol, depth
      FROM ref_chain
      ORDER BY depth, from_file, ref_line
      LIMIT 200
    `;

    return this.db.prepare(sql).all(symbolName, symbolName, symbolName, depth) as Array<{
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
    const files = (this.stmts.countFiles.get() as { c: number }).c;
    const symbols = (this.stmts.countSymbols.get() as { c: number }).c;
    const references = (this.stmts.countRefs.get() as { c: number }).c;
    const imports = (this.stmts.countImports.get() as { c: number }).c;
    return { files, symbols, references, imports };
  }
}
