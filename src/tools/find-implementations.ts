import { LspManager } from "../lsp/lsp-manager.js";
import { readFileSync } from "fs";

export const findImplementationsTool = {
  name: "find_implementations",
  description:
    "Find all implementations of an interface or abstract method. Uses LSP for precise type-aware resolution across files.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file containing the interface/abstract method",
      },
      line: {
        type: "number",
        description: "Line number of the interface/method (1-based)",
      },
      character: {
        type: "number",
        description: "Column number (0-based)",
      },
    },
    required: ["file_path", "line", "character"],
  },
};

export async function handleFindImplementations(
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

  const implementations = await client.getImplementations(
    args.file_path,
    args.line,
    args.character
  );

  if (implementations.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No implementations found at ${args.file_path}:${args.line}:${args.character}`,
        },
      ],
    };
  }

  const results = implementations.map((loc) => {
    const filePath = loc.uri.replace("file://", "");
    let lineText = "";
    try {
      const lines = readFileSync(filePath, "utf-8").split("\n");
      lineText = lines[loc.line - 1]?.trim() ?? "";
    } catch {
      // ignore read errors
    }

    return `  ${filePath}:${loc.line}:${loc.character}  ${lineText}`;
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Found ${implementations.length} implementation(s):\n\n${results.join("\n")}`,
      },
    ],
  };
}
