# mcp-codebase-intelligence

Semantic code intelligence for AI assistants via Model Context Protocol (MCP).

## What It Does

Provides deep code understanding for TypeScript and JavaScript codebases through an MCP server. Parses your codebase with tree-sitter, builds a symbol graph in SQLite, and exposes semantic queries that AI assistants can use to navigate code, find references, trace dependencies, and understand architecture.

## Available Tools

| Tool | Description |
|------|-------------|
| `find_symbol` | Find symbols (functions, classes, interfaces, types, variables, methods) by name with full type information and location. Supports fuzzy matching. |
| `get_references` | Find all references to a symbol — who calls it, uses it, or depends on it. Supports transitive reference discovery. |
| `get_exports` | Get the public API surface of a file or module — all exported symbols with their types and signatures. |
| `get_dependencies` | Get the import/dependency graph for a file — what it imports and optionally what those files import (transitive). |
| `get_index_stats` | Get statistics about the indexed codebase — number of files, symbols, references, and imports. |
| `reindex` | Trigger a full re-index of the codebase. Useful after major changes or when results seem stale. |
| `analyze_change_impact` | Analyze what code is affected if specific lines are changed — returns affected symbols and their dependents. |
| `get_call_graph` | Get the call graph for a function — callers and callees with tree or mermaid diagram output. |

## Quick Start

### Installation

```bash
npm install
npm run build
```

### Running the Server

The server requires a `PROJECT_ROOT` environment variable pointing to the codebase you want to index:

```bash
PROJECT_ROOT=/path/to/your/project node dist/index.js
```

For development:

```bash
PROJECT_ROOT=/path/to/your/project npm run dev
```

## Configuration

### Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "codebase-intelligence": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-codebase-intelligence/dist/index.js"],
      "env": {
        "PROJECT_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

### Cursor / VS Code MCP

Add to your MCP settings file (`.cursor/mcp.json` or `.vscode/mcp.json`):

```json
{
  "mcpServers": {
    "codebase-intelligence": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-codebase-intelligence/dist/index.js"],
      "env": {
        "PROJECT_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

## Supported Languages

- TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`)
- JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`)
- Python (`.py`, `.pyi`)
- Go (`.go`)

## How It Works

1. **Tree-sitter Parsing**: Parses source files into abstract syntax trees (AST)
2. **Symbol Extraction**: Extracts functions, classes, interfaces, types, variables, methods, properties, and enums
3. **Relationship Tracking**: Tracks calls, references, imports, exports, extends/implements relationships
4. **SQLite Graph**: Stores symbols and relationships in a normalized SQLite database with recursive query support
5. **File Watching**: Monitors filesystem for changes and incrementally updates the index
6. **MCP Tools**: Exposes semantic queries through Model Context Protocol for AI assistant integration

The indexer uses a two-pass approach to handle self-referential symbols, and stores the graph in SQLite with WAL mode for better concurrent read performance.

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `PROJECT_ROOT` | Absolute path to the codebase to index | Yes | - |
| `DB_PATH` | Path to SQLite database file | No | `${PROJECT_ROOT}/.codegraph/index.db` |
| `LOG_LEVEL` | Logging verbosity (debug, info, warn, error) | No | `info` |

## License

MIT
