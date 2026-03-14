import { CodeGraph } from "../graph/code-graph.js";

export const getExportsTool = {
  name: "get_exports",
  description:
    "Get the public API surface of a file or module — all exported symbols with their types and signatures.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to inspect",
      },
    },
    required: ["file_path"],
  },
};

export function handleGetExports(
  graph: CodeGraph,
  args: { file_path: string }
) {
  const exports = graph.getExports(args.file_path);

  if (exports.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No exports found in "${args.file_path}"`,
        },
      ],
    };
  }

  const formatted = exports.map((e) => {
    const sig = e.signature ? ` — ${e.signature}` : "";
    return `  ${e.kind} ${e.name} (line ${e.lineStart})${sig}`;
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Exports from ${args.file_path} (${exports.length}):\n\n${formatted.join("\n")}`,
      },
    ],
  };
}
