import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSource } from "./helpers.js";

describe("Rust parser", () => {
  describe("functions", () => {
    it("extracts public functions", () => {
      const result = parseSource(
        `pub fn process(input: &str) -> Result<String, Error> {\n    Ok(input.to_string())\n}`,
        "test.rs"
      );
      const fn_ = result.symbols.find((s) => s.name === "process");
      assert.ok(fn_);
      assert.equal(fn_.kind, "function");
      assert.equal(fn_.isExported, true);
      assert.ok(fn_.signature?.includes("input: &str"));
    });

    it("marks private functions as non-exported", () => {
      const result = parseSource(`fn helper() {}`, "test.rs");
      assert.equal(result.symbols.find((s) => s.name === "helper")?.isExported, false);
    });
  });

  describe("structs", () => {
    it("extracts structs as class kind", () => {
      const result = parseSource(
        `pub struct Config {\n    port: u16,\n    host: String,\n}`,
        "test.rs"
      );
      const s = result.symbols.find((s) => s.name === "Config");
      assert.ok(s);
      assert.equal(s.kind, "class");
      assert.equal(s.isExported, true);
      assert.ok(s.signature?.includes("struct Config"));
    });
  });

  describe("enums", () => {
    it("extracts enums", () => {
      const result = parseSource(
        `pub enum Color {\n    Red,\n    Green,\n    Blue,\n}`,
        "test.rs"
      );
      const e = result.symbols.find((s) => s.name === "Color");
      assert.ok(e);
      assert.equal(e.kind, "enum");
      assert.equal(e.isExported, true);
    });
  });

  describe("traits", () => {
    it("extracts traits as interface kind", () => {
      const result = parseSource(
        `pub trait Serialize {\n    fn serialize(&self) -> String;\n}`,
        "test.rs"
      );
      const t = result.symbols.find((s) => s.name === "Serialize");
      assert.ok(t);
      assert.equal(t.kind, "interface");
      assert.equal(t.isExported, true);
    });
  });

  describe("impl blocks", () => {
    it("tracks trait implementation references", () => {
      const result = parseSource(
        `impl Display for Config {\n    fn fmt(&self, f: &mut Formatter) -> Result {\n        Ok(())\n    }\n}`,
        "test.rs"
      );
      const implRef = result.references.find((r) => r.kind === "implements");
      assert.ok(implRef);
      assert.equal(implRef.toSymbolName, "Display");
    });
  });

  describe("use declarations", () => {
    it("tracks simple use", () => {
      const result = parseSource(`use std::collections::HashMap;`, "test.rs");
      assert.ok(result.imports.length > 0);
      assert.ok(result.imports[0].sourcePath.includes("HashMap"));
    });

    it("tracks grouped use", () => {
      const result = parseSource(`use std::io::{Read, Write};`, "test.rs");
      assert.equal(result.imports.length, 2);
      assert.ok(result.imports.some((i) => i.importedName === "Read"));
      assert.ok(result.imports.some((i) => i.importedName === "Write"));
    });

    it("tracks wildcard use", () => {
      const result = parseSource(`use std::prelude::*;`, "test.rs");
      const wild = result.imports.find((i) => i.importedName === "*");
      assert.ok(wild);
      assert.equal(wild.isNamespace, true);
    });
  });

  describe("modules", () => {
    it("extracts mod declarations", () => {
      const result = parseSource(`pub mod utils;\nmod internal;`, "test.rs");
      const pubMod = result.symbols.find((s) => s.name === "utils");
      assert.ok(pubMod);
      assert.equal(pubMod.isExported, true);
      const privMod = result.symbols.find((s) => s.name === "internal");
      assert.ok(privMod);
      assert.equal(privMod.isExported, false);
    });
  });
});
