import { initializeDatabase } from "../src/graph/schema.js";
import { CodeGraph } from "../src/graph/code-graph.js";
import { parseSource } from "../src/indexer/tree-sitter-indexer.js";

// Import language plugins for side-effect registration
import "../src/indexer/lang-python.js";
import "../src/indexer/lang-go.js";
import "../src/indexer/lang-rust.js";
import "../src/indexer/lang-java.js";

export { parseSource };

export function createTestGraph(): CodeGraph {
  const db = initializeDatabase(":memory:");
  return new CodeGraph(db);
}

export function indexSource(graph: CodeGraph, code: string, filePath: string) {
  const result = parseSource(code, filePath);
  graph.indexFile(filePath, code, result.symbols, result.references, result.imports);
  return result;
}
