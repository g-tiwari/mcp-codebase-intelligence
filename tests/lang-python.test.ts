import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSource } from "./helpers.js";

describe("Python parser", () => {
  describe("functions", () => {
    it("extracts function definitions", () => {
      const result = parseSource(
        `def greet(name: str) -> str:\n    return f"Hello {name}"`,
        "test.py"
      );
      assert.equal(result.symbols[0].name, "greet");
      assert.equal(result.symbols[0].kind, "function");
      assert.equal(result.symbols[0].isExported, true);
      assert.ok(result.symbols[0].signature?.includes("name: str"));
    });

    it("marks private functions as non-exported", () => {
      const result = parseSource(`def _helper():\n    pass`, "test.py");
      assert.equal(result.symbols[0].name, "_helper");
      assert.equal(result.symbols[0].isExported, false);
    });

    it("marks dunder methods as exported", () => {
      const result = parseSource(
        `class Foo:\n    def __init__(self):\n        pass`,
        "test.py"
      );
      const init = result.symbols.find((s) => s.name === "__init__");
      assert.ok(init);
      assert.equal(init.isExported, true);
      assert.equal(init.kind, "method");
    });
  });

  describe("classes", () => {
    it("extracts class with methods", () => {
      const result = parseSource(
        `class UserService:\n    def get_user(self, id: str) -> dict:\n        pass\n    def delete_user(self, id: str) -> None:\n        pass`,
        "test.py"
      );
      const cls = result.symbols.find((s) => s.kind === "class");
      assert.ok(cls);
      assert.equal(cls.name, "UserService");
      const methods = result.symbols.filter((s) => s.kind === "method");
      assert.equal(methods.length, 2);
    });

    it("tracks inheritance", () => {
      const result = parseSource(
        `class Dog(Animal):\n    def bark(self):\n        pass`,
        "test.py"
      );
      const ext = result.references.find((r) => r.kind === "extends");
      assert.ok(ext);
      assert.equal(ext.toSymbolName, "Animal");
    });

    it("tracks multiple inheritance", () => {
      const result = parseSource(`class MyView(View, Mixin):\n    pass`, "test.py");
      const exts = result.references.filter((r) => r.kind === "extends");
      assert.equal(exts.length, 2);
      assert.ok(exts.some((r) => r.toSymbolName === "View"));
      assert.ok(exts.some((r) => r.toSymbolName === "Mixin"));
    });
  });

  describe("imports", () => {
    it("tracks import statements", () => {
      const result = parseSource(`import os`, "test.py");
      assert.equal(result.imports[0].sourcePath, "os");
      assert.equal(result.imports[0].isNamespace, true);
    });

    it("tracks from-import statements", () => {
      const result = parseSource(`from pathlib import Path, PurePath`, "test.py");
      assert.equal(result.imports.length, 2);
      assert.equal(result.imports[0].sourcePath, "pathlib");
      assert.equal(result.imports[0].importedName, "Path");
    });

    it("tracks aliased imports", () => {
      const result = parseSource(`import numpy as np`, "test.py");
      assert.equal(result.imports[0].sourcePath, "numpy");
      assert.equal(result.imports[0].localName, "np");
    });

    it("tracks wildcard imports", () => {
      const result = parseSource(`from utils import *`, "test.py");
      assert.equal(result.imports[0].importedName, "*");
      assert.equal(result.imports[0].isNamespace, true);
    });
  });

  describe("references", () => {
    it("tracks function calls", () => {
      const result = parseSource(
        `def main():\n    print("hello")\n    greet("world")`,
        "test.py"
      );
      const calls = result.references.filter((r) => r.kind === "call");
      assert.ok(calls.some((c) => c.toSymbolName === "print"));
      assert.ok(calls.some((c) => c.toSymbolName === "greet"));
    });

    it("tracks method calls with bare names", () => {
      const result = parseSource(
        `def main():\n    response = session.get("https://example.com")`,
        "test.py"
      );
      const call = result.references.find((r) => r.toSymbolName === "session.get");
      assert.ok(call);
      assert.equal(call.toSymbolBareName, "get");
    });
  });

  describe("variables", () => {
    it("tracks top-level constants", () => {
      const result = parseSource(`MAX_RETRIES = 3\nDEFAULT_TIMEOUT = 30`, "test.py");
      const vars = result.symbols.filter((s) => s.kind === "variable");
      assert.ok(vars.some((v) => v.name === "MAX_RETRIES"));
      assert.ok(vars.some((v) => v.name === "DEFAULT_TIMEOUT"));
    });
  });
});
