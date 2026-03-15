import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSource } from "./helpers.js";

describe("C parser", () => {
  describe("functions", () => {
    it("extracts functions with signatures", () => {
      const { symbols } = parseSource(
        `int process(int x, int y) { return x + y; }`,
        "test.c"
      );
      const fn = symbols.find((s) => s.name === "process");
      assert.ok(fn);
      assert.equal(fn.kind, "function");
      assert.equal(fn.isExported, true);
      assert.ok(fn.signature?.includes("int process"));
    });

    it("marks static functions as non-exported", () => {
      const { symbols } = parseSource(
        `static int helper(int n) { return n * 2; }`,
        "test.c"
      );
      const fn = symbols.find((s) => s.name === "helper");
      assert.ok(fn);
      assert.equal(fn.isExported, false);
    });
  });

  describe("structs", () => {
    it("extracts typedef structs", () => {
      const { symbols } = parseSource(
        `typedef struct { int x; int y; } Point;`,
        "test.c"
      );
      assert.ok(symbols.find((s) => s.name === "Point" && s.kind === "type"));
    });
  });

  describe("enums", () => {
    it("extracts enums", () => {
      const { symbols } = parseSource(
        `enum Color { RED, GREEN, BLUE };`,
        "test.c"
      );
      const e = symbols.find((s) => s.name === "Color");
      assert.ok(e);
      assert.equal(e.kind, "enum");
    });

    it("does not duplicate enums used in function parameters", () => {
      const { symbols } = parseSource(
        `enum Dir { N, S, E, W };\nvoid move(enum Dir d) {}`,
        "test.c"
      );
      const enums = symbols.filter((s) => s.name === "Dir" && s.kind === "enum");
      assert.equal(enums.length, 1, "enum should appear exactly once");
    });
  });

  describe("includes", () => {
    it("extracts system includes", () => {
      const { imports } = parseSource(
        `#include <stdio.h>\n#include <stdlib.h>\nvoid main() {}`,
        "test.c"
      );
      assert.ok(imports.find((i) => i.sourcePath === "stdio.h"));
      assert.ok(imports.find((i) => i.sourcePath === "stdlib.h"));
    });

    it("extracts local includes", () => {
      const { imports } = parseSource(
        `#include "myheader.h"\nvoid foo() {}`,
        "test.c"
      );
      assert.ok(imports.find((i) => i.sourcePath === "myheader.h"));
    });
  });

  describe("references", () => {
    it("tracks function calls", () => {
      const { references } = parseSource(
        `int helper(int n) { return n; }\nint main() { return helper(42); }`,
        "test.c"
      );
      assert.ok(references.find((r) => r.toSymbolName === "helper" && r.kind === "call"));
    });
  });
});

describe("C++ parser", () => {
  describe("classes", () => {
    it("extracts classes", () => {
      const { symbols } = parseSource(
        `class Animal {\npublic:\n  virtual void speak() = 0;\n};`,
        "test.cpp"
      );
      const cls = symbols.find((s) => s.name === "Animal");
      assert.ok(cls);
      assert.equal(cls.kind, "class");
    });

    it("extracts structs as class kind", () => {
      const { symbols } = parseSource(
        `struct Point {\n  double x, y;\n};`,
        "test.cpp"
      );
      assert.ok(symbols.find((s) => s.name === "Point" && s.kind === "class"));
    });
  });

  describe("inheritance", () => {
    it("tracks base classes as extends references", () => {
      const { references } = parseSource(
        `class Base {};\nclass Derived : public Base {};`,
        "test.cpp"
      );
      assert.ok(references.find((r) => r.toSymbolName === "Base" && r.kind === "extends"));
    });
  });

  describe("namespaces", () => {
    it("extracts namespaces", () => {
      const { symbols } = parseSource(
        `namespace mylib {\n  void helper() {}\n}`,
        "test.cpp"
      );
      assert.ok(symbols.find((s) => s.name === "mylib"));
      assert.ok(symbols.find((s) => s.name === "helper" && s.kind === "function"));
    });
  });

  describe("templates", () => {
    it("extracts template functions", () => {
      const { symbols } = parseSource(
        `template<typename T>\nT max_val(T a, T b) { return (a > b) ? a : b; }`,
        "test.cpp"
      );
      assert.ok(symbols.find((s) => s.name === "max_val" && s.kind === "function"));
    });
  });

  describe("methods", () => {
    it("extracts class methods", () => {
      const { symbols } = parseSource(
        `class Dog {\npublic:\n  void speak() const { }\n  std::string name() { return ""; }\n};`,
        "test.cpp"
      );
      // Methods may appear as method or function depending on parser context
      const speak = symbols.find((s) => s.name === "speak");
      assert.ok(speak, "should find speak");
      const name = symbols.find((s) => s.name === "name");
      assert.ok(name, "should find name");
    });
  });

  describe("includes", () => {
    it("extracts C++ includes", () => {
      const { imports } = parseSource(
        `#include <iostream>\n#include <vector>\nvoid foo() {}`,
        "test.cpp"
      );
      assert.ok(imports.find((i) => i.sourcePath === "iostream"));
      assert.ok(imports.find((i) => i.sourcePath === "vector"));
    });
  });

  describe("enums", () => {
    it("extracts enum class (C++11)", () => {
      const { symbols } = parseSource(
        `enum class Color { Red, Green, Blue };`,
        "test.cpp"
      );
      const e = symbols.find((s) => s.name === "Color" && s.kind === "enum");
      assert.ok(e, "should extract enum class");
    });
  });
});
