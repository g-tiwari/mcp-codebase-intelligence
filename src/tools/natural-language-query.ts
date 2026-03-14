import { CodeGraph } from "../graph/code-graph.js";

export const naturalLanguageQueryTool = {
  name: "query_codebase",
  description:
    "Answer natural language questions about the codebase structure. Examples: 'Find all API endpoints', 'Show the auth flow', 'What modules depend on the database layer?', 'List all exported classes', 'What does the orders module do?'. Translates questions into graph queries.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Natural language question about the codebase",
      },
    },
    required: ["query"],
  },
};

interface QueryIntent {
  type:
    | "find_endpoints"
    | "find_classes"
    | "find_functions"
    | "find_interfaces"
    | "find_exports"
    | "dependency_of"
    | "dependents_of"
    | "module_summary"
    | "entry_points"
    | "largest_files"
    | "symbol_search";
  target?: string;
}

export function handleNaturalLanguageQuery(
  graph: CodeGraph,
  args: { query: string }
) {
  const query = args.query.toLowerCase().trim();
  const intent = classifyIntent(query);
  const db = graph.getDb();

  let text: string;

  switch (intent.type) {
    case "find_endpoints":
      text = findEndpoints(db);
      break;
    case "find_classes":
      text = findByKind(db, "class", intent.target);
      break;
    case "find_functions":
      text = findByKind(db, "function", intent.target);
      break;
    case "find_interfaces":
      text = findByKind(db, "interface", intent.target);
      break;
    case "find_exports":
      text = findExports(db, intent.target);
      break;
    case "dependency_of":
      text = dependencyOf(graph, intent.target!);
      break;
    case "dependents_of":
      text = dependentsOf(graph, intent.target!);
      break;
    case "module_summary":
      text = moduleSummary(db, intent.target);
      break;
    case "entry_points":
      text = findEntryPoints(db);
      break;
    case "largest_files":
      text = findLargestFiles(db);
      break;
    case "symbol_search":
      text = symbolSearch(graph, intent.target ?? query);
      break;
  }

  return {
    content: [{ type: "text" as const, text }],
  };
}

function classifyIntent(query: string): QueryIntent {
  // Endpoints / routes / API
  if (/\b(endpoint|route|api|handler|controller)\b/.test(query)) {
    return { type: "find_endpoints" };
  }

  // Classes
  if (/\b(class|classes)\b/.test(query) && !/depend/.test(query)) {
    const target = extractTarget(query);
    return { type: "find_classes", target };
  }

  // Interfaces
  if (/\b(interface|interfaces|contract)\b/.test(query)) {
    const target = extractTarget(query);
    return { type: "find_interfaces", target };
  }

  // Functions
  if (/\b(function|functions|method|methods)\b/.test(query) && !/depend/.test(query)) {
    const target = extractTarget(query);
    return { type: "find_functions", target };
  }

  // Exports
  if (/\b(export|exports|public api)\b/.test(query)) {
    const target = extractTarget(query);
    return { type: "find_exports", target };
  }

  // Dependency / imports: "what does X depend on" / "what does X import"
  if (/\b(depend on|depends on|import|imports from|uses)\b/.test(query)) {
    const target = extractTarget(query);
    if (target) return { type: "dependency_of", target };
  }

  // Dependents: "what depends on X" / "who uses X" / "what references X"
  if (/\b(depends on|depend on|who uses|what uses|references|consumers of|callers of)\b/.test(query)) {
    const target = extractAfter(query, /(?:depends? on|who uses|what uses|references|consumers of|callers of)\s+/);
    if (target) return { type: "dependents_of", target };
  }

  // Module summary: "what does X do" / "describe X" / "summarize X"
  if (/\b(what does|describe|summarize|overview|about)\b/.test(query)) {
    const target = extractTarget(query);
    if (target) return { type: "module_summary", target };
  }

  // Entry points
  if (/\b(entry point|main|entrypoint|start)\b/.test(query)) {
    return { type: "entry_points" };
  }

  // Largest / most complex
  if (/\b(largest|biggest|most complex|most symbols)\b/.test(query)) {
    return { type: "largest_files" };
  }

  // Fallback: symbol search
  const target = extractTarget(query);
  return { type: "symbol_search", target: target || query };
}

