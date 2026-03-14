import { execSync } from "child_process";
import { CodeGraph } from "../graph/code-graph.js";

export const semanticDiffTool = {
  name: "semantic_diff",
  description:
    "Analyze the semantic impact of a git diff or code change. Identifies which symbols were modified/added/removed, finds all downstream dependents, and produces a structured impact report. Preferred: use `git_ref` (e.g. 'HEAD~1', 'HEAD~5', 'main', 'staged') to let the tool run git diff directly — avoids truncation of large diffs. Alternatively pass raw diff text via `diff`.",
  inputSchema: {
    type: "object" as const,
    properties: {
      git_ref: {
        type: "string",
        description:
          "Git ref to diff against (e.g. 'HEAD~1', 'HEAD~5', 'main', 'staged', 'unstaged'). The tool runs git diff internally — use this instead of passing diff text to avoid truncation.",
      },
      diff: {
        type: "string",
        description:
          "Raw unified diff text. Only use if git_ref is not applicable (e.g. for non-git diffs).",
      },
      depth: {
        type: "number",
        description:
          "How many levels of transitive dependents to follow (default: 2, max: 5)",
      },
    },
  },
};

interface DiffHunk {
  filePath: string;
  oldFile: string;
  newFile: string;
  addedLines: number[];
  removedLines: number[];
  changedLineStart: number;
  changedLineEnd: number;
  status: "modified" | "added" | "deleted" | "renamed";
}

interface AffectedSymbol {
  name: string;
  kind: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
  changeType: "modified" | "added" | "removed";
}

interface SymbolImpact {
  symbol: AffectedSymbol;
  directDependents: number;
  totalDependents: number;
  dependentFiles: string[];
  references: Array<{
    fromSymbol: string;
    fromFile: string;
    fromLine: number;
    refKind: string;
    depth: number;
  }>;
}

