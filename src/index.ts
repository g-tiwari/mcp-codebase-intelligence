import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "path";
import { initializeDatabase } from "./graph/schema.js";
import { CodeGraph } from "./graph/code-graph.js";
import { FileWatcher } from "./indexer/file-watcher.js";
// Language plugins — imported for side-effect (registration)
import "./indexer/lang-python.js";
import "./indexer/lang-go.js";
import "./indexer/lang-rust.js";
import "./indexer/lang-java.js";
import { findSymbolTool, handleFindSymbol } from "./tools/find-symbol.js";
import { getReferencesTool, handleGetReferences } from "./tools/get-references.js";
import { getExportsTool, handleGetExports } from "./tools/get-exports.js";
import { getDependenciesTool, handleGetDependencies } from "./tools/get-dependencies.js";
import { getStatsTool, handleGetStats } from "./tools/get-stats.js";
import { reindexTool, handleReindex } from "./tools/reindex.js";
import { analyzeChangeImpactTool, handleAnalyzeChangeImpact } from "./tools/analyze-impact.js";
import { getCallGraphTool, handleGetCallGraph } from "./tools/get-call-graph.js";
import { gotoDefinitionTool, handleGotoDefinition } from "./tools/goto-definition.js";
import { getTypeInfoTool, handleGetTypeInfo } from "./tools/get-type-info.js";
import { findImplementationsTool, handleFindImplementations } from "./tools/find-implementations.js";
import { semanticDiffTool, handleSemanticDiff } from "./tools/semantic-diff.js";
import { architectureDiagramTool, handleArchitectureDiagram } from "./tools/architecture-diagram.js";
import { naturalLanguageQueryTool, handleNaturalLanguageQuery } from "./tools/natural-language-query.js";
import { LspManager } from "./lsp/lsp-manager.js";
import { logger } from "./utils/logger.js";
import { z } from "zod";

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const DB_PATH = process.env.DB_PATH || path.join(PROJECT_ROOT, ".codegraph", "index.db");

async function main() {
  // Validate PROJECT_ROOT exists and is a directory
  const { existsSync, statSync } = await import("fs");
  if (!existsSync(PROJECT_ROOT)) {
    logger.error(`PROJECT_ROOT does not exist: ${PROJECT_ROOT}`);
    process.exit(1);
  }
  if (!statSync(PROJECT_ROOT).isDirectory()) {
    logger.error(`PROJECT_ROOT is not a directory: ${PROJECT_ROOT}`);
    process.exit(1);
  }

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
    description: `Semantic code intelligence for the project at: ${PROJECT_ROOT}. All tools in this server operate on this indexed project, not the user's current working directory.`,
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
    () => handleGetStats(graph, PROJECT_ROOT)
  );

  server.tool(
    reindexTool.name,
    reindexTool.description,
    {},
    async () => handleReindex(watcher)
  );

  server.tool(
    analyzeChangeImpactTool.name,
    analyzeChangeImpactTool.description,
    {
      file_path: z.string().describe("Absolute path to the file being modified"),
      line_start: z.number().describe("Starting line number of the change (inclusive)"),
      line_end: z.number().describe("Ending line number of the change (inclusive)"),
      depth: z
        .number()
        .optional()
        .describe("How many levels of transitive dependents to follow (1 = direct only, default: 2, max: 10)"),
    },
    (args) => handleAnalyzeChangeImpact(graph, args)
  );

  server.tool(
    getCallGraphTool.name,
    getCallGraphTool.description,
    {
      function_name: z.string().describe("Name of the function to get the call graph for"),
      direction: z
        .enum(["callers", "callees", "both"])
        .optional()
        .describe("Direction of the graph (default: both)"),
      depth: z.number().optional().describe("How many levels to traverse (default: 2, max: 5)"),
      format: z
        .enum(["tree", "mermaid"])
        .optional()
        .describe("Output format (default: tree)"),
    },
    (args) => handleGetCallGraph(graph, args)
  );

  // Register LSP-powered tools
  const lspManager = new LspManager(PROJECT_ROOT);

  server.tool(
    gotoDefinitionTool.name,
    gotoDefinitionTool.description,
    {
      file_path: z.string().describe("Absolute path to the file"),
      line: z.number().describe("Line number (1-based)"),
      character: z.number().describe("Column number (0-based)"),
    },
    (args) => handleGotoDefinition(lspManager, args)
  );

  server.tool(
    getTypeInfoTool.name,
    getTypeInfoTool.description,
    {
      file_path: z.string().describe("Absolute path to the file"),
      line: z.number().describe("Line number (1-based)"),
      character: z.number().describe("Column number (0-based)"),
    },
    (args) => handleGetTypeInfo(lspManager, args)
  );

  server.tool(
    findImplementationsTool.name,
    findImplementationsTool.description,
    {
      file_path: z.string().describe("Absolute path to the file containing the interface/abstract method"),
      line: z.number().describe("Line number (1-based)"),
      character: z.number().describe("Column number (0-based)"),
    },
    (args) => handleFindImplementations(lspManager, args)
  );

  server.tool(
    semanticDiffTool.name,
    semanticDiffTool.description,
    {
      git_ref: z.string().optional().describe("Git ref to diff against (e.g. 'HEAD~1', 'HEAD~5', 'main', 'staged', 'unstaged'). Preferred over passing raw diff text."),
      diff: z.string().optional().describe("Raw unified diff text. Only use if git_ref is not applicable."),
      depth: z.number().optional().describe("Transitive dependency depth (default: 2, max: 5)"),
    },
    (args) => handleSemanticDiff(graph, args, PROJECT_ROOT)
  );

  server.tool(
    architectureDiagramTool.name,
    architectureDiagramTool.description,
    {
      scope: z.string().optional().describe("Optional: limit diagram to files under this path prefix"),
      max_depth: z.number().optional().describe("Maximum directory nesting depth for subgraph grouping (default: 2)"),
      format: z.enum(["mermaid", "text"]).optional().describe("Output format (default: mermaid)"),
    },
    (args) => handleArchitectureDiagram(graph, args, PROJECT_ROOT)
  );

  server.tool(
    naturalLanguageQueryTool.name,
    naturalLanguageQueryTool.description,
    {
      query: z.string().describe("Natural language question about the codebase"),
    },
    (args) => handleNaturalLanguageQuery(graph, args)
  );

  // Perform initial indexing (tree-sitter — fast)
  await watcher.initialIndex();
  watcher.startWatching();

  // Start LSP servers in background (slow — don't block MCP)
  lspManager.start().then(() => {
    const servers = lspManager.getActiveServers();
    if (servers.length > 0) {
      logger.info(`LSP servers active: ${servers.join(", ")}`);
    } else {
      logger.info("No LSP servers started (tools still work via tree-sitter)");
    }
  }).catch((err) => {
    logger.warn("LSP startup failed (non-fatal)", err);
  });

  // Start MCP server on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("MCP server running on stdio");

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await watcher.stop();
    await lspManager.stop();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
