import { LspManager } from "../lsp/lsp-manager.js";

export const getTypeInfoTool = {
  name: "get_type_info",
  description:
    "Get the type information for a symbol at a specific position. Uses LSP to resolve the full type, including generics, union types, and inferred types.",
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

export async function handleGetTypeInfo(
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

  // Get hover info (contains type information)
  const hoverInfo = await client.getHover(args.file_path, args.line, args.character);

  // Also try to get type definition location
  const typeDefs = await client.getTypeDefinition(args.file_path, args.line, args.character);

  const sections: string[] = [];

  if (hoverInfo) {
    sections.push(`Type info at ${args.file_path}:${args.line}:${args.character}:\n\n${hoverInfo}`);
  }

  if (typeDefs.length > 0) {
    const defLines = typeDefs.map((loc) => {
      const filePath = loc.uri.replace("file://", "");
      return `  ${filePath}:${loc.line}:${loc.character}`;
    });
    sections.push(`Type defined at:\n${defLines.join("\n")}`);
  }

  if (sections.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No type information available at ${args.file_path}:${args.line}:${args.character}`,
        },
      ],
    };
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
