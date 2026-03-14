import { CodeGraph } from "../graph/code-graph.js";

export const getStatsTool = {
  name: "get_index_stats",
  description: "Get statistics about the indexed codebase — number of files, symbols, references, and imports.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export function handleGetStats(graph: CodeGraph, projectRoot?: string) {
  const stats = graph.getStats();

  const header = projectRoot
    ? `Indexed project: ${projectRoot}\n\n`
    : "";

  return {
    content: [
      {
        type: "text" as const,
        text: `${header}Codebase index statistics:\n  Files indexed: ${stats.files}\n  Symbols: ${stats.symbols}\n  References: ${stats.references}\n  Imports: ${stats.imports}`,
      },
    ],
  };
}
