import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestGraph, indexSource, parseSource } from "./helpers.js";
import type { CodeGraph } from "../src/graph/code-graph.js";

describe("CodeGraph", () => {
  let graph: CodeGraph;

  beforeEach(() => {
    graph = createTestGraph();
  });

  describe("indexFile", () => {
    it("indexes a TypeScript file and returns stats", () => {
      indexSource(
        graph,
        `export function greet(name: string) { return name; }\nexport class Foo {}`,
        "/test/file.ts"
      );
      const stats = graph.getStats();
      assert.equal(stats.files, 1);
      assert.ok(stats.symbols >= 2);
    });

    it("skips unchanged files on re-index", () => {
      const code = `export function hello() {}`;
      indexSource(graph, code, "/test/file.ts");
      const stats1 = graph.getStats();

      indexSource(graph, code, "/test/file.ts");
      const stats2 = graph.getStats();
      assert.equal(stats2.symbols, stats1.symbols);
    });

    it("re-indexes when file content changes", () => {
      indexSource(graph, `function a() {}`, "/test/file.ts");
      const stats1 = graph.getStats();

      indexSource(graph, `function a() {}\nfunction b() {}`, "/test/file.ts");
      const stats2 = graph.getStats();
      assert.ok(stats2.symbols > stats1.symbols);
    });
  });

  describe("findSymbols", () => {
    beforeEach(() => {
      indexSource(
        graph,
        `export function processData(input: string) {}
         export class DataProcessor {
           transform(data: any) {}
         }
         export interface Config {}
         export type ID = string;
         const helper = () => {};`,
        "/test/app.ts"
      );
    });

    it("finds symbols by name", () => {
      const results = graph.findSymbols({ name: "processData" });
      assert.ok(results.length > 0);
      assert.equal(results[0].name, "processData");
    });

    it("finds symbols by partial name", () => {
      const results = graph.findSymbols({ name: "Data" });
      assert.ok(results.length >= 2);
    });

    it("filters by kind", () => {
      const results = graph.findSymbols({ name: "Data", kind: "class" });
      assert.equal(results.length, 1);
      assert.equal(results[0].name, "DataProcessor");
    });

    it("filters by scope (file path prefix)", () => {
      indexSource(graph, `function other() {}`, "/other/file.ts");
      const results = graph.findSymbols({ name: "other", scope: "/other/" });
      assert.ok(results.length > 0);
      assert.ok(results.every((r) => r.filePath.startsWith("/other/")));
    });

    it("prioritizes exact name matches", () => {
      const results = graph.findSymbols({ name: "Config" });
      assert.equal(results[0].name, "Config");
    });

    it("respects limit", () => {
      const results = graph.findSymbols({ limit: 1 });
      assert.equal(results.length, 1);
    });
  });

  describe("getReferences", () => {
    beforeEach(() => {
      indexSource(
        graph,
        `import { helper } from "./utils";
         export function main() {
           helper();
           logger.info("starting");
           const result = process("data");
         }`,
        "/test/main.ts"
      );
    });

    it("finds direct references by exact name", () => {
      const refs = graph.getReferences("helper");
      assert.ok(refs.length > 0);
      assert.ok(refs.some((r) => r.toSymbol === "helper"));
    });

    it("finds member expression references by bare name", () => {
      const refs = graph.getReferences("info");
      assert.ok(refs.length > 0);
    });

    it("finds references by object prefix", () => {
      const refs = graph.getReferences("logger");
      assert.ok(refs.length > 0);
      assert.ok(refs.some((r) => r.toSymbol.startsWith("logger.")));
    });
  });

  describe("getExports", () => {
    it("returns only exported symbols", () => {
      indexSource(
        graph,
        `export function pub() {}
         function priv() {}
         export class Exported {}`,
        "/test/mod.ts"
      );
      const exports = graph.getExports("/test/mod.ts");
      assert.ok(exports.some((e) => e.name === "pub"));
      assert.ok(exports.some((e) => e.name === "Exported"));
      assert.ok(!exports.some((e) => e.name === "priv"));
    });
  });

  describe("getImports", () => {
    it("returns imports for a file", () => {
      indexSource(
        graph,
        `import { foo } from "./foo";\nimport bar from "./bar";`,
        "/test/main.ts"
      );
      const imports = graph.getImports("/test/main.ts");
      assert.equal(imports.length, 2);
      assert.ok(imports.some((i) => i.sourcePath === "./foo"));
      assert.ok(imports.some((i) => i.sourcePath === "./bar"));
    });
  });

  describe("removeFile", () => {
    it("removes a file and its symbols", () => {
      indexSource(graph, `function a() {}`, "/test/file.ts");
      assert.equal(graph.getStats().files, 1);

      graph.removeFile("/test/file.ts");
      assert.equal(graph.getStats().files, 0);
      assert.equal(graph.getStats().symbols, 0);
    });
  });

  describe("indexFileBatch", () => {
    it("indexes multiple files in a single transaction", () => {
      const files = [
        { code: `export function a() {}`, path: "/test/a.ts" },
        { code: `export function b() { a(); }`, path: "/test/b.ts" },
        { code: `export class C {}`, path: "/test/c.ts" },
      ].map(({ code, path }) => {
        const result = parseSource(code, path);
        return { filePath: path, content: code, ...result };
      });

      const { indexed, skipped } = graph.indexFileBatch(files);
      assert.equal(indexed, 3);
      assert.equal(skipped, 0);
      assert.equal(graph.getStats().files, 3);

      // Re-batch same files — should all be skipped
      const result2 = graph.indexFileBatch(files);
      assert.equal(result2.skipped, 3);
      assert.equal(result2.indexed, 0);
    });
  });

  describe("cross-language indexing", () => {
    it("indexes files from multiple languages", () => {
      indexSource(graph, `export function tsFunc() {}`, "/proj/app.ts");
      indexSource(graph, `def py_func():\n    pass`, "/proj/app.py");
      indexSource(graph, `package main\nfunc GoFunc() {}`, "/proj/main.go");

      const stats = graph.getStats();
      assert.equal(stats.files, 3);

      assert.equal(graph.findSymbols({ name: "tsFunc" }).length, 1);
      assert.equal(graph.findSymbols({ name: "py_func" }).length, 1);
      assert.equal(graph.findSymbols({ name: "GoFunc" }).length, 1);
    });
  });
});
