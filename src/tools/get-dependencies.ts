import { CodeGraph } from "../graph/code-graph.js";

export const getDependenciesTool = {
  name: "get_dependencies",
  description:
    "Get the import/dependency graph for a file — what it imports and optionally what those files import (transitive).",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to inspect",
      },
      depth: {
        type: "number",
        description: "How many levels of transitive dependencies to follow (default: 1, max: 5)",
      },
    },
    required: ["file_path"],
  },
};

export function handleGetDependencies(
  graph: CodeGraph,
  args: { file_path: string; depth?: number }
) {
  const imports = graph.getImports(args.file_path);

  if (imports.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No imports found in "${args.file_path}"`,
        },
      ],
    };
  }

  // Group imports by source
  const bySource = new Map<string, typeof imports>();
  for (const imp of imports) {
    const list = bySource.get(imp.sourcePath) ?? [];
    list.push(imp);
    bySource.set(imp.sourcePath, list);
  }

  const sections: string[] = [];
  for (const [source, sourceImports] of bySource) {
    const names = sourceImports.map((i) => {
      if (i.isNamespace) return `* as ${i.localName}`;
      if (i.isDefault) return `${i.localName} (default)`;
      return i.importedName === i.localName ? i.importedName : `${i.importedName} as ${i.localName}`;
    });
    sections.push(`  from "${source}": ${names.join(", ")}`);
  }

  // Also get transitive dependencies if requested
  let transitiveSection = "";
  const depth = args.depth ?? 1;
  if (depth > 1) {
    const deps = graph.getDependencyGraph(args.file_path, depth);
    if (deps.length > 0) {
      const transLines = deps.map((d) => `  ${"  ".repeat(d.depth - 1)}${d.file} -> ${d.imports}`);
      transitiveSection = `\n\nDependency tree (depth ${depth}):\n${transLines.join("\n")}`;
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Imports in ${args.file_path} (${imports.length} from ${bySource.size} modules):\n\n${sections.join("\n")}${transitiveSection}`,
      },
    ],
  };
}
