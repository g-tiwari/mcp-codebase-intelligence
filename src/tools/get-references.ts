import { CodeGraph } from "../graph/code-graph.js";

export const getReferencesTool = {
  name: "get_references",
  description:
    "Find all references to a symbol — who calls it, uses it, or depends on it. Supports transitive reference discovery via depth parameter.",
  inputSchema: {
    type: "object" as const,
    properties: {
      symbol_name: {
        type: "string",
        description: "Name of the symbol to find references for",
      },
      depth: {
        type: "number",
        description:
          "How many levels of transitive references to follow (1 = direct only, default: 1, max: 10)",
      },
    },
    required: ["symbol_name"],
  },
};

export function handleGetReferences(
  graph: CodeGraph,
  args: { symbol_name: string; depth?: number }
) {
  const refs = graph.getReferences(args.symbol_name, args.depth ?? 1);

  if (refs.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No references found for "${args.symbol_name}"`,
        },
      ],
    };
  }

  // Group by depth
  const byDepth = new Map<number, typeof refs>();
  for (const ref of refs) {
    const list = byDepth.get(ref.depth) ?? [];
    list.push(ref);
    byDepth.set(ref.depth, list);
  }

  const sections: string[] = [];
  for (const [depth, depthRefs] of byDepth) {
    const label = depth === 1 ? "Direct references" : `Depth ${depth} (transitive)`;
    const lines = depthRefs.map(
      (r) =>
        `  ${r.fromKind} ${r.fromSymbol} (${r.fromFile}:${r.fromLine}) --[${r.refKind}]--> ${r.toSymbol} at line ${r.refLine}`
    );
    sections.push(`${label}:\n${lines.join("\n")}`);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `References to "${args.symbol_name}" (${refs.length} total):\n\n${sections.join("\n\n")}`,
      },
    ],
  };
}
