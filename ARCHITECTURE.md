# Architecture: mcp-codebase-intelligence

## Overview

An MCP server that provides semantic code understanding by parsing TypeScript/JavaScript
codebases with tree-sitter and exposing structured queries via MCP tools.

## Directory Structure

```
src/
  index.ts              - Entry point, MCP server setup
  indexer/
    tree-sitter-indexer.ts - Parses files with tree-sitter, extracts symbols & relationships
    file-watcher.ts     - Watches filesystem for changes, triggers re-indexing
  graph/
    schema.ts           - SQLite schema definition
    code-graph.ts       - Graph storage & query engine (SQLite)
  tools/
    find-symbol.ts      - MCP tool: find symbols by name/kind
    get-references.ts   - MCP tool: find all references/callers of a symbol
    get-call-graph.ts   - MCP tool: call graph traversal
    analyze-impact.ts   - MCP tool: change impact analysis
    get-exports.ts      - MCP tool: module public API surface
    get-dependencies.ts - MCP tool: import/dependency graph
  utils/
    logger.ts           - Logging utility
```

## Data Model (SQLite)

### Tables

- **files** - tracked files with hash for change detection
- **symbols** - all symbols (functions, classes, interfaces, types, variables, methods)
- **references** - symbol-to-symbol references (calls, imports, type usage)
- **exports** - module export declarations

### Key Queries

- find_symbol: SELECT from symbols with fuzzy name match + optional kind/scope filter
- get_references: Recursive CTE traversing references table
- get_call_graph: Directional traversal (callers/callees) of references where kind='call'
- analyze_change_impact: Starting from symbols in changed lines, traverse references transitively

## Indexing Pipeline

1. File watcher detects change
2. Tree-sitter parses file into AST
3. Visitor walks AST extracting symbols and references
4. Symbols/references upserted into SQLite
5. Old entries for the file are cleaned up (delta update)

## Phase 1 Scope (Current)

- Tree-sitter parsing for TypeScript/JavaScript
- SQLite-backed code graph
- MCP tools: find_symbol, get_references
- File watcher for incremental updates
- stdio MCP transport
