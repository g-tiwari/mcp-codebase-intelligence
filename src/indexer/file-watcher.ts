import { watch, type FSWatcher } from "chokidar";
import { glob } from "glob";
import path from "path";
import { parseFile } from "./tree-sitter-indexer.js";
import { getAllExtensions } from "./language-plugin.js";
import { CodeGraph } from "../graph/code-graph.js";
import { logger } from "../utils/logger.js";

const IGNORE_PATTERNS = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/coverage/**", "**/__pycache__/**", "**/venv/**", "**/.venv/**"];

function isTargetFile(filePath: string): boolean {
  const extensions = getAllExtensions();
  return extensions.some((ext) => filePath.endsWith(ext));
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private indexing = false;

  constructor(
    private rootPath: string,
    private graph: CodeGraph
  ) {}

  async initialIndex(): Promise<void> {
    if (this.indexing) return;
    this.indexing = true;

    logger.info(`Starting initial index of ${this.rootPath}`);
    const startTime = Date.now();

    try {
      const extensions = getAllExtensions();
      const patterns = extensions.map((ext) => `**/*${ext}`);
      const files: string[] = [];

      for (const pattern of patterns) {
        const matched = await glob(pattern, {
          cwd: this.rootPath,
          absolute: true,
          ignore: IGNORE_PATTERNS,
        });
        files.push(...matched);
      }

      logger.info(`Found ${files.length} files to index`);

      let indexed = 0;
      for (const file of files) {
        const result = parseFile(file);
        if (result) {
          this.graph.indexFile(file, result.content, result.symbols, result.references, result.imports);
          indexed++;
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      const stats = this.graph.getStats();
      logger.info(`Initial index complete in ${elapsed}s: ${stats.files} files, ${stats.symbols} symbols, ${stats.references} references`);
    } finally {
      this.indexing = false;
    }
  }

  startWatching(): void {
    const extensions = getAllExtensions();
    const watchPatterns = extensions.map((ext) => path.join(this.rootPath, "**", `*${ext}`));

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

    logger.info(`Watching for file changes in ${this.rootPath}`);
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