export function handleSemanticDiff(
  graph: CodeGraph,
  args: { diff?: string; git_ref?: string; depth?: number },
  projectRoot?: string
) {
  const depth = Math.min(Math.max(args.depth ?? 2, 1), 5);

  let diffText = args.diff ?? "";

  // If git_ref is provided, run git diff directly to avoid AI truncation
  if (args.git_ref && projectRoot) {
    try {
      const ref = args.git_ref.trim();
      let cmd: string;
      if (ref === "staged") {
        cmd = "git diff --staged";
      } else if (ref === "unstaged") {
        cmd = "git diff";
      } else {
        // Sanitize: only allow safe git ref characters
        const safeRef = ref.replace(/[^a-zA-Z0-9_.~\-/^]/g, "");
        cmd = `git diff ${safeRef}`;
      }
      diffText = execSync(cmd, {
        cwd: projectRoot,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        encoding: "utf-8",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to run git diff: ${message}`,
          },
        ],
      };
    }
  }

  if (!diffText) {
    return {
      content: [
        {
          type: "text" as const,
          text: "No diff provided. Use `git_ref` (e.g. 'HEAD~1', 'staged') or pass raw diff text via `diff`.",
        },
      ],
    };
  }

  const hunks = parseDiff(diffText);

  if (hunks.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "No file changes detected in the provided diff.",
        },
      ],
    };
  }

  // Collect all affected symbols across all changed files
  const allImpacts: SymbolImpact[] = [];
  const filesSummary: Array<{
    file: string;
    status: string;
    symbolsAffected: number;
    linesChanged: number;
  }> = [];

  for (const hunk of hunks) {
    const filePath = hunk.newFile !== "/dev/null" ? hunk.newFile : hunk.oldFile;
    const linesChanged = hunk.addedLines.length + hunk.removedLines.length;

    // Find symbols affected by this hunk
    const affected = findAffectedSymbols(graph, hunk);

    filesSummary.push({
      file: filePath,
      status: hunk.status,
      symbolsAffected: affected.length,
      linesChanged,
    });

    // For each affected symbol, find dependents
    for (const sym of affected) {
      const refs = graph.getReferences(sym.name, depth);
      // Exclude self-references (same file, same symbol)
      const externalRefs = refs.filter(
        (r) => r.fromFile !== sym.filePath || r.fromSymbol !== sym.name
      );

      const dependentFiles = [
        ...new Set(externalRefs.map((r) => r.fromFile)),
      ];

      allImpacts.push({
        symbol: sym,
        directDependents: externalRefs.filter((r) => r.depth === 1).length,
        totalDependents: externalRefs.length,
        dependentFiles,
        references: externalRefs.map((r) => ({
          fromSymbol: r.fromSymbol,
          fromFile: r.fromFile,
          fromLine: r.fromLine,
          refKind: r.refKind,
          depth: r.depth,
        })),
      });
    }
  }

  // Build the report
  return {
    content: [
      {
        type: "text" as const,
        text: buildReport(hunks, filesSummary, allImpacts, depth),
      },
    ],
  };
}

function buildReport(
  hunks: DiffHunk[],
  filesSummary: typeof Array.prototype,
  impacts: SymbolImpact[],
  depth: number
): string {
  const sections: string[] = [];

  // --- Header ---
  const totalFiles = hunks.length;
  const totalSymbols = impacts.length;
  const totalDependents = impacts.reduce((s, i) => s + i.totalDependents, 0);
  const allDependentFiles = [
    ...new Set(impacts.flatMap((i) => i.dependentFiles)),
  ];

  sections.push(
    `# Semantic Diff Analysis\n\n` +
      `**${totalFiles} file(s) changed** → **${totalSymbols} symbol(s) affected** → **${totalDependents} dependent(s)** across **${allDependentFiles.length} file(s)**`
  );

  // --- Files Changed ---
  sections.push(`\n## Files Changed\n`);
  for (const f of filesSummary as Array<{
    file: string;
    status: string;
    symbolsAffected: number;
    linesChanged: number;
  }>) {
    const statusIcon =
      f.status === "added"
        ? "+"
        : f.status === "deleted"
          ? "-"
          : f.status === "renamed"
            ? "→"
            : "M";
    sections.push(
      `  ${statusIcon} ${f.file} (${f.linesChanged} lines, ${f.symbolsAffected} symbols)`
    );
  }

  // --- Modified Symbols ---
  if (impacts.length > 0) {
    sections.push(`\n## Affected Symbols\n`);

    // Group by change type
    const added = impacts.filter((i) => i.symbol.changeType === "added");
    const modified = impacts.filter((i) => i.symbol.changeType === "modified");
    const removed = impacts.filter((i) => i.symbol.changeType === "removed");

    if (added.length > 0) {
      sections.push(`### Added`);
      for (const i of added) {
        const sig = i.symbol.signature ? ` — \`${i.symbol.signature}\`` : "";
        sections.push(`  + ${i.symbol.kind} **${i.symbol.name}**${sig}`);
      }
    }

    if (modified.length > 0) {
      sections.push(`### Modified`);
      for (const i of modified) {
        const sig = i.symbol.signature ? ` — \`${i.symbol.signature}\`` : "";
        const deps =
          i.totalDependents > 0
            ? ` (${i.directDependents} direct, ${i.totalDependents} total dependents)`
            : "";
        sections.push(
          `  M ${i.symbol.kind} **${i.symbol.name}**${sig}${deps}`
        );
      }
    }

    if (removed.length > 0) {
      sections.push(`### Removed`);
      for (const i of removed) {
        const deps =
          i.totalDependents > 0
            ? ` ⚠️ **${i.totalDependents} broken reference(s)**`
            : "";
        sections.push(`  - ${i.symbol.kind} **${i.symbol.name}**${deps}`);
      }
    }
  }

  // --- Impact Details ---
  const impactsWithDeps = impacts.filter((i) => i.totalDependents > 0);
  if (impactsWithDeps.length > 0) {
    sections.push(`\n## Impact Details\n`);

    for (const impact of impactsWithDeps) {
      sections.push(
        `### ${impact.symbol.kind} \`${impact.symbol.name}\` (${impact.symbol.filePath}:${impact.symbol.lineStart})`
      );

      // Group dependents by file
      const byFile = new Map<string, typeof impact.references>();
      for (const ref of impact.references) {
        const list = byFile.get(ref.fromFile) ?? [];
        list.push(ref);
        byFile.set(ref.fromFile, list);
      }

      for (const [file, refs] of byFile) {
        const lines = refs
          .map(
            (r) =>
              `    ${r.fromSymbol} (line ${r.fromLine}) --[${r.refKind}]-->`
          )
          .join("\n");
        sections.push(`  ${file}:\n${lines}`);
      }
    }
  }

  // --- Risk Assessment ---
  const removedWithDeps = impacts.filter(
    (i) => i.symbol.changeType === "removed" && i.totalDependents > 0
  );
  const highImpact = impacts.filter((i) => i.totalDependents > 5);

  if (removedWithDeps.length > 0 || highImpact.length > 0) {
    sections.push(`\n## ⚠️ Risk Assessment\n`);

    if (removedWithDeps.length > 0) {
      sections.push(
        `**Breaking changes detected:** ${removedWithDeps.length} removed symbol(s) with active references:`
      );
      for (const i of removedWithDeps) {
        sections.push(
          `  - \`${i.symbol.name}\` is referenced ${i.totalDependents} time(s) in ${i.dependentFiles.length} file(s): ${i.dependentFiles.join(", ")}`
        );
      }
    }

    if (highImpact.length > 0) {
      sections.push(
        `\n**High-impact changes:** ${highImpact.length} symbol(s) with >5 dependents:`
      );
      for (const i of highImpact) {
        sections.push(
          `  - \`${i.symbol.name}\` → ${i.totalDependents} dependents across ${i.dependentFiles.length} files`
        );
      }
    }
  }

  return sections.join("\n");
}

// --- Diff Parsing ---

function parseDiff(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diffText.split("\n");
  let i = 0;

  while (i < lines.length) {
    // Find diff header: "diff --git a/path b/path"
    if (!lines[i].startsWith("diff --git")) {
      i++;
      continue;
    }

    const diffLine = lines[i];
    i++;

    // Parse file paths
    let oldFile = "";
    let newFile = "";
    let status: DiffHunk["status"] = "modified";

    // Look for --- and +++ lines
    while (i < lines.length && !lines[i].startsWith("@@")) {
      if (lines[i].startsWith("--- ")) {
        oldFile = lines[i].substring(4);
        if (oldFile.startsWith("a/")) oldFile = oldFile.substring(2);
        if (oldFile === "/dev/null") status = "added";
      } else if (lines[i].startsWith("+++ ")) {
        newFile = lines[i].substring(4);
        if (newFile.startsWith("b/")) newFile = newFile.substring(2);
        if (newFile === "/dev/null") status = "deleted";
      } else if (lines[i].startsWith("rename from")) {
        status = "renamed";
      }
      i++;
    }

    // If no --- / +++ found, try to extract from the diff --git line
    if (!oldFile && !newFile) {
      const match = diffLine.match(/diff --git a\/(.+) b\/(.+)/);
      if (match) {
        oldFile = match[1];
        newFile = match[2];
      }
    }

    // Parse hunks for this file
    const addedLines: number[] = [];
    const removedLines: number[] = [];
    let minLine = Infinity;
    let maxLine = 0;

    while (i < lines.length && !lines[i].startsWith("diff --git")) {
      if (lines[i].startsWith("@@")) {
        // Parse hunk header: @@ -old,count +new,count @@
        const match = lines[i].match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          let oldLineNum = parseInt(match[1], 10);
          let newLineNum = parseInt(match[2], 10);
          i++;

          while (
            i < lines.length &&
            !lines[i].startsWith("@@") &&
            !lines[i].startsWith("diff --git")
          ) {
            if (lines[i].startsWith("+") && !lines[i].startsWith("+++")) {
              addedLines.push(newLineNum);
              minLine = Math.min(minLine, newLineNum);
              maxLine = Math.max(maxLine, newLineNum);
              newLineNum++;
            } else if (lines[i].startsWith("-") && !lines[i].startsWith("---")) {
              removedLines.push(oldLineNum);
              minLine = Math.min(minLine, oldLineNum);
              maxLine = Math.max(maxLine, oldLineNum);
              oldLineNum++;
            } else {
              // Context line
              oldLineNum++;
              newLineNum++;
            }
            i++;
          }
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    if (minLine === Infinity) minLine = 1;
    if (maxLine === 0) maxLine = minLine;

    hunks.push({
      filePath: newFile || oldFile,
      oldFile,
      newFile,
      addedLines,
      removedLines,
      changedLineStart: minLine,
      changedLineEnd: maxLine,
      status,
    });
  }

  return hunks;
}

// --- Symbol Impact Detection ---

function findAffectedSymbols(
  graph: CodeGraph,
  hunk: DiffHunk
): AffectedSymbol[] {
  const result: AffectedSymbol[] = [];

  if (hunk.status === "added") {
    // New file — all symbols are "added"
    const symbols = graph.findSymbols({ scope: hunk.newFile, limit: 100 });
    for (const sym of symbols) {
      if (sym.filePath === hunk.newFile || sym.filePath.endsWith("/" + hunk.newFile)) {
        result.push({
          ...sym,
          filePath: sym.filePath,
          changeType: "added",
        });
      }
    }
    return result;
  }

  if (hunk.status === "deleted") {
    // Deleted file — find symbols from old index (they might still be in DB)
    const symbols = graph.findSymbols({ scope: hunk.oldFile, limit: 100 });
    for (const sym of symbols) {
      if (sym.filePath === hunk.oldFile || sym.filePath.endsWith("/" + hunk.oldFile)) {
        result.push({
          ...sym,
          filePath: sym.filePath,
          changeType: "removed",
        });
      }
    }
    return result;
  }

  // Modified file — find symbols that overlap with changed lines
  const filePath = hunk.newFile;

  // Try both the path as-is and with the project root
  const db = graph.getDb();

  // Find the file in the index — try exact match and suffix match
  const fileRow = db
    .prepare(
      `SELECT id, path FROM files WHERE path = ? OR path LIKE ?`
    )
    .get(filePath, `%/${filePath}`) as { id: number; path: string } | undefined;

  if (!fileRow) return result;

  const actualPath = fileRow.path;

  // Get all symbols in this file
  const allSymbols = db
    .prepare(
      `SELECT name, kind, line_start as lineStart, line_end as lineEnd, signature
       FROM symbols WHERE file_id = ? ORDER BY line_start`
    )
    .all(fileRow.id) as Array<{
    name: string;
    kind: string;
    lineStart: number;
    lineEnd: number;
    signature: string | null;
  }>;

  // Check which symbols overlap with changed lines
  const changedLineSet = new Set([...hunk.addedLines, ...hunk.removedLines]);

  for (const sym of allSymbols) {
    let overlaps = false;

    // Check if any changed line falls within this symbol's range
    for (const line of changedLineSet) {
      if (line >= sym.lineStart && line <= sym.lineEnd) {
        overlaps = true;
        break;
      }
    }

    // Also check using the hunk's overall range
    if (
      !overlaps &&
      sym.lineStart <= hunk.changedLineEnd &&
      sym.lineEnd >= hunk.changedLineStart
    ) {
      overlaps = true;
    }

    if (overlaps) {
      result.push({
        ...sym,
        filePath: actualPath,
        changeType: "modified",
      });
    }
  }

  return result;
}
