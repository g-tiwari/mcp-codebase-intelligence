#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// Language plugins — imported for side-effect (registration)
import "./indexer/lang-python.js";
import "./indexer/lang-go.js";
import "./indexer/lang-rust.js";
import "./indexer/lang-java.js";
import "./indexer/lang-cpp.js";
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
import { searchCodebaseTool, handleSearchCodebase } from "./tools/search-codebase.js";
import {
  listProjectsTool, handleListProjects,
  switchProjectTool, handleSwitchProject,
  addProjectTool, handleAddProject,
} from "./tools/project-tools.js";
import { ProjectManager } from "./project-manager.js";
import { logger } from "./utils/logger.js";
import { z } from "zod";

async function main() {
  // Initialize project manager (handles all config resolution)
  const pm = new ProjectManager();
  await pm.initialize();

  const active = pm.active;
  if (!active) {
    logger.error("No valid project roots found. Set PROJECT_ROOT, PROJECT_ROOTS, or create .codegraph.json");
    process.exit(1);
  }

  const projectDesc = pm.listProjects().map(p =>
    `${p.name}${p.active ? " (active)" : ""}: ${p.roots.join(", ")}`
  ).join("; ");

  // Create MCP server
  const server = new McpServer({
    name: "codebase-intelligence",
    version: "0.3.0",
    description: `Semantic code intelligence. Projects: ${projectDesc}. Use list_projects to see all projects and switch_project to change context.`,
  });

  // Helper to get active graph/project (throws clear error if none)
  function getActive() {
    const a = pm.active;
    if (!a) throw new Error("No active project. Use list_projects and switch_project.");
    return a;
  }

  // --- Project management tools ---

  server.tool(
    listProjectsTool.name,
    listProjectsTool.description,
    {},
    () => handleListProjects(pm)
  );

  server.tool(
    switchProjectTool.name,
    switchProjectTool.description,
    {
      project_name: z.string().describe("Name of the project to switch to"),
    },
    (args) => handleSwitchProject(pm, args)
  );

  server.tool(
    addProjectTool.name,
    addProjectTool.description,
    {
      project_name: z.string().describe("Name for the new project"),
      root: z.string().optional().describe("Single root path (for a repo or monorepo)"),
      roots: z.string().optional().describe("Comma-separated root paths (for multi-repo projects)"),
      include: z.string().optional().describe("Comma-separated relative paths to include within root (for monorepo scoping)"),
    },
    (args) => handleAddProject(pm, args)
  );

  // --- Code navigation tools ---

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
    (args) => handleFindSymbol(getActive().graph, args)
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
    (args) => handleGetReferences(getActive().graph, args)
  );

  server.tool(
    getExportsTool.name,
    getExportsTool.description,
    {
      file_path: z.string().describe("Absolute path to the file to inspect"),
    },
    (args) => handleGetExports(getActive().graph, args)
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
    (args) => handleGetDependencies(getActive().graph, args)
  );

  server.tool(
    getStatsTool.name,
    getStatsTool.description,
    {},
    () => handleGetStats(getActive().graph, pm.getPrimaryRoot() || undefined)
  );

  server.tool(
    reindexTool.name,
    reindexTool.description,
    {},
    async () => handleReindex(getActive().watcher)
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
    (args) => handleAnalyzeChangeImpact(getActive().graph, args)
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
    (args) => handleGetCallGraph(getActive().graph, args)
  );

  // --- LSP-powered tools ---

  server.tool(
    gotoDefinitionTool.name,
    gotoDefinitionTool.description,
    {
      file_path: z.string().describe("Absolute path to the file"),
      line: z.number().describe("Line number (1-based)"),
      character: z.number().describe("Column number (0-based)"),
    },
    (args) => handleGotoDefinition(getActive().lspManager, args)
  );

  server.tool(
    getTypeInfoTool.name,
    getTypeInfoTool.description,
    {
      file_path: z.string().describe("Absolute path to the file"),
      line: z.number().describe("Line number (1-based)"),
      character: z.number().describe("Column number (0-based)"),
    },
    (args) => handleGetTypeInfo(getActive().lspManager, args)
  );

  server.tool(
    findImplementationsTool.name,
    findImplementationsTool.description,
    {
      file_path: z.string().describe("Absolute path to the file containing the interface/abstract method"),
      line: z.number().describe("Line number (1-based)"),
      character: z.number().describe("Column number (0-based)"),
    },
    (args) => handleFindImplementations(getActive().lspManager, args)
  );

  // --- Change analysis tools ---

  server.tool(
    semanticDiffTool.name,
    semanticDiffTool.description,
    {
      git_ref: z.string().optional().describe("Git ref to diff against (e.g. 'HEAD~1', 'HEAD~5', 'main', 'staged', 'unstaged'). Preferred over passing raw diff text."),
      diff: z.string().optional().describe("Raw unified diff text. Only use if git_ref is not applicable."),
      depth: z.number().optional().describe("Transitive dependency depth (default: 2, max: 5)"),
    },
    (args) => handleSemanticDiff(getActive().graph, args, pm.getPrimaryRoot() || undefined)
  );

  // --- Architecture & discovery tools ---

  server.tool(
    architectureDiagramTool.name,
    architectureDiagramTool.description,
    {
      scope: z.string().optional().describe("Optional: limit diagram to files under this path prefix"),
      max_depth: z.number().optional().describe("Maximum directory nesting depth for subgraph grouping (default: 2)"),
      format: z.enum(["mermaid", "text"]).optional().describe("Output format (default: mermaid)"),
    },
    (args) => handleArchitectureDiagram(getActive().graph, args, pm.getPrimaryRoot() || undefined)
  );

  server.tool(
    naturalLanguageQueryTool.name,
    naturalLanguageQueryTool.description,
    {
      query: z.string().describe("Natural language question about the codebase"),
    },
    (args) => handleNaturalLanguageQuery(getActive().graph, args)
  );

  server.tool(
    searchCodebaseTool.name,
    searchCodebaseTool.description,
    {
      query: z.string().describe("Text to search for in docstrings/comments"),
      kind: z
        .enum(["function", "class", "interface", "type", "variable", "method", "enum", "property"])
        .optional()
        .describe("Optional: filter by symbol kind"),
      scope: z.string().optional().describe("Optional: limit search to files under this path prefix"),
      limit: z.number().optional().describe("Maximum results to return (default: 20)"),
    },
    (args) => handleSearchCodebase(getActive().graph, args)
  );

  // --- Start indexing and MCP server ---

  await pm.startAll();

  // Start MCP server on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("MCP server running on stdio");

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await pm.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
