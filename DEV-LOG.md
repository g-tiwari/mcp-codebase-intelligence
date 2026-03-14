# Development Log: mcp-codebase-intelligence

## Phase 1 — Status: COMPLETE

### Git History

- `bb6d055` — initial MCP server with 6 tools
- `ae49be3` — add analyze_change_impact tool + README
- `d9ef0ed` — re-exports, barrel files, dynamic imports, require calls + PROJECT_ROOT validation
- `52277dd` — Phase 1 complete dev log
- `2e54065` — real-world test results (Express, Zod) and known limitations
- `524f4eb` — 3-level reference matching + CJS exports (major fix)
- `5275381` — updated test results
- `b406ca5` — Phase 2: Python, Go, get_call_graph, plugin architecture

## Phase 2 — Status: COMPLETE

### What's Done

- [x] Plugin architecture (`LanguagePlugin` interface with auto-registration)
- [x] Python support (functions, classes, methods, imports, decorators, inheritance)
- [x] Go support (functions, methods with receivers, structs, interfaces, imports, capitalized exports)
- [x] `get_call_graph` tool (callers + callees, tree/mermaid output)
- [x] File watcher dynamically picks up extensions from all registered plugins

### Test Results

**Python — requests library (33 files)**
- 471 symbols, 1005 references, 315 imports
- `find_symbol("Session")` — found with inheritance chain
- `get_exports("api.py")` — 8 exports with full Python signatures
- `get_references("get")` — 36 results

**Go — gin web framework (94 files)**
- 1219 symbols, 5600 references, 436 imports
- `find_symbol("Engine")` — found struct type
- `get_exports("gin.go")` — 34 exports with Go signatures including receiver types
- `get_call_graph("New")` — callers: dozens of tests; callees: Engine, RouterGroup, Context instantiations (mermaid diagram)

## Phase 3 (LSP Integration) — Status: COMPLETE

### What's Done

- [x] LSP JSON-RPC client (`lsp-client.ts`) — Content-Length framing, request/response matching, 30s timeout
- [x] LSP manager (`lsp-manager.ts`) — auto-detects project type, npx fallback if binary not in PATH
- [x] Non-blocking startup — LSP starts in background after tree-sitter indexing
- [x] 3 new MCP tools:
  - `goto_definition` — resolves definition at file:line:character, shows surrounding code context
  - `get_type_info` — hover info + type definition location
  - `find_implementations` — find all implementations of interface/abstract method
- [x] Bug fix: `require("child_process")` in ESM module — replaced with proper `import { execFile }`

### Git History

- `b406ca5` — Phase 2: Python, Go, get_call_graph, plugin architecture
- *(LSP integration committed next)*

### Test Results

**LSP Startup (self-index)**
- typescript-language-server detected via npx fallback
- LSP initialized in ~300ms after tree-sitter indexing
- `goto_definition` on `CodeGraph` — resolves to import declaration
- `get_type_info` (hover) — returns `import CodeGraph` type info
- Clean shutdown with graceful LSP stop

### What's Next (Phase 4)

- [ ] Performance optimization for large repos (>10k files)
- [ ] Rust support via tree-sitter-rust
- [ ] Java support via tree-sitter-java

---

### What's Done (Phase 1)

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

### Real-World Test Results

**Express.js (CJS, 141 files)**
- Indexed: 2029 symbols, 2094 refs, 399 imports
- `find_symbol("createApplication")` — found correctly
- `get_exports("lib/express.js")` — found 10 CJS exports (application, request, response, Route, Router, json, etc.)
- `get_references("render")` — found view.render() call in application.js

**Zod (TypeScript monorepo, 386 files)**
- Indexed: 6253 symbols, 8961 refs, 1434 imports
- `find_symbol("parse")` — found 10 matches across packages
- `get_references("parse")` — 200 results (schema.parse(), zod3.parse(), etc.)
- `get_references("z")` — 200 results (z.array(), z.string(), z.boolean(), etc.)
- `get_references("safeParse")` — 200 results across packages

**Self-index (13 files)**
- `get_references("logger")` — 18 results (all logger.info/error/debug calls)
- `get_references("graph")` — 9 results (all graph.* method calls across tools)

**Reference Matching Strategy (3-level)**
1. Exact: `to_symbol_name = "query"` — plain function calls
2. Bare name: `to_symbol_bare_name = "query"` — last segment of `obj.query()`
3. Prefix: `to_symbol_name LIKE "query.%"` — all member access on the object

### What's Next (Phase 2)

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
  index.ts                    — MCP server entry point (11 tools registered)
  graph/
    schema.ts                 — SQLite schema (files, symbols, references_, imports)
    code-graph.ts             — Graph storage + query engine
  indexer/
    language-plugin.ts        — Plugin interface + registry
    tree-sitter-indexer.ts    — TS/JS plugin (auto-registers on import)
    lang-python.ts            — Python plugin
    lang-go.ts                — Go plugin
    file-watcher.ts           — File discovery + incremental watching
  lsp/
    lsp-client.ts             — LSP JSON-RPC client over stdio
    lsp-manager.ts            — Auto-detect, lifecycle, npx fallback
  tools/
    find-symbol.ts            — find_symbol tool
    get-references.ts         — get_references tool
    get-exports.ts            — get_exports tool
    get-dependencies.ts       — get_dependencies tool
    get-stats.ts              — get_index_stats tool
    reindex.ts                — reindex tool
    analyze-impact.ts         — analyze_change_impact tool
    get-call-graph.ts         — get_call_graph tool (tree/mermaid)
    goto-definition.ts        — goto_definition tool (LSP)
    get-type-info.ts          — get_type_info tool (LSP)
    find-implementations.ts   — find_implementations tool (LSP)
  utils/
    logger.ts                 — stderr JSON logger
```
