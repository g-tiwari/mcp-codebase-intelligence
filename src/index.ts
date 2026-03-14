import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "path";
import { initializeDatabase } from "./graph/schema.js";
import { CodeGraph } from "./graph/code-graph.js";
import { FileWatcher } from "./indexer/file-watcher.js";
import { findSymbolTool, handleFindSymbol } from "./tools/find-symbol.js";
import { getReferencesTool, handleGetReferences } from "./tools/get-references.js";
import { getExportsTool, handleGetExports } from "./tools/get-exports.js";
import { getDependenciesTool, handleGetDependencies } from "./tools/get-dependencies.js";
import { getStatsTool, handleGetStats } from "./tools/get-stats.js";
import { reindexTool, handleReindex } from "./tools/reindex.js";
import { logger } from "./utils/logger.js";
import { z } from "zod";

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const DB_PATH = process.env.DB_PATH || path.join(PROJECT_ROOT, ".codegraph", "index.db");

async function main() {
  logger.info(`Starting mcp-codebase-intelligence for ${PROJECT_ROOT}`);

  // Ensure DB directory exists
  const { mkdirSync } = await import("fs");
  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  // Initialize database and graph
  const db = initializeDatabase(DB_PATH);
  const graph = new CodeGraph(db);
  const watcher = new FileWatcher(PROJECT_ROOT, graph);

  // Create MCP server
  const server = new McpServer({
    name: "codebase-intelligence",
    version: "0.1.0",
  });

  // Register tools
  server.tool(
    findSymbolTool.name,
    findSymbolTool.description,
    {
      name: z.string().describe("Symbol name to search for (supports partial matching)"),
      kind: z
        .enum(["function", "class", "interface", "type", "variable", "method", "enum", "property"])
        .optional()
        .describe("Optional: filter by symbol kind"),
      scope: z.string().optional().describe("Optional: limit search to files under this path prefix"),
      limit: z.number().optional().describe("Maximum results to return (default: 20)"),
    },
    (args) => handleFindSymbol(graph, args)
  );

  server.tool(
    getReferencesTool.name,
    getReferencesTool.description,
    {
      symbol_name: z.string().describe("Name of the symbol to find references for"),
      depth: z
        .number()
        .optional()
        .describe("How many levels of transitive references to follow (1 = direct only, default: 1, max: 10)"),
    },
    (args) => handleGetReferences(graph, args)
  );

  server.tool(
    getExportsTool.name,
    getExportsTool.description,
    {
      file_path: z.string().describe("Absolute path to the file to inspect"),
    },
    (args) => handleGetExports(graph, args)
  );

  server.tool(
    getDependenciesTool.name,
    getDependenciesTool.description,
    {
      file_path: z.string().describe("Absolute path to the file to inspect"),
      depth: z
        .number()
        .optional()
        .describe("How many levels of transitive dependencies to follow (default: 1, max: 5)"),
    },
    (args) => handleGetDependencies(graph, args)
  );

  server.tool(
    getStatsTool.name,
    getStatsTool.description,
    {},
    () => handleGetStats(graph)
  );

  server.tool(
    reindexTool.name,
    reindexTool.description,
    {},
    async () => handleReindex(watcher)
  );

  // Perform initial indexing
  await watcher.initialIndex();
  watcher.startWatching();

  // Start MCP server on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("MCP server running on stdio");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    await watcher.stop();
    db.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Shutting down...");
    await watcher.stop();
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
