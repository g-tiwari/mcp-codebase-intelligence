import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSource } from "./helpers.js";

describe("Java parser", () => {
  describe("classes", () => {
    it("extracts public class with methods", () => {
      const result = parseSource(
        `public class UserService {
          public User getUser(String id) { return null; }
          private void validate(String id) {}
        }`,
        "UserService.java"
      );
      const cls = result.symbols.find((s) => s.kind === "class");
      assert.ok(cls);
      assert.equal(cls.name, "UserService");
      assert.equal(cls.isExported, true);
      const methods = result.symbols.filter((s) => s.kind === "method");
      assert.equal(methods.length, 2);
      assert.equal(methods.find((m) => m.name === "getUser")?.isExported, true);
      assert.equal(methods.find((m) => m.name === "validate")?.isExported, false);
    });

    it("tracks class inheritance", () => {
      const result = parseSource(`public class Dog extends Animal {}`, "Dog.java");
      const ext = result.references.find((r) => r.kind === "extends");
      assert.ok(ext);
      assert.equal(ext.toSymbolName, "Animal");
    });

    it("tracks interface implementation", () => {
      const result = parseSource(
        `public class MyService implements Serializable, Comparable {}`,
        "MyService.java"
      );
      const impls = result.references.filter((r) => r.kind === "implements");
      assert.equal(impls.length, 2);
      assert.ok(impls.some((r) => r.toSymbolName === "Serializable"));
      assert.ok(impls.some((r) => r.toSymbolName === "Comparable"));
    });
  });

  describe("interfaces", () => {
    it("extracts interfaces", () => {
      const result = parseSource(
        `public interface Repository {\n    Object findById(String id);\n}`,
        "Repository.java"
      );
      const iface = result.symbols.find((s) => s.kind === "interface");
      assert.ok(iface);
      assert.equal(iface.name, "Repository");
      assert.equal(iface.isExported, true);
    });
  });

  describe("enums", () => {
    it("extracts enums", () => {
      const result = parseSource(
        `public enum Status { ACTIVE, INACTIVE, PENDING }`,
        "Status.java"
      );
      const e = result.symbols.find((s) => s.kind === "enum");
      assert.ok(e);
      assert.equal(e.name, "Status");
    });
  });

  describe("fields", () => {
    it("extracts field declarations", () => {
      const result = parseSource(
        `public class Config {\n    private int port;\n    public String host;\n}`,
        "Config.java"
      );
      const fields = result.symbols.filter((s) => s.kind === "property");
      assert.equal(fields.length, 2);
      assert.ok(fields.some((f) => f.name === "port"));
      assert.ok(fields.some((f) => f.name === "host"));
    });
  });

  describe("imports", () => {
    it("tracks import declarations", () => {
      const result = parseSource(
        `import java.util.HashMap;\nimport java.util.List;`,
        "Test.java"
      );
      assert.equal(result.imports.length, 2);
      assert.equal(result.imports[0].importedName, "HashMap");
      assert.equal(result.imports[1].importedName, "List");
    });

    it("tracks wildcard imports", () => {
      const result = parseSource(`import java.util.*;`, "Test.java");
      assert.equal(result.imports[0].importedName, "*");
      assert.equal(result.imports[0].isNamespace, true);
    });
  });

  describe("references", () => {
    it("tracks method invocations", () => {
      const result = parseSource(
        `public class Main {\n    public void run() {\n        System.out.println("hi");\n        helper();\n    }\n}`,
        "Main.java"
      );
      const calls = result.references.filter((r) => r.kind === "call");
      assert.ok(calls.some((c) => c.toSymbolBareName === "println"));
      assert.ok(calls.some((c) => c.toSymbolName === "helper"));
    });

    it("tracks object creation", () => {
      const result = parseSource(
        `public class Factory {\n    public Object create() {\n        return new HashMap();\n    }\n}`,
        "Factory.java"
      );
      const inst = result.references.find((r) => r.kind === "instantiation");
      assert.ok(inst);
      assert.equal(inst.toSymbolName, "HashMap");
    });

    it("tracks annotations as references", () => {
      const result = parseSource(
        `public class MyController {\n    @Override\n    public String toString() { return ""; }\n}`,
        "MyController.java"
      );
      const annot = result.references.find((r) => r.toSymbolName === "Override");
      assert.ok(annot);
    });
  });

  describe("package", () => {
    it("tracks package declaration", () => {
      const result = parseSource(
        `package com.example.app;\npublic class App {}`,
        "App.java"
      );
      const pkg = result.symbols.find((s) => s.signature?.startsWith("package"));
      assert.ok(pkg);
      assert.equal(pkg.name, "com.example.app");
    });
  });
});
