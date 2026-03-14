# Roadmap: Path to 50k Stars

## Current State
- Core engine complete (Phases 1–4)
- 11 MCP tools, 6 languages (TS, JS, Python, Go, Rust, Java)
- LSP integration for TS/JS
- Performance optimized (batch indexing, prepared stmts, hash cache)
- Tested on real projects: Zod, Express, gin, ripgrep, gson

---

## Priority 1: Remove Adoption Barriers

### npm publish + zero-config setup (1 day)
- `npx mcp-codebase-intelligence` — just works, no build step
- Auto-detect project root (walk up to nearest `.git`)
- One-line install in Claude Code / Cursor / VS Code settings
- Publish to npm registry

### Tests + CI (1–2 days)
- Unit tests for each language plugin (parse known snippets, assert symbols)
- Integration tests (index → query → verify results)
- GitHub Actions CI pipeline

### README rewrite + demo GIF (half day)
- 10-second screen recording showing AI using the tools
- "Why" section before "How" — the value pitch
- Before/after comparison table
- One-command quick start
- Badges (npm version, CI status, license)

---

## Priority 2: Killer Features

### Semantic diff / PR review tool (1–2 days)
- Feed it a `git diff`, get structured impact analysis
- "These 3 changed functions affect 12 downstream dependents in 5 files"
- This is the feature people screenshot and share

### Architecture diagram tool (1 day)
- Auto-generate mermaid diagram of module dependencies
- Visual wow factor for README and demos

### Natural language queries (1–2 days)
- "Find all API endpoints"
- "Show me the auth flow"
- "What modules depend on the database layer?"

---

## Priority 3: Accuracy & Coverage

### Upgrade tree-sitter grammars (1 day)
- Rust: 18% parse failure rate with v0.21.0 on modern syntax
- Java: 3% failure rate
- Upgrade tree-sitter core + all grammars to latest compatible versions

### More languages (1 day each)
- C/C++ via tree-sitter-c / tree-sitter-cpp
- Swift, Kotlin, Ruby — the long tail matters

### Multi-language LSP (1–2 days)
- Python LSP via pyright
- Go LSP via gopls
- Currently only TS/JS has LSP support

### Accuracy improvements
- Scope-aware reference matching (not just name-based)
- Monorepo awareness (workspaces, packages)

---

## Priority 4: Scale & Distribution

### Performance at true scale (1–2 days)
- Test at 10k–50k files
- Worker thread parallelism for parsing
- Streaming/pagination for large result sets
- Memory profiling

### VS Code extension (2–3 days)
- Most developers aren't using MCP yet
- Extension brings this to mainstream audience

---

## Priority 5: Community & Growth

### Documentation
- `CONTRIBUTING.md`
- "Add a new language" plugin guide
- `examples/` directory with sample queries

### Launch
- Blog post / launch story
- Demo video (2–3 min)
- Post on HN, Twitter/X, Reddit r/programming
- Discord or GitHub Discussions

---

## The 70/30 Rule

The engine is ~30% of what makes a 50k-star project. The other 70% is:
- **Packaging** — zero-friction install
- **Docs** — README that sells, not just explains
- **That one feature** — semantic diff/PR review is the most shareable
- **Marketing** — demo GIF, blog post, social proof

The #1 thing to build next: **semantic diff tool + npm publish + README rewrite**. That combination makes it installable, useful, and shareable.
