import { CodeGraph } from "../graph/code-graph.js";

export const architectureDiagramTool = {
  name: "architecture_diagram",
  description:
    "Auto-generate a mermaid diagram of the project's module dependency graph. Shows which files import from which other files, grouped by directory. Useful for understanding project structure at a glance.",
  inputSchema: {
    type: "object" as const,
    properties: {
      scope: {
        type: "string",
        description:
          "Optional: limit diagram to files under this path prefix (e.g. 'src/api')",
      },
      max_depth: {
        type: "number",
        description:
          "Maximum directory nesting depth for subgraph grouping (default: 2)",
      },
      format: {
        type: "string",
        enum: ["mermaid", "text"],
        description: "Output format (default: mermaid)",
      },
    },
  },
};

interface FileNode {
  path: string;
  imports: string[];
}

interface ModuleEdge {
  from: string;
  to: string;
}

export function handleArchitectureDiagram(
  graph: CodeGraph,
  args: { scope?: string; max_depth?: number; format?: string },
  projectRoot?: string
) {
  const db = graph.getDb();
  const maxDepth = Math.min(Math.max(args.max_depth ?? 2, 1), 5);
  const format = args.format ?? "mermaid";

  // Get all files and their imports
  const scopeFilter = args.scope
    ? `WHERE f.path LIKE ?`
    : "";
  const scopeParam = args.scope ? `${args.scope}%` : undefined;

  const filesQuery = `
    SELECT f.path, i.source_path as importSource
    FROM files f
    LEFT JOIN imports i ON i.file_id = f.id
    ${scopeFilter}
    ORDER BY f.path
  `;

  const rows = (scopeParam
    ? db.prepare(filesQuery).all(scopeParam)
    : db.prepare(filesQuery).all()
  ) as Array<{ path: string; importSource: string | null }>;

  if (rows.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: args.scope
            ? `No files found under scope "${args.scope}".`
            : "No files indexed yet. Run reindex first.",
        },
      ],
    };
  }

  // Build file → imports map
  const fileMap = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const row of rows) {
    allFiles.add(row.path);
    if (row.importSource) {
      const imports = fileMap.get(row.path) ?? new Set();
      imports.add(row.importSource);
      fileMap.set(row.path, imports);
    }
  }

  // Resolve relative imports to actual indexed file paths
  const edges: ModuleEdge[] = [];
  const indexedPaths = [...allFiles];

  for (const [filePath, importSources] of fileMap) {
    for (const source of importSources) {
      const resolved = resolveImport(filePath, source, indexedPaths);
      if (resolved) {
        edges.push({ from: filePath, to: resolved });
      }
    }
  }

  const header = projectRoot ? `Project: ${projectRoot}\n\n` : "";

  if (format === "text") {
    return {
      content: [
        {
          type: "text" as const,
          text: header + buildTextDiagram(allFiles, edges),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: header + buildMermaidDiagram(allFiles, edges, maxDepth),
      },
    ],
  };
}

function resolveImport(
  fromFile: string,
  importSource: string,
  indexedPaths: string[]
): string | null {
  // If it's a relative import (starts with . or ..)
  if (importSource.startsWith(".")) {
    const fromDir = fromFile.substring(0, fromFile.lastIndexOf("/"));
    const resolved = normalizePath(fromDir + "/" + importSource);

    // Try exact match and common extensions
    const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java"];
    for (const ext of extensions) {
      const candidate = resolved + ext;
      if (indexedPaths.includes(candidate)) return candidate;
    }
    // Try index files
    for (const idx of ["/index.ts", "/index.js", "/index.tsx"]) {
      const candidate = resolved + idx;
      if (indexedPaths.includes(candidate)) return candidate;
    }
    return null;
  }

  // Absolute/package imports — try suffix match
  for (const p of indexedPaths) {
    if (p.endsWith("/" + importSource) || p.endsWith("/" + importSource + ".ts") || p.endsWith("/" + importSource + ".js")) {
      return p;
    }
  }

  return null;
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function getDirectory(filePath: string, depth: number): string {
  const parts = filePath.split("/");
  return parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
}

function buildMermaidDiagram(
  allFiles: Set<string>,
  edges: ModuleEdge[],
  maxDepth: number
): string {
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");
  const shortName = (p: string) => {
    const parts = p.split("/");
    return parts[parts.length - 1];
  };

  // Group files by directory
  const dirGroups = new Map<string, string[]>();
  for (const file of allFiles) {
    const dir = getDirectory(file, maxDepth) || "root";
    const list = dirGroups.get(dir) ?? [];
    list.push(file);
    dirGroups.set(dir, list);
  }

  const lines: string[] = [
    "# Architecture Diagram\n",
    "```mermaid",
    "graph LR",
  ];

  // Add subgraphs for each directory
  for (const [dir, files] of dirGroups) {
    if (dirGroups.size > 1) {
      lines.push(`  subgraph ${sanitize(dir)}["${dir}"]`);
    }
    for (const file of files) {
      lines.push(`    ${sanitize(file)}["${shortName(file)}"]`);
    }
    if (dirGroups.size > 1) {
      lines.push("  end");
    }
  }

  // Add edges
  const seenEdges = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    lines.push(`  ${sanitize(edge.from)} --> ${sanitize(edge.to)}`);
  }

  lines.push("```");

  // Add summary
  const fileCount = allFiles.size;
  const edgeCount = seenEdges.size;
  lines.push(`\n**${fileCount} modules, ${edgeCount} dependencies**`);

  return lines.join("\n");
}

function buildTextDiagram(allFiles: Set<string>, edges: ModuleEdge[]): string {
  const lines: string[] = ["# Module Dependencies\n"];

  // Group edges by source file
  const bySource = new Map<string, string[]>();
  for (const edge of edges) {
    const list = bySource.get(edge.from) ?? [];
    list.push(edge.to);
    bySource.set(edge.from, list);
  }

  // Files with dependencies
  for (const [file, deps] of [...bySource].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${file}`);
    for (const dep of deps.sort()) {
      lines.push(`  --> ${dep}`);
    }
    lines.push("");
  }

  // Files with no dependencies
  const filesWithDeps = new Set(bySource.keys());
  const filesWithNoDeps = [...allFiles].filter((f) => !filesWithDeps.has(f)).sort();
  if (filesWithNoDeps.length > 0) {
    lines.push("## Standalone modules (no imports)");
    for (const f of filesWithNoDeps) {
      lines.push(`  ${f}`);
    }
  }

  lines.push(`\n**${allFiles.size} modules, ${edges.length} dependencies**`);

  return lines.join("\n");
}
