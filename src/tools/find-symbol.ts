import { CodeGraph } from "../graph/code-graph.js";

export const findSymbolTool = {
  name: "find_symbol",
  description:
    "Find symbols (functions, classes, interfaces, types, variables, methods) by name with full type information and location. Supports fuzzy matching.",
  inputSchema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "Symbol name to search for (supports partial matching)",
      },
      kind: {
        type: "string",
        enum: ["function", "class", "interface", "type", "variable", "method", "enum", "property"],
        description: "Optional: filter by symbol kind",
      },
      scope: {
        type: "string",
        description: "Optional: limit search to files under this path prefix",
      },
      limit: {
        type: "number",
        description: "Maximum results to return (default: 20)",
      },
    },
    required: ["name"],
  },
};

export function handleFindSymbol(
  graph: CodeGraph,
  args: { name: string; kind?: string; scope?: string; limit?: number }
) {
  const results = graph.findSymbols({
    name: args.name,
    kind: args.kind,
    scope: args.scope,
    limit: args.limit ?? 20,
  });

  if (results.length === 0) {
    return { content: [{ type: "text" as const, text: `No symbols found matching "${args.name}"` }] };
  }

  const formatted = results.map((s) => {
    const exported = s.isExported ? " [exported]" : "";
    const sig = s.signature ? `\n  Signature: ${s.signature}` : "";
    return `${s.kind} ${s.name}${exported}\n  Location: ${s.filePath}:${s.lineStart}-${s.lineEnd}${sig}`;
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Found ${results.length} symbol(s) matching "${args.name}":\n\n${formatted.join("\n\n")}`,
      },
    ],
  };
}
