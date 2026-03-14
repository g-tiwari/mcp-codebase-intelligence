import { CodeGraph } from "../graph/code-graph.js";

export const analyzeChangeImpactTool = {
  name: "analyze_change_impact",
  description:
    "Analyze the impact of changing lines in a file. Returns all symbols affected by the change and their dependents (callers/users) at configurable depth.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file being modified",
      },
      line_start: {
        type: "number",
        description: "Starting line number of the change (inclusive)",
      },
      line_end: {
        type: "number",
        description: "Ending line number of the change (inclusive)",
      },
      depth: {
        type: "number",
        description:
          "How many levels of transitive dependents to follow (1 = direct only, default: 2, max: 10)",
      },
    },
    required: ["file_path", "line_start", "line_end"],
  },
};

export function handleAnalyzeChangeImpact(
  graph: CodeGraph,
  args: { file_path: string; line_start: number; line_end: number; depth?: number }
) {
  const depth = args.depth ?? 2;
  const clampedDepth = Math.min(Math.max(depth, 1), 10);

  // Find all symbols in the file that overlap with the line range
  const affectedSymbols = findSymbolsInRange(
    graph,
    args.file_path,
    args.line_start,
    args.line_end
  );

  if (affectedSymbols.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No symbols found in ${args.file_path} at lines ${args.line_start}-${args.line_end}\n\nThe change may affect code outside of symbol definitions (e.g., module-level code, imports).`,
        },
      ],
    };
  }

  // For each affected symbol, get its references (dependents)
  const impactReport: Array<{
    symbol: string;
    kind: string;
    lines: string;
    signature: string | null;
    directDependents: number;
    totalDependents: number;
    references: Array<{
      fromSymbol: string;
      fromKind: string;
      fromFile: string;
      fromLine: number;
      refKind: string;
      refLine: number;
      depth: number;
    }>;
  }> = [];

  for (const sym of affectedSymbols) {
    const refs = graph.getReferences(sym.name, clampedDepth);
    const directRefs = refs.filter((r) => r.depth === 1);

    impactReport.push({
      symbol: sym.name,
      kind: sym.kind,
      lines: `${sym.lineStart}-${sym.lineEnd}`,
      signature: sym.signature,
      directDependents: directRefs.length,
      totalDependents: refs.length,
      references: refs,
    });
  }

  // Build the report
  const sections: string[] = [];

  // Summary section
  const totalDirect = impactReport.reduce((sum, r) => sum + r.directDependents, 0);
  const totalAll = impactReport.reduce((sum, r) => sum + r.totalDependents, 0);
  sections.push(
    `IMPACT ANALYSIS: ${args.file_path} lines ${args.line_start}-${args.line_end}\n` +
      `\nAffected symbols: ${affectedSymbols.length}` +
      `\nDirect dependents: ${totalDirect}` +
      `\nTotal dependents (depth ${clampedDepth}): ${totalAll}`
  );

  // Affected symbols section
  const affectedList = affectedSymbols.map((s) => {
    const sig = s.signature ? `\n    Signature: ${s.signature}` : "";
    return `  ${s.kind} ${s.name} (lines ${s.lineStart}-${s.lineEnd})${sig}`;
  });
  sections.push(`\nAFFECTED SYMBOLS:\n${affectedList.join("\n")}`);

  // Dependents breakdown
  if (totalAll > 0) {
    const dependentSections: string[] = [];

    for (const impact of impactReport) {
      if (impact.references.length === 0) {
        continue;
      }

      const header = `\n${impact.kind} ${impact.symbol}:`;
      const byDepth = new Map<number, typeof impact.references>();

      for (const ref of impact.references) {
        const list = byDepth.get(ref.depth) ?? [];
        list.push(ref);
        byDepth.set(ref.depth, list);
      }

      const depthSections: string[] = [];
      for (const [d, depthRefs] of byDepth) {
        const label = d === 1 ? "  Direct callers/users" : `  Depth ${d} (transitive)`;
        const lines = depthRefs.map(
          (r) =>
            `    ${r.fromKind} ${r.fromSymbol} (${r.fromFile}:${r.fromLine}) --[${r.refKind}]--> line ${r.refLine}`
        );
        depthSections.push(`${label}:\n${lines.join("\n")}`);
      }

      dependentSections.push(header + "\n" + depthSections.join("\n"));
    }

    sections.push(`\nDEPENDENTS:${dependentSections.join("\n")}`);
  } else {
    sections.push(
      `\nDEPENDENTS:\nNo references found. The affected symbols are not used elsewhere in the indexed codebase.`
    );
  }

  return {
    content: [
      {
        type: "text" as const,
        text: sections.join("\n"),
      },
    ],
  };
}

// Helper function to find symbols that overlap with a line range
function findSymbolsInRange(
  graph: CodeGraph,
  filePath: string,
  lineStart: number,
  lineEnd: number
): Array<{
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
}> {
  // Query the database directly for symbols in the file that overlap with the range
  const fileId = graph.getFileId(filePath);
  if (!fileId) {
    return [];
  }

  const sql = `
    SELECT s.name, s.kind, s.line_start as lineStart, s.line_end as lineEnd, s.signature
    FROM symbols s
    WHERE s.file_id = ?
      AND s.line_start <= ?
      AND s.line_end >= ?
    ORDER BY s.line_start
  `;

  const db = graph.getDb();

  return db.prepare(sql).all(fileId, lineEnd, lineStart) as Array<{
    name: string;
    kind: string;
    lineStart: number;
    lineEnd: number;
    signature: string | null;
  }>;
}
