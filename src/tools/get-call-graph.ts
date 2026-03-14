import { CodeGraph } from "../graph/code-graph.js";

export const getCallGraphTool = {
  name: "get_call_graph",
  description:
    "Get the call graph for a function — who calls it (callers) and what it calls (callees). Returns as a tree or mermaid diagram.",
  inputSchema: {
    type: "object" as const,
    properties: {
      function_name: {
        type: "string",
        description: "Name of the function to get the call graph for",
      },
      direction: {
        type: "string",
        enum: ["callers", "callees", "both"],
        description: "Direction of the graph (default: both)",
      },
      depth: {
        type: "number",
        description: "How many levels to traverse (default: 2, max: 5)",
      },
      format: {
        type: "string",
        enum: ["tree", "mermaid"],
        description: "Output format (default: tree)",
      },
    },
    required: ["function_name"],
  },
};

interface CallNode {
  name: string;
  kind: string;
  file: string;
  line: number;
  refKind: string;
  children: CallNode[];
}

export function handleGetCallGraph(
  graph: CodeGraph,
  args: {
    function_name: string;
    direction?: string;
    depth?: number;
    format?: string;
  }
) {
  const direction = args.direction ?? "both";
  const depth = Math.min(Math.max(args.depth ?? 2, 1), 5);
  const format = args.format ?? "tree";

  const sections: string[] = [];

  // Callers: who calls this function?
  if (direction === "callers" || direction === "both") {
    const callers = graph.getReferences(args.function_name, depth);
    if (callers.length > 0) {
      if (format === "mermaid") {
        sections.push(buildMermaid(args.function_name, callers, "callers"));
      } else {
        sections.push(buildTree(args.function_name, callers, "callers"));
      }
    } else {
      sections.push(`Callers of "${args.function_name}": none found`);
    }
  }

  // Callees: what does this function call?
  if (direction === "callees" || direction === "both") {
    const db = graph.getDb();
    const callees = getCallees(db, args.function_name, depth);
    if (callees.length > 0) {
      if (format === "mermaid") {
        sections.push(buildCalleeMermaid(args.function_name, callees));
      } else {
        sections.push(buildCalleeTree(args.function_name, callees));
      }
    } else {
      sections.push(`Callees of "${args.function_name}": none found`);
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: sections.join("\n\n"),
      },
    ],
  };
}

interface CalleeRow {
  callee: string;
  calleeBare: string;
  refKind: string;
  line: number;
  depth: number;
}

function getCallees(
  db: ReturnType<CodeGraph["getDb"]>,
  functionName: string,
  maxDepth: number
): CalleeRow[] {
  const sql = `
    WITH RECURSIVE callee_chain(caller_name, callee_name, callee_bare, ref_kind, line, depth) AS (
      -- Base: what does the target function call?
      SELECT s.name, r.to_symbol_name, r.to_symbol_bare_name, r.kind, r.line, 1
      FROM symbols s
      JOIN references_ r ON r.from_symbol_id = s.id
      WHERE s.name = ? AND r.kind IN ('call', 'instantiation')

      UNION ALL

      -- Recursive: what do those callees call?
      SELECT s.name, r.to_symbol_name, r.to_symbol_bare_name, r.kind, r.line, cc.depth + 1
      FROM symbols s
      JOIN references_ r ON r.from_symbol_id = s.id
      JOIN callee_chain cc ON s.name = cc.callee_bare OR s.name = cc.callee_name
      WHERE cc.depth < ? AND r.kind IN ('call', 'instantiation')
    )
    SELECT callee_name as callee, callee_bare as calleeBare, ref_kind as refKind, line, depth
    FROM callee_chain
    ORDER BY depth, line
    LIMIT 100
  `;

  return db.prepare(sql).all(functionName, maxDepth) as CalleeRow[];
}

function buildTree(
  rootName: string,
  refs: Array<{ fromSymbol: string; fromFile: string; fromLine: number; refKind: string; depth: number }>,
  label: string
): string {
  const lines: string[] = [`${label === "callers" ? "Callers" : "Callees"} of "${rootName}":`];
  lines.push(`  ${rootName}`);

  const byDepth = new Map<number, typeof refs>();
  for (const ref of refs) {
    const list = byDepth.get(ref.depth) ?? [];
    list.push(ref);
    byDepth.set(ref.depth, list);
  }

  for (const [d, depthRefs] of byDepth) {
    const indent = "  ".repeat(d + 1);
    const seen = new Set<string>();
    for (const ref of depthRefs) {
      const key = `${ref.fromSymbol}:${ref.fromFile}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`${indent}<-- ${ref.fromSymbol} (${ref.fromFile}:${ref.fromLine})`);
    }
  }

  return lines.join("\n");
}

function buildCalleeTree(rootName: string, callees: CalleeRow[]): string {
  const lines: string[] = [`Callees of "${rootName}":`];
  lines.push(`  ${rootName}`);

  const byDepth = new Map<number, CalleeRow[]>();
  for (const c of callees) {
    const list = byDepth.get(c.depth) ?? [];
    list.push(c);
    byDepth.set(c.depth, list);
  }

  for (const [d, depthCallees] of byDepth) {
    const indent = "  ".repeat(d + 1);
    const seen = new Set<string>();
    for (const c of depthCallees) {
      if (seen.has(c.callee)) continue;
      seen.add(c.callee);
      lines.push(`${indent}--> ${c.callee} [${c.refKind}] (line ${c.line})`);
    }
  }

  return lines.join("\n");
}

function buildMermaid(
  rootName: string,
  refs: Array<{ fromSymbol: string; toSymbol: string; refKind: string; depth: number }>,
  label: string
): string {
  const lines: string[] = ["```mermaid", "graph TD"];
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");
  const edges = new Set<string>();

  for (const ref of refs) {
    const from = sanitize(ref.fromSymbol);
    const to = sanitize(rootName);
    const edge = `  ${from}["${ref.fromSymbol}"] -->|${ref.refKind}| ${to}["${rootName}"]`;
    if (!edges.has(edge)) {
      edges.add(edge);
      lines.push(edge);
    }
  }

  lines.push("```");
  return `Callers of "${rootName}" (mermaid):\n${lines.join("\n")}`;
}

function buildCalleeMermaid(rootName: string, callees: CalleeRow[]): string {
  const lines: string[] = ["```mermaid", "graph TD"];
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");
  const edges = new Set<string>();

  for (const c of callees) {
    const from = sanitize(rootName);
    const to = sanitize(c.calleeBare);
    const edge = `  ${from}["${rootName}"] -->|${c.refKind}| ${to}["${c.calleeBare}"]`;
    if (!edges.has(edge)) {
      edges.add(edge);
      lines.push(edge);
    }
  }

  lines.push("```");
  return `Callees of "${rootName}" (mermaid):\n${lines.join("\n")}`;
}
