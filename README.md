# mcp-codebase-intelligence

**Give your AI assistant a deep understanding of your codebase.**

[![CI](https://github.com/g-tiwari/mcp-codebase-intelligence/actions/workflows/ci.yml/badge.svg)](https://github.com/g-tiwari/mcp-codebase-intelligence/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An MCP server that parses your entire codebase with tree-sitter, builds a semantic graph of symbols, references, and dependencies, and lets AI assistants query it in real time. Works with Claude Code, Cursor, VS Code, and any MCP-compatible client.

---

## Why?

AI coding assistants are limited by what fits in their context window. When they need to understand your codebase -- find callers of a function, trace a dependency chain, or assess the impact of a change -- they resort to `grep` and guesswork.

**mcp-codebase-intelligence gives them structural understanding instead.**

| Without | With |
|---------|------|
| AI greps for function name, misses qualified calls | AI queries the symbol graph, finds all 47 callers instantly |
| AI reads files one by one to trace imports | AI gets the full dependency tree in one call |
| AI reviews a PR by reading the diff | AI analyzes which 12 downstream modules are affected by the change |
| AI guesses at project structure | AI generates an architecture diagram from the actual import graph |

---

## Quick Start

### One-liner (no clone needed)

```bash
# Add to Claude Code via npx
claude mcp add codebase-intelligence \
  npx mcp-codebase-intelligence \
  -e PROJECT_ROOT=/path/to/your/project
```

### JSON config (Claude Code, Cursor, VS Code)

Add to your MCP config file:

```json
{
  "mcpServers": {
    "codebase-intelligence": {
      "command": "npx",
      "args": ["mcp-codebase-intelligence"],
      "env": {
        "PROJECT_ROOT": "/path/to/your/project"
      }
    }
  }
}
```

### From source (for development)

```bash
git clone https://github.com/g-tiwari/mcp-codebase-intelligence.git
cd mcp-codebase-intelligence
npm install && npm run build

claude mcp add codebase-intelligence \
  node /path/to/mcp-codebase-intelligence/dist/index.js \
  -e PROJECT_ROOT=/path/to/your/project
```

That's it. The server indexes your codebase on startup and watches for changes.

---

## 14 Tools

### Code Navigation
| Tool | What it does |
|------|-------------|
| `find_symbol` | Search for functions, classes, interfaces, types by name. Fuzzy matching, kind/scope filters. |
| `get_references` | Find all callers/users of a symbol. Transitive: follow the chain N levels deep. |
| `get_exports` | Public API surface of any file -- all exported symbols with signatures. |
| `get_dependencies` | Import graph for a file. Transitive: see the full dependency tree. |
| `get_call_graph` | Who calls this function? What does it call? Tree or mermaid diagram output. |

### Code Intelligence (LSP-powered)
| Tool | What it does |
|------|-------------|
| `goto_definition` | Jump to the definition of any symbol at a given position (TS/JS). |
| `get_type_info` | Get the inferred type of any expression at a given position (TS/JS). |
| `find_implementations` | Find all implementations of an interface or abstract method (TS/JS). |

### Change Analysis
| Tool | What it does |
|------|-------------|
| `semantic_diff` | Feed it `git diff` output. It identifies affected symbols, finds all downstream dependents, and flags breaking changes and high-impact modifications. |
| `analyze_change_impact` | Point it at specific lines in a file. It tells you which symbols are affected and who depends on them. |

### Architecture & Discovery
| Tool | What it does |
|------|-------------|
| `architecture_diagram` | Auto-generate a mermaid diagram of module dependencies, grouped by directory. |
| `query_codebase` | Ask natural language questions: "find all API endpoints", "what does the orders module do?", "what depends on the database layer?" |

### Admin
| Tool | What it does |
|------|-------------|
| `get_index_stats` | How many files, symbols, references, and imports are indexed. |
| `reindex` | Trigger a full re-index after major changes. |

---

## 6 Languages

| Language | Extensions | Parser |
|----------|-----------|--------|
| TypeScript | `.ts` `.tsx` `.mts` `.cts` | tree-sitter + LSP |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | tree-sitter + LSP |
| Python | `.py` `.pyi` | tree-sitter |
| Go | `.go` | tree-sitter |
| Rust | `.rs` | tree-sitter |
| Java | `.java` | tree-sitter |

All languages get symbol extraction, reference tracking, import/export analysis, and call graphs. TypeScript/JavaScript additionally get LSP-powered go-to-definition, type info, and find-implementations.

---

## How It Works

```
Source Files ──> tree-sitter AST ──> Symbol Extraction ──> SQLite Graph
                                                              │
                                    File Watcher ─────────────┤ (incremental updates)
                                                              │
                                    MCP Tools ◄───────────────┘ (AI queries)
                                        │
                                    LSP Servers ──> Type Info (TS/JS)
```

1. **Parse** -- tree-sitter builds ASTs for all supported files
2. **Extract** -- language plugins walk the AST to find symbols, references, imports, inheritance
3. **Store** -- everything goes into a SQLite database with WAL mode, prepared statements, batch transactions
4. **Watch** -- chokidar monitors the filesystem; changed files are re-indexed incrementally
5. **Query** -- MCP tools run recursive SQL queries against the graph (transitive references, dependency chains)
6. **LSP** -- typescript-language-server provides type-aware intelligence for TS/JS

### Performance

- **Batch indexing** with single-transaction writes
- **Prepared statement cache** -- 14 SQL statements prepared once at startup
- **In-memory hash cache** -- skip DB lookups for unchanged files
- **Incremental updates** -- only re-index files that actually changed

Tested on real-world projects: Zod, Express, gin, ripgrep, gson.

---

## Testing

```bash
npm test
```

108 tests across 8 test suites covering all 6 language parsers, grammar regression tests, the graph engine, and semantic diff.

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PROJECT_ROOT` | Path to the codebase to index (required) | `cwd()` |
| `DB_PATH` | Path to SQLite database file | `$PROJECT_ROOT/.codegraph/index.db` |
| `LOG_LEVEL` | Logging verbosity: debug, info, warn, error | `info` |

---

## License

MIT