function extractTarget(query: string): string | undefined {
  // Try to extract a meaningful target from the query
  // Look for quoted strings first
  const quoted = query.match(/["'`]([^"'`]+)["'`]/);
  if (quoted) return quoted[1];

  // Look for file-like patterns
  const fileLike = query.match(/\b([\w/.-]+\.\w+)\b/);
  if (fileLike) return fileLike[1];

  // Look for CamelCase or specific identifiers
  const camel = query.match(/\b([A-Z][a-zA-Z0-9]+)\b/);
  if (camel) return camel[1];

  // Try to extract noun after common prepositions
  const afterPrep = query.match(/(?:in|from|of|about|the)\s+(\w+)/);
  if (afterPrep) return afterPrep[1];

  return undefined;
}

function extractAfter(query: string, pattern: RegExp): string | undefined {
  const match = query.match(pattern);
  if (!match) return undefined;
  const rest = query.substring(match.index! + match[0].length).trim();
  // Take the first word or quoted string
  const quoted = rest.match(/^["'`]([^"'`]+)["'`]/);
  if (quoted) return quoted[1];
  const word = rest.match(/^([\w./-]+)/);
  return word?.[1];
}

function findEndpoints(db: ReturnType<CodeGraph["getDb"]>): string {
  // Look for common endpoint patterns: route handlers, HTTP methods, decorators
  const patterns = [
    "app.get", "app.post", "app.put", "app.delete", "app.patch",
    "router.get", "router.post", "router.put", "router.delete",
    "GET", "POST", "PUT", "DELETE", "PATCH",
    "RequestMapping", "GetMapping", "PostMapping",
    "handle", "handler", "endpoint",
  ];

  const results: Array<{ name: string; kind: string; file: string; line: number; sig: string | null }> = [];

  // Search for handler-like functions
  const handlerRows = db.prepare(`
    SELECT s.name, s.kind, f.path as file, s.line_start as line, s.signature as sig
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE (s.name LIKE '%handler%' OR s.name LIKE '%Handler%'
           OR s.name LIKE '%endpoint%' OR s.name LIKE '%Endpoint%'
           OR s.name LIKE '%route%' OR s.name LIKE '%Route%'
           OR s.name LIKE '%controller%' OR s.name LIKE '%Controller%')
      AND s.kind IN ('function', 'method', 'class')
    ORDER BY f.path, s.line_start
    LIMIT 50
  `).all() as typeof results;

  results.push(...handlerRows);

  // Search for HTTP method references
  const refRows = db.prepare(`
    SELECT DISTINCT s.name, s.kind, f.path as file, s.line_start as line, s.signature as sig
    FROM references_ r
    JOIN symbols s ON r.from_symbol_id = s.id
    JOIN files f ON s.file_id = f.id
    WHERE r.to_symbol_bare_name IN ('get', 'post', 'put', 'delete', 'patch')
      AND r.kind = 'call'
    ORDER BY f.path, s.line_start
    LIMIT 50
  `).all() as typeof results;

  results.push(...refRows);

  if (results.length === 0) {
    return "No API endpoints or route handlers found in the indexed codebase.";
  }

  const lines = ["# API Endpoints & Handlers\n"];
  const seen = new Set<string>();
  for (const r of results) {
    const key = `${r.file}:${r.line}:${r.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sig = r.sig ? ` -- \`${r.sig}\`` : "";
    lines.push(`- **${r.name}** (${r.kind}) in \`${r.file}:${r.line}\`${sig}`);
  }

  return lines.join("\n");
}

function findByKind(
  db: ReturnType<CodeGraph["getDb"]>,
  kind: string,
  target?: string
): string {
  const filter = target
    ? `AND (s.name LIKE ? OR f.path LIKE ?)`
    : "";
  const params: unknown[] = [kind];
  if (target) {
    params.push(`%${target}%`, `%${target}%`);
  }

  const rows = db.prepare(`
    SELECT s.name, s.kind, f.path as file, s.line_start as line, s.signature as sig, s.is_exported as exported
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.kind = ? ${filter}
    ORDER BY s.is_exported DESC, f.path, s.line_start
    LIMIT 50
  `).all(...params) as Array<{ name: string; kind: string; file: string; line: number; sig: string | null; exported: number }>;

  if (rows.length === 0) {
    return target
      ? `No ${kind}s found matching "${target}".`
      : `No ${kind}s found in the indexed codebase.`;
  }

  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  const lines = [`# ${label}s${target ? ` matching "${target}"` : ""}\n`];
  for (const r of rows) {
    const exp = r.exported ? " (exported)" : "";
    const sig = r.sig ? ` -- \`${r.sig}\`` : "";
    lines.push(`- **${r.name}**${exp} in \`${r.file}:${r.line}\`${sig}`);
  }

  return lines.join("\n");
}

function findExports(db: ReturnType<CodeGraph["getDb"]>, target?: string): string {
  const filter = target ? `AND f.path LIKE ?` : "";
  const params: unknown[] = [];
  if (target) params.push(`%${target}%`);

  const rows = db.prepare(`
    SELECT s.name, s.kind, f.path as file, s.line_start as line, s.signature as sig
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.is_exported = 1 ${filter}
    ORDER BY f.path, s.line_start
    LIMIT 100
  `).all(...params) as Array<{ name: string; kind: string; file: string; line: number; sig: string | null }>;

  if (rows.length === 0) {
    return target
      ? `No exports found in files matching "${target}".`
      : "No exported symbols found.";
  }

  const lines = [`# Exported Symbols${target ? ` (${target})` : ""}\n`];

  // Group by file
  const byFile = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byFile.get(r.file) ?? [];
    list.push(r);
    byFile.set(r.file, list);
  }

  for (const [file, symbols] of byFile) {
    lines.push(`## ${file}`);
    for (const s of symbols) {
      const sig = s.sig ? ` -- \`${s.sig}\`` : "";
      lines.push(`  - ${s.kind} **${s.name}**${sig}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function dependencyOf(graph: CodeGraph, target: string): string {
  const db = graph.getDb();

  // Find files matching the target
  const files = db.prepare(`
    SELECT f.path, i.source_path as importSource, i.imported_name as importedName
    FROM files f
    JOIN imports i ON i.file_id = f.id
    WHERE f.path LIKE ?
    ORDER BY f.path, i.line
    LIMIT 100
  `).all(`%${target}%`) as Array<{ path: string; importSource: string; importedName: string }>;

  if (files.length === 0) {
    return `No imports found for files matching "${target}". The file may not import anything or may not be indexed.`;
  }

  const lines = [`# Dependencies of "${target}"\n`];
  const byFile = new Map<string, Array<{ source: string; name: string }>>();
  for (const r of files) {
    const list = byFile.get(r.path) ?? [];
    list.push({ source: r.importSource, name: r.importedName });
    byFile.set(r.path, list);
  }

  for (const [file, deps] of byFile) {
    lines.push(`## ${file}`);
    for (const d of deps) {
      lines.push(`  - \`${d.name}\` from \`${d.source}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function dependentsOf(graph: CodeGraph, target: string): string {
  const refs = graph.getReferences(target, 2);
  if (refs.length === 0) {
    return `No dependents found for "${target}". It may not be referenced by other symbols.`;
  }

  const lines = [`# Dependents of "${target}"\n`];
  const byFile = new Map<string, typeof refs>();
  for (const r of refs) {
    const list = byFile.get(r.fromFile) ?? [];
    list.push(r);
    byFile.set(r.fromFile, list);
  }

  for (const [file, fileRefs] of byFile) {
    lines.push(`## ${file}`);
    for (const r of fileRefs) {
      lines.push(`  - **${r.fromSymbol}** (${r.fromKind}) --[${r.refKind}]--> ${r.toSymbol} (line ${r.refLine})`);
    }
    lines.push("");
  }

  lines.push(`\n**${refs.length} total references across ${byFile.size} files**`);
  return lines.join("\n");
}

function moduleSummary(db: ReturnType<CodeGraph["getDb"]>, target?: string): string {
  if (!target) return "Please specify a module or file to summarize.";

  // Find matching files
  const files = db.prepare(`
    SELECT id, path FROM files WHERE path LIKE ? LIMIT 10
  `).all(`%${target}%`) as Array<{ id: number; path: string }>;

  if (files.length === 0) {
    return `No files found matching "${target}".`;
  }

  const lines = [`# Module Summary: "${target}"\n`];

  for (const file of files) {
    const symbols = db.prepare(`
      SELECT name, kind, line_start as line, signature as sig, is_exported as exported
      FROM symbols WHERE file_id = ?
      ORDER BY line_start
    `).all(file.id) as Array<{ name: string; kind: string; line: number; sig: string | null; exported: number }>;

    const imports = db.prepare(`
      SELECT source_path as source, imported_name as name FROM imports WHERE file_id = ?
    `).all(file.id) as Array<{ source: string; name: string }>;

    lines.push(`## ${file.path}`);

    if (imports.length > 0) {
      lines.push(`\n**Imports:** ${imports.map((i) => `\`${i.name}\` from \`${i.source}\``).join(", ")}`);
    }

    const exported = symbols.filter((s) => s.exported);
    const internal = symbols.filter((s) => !s.exported);

    if (exported.length > 0) {
      lines.push(`\n**Exports (${exported.length}):**`);
      for (const s of exported) {
        const sig = s.sig ? ` -- \`${s.sig}\`` : "";
        lines.push(`  - ${s.kind} **${s.name}**${sig}`);
      }
    }

    if (internal.length > 0) {
      lines.push(`\n**Internal (${internal.length}):**`);
      for (const s of internal) {
        lines.push(`  - ${s.kind} ${s.name}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

function findEntryPoints(db: ReturnType<CodeGraph["getDb"]>): string {
  // Entry points: main functions, index files, files with no importers
  const mainFuncs = db.prepare(`
    SELECT s.name, s.kind, f.path as file, s.line_start as line
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.name IN ('main', 'Main', 'run', 'start', 'init', 'bootstrap', 'setup')
      AND s.kind IN ('function', 'method')
    ORDER BY f.path
    LIMIT 20
  `).all() as Array<{ name: string; kind: string; file: string; line: number }>;

  const indexFiles = db.prepare(`
    SELECT path FROM files
    WHERE path LIKE '%/index.%' OR path LIKE '%/main.%' OR path LIKE '%/app.%' OR path LIKE '%/server.%'
    ORDER BY path
    LIMIT 20
  `).all() as Array<{ path: string }>;

  const lines = ["# Entry Points\n"];

  if (mainFuncs.length > 0) {
    lines.push("## Main Functions");
    for (const f of mainFuncs) {
      lines.push(`  - **${f.name}** (${f.kind}) in \`${f.file}:${f.line}\``);
    }
    lines.push("");
  }

  if (indexFiles.length > 0) {
    lines.push("## Entry Files");
    for (const f of indexFiles) {
      lines.push(`  - \`${f.path}\``);
    }
    lines.push("");
  }

  if (mainFuncs.length === 0 && indexFiles.length === 0) {
    return "No obvious entry points found. Look for files named main.*, index.*, app.*, or functions named main/run/start.";
  }

  return lines.join("\n");
}

function findLargestFiles(db: ReturnType<CodeGraph["getDb"]>): string {
  const rows = db.prepare(`
    SELECT f.path, COUNT(s.id) as symbolCount
    FROM files f
    LEFT JOIN symbols s ON s.file_id = f.id
    GROUP BY f.id
    ORDER BY symbolCount DESC
    LIMIT 20
  `).all() as Array<{ path: string; symbolCount: number }>;

  if (rows.length === 0) {
    return "No files indexed yet.";
  }

  const lines = ["# Largest Files by Symbol Count\n"];
  for (const r of rows) {
    lines.push(`- **${r.symbolCount}** symbols -- \`${r.path}\``);
  }

  return lines.join("\n");
}

function symbolSearch(graph: CodeGraph, target: string): string {
  const results = graph.findSymbols({ name: target, limit: 30 });
  if (results.length === 0) {
    return `No symbols found matching "${target}". Try a different search term or run reindex.`;
  }

  const lines = [`# Symbols matching "${target}"\n`];
  for (const r of results) {
    const sig = r.signature ? ` -- \`${r.signature}\`` : "";
    const exp = r.isExported ? " (exported)" : "";
    lines.push(`- ${r.kind} **${r.name}**${exp} in \`${r.filePath}:${r.lineStart}\`${sig}`);
  }

  return lines.join("\n");
}
