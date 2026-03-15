import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSource } from "./helpers.js";
import { createTestGraph, indexSource } from "./helpers.js";

describe("docstring extraction", () => {
  describe("TypeScript/JavaScript", () => {
    it("extracts JSDoc from functions", () => {
      const { symbols } = parseSource(
        `/** Processes user input and returns result */\nfunction process(x: number): number { return x; }`,
        "test.ts"
      );
      const fn = symbols.find(s => s.name === "process");
      assert.ok(fn);
      assert.ok(fn.docstring?.includes("Processes user input"));
    });

    it("extracts JSDoc from classes", () => {
      const { symbols } = parseSource(
        `/** Represents a user in the system */\nclass User { name: string = ""; }`,
        "test.ts"
      );
      const cls = symbols.find(s => s.name === "User");
      assert.ok(cls);
      assert.ok(cls.docstring?.includes("Represents a user"));
    });

    it("extracts JSDoc from interfaces", () => {
      const { symbols } = parseSource(
        `/** Configuration options for the app */\ninterface AppConfig { port: number; }`,
        "test.ts"
      );
      const iface = symbols.find(s => s.name === "AppConfig");
      assert.ok(iface);
      assert.ok(iface.docstring?.includes("Configuration options"));
    });

    it("extracts multiline JSDoc", () => {
      const { symbols } = parseSource(
        `/**\n * Calculate the area of a rectangle.\n * @param w - width\n * @param h - height\n */\nfunction area(w: number, h: number) { return w * h; }`,
        "test.ts"
      );
      const fn = symbols.find(s => s.name === "area");
      assert.ok(fn);
      assert.ok(fn.docstring?.includes("Calculate the area"));
      assert.ok(fn.docstring?.includes("@param w"));
    });

    it("returns undefined when no docstring", () => {
      const { symbols } = parseSource(
        `function bare() { return 1; }`,
        "test.ts"
      );
      const fn = symbols.find(s => s.name === "bare");
      assert.ok(fn);
      assert.equal(fn.docstring, undefined);
    });
  });

  describe("Python", () => {
    it("extracts triple-quoted docstrings from functions", () => {
      const { symbols } = parseSource(
        `def greet(name):\n    """Greet the user by name."""\n    return f"Hello {name}"`,
        "test.py"
      );
      const fn = symbols.find(s => s.name === "greet");
      assert.ok(fn);
      assert.ok(fn.docstring?.includes("Greet the user"));
    });

    it("extracts docstrings from classes", () => {
      const { symbols } = parseSource(
        `class Animal:\n    """Base class for all animals."""\n    pass`,
        "test.py"
      );
      const cls = symbols.find(s => s.name === "Animal");
      assert.ok(cls);
      assert.ok(cls.docstring?.includes("Base class for all animals"));
    });

    it("extracts preceding # comments as fallback", () => {
      const { symbols } = parseSource(
        `# Calculate the sum of two numbers\ndef add(a, b):\n    return a + b`,
        "test.py"
      );
      const fn = symbols.find(s => s.name === "add");
      assert.ok(fn);
      assert.ok(fn.docstring?.includes("Calculate the sum"));
    });

    it("prefers body docstring over preceding comment", () => {
      const { symbols } = parseSource(
        `# This is a comment\ndef foo():\n    """The actual docstring."""\n    pass`,
        "test.py"
      );
      const fn = symbols.find(s => s.name === "foo");
      assert.ok(fn);
      assert.ok(fn.docstring?.includes("actual docstring"));
    });
  });

  describe("Go", () => {
    it("extracts // comments from functions", () => {
      const { symbols } = parseSource(
        `package main\n\n// Process handles incoming requests.\nfunc Process(req string) string { return req }`,
        "test.go"
      );
      const fn = symbols.find(s => s.name === "Process");
      assert.ok(fn);
      assert.ok(fn.docstring?.includes("handles incoming requests"));
    });

    it("extracts comments from type declarations", () => {
      const { symbols } = parseSource(
        `package main\n\n// Server represents an HTTP server.\ntype Server struct { port int }`,
        "test.go"
      );
      const srv = symbols.find(s => s.name === "Server");
      assert.ok(srv);
      assert.ok(srv.docstring?.includes("represents an HTTP server"));
    });
  });

  describe("Rust", () => {
    it("extracts /// doc comments from functions", () => {
      const { symbols } = parseSource(
        `/// Computes the factorial of n.\nfn factorial(n: u64) -> u64 { if n <= 1 { 1 } else { n * factorial(n - 1) } }`,
        "test.rs"
      );
      const fn = symbols.find(s => s.name === "factorial");
      assert.ok(fn);
      assert.ok(fn.docstring?.includes("Computes the factorial"));
    });

    it("extracts doc comments from structs", () => {
      const { symbols } = parseSource(
        `/// A point in 2D space.\npub struct Point { x: f64, y: f64 }`,
        "test.rs"
      );
      const s = symbols.find(s => s.name === "Point");
      assert.ok(s);
      assert.ok(s.docstring?.includes("point in 2D space"));
    });

    it("extracts doc comments from traits", () => {
      const { symbols } = parseSource(
        `/// Defines drawable behavior.\npub trait Drawable { fn draw(&self); }`,
        "test.rs"
      );
      const t = symbols.find(s => s.name === "Drawable");
      assert.ok(t);
      assert.ok(t.docstring?.includes("Defines drawable behavior"));
    });
  });

  describe("Java", () => {
    it("extracts Javadoc from classes", () => {
      const { symbols } = parseSource(
        `/** Represents a bank account. */\npublic class Account { }`,
        "test.java"
      );
      const cls = symbols.find(s => s.name === "Account");
      assert.ok(cls);
      assert.ok(cls.docstring?.includes("Represents a bank account"));
    });

    it("extracts Javadoc from methods", () => {
      const { symbols } = parseSource(
        `public class Foo {\n  /** Withdraws money from the account. */\n  public void withdraw(int amount) { }\n}`,
        "test.java"
      );
      const m = symbols.find(s => s.name === "withdraw");
      assert.ok(m);
      assert.ok(m.docstring?.includes("Withdraws money"));
    });

    it("extracts Javadoc from interfaces", () => {
      const { symbols } = parseSource(
        `/** Defines payment processing. */\npublic interface PaymentProcessor { void process(); }`,
        "test.java"
      );
      const iface = symbols.find(s => s.name === "PaymentProcessor");
      assert.ok(iface);
      assert.ok(iface.docstring?.includes("Defines payment processing"));
    });
  });

  describe("C/C++", () => {
    it("extracts Doxygen comments from C functions", () => {
      const { symbols } = parseSource(
        `/** Initializes the system. */\nvoid init(void) { }`,
        "test.c"
      );
      const fn = symbols.find(s => s.name === "init");
      assert.ok(fn);
      assert.ok(fn.docstring?.includes("Initializes the system"));
    });

    it("extracts // comments from C++ classes", () => {
      const { symbols } = parseSource(
        `// Represents a vector in 3D space.\nclass Vec3 {\npublic:\n  double x, y, z;\n};`,
        "test.cpp"
      );
      const cls = symbols.find(s => s.name === "Vec3");
      assert.ok(cls);
      assert.ok(cls.docstring?.includes("Represents a vector"));
    });

    it("extracts comments from structs", () => {
      const { symbols } = parseSource(
        `/* Configuration for the renderer. */\nstruct Config { int width; int height; };`,
        "test.c"
      );
      const s = symbols.find(s => s.name === "Config");
      assert.ok(s);
      assert.ok(s.docstring?.includes("Configuration for the renderer"));
    });
  });

  describe("search_codebase integration", () => {
    it("indexes and searches by docstring", () => {
      const graph = createTestGraph();
      indexSource(
        graph,
        `/** Calculate tax for a given income amount. */\nfunction calculateTax(income: number): number { return income * 0.3; }\n\n/** Validate email format. */\nfunction validateEmail(email: string): boolean { return true; }`,
        "/test/utils.ts"
      );

      const taxResults = graph.searchByDocstring("tax");
      assert.ok(taxResults.length > 0);
      assert.ok(taxResults.some(r => r.name === "calculateTax"));

      const emailResults = graph.searchByDocstring("email");
      assert.ok(emailResults.length > 0);
      assert.ok(emailResults.some(r => r.name === "validateEmail"));

      const noResults = graph.searchByDocstring("nonexistent query xyz");
      assert.equal(noResults.length, 0);
    });

    it("filters by kind and scope", () => {
      const graph = createTestGraph();
      indexSource(
        graph,
        `/** A helper class. */\nclass Helper {}\n\n/** A helper function. */\nfunction helperFn() {}`,
        "/src/helpers.ts"
      );

      const classOnly = graph.searchByDocstring("helper", { kind: "class" });
      assert.ok(classOnly.length > 0);
      assert.ok(classOnly.every(r => r.kind === "class"));

      const scopedResults = graph.searchByDocstring("helper", { scope: "/src/" });
      assert.ok(scopedResults.length > 0);

      const wrongScope = graph.searchByDocstring("helper", { scope: "/other/" });
      assert.equal(wrongScope.length, 0);
    });
  });
});
