import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSource } from "./helpers.js";

describe("Go parser", () => {
  describe("functions", () => {
    it("extracts exported functions (capitalized)", () => {
      const result = parseSource(
        `package main\nfunc HandleRequest(w http.ResponseWriter, r *http.Request) {}`,
        "test.go"
      );
      const fn = result.symbols.find((s) => s.name === "HandleRequest");
      assert.ok(fn);
      assert.equal(fn.kind, "function");
      assert.equal(fn.isExported, true);
    });

    it("marks unexported functions (lowercase)", () => {
      const result = parseSource(`package main\nfunc helper() {}`, "test.go");
      const fn = result.symbols.find((s) => s.name === "helper");
      assert.ok(fn);
      assert.equal(fn.isExported, false);
    });
  });

  describe("methods", () => {
    it("extracts methods with receiver type", () => {
      const result = parseSource(
        `package main\nfunc (s *Server) Start() error { return nil }`,
        "test.go"
      );
      const method = result.symbols.find((s) => s.name === "Start");
      assert.ok(method);
      assert.equal(method.kind, "method");
      assert.equal(method.isExported, true);
      assert.ok(method.signature?.includes("Server"));
    });
  });

  describe("types", () => {
    it("extracts structs as class kind", () => {
      const result = parseSource(
        `package main\ntype Engine struct {\n    Port int\n}`,
        "test.go"
      );
      const s = result.symbols.find((s) => s.name === "Engine");
      assert.ok(s);
      assert.equal(s.kind, "class");
      assert.equal(s.isExported, true);
      assert.ok(s.signature?.includes("struct"));
    });

    it("extracts interfaces", () => {
      const result = parseSource(
        `package main\ntype Handler interface {\n    ServeHTTP(w ResponseWriter, r *Request)\n}`,
        "test.go"
      );
      const iface = result.symbols.find((s) => s.name === "Handler");
      assert.ok(iface);
      assert.equal(iface.kind, "interface");
    });

    it("marks unexported types", () => {
      const result = parseSource(`package main\ntype config struct {}`, "test.go");
      const s = result.symbols.find((s) => s.name === "config");
      assert.ok(s);
      assert.equal(s.isExported, false);
    });
  });

  describe("imports", () => {
    it("tracks single import", () => {
      const result = parseSource(`package main\nimport "fmt"`, "test.go");
      assert.ok(result.imports.some((i) => i.sourcePath === "fmt"));
    });

    it("tracks import block", () => {
      const result = parseSource(
        `package main\nimport (\n    "fmt"\n    "net/http"\n)`,
        "test.go"
      );
      assert.equal(result.imports.length, 2);
      assert.ok(result.imports.some((i) => i.sourcePath === "fmt"));
      assert.ok(result.imports.some((i) => i.sourcePath === "net/http"));
    });

    it("tracks aliased import", () => {
      const result = parseSource(`package main\nimport myhttp "net/http"`, "test.go");
      const imp = result.imports.find((i) => i.sourcePath === "net/http");
      assert.ok(imp);
      assert.equal(imp.localName, "myhttp");
    });
  });

  describe("references", () => {
    it("tracks function calls", () => {
      const result = parseSource(
        `package main\nfunc main() {\n    fmt.Println("hello")\n}`,
        "test.go"
      );
      const call = result.references.find((r) => r.toSymbolName === "fmt.Println");
      assert.ok(call);
      assert.equal(call.toSymbolBareName, "Println");
    });

    it("tracks struct instantiation", () => {
      const result = parseSource(
        `package main\nfunc create() {\n    s := Server{Port: 8080}\n}`,
        "test.go"
      );
      const inst = result.references.find((r) => r.kind === "instantiation");
      assert.ok(inst);
      assert.equal(inst.toSymbolName, "Server");
    });
  });
});
