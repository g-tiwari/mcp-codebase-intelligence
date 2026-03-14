import { LspManager } from "../lsp/lsp-manager.js";
import { readFileSync } from "fs";

export const gotoDefinitionTool = {
  name: "goto_definition",
  description:
    "Go to the definition of a symbol at a specific position in a file. Uses LSP for precise type-aware resolution — resolves through imports, type aliases, and inheritance.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file",
      },
      line: {
        type: "number",
        description: "Line number (1-based)",
      },
      character: {
        type: "number",
        description: "Column number (0-based)",
      },
    },
    required: ["file_path", "line", "character"],
  },
};

export async function handleGotoDefinition(
  lspManager: LspManager,
  args: { file_path: string; line: number; character: number }
) {
  const client = lspManager.getClientForFile(args.file_path);
  if (!client) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No LSP server available for ${args.file_path}. LSP features require a running language server.`,
        },
      ],
    };
  }

  const locations = await client.getDefinition(args.file_path, args.line, args.character);

  if (locations.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No definition found at ${args.file_path}:${args.line}:${args.character}`,
        },
      ],
    };
  }

  const results = locations.map((loc) => {
    const filePath = loc.uri.replace("file://", "");
    let context = "";
    try {
      const lines = readFileSync(filePath, "utf-8").split("\n");
      const startLine = Math.max(0, loc.line - 2);
      const endLine = Math.min(lines.length, loc.line + 3);
      context = lines
        .slice(startLine, endLine)
        .map((l, i) => {
          const lineNum = startLine + i + 1;
          const marker = lineNum === loc.line ? " >>>" : "    ";
          return `${marker} ${lineNum}: ${l}`;
        })
        .join("\n");
    } catch {
      // ignore read errors
    }

    return `${filePath}:${loc.line}:${loc.character}\n${context}`;
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Definition(s) found:\n\n${results.join("\n\n")}`,
      },
    ],
  };
}
