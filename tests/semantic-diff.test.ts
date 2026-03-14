import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestGraph, indexSource } from "./helpers.js";
import { handleSemanticDiff } from "../src/tools/semantic-diff.js";
import type { CodeGraph } from "../src/graph/code-graph.js";

describe("semantic_diff tool", () => {
  let graph: CodeGraph;

  beforeEach(() => {
    graph = createTestGraph();

    // Index a small project
    indexSource(
      graph,
      `import { validate } from "./utils";
       export function processOrder(order: Order): Result {
         validate(order);
         return save(order);
       }
       export function cancelOrder(id: string): void {
         const order = findOrder(id);
         processOrder(order);
       }`,
      "/project/src/orders.ts"
    );

    indexSource(
      graph,
      `export function validate(input: any): boolean {
         return input != null;
       }
       export function formatError(err: Error): string {
         return err.message;
       }`,
      "/project/src/utils.ts"
    );

    indexSource(
      graph,
      `import { processOrder } from "./orders";
       export function handleRequest(req: Request) {
         const result = processOrder(req.body);
         return result;
       }`,
      "/project/src/api.ts"
    );
  });

  describe("diff parsing", () => {
    it("parses a simple unified diff", () => {
      const diff = `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,4 @@
 export function validate(input: any): boolean {
-  return input != null;
+  if (typeof input !== 'object') return false;
+  return input != null;
 }`;

      const result = handleSemanticDiff(graph, { diff });
      const text = result.content[0].text;
      assert.ok(text.includes("Semantic Diff Analysis"));
      assert.ok(text.includes("file(s) changed"));
    });

    it("handles new file diffs", () => {
      const diff = `diff --git a/src/new-file.ts b/src/new-file.ts
--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1,3 @@
+export function newHelper() {
+  return true;
+}`;

      const result = handleSemanticDiff(graph, { diff });
      const text = result.content[0].text;
      assert.ok(text.includes("1 file(s) changed"));
    });

    it("handles deleted file diffs", () => {
      const diff = `diff --git a/src/old-file.ts b/src/old-file.ts
--- a/src/old-file.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function oldHelper() {
-  return false;
-}`;

      const result = handleSemanticDiff(graph, { diff });
      const text = result.content[0].text;
      assert.ok(text.includes("1 file(s) changed"));
    });

    it("returns message for empty diff", () => {
      const result = handleSemanticDiff(graph, { diff: "" });
      assert.ok(
        result.content[0].text.includes("No diff provided") ||
        result.content[0].text.includes("No file changes")
      );
    });
  });

  describe("impact analysis", () => {
    it("finds affected symbols from a diff modifying a function", () => {
      // Modify the validate function in utils.ts
      const diff = `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,4 @@
 export function validate(input: any): boolean {
-  return input != null;
+  if (!input) throw new Error("invalid");
+  return true;
 }`;

      // Index uses relative paths so we need to match
      // Re-index with the path the diff references
      indexSource(
        graph,
        `export function validate(input: any): boolean {
           return input != null;
         }
         export function formatError(err: Error): string {
           return err.message;
         }`,
        "src/utils.ts"
      );

      indexSource(
        graph,
        `import { validate } from "./utils";
         export function processOrder(order: Order): Result {
           validate(order);
           return save(order);
         }`,
        "src/orders.ts"
      );

      const result = handleSemanticDiff(graph, { diff });
      const text = result.content[0].text;

      // Should detect that validate is modified
      assert.ok(text.includes("validate") || text.includes("symbol(s) affected"));
    });

    it("detects high-impact changes", () => {
      // Create a symbol that many things depend on
      indexSource(graph, `export function log(msg: string) {}`, "src/logger.ts");
      for (let i = 0; i < 6; i++) {
        indexSource(
          graph,
          `import { log } from "./logger";\nexport function f${i}() { log("test"); }`,
          `src/module${i}.ts`
        );
      }

      const diff = `diff --git a/src/logger.ts b/src/logger.ts
--- a/src/logger.ts
+++ b/src/logger.ts
@@ -1 +1,2 @@
-export function log(msg: string) {}
+export function log(msg: string, level: string = "info") {}`;

      const result = handleSemanticDiff(graph, { diff });
      const text = result.content[0].text;
      // Should flag high-impact change (log has >5 dependents)
      assert.ok(
        text.includes("dependents") || text.includes("Impact"),
        "Should report dependents for high-impact change"
      );
    });
  });

  describe("multi-file diffs", () => {
    it("handles diffs touching multiple files", () => {
      const diff = `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,3 @@
 export function validate(input: any): boolean {
-  return input != null;
+  return input !== null && input !== undefined;
 }
diff --git a/src/orders.ts b/src/orders.ts
--- a/src/orders.ts
+++ b/src/orders.ts
@@ -1,5 +1,5 @@
 import { validate } from "./utils";
 export function processOrder(order: Order): Result {
-  validate(order);
+  if (!validate(order)) throw new Error("invalid");
   return save(order);
 }`;

      const result = handleSemanticDiff(graph, { diff });
      const text = result.content[0].text;
      assert.ok(text.includes("2 file(s) changed"));
    });
  });
});
