import { CodeGraph } from "../graph/code-graph.js";

export const searchCodebaseTool = {
  name: "search_codebase",
  description:
    "Search symbols by their docstring/comment content. Find functions, classes, and methods by what they do, not just their name. Useful for discovering APIs, finding implementations by description, or locating code by its documentation.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Text to search for in docstrings/comments (supports partial matching)",
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
    required: ["query"],
  },
};

export function handleSearchCodebase(
  graph: CodeGraph,
  args: { query: string; kind?: string; scope?: string; limit?: number }
) {
  const results = graph.searchByDocstring(args.query, {
    kind: args.kind,
    scope: args.scope,
    limit: args.limit ?? 20,
  });

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No symbols found with docstrings matching "${args.query}"`,
        },
      ],
    };
  }

  const formatted = results.map((s) => {
    const exported = s.isExported ? " [exported]" : "";
    const sig = s.signature ? `\n  Signature: ${s.signature}` : "";
    const doc = s.docstring ? `\n  Docstring: ${s.docstring}` : "";
    return `${s.kind} ${s.name}${exported}\n  Location: ${s.filePath}:${s.lineStart}-${s.lineEnd}${sig}${doc}`;
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Found ${results.length} symbol(s) with docstrings matching "${args.query}":\n\n${formatted.join("\n\n")}`,
      },
    ],
  };
}
