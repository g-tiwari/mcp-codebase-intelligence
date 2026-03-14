# Development Log: mcp-codebase-intelligence

## Phase 1 — Status: COMPLETE

### Git History

- `bb6d055` — initial MCP server with 6 tools
- `ae49be3` — add analyze_change_impact tool + README
- `d9ef0ed` — handle re-exports, barrel files, dynamic imports, require calls + PROJECT_ROOT validation

### What's Done

- [x] Project scaffolding (TypeScript, npm, tsconfig)
- [x] SQLite schema with tables: files, symbols, references_, imports
- [x] `CodeGraph` class — insert/query engine with recursive CTEs
- [x] Tree-sitter indexer for TypeScript/TSX/JavaScript/JSX
  - Extracts: functions, classes, interfaces, types, enums, methods, properties, variables
  - Tracks: call references, extends/implements, imports, new expressions
  - Handles: export detection, arrow functions, member expressions, nested scopes
  - Edge cases: re-exports, barrel files (`export { default as X }`), `export *`, dynamic imports, require()
- [x] File watcher (chokidar) — initial index + incremental updates
- [x] MCP server with stdio transport
- [x] PROJECT_ROOT validation with clear error messages
- [x] 7 MCP tools registered and working:
  - `find_symbol` — fuzzy name search with kind/scope filters
  - `get_references` — transitive reference chain via recursive CTE
  - `get_exports` — module public API surface
  - `get_dependencies` — import graph with transitive option
  - `get_index_stats` — codebase statistics
  - `reindex` — full re-index trigger
  - `analyze_change_impact` — lines -> affected symbols -> dependents
- [x] README with Claude Code + Cursor config examples

### Smoke Test Results (self-indexing, post-edge-case fixes)

- Indexed 13 source files in 0.05s
- Found 245 symbols, 354 references, 47 imports
- `find_symbol("CodeGraph")` — correctly found class with signature
- `get_references("logger.info")` — found 11 call sites across 4 files
- `get_references("parseFile")` — found 2 callers in file-watcher.ts
- `analyze_change_impact(code-graph.ts, 36-50)` — found 6 affected symbols, 1 dependent
- Invalid PROJECT_ROOT — clean error message, immediate exit

### What's Next (Phase 2)

- [ ] Test against a large real-world project (e.g., Express, Next.js)
- [ ] LSP integration for richer semantic data (tsserver)
- [ ] Python support via pyright/pylsp
- [ ] Go support via gopls
- [ ] `get_call_graph` tool with mermaid output
- [ ] Performance optimization for large repos (>10k files)

### Key Architecture Decisions

- **Two-pass symbol insertion**: symbols inserted without parent FK first, then parent updated in second pass (avoids FK constraint issues with self-referential table)
- **references_.to_file_id has no FK**: we store symbol names as strings for cross-file references since files may not be indexed yet
- **Logs go to stderr**: stdout is reserved for MCP JSON-RPC protocol
- **SQLite WAL mode**: better concurrent read performance
- **CodeGraph.getDb()**: public accessor for direct SQL queries from tools (used by analyze-impact)

### How to Run

```bash
# Development
PROJECT_ROOT=/path/to/your/project npx tsx src/index.ts

# Production
npm run build
PROJECT_ROOT=/path/to/your/project node dist/index.js

# Claude Code config (add to settings)
# "mcpServers": {
#   "codebase-intelligence": {
#     "command": "node",
#     "args": ["/path/to/mcp-codebase-intelligence/dist/index.js"],
#     "env": { "PROJECT_ROOT": "/path/to/your/project" }
#   }
# }
```

### Dependencies

- `@modelcontextprotocol/sdk` ^1.27.1 — MCP protocol
- `tree-sitter` ^0.21.1 + `tree-sitter-typescript` ^0.23.2 — AST parsing
- `better-sqlite3` ^12.8.0 — graph storage
- `chokidar` ^5.0.0 — file watching
- `glob` ^13.0.6 — file discovery
- `zod` ^3.25 — schema validation for MCP tools

### File Structure

```
src/
  index.ts                    — MCP server entry point (7 tools registered)
  graph/
    schema.ts                 — SQLite schema (files, symbols, references_, imports)
    code-graph.ts             — Graph storage + query engine
  indexer/
    tree-sitter-indexer.ts    — AST parser (TS/TSX/JS/JSX) with edge case handling
    file-watcher.ts           — File discovery + incremental watching
  tools/
    find-symbol.ts            — find_symbol tool
    get-references.ts         — get_references tool
    get-exports.ts            — get_exports tool
    get-dependencies.ts       — get_dependencies tool
    get-stats.ts              — get_index_stats tool
    reindex.ts                — reindex tool
    analyze-impact.ts         — analyze_change_impact tool
  utils/
    logger.ts                 — stderr JSON logger
```
