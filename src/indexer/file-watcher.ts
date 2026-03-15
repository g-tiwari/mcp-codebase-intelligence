import { watch, type FSWatcher } from "chokidar";
import { glob } from "glob";
import path from "path";
import { parseFile } from "./tree-sitter-indexer.js";
import { getAllExtensions } from "./language-plugin.js";
import { CodeGraph } from "../graph/code-graph.js";
import { logger } from "../utils/logger.js";

const IGNORE_PATTERNS = [
  "**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/coverage/**",
  "**/__pycache__/**", "**/venv/**", "**/.venv/**",
  "**/target/**", "**/out/**", "**/.gradle/**", "**/.mvn/**",
];

function isTargetFile(filePath: string): boolean {
  const extensions = getAllExtensions();
  return extensions.some((ext) => filePath.endsWith(ext));
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private indexing = false;
  private rootPaths: string[];

  constructor(
    rootPathOrPaths: string | string[],
    private graph: CodeGraph
  ) {
    this.rootPaths = Array.isArray(rootPathOrPaths) ? rootPathOrPaths : [rootPathOrPaths];
  }

  async initialIndex(): Promise<void> {
    if (this.indexing) return;
    this.indexing = true;

    logger.info(`Starting initial index of ${this.rootPaths.length} root(s): ${this.rootPaths.join(", ")}`);
    const startTime = Date.now();

    try {
      const extensions = getAllExtensions();
      const patterns = extensions.map((ext) => `**/*${ext}`);
      const files: string[] = [];

      for (const rootPath of this.rootPaths) {
        for (const pattern of patterns) {
          const matched = await glob(pattern, {
            cwd: rootPath,
            absolute: true,
            ignore: IGNORE_PATTERNS,
          });
          files.push(...matched);
        }
      }

      // Deduplicate (in case roots overlap)
      const uniqueFiles = [...new Set(files)];
      logger.info(`Found ${uniqueFiles.length} files to index`);

      // Parse all files first (CPU-bound, tree-sitter)
      const parseStart = Date.now();
      const parsed: Array<{ filePath: string; content: string; symbols: import("../graph/code-graph.js").SymbolInfo[]; references: import("../graph/code-graph.js").ReferenceInfo[]; imports: import("../graph/code-graph.js").ImportInfo[] }> = [];
      for (const file of uniqueFiles) {
        const result = parseFile(file);
        if (result) {
          parsed.push({ filePath: file, content: result.content, symbols: result.symbols, references: result.references, imports: result.imports });
        }
      }
      const parseElapsed = Date.now() - parseStart;

      // Batch insert into DB (single transaction — much faster for large repos)
      const dbStart = Date.now();
      const { indexed, skipped } = this.graph.indexFileBatch(parsed);
      const dbElapsed = Date.now() - dbStart;

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      const stats = this.graph.getStats();
      logger.info(
        `Initial index complete in ${elapsed}s (parse: ${parseElapsed}ms, db: ${dbElapsed}ms): ` +
        `${stats.files} files, ${stats.symbols} symbols, ${stats.references} references` +
        (skipped > 0 ? ` (${skipped} unchanged)` : "")
      );
    } finally {
      this.indexing = false;
    }
  }

  startWatching(): void {
    const extensions = getAllExtensions();
    const watchPatterns: string[] = [];
    for (const rootPath of this.rootPaths) {
      for (const ext of extensions) {
        watchPatterns.push(path.join(rootPath, "**", `*${ext}`));
      }
    }

    this.watcher = watch(watchPatterns, {
      ignored: IGNORE_PATTERNS,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.watcher
      .on("add", (filePath) => this.handleFileChange(filePath))
      .on("change", (filePath) => this.handleFileChange(filePath))
      .on("unlink", (filePath) => this.handleFileRemove(filePath));

    logger.info(`Watching for file changes in ${this.rootPaths.length} root(s)`);
  }

  private handleFileChange(filePath: string) {
    if (!isTargetFile(filePath)) return;
    logger.debug(`File changed: ${filePath}`);
    const result = parseFile(filePath);
    if (result) {
      this.graph.indexFile(filePath, result.content, result.symbols, result.references, result.imports);
    }
  }

  private handleFileRemove(filePath: string) {
    if (!isTargetFile(filePath)) return;
    logger.debug(`File removed: ${filePath}`);
    this.graph.removeFile(filePath);
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      logger.info("File watcher stopped");
    }
  }
}
