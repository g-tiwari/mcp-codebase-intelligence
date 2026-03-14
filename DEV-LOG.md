# Development Log: mcp-codebase-intelligence

## Phase 1 — Status: IN PROGRESS

### What's Done

- [x] Project scaffolding (TypeScript, npm, tsconfig)
- [x] SQLite schema with tables: files, symbols, references_, imports
- [x] `CodeGraph` class — insert/query engine with recursive CTEs
- [x] Tree-sitter indexer for TypeScript/TSX/JavaScript/JSX
  - Extracts: functions, classes, interfaces, types, enums, methods, properties, variables
  - Tracks: call references, extends/implements, imports, new expressions
  - Handles: export detection, arrow functions, member expressions, nested scopes
- [x] File watcher (chokidar) — initial index + incremental updates
- [x] MCP server with stdio transport
- [x] 6 MCP tools registered and working:
  - `find_symbol` — fuzzy name search with kind/scope filters
  - `get_references` — transitive reference chain via recursive CTE
  - `get_exports` — module public API surface
  - `get_dependencies` — import graph with transitive option
  - `get_index_stats` — codebase statistics
  - `reindex` — full re-index trigger

### Smoke Test Results (self-indexing)

- Indexed 12 source files in 0.05s
- Found 200 symbols, 283 references, 44 imports
- `find_symbol("CodeGraph")` — correctly found class with signature
- `get_references("logger.info")` — found 11 call sites across 4 files
- `get_references("parseFile")` — found 2 callers in file-watcher.ts
- MCP initialize handshake working
- tools/list returns all 6 tools with schemas

### What's Left for Phase 1

- [ ] Test against a real external project (not just self-indexing)
- [ ] Handle edge cases: re-exports, barrel files, dynamic imports
- [ ] Better error messages when project root doesn't exist
- [ ] Add `analyze_change_impact` tool (lines -> affected symbols)
- [ ] README with usage instructions and Claude Code config example

### Key Architecture Decisions

- **Two-pass symbol insertion**: symbols inserted without parent FK first, then parent updated in second pass (avoids FK constraint issues with self-referential table)
- **references_.to_file_id has no FK**: we store symbol names as strings for cross-file references since files may not be indexed yet
- **Logs go to stderr**: stdout is reserved for MCP JSON-RPC protocol
- **SQLite WAL mode**: better concurrent read performance

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
