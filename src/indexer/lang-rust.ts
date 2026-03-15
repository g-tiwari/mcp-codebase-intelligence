import Parser from "tree-sitter";
import Rust from "tree-sitter-rust";
import { SymbolInfo, ReferenceInfo, ImportInfo } from "../graph/code-graph.js";
import { type LanguagePlugin, registerLanguage } from "./language-plugin.js";
import { bareName } from "./tree-sitter-indexer.js";
import { getPrecedingComment } from "./docstring-extractor.js";

const rustParser = new Parser();
rustParser.setLanguage(Rust as unknown as Parser.Language);

function isPublic(node: Parser.SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "visibility_modifier") return true;
  }
  return false;
}

function extractRustFnSig(node: Parser.SyntaxNode): string | undefined {
  const name = node.childForFieldName("name")?.text ?? "";
  const params = node.childForFieldName("parameters")?.text ?? "()";
  const retType = node.childForFieldName("return_type");
  const ret = retType ? ` -> ${retType.text.replace("-> ", "")}` : "";
  return `${name}${params}${ret}`;
}

function walkRust(
  node: Parser.SyntaxNode,
  filePath: string,
  symbols: SymbolInfo[],
  references: ReferenceInfo[],
  imports: ImportInfo[],
  parentIndex?: number
) {
  switch (node.type) {
    case "function_item": {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const sym: SymbolInfo = {
          name: nameNode.text,
          kind: "function",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: isPublic(node),
          signature: extractRustFnSig(node),
          docstring: getPrecedingComment(node),
        };
        const idx = symbols.length;
        symbols.push(sym);
        walkRustChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

    case "struct_item": {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const sym: SymbolInfo = {
          name: nameNode.text,
          kind: "class",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: isPublic(node),
          signature: `struct ${nameNode.text}`,
          docstring: getPrecedingComment(node),
        };
        const idx = symbols.length;
        symbols.push(sym);
        walkRustChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

    case "enum_item": {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const sym: SymbolInfo = {
          name: nameNode.text,
          kind: "enum",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: isPublic(node),
          signature: `enum ${nameNode.text}`,
          docstring: getPrecedingComment(node),
        };
        const idx = symbols.length;
        symbols.push(sym);
        walkRustChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

    case "trait_item": {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const sym: SymbolInfo = {
          name: nameNode.text,
          kind: "interface",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: isPublic(node),
          signature: `trait ${nameNode.text}`,
          docstring: getPrecedingComment(node),
        };
        const idx = symbols.length;
        symbols.push(sym);
        walkRustChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

    case "impl_item": {
      // impl Foo { ... } or impl Trait for Foo { ... }
      const typeNode = node.childForFieldName("type");
      const traitNode = node.childForFieldName("trait");
      if (typeNode) {
        // Track as reference to the type being implemented
        if (parentIndex !== undefined || true) {
          if (traitNode) {
            references.push({
              fromSymbolId: parentIndex ?? 0,
              toSymbolName: traitNode.text,
              toSymbolBareName: bareName(traitNode.text),
              kind: "implements",
              line: node.startPosition.row + 1,
              col: node.startPosition.column,
            });
          }
        }
      }
      // Walk body for methods
      const body = node.childForFieldName("body");
      if (body) {
        walkRustChildren(body, filePath, symbols, references, imports, parentIndex);
      }
      return;
    }

    case "type_item": {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          kind: "type",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: isPublic(node),
        });
      }
      break;
    }

    case "const_item":
    case "static_item": {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          kind: "variable",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: isPublic(node),
        });
      }
      break;
    }

    case "mod_item": {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const sym: SymbolInfo = {
          name: nameNode.text,
          kind: "variable",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: isPublic(node),
          signature: `mod ${nameNode.text}`,
        };
        const idx = symbols.length;
        symbols.push(sym);
        // Walk the module body if inline
        const body = node.childForFieldName("body");
        if (body) {
          walkRustChildren(body, filePath, symbols, references, imports, idx);
        }
        return;
      }
      break;
    }

    case "call_expression": {
      const func = node.childForFieldName("function");
      if (func && parentIndex !== undefined) {
        const name = func.text;
        references.push({
          fromSymbolId: parentIndex,
          toSymbolName: name,
          toSymbolBareName: bareName(name),
          kind: "call",
          line: node.startPosition.row + 1,
          col: node.startPosition.column,
        });
      }
      break;
    }

    case "macro_invocation": {
      // println!(), vec![], etc.
      const macro = node.childForFieldName("macro");
      if (macro && parentIndex !== undefined) {
        references.push({
          fromSymbolId: parentIndex,
          toSymbolName: macro.text,
          toSymbolBareName: bareName(macro.text),
          kind: "call",
          line: node.startPosition.row + 1,
          col: node.startPosition.column,
        });
      }
      break;
    }

    case "use_declaration": {
      // use std::collections::HashMap;
      // use crate::module::{Foo, Bar};
      const arg = node.childForFieldName("argument");
      if (arg) {
        extractUseImports(arg, filePath, imports, node.startPosition.row + 1);
      }
      return;
    }
  }

  walkRustChildren(node, filePath, symbols, references, imports, parentIndex);
}

function extractUseImports(
  node: Parser.SyntaxNode,
  filePath: string,
  imports: ImportInfo[],
  line: number,
  pathPrefix: string = ""
) {
  switch (node.type) {
    case "scoped_identifier":
    case "identifier": {
      const fullPath = pathPrefix ? `${pathPrefix}::${node.text}` : node.text;
      const name = bareName(fullPath.replace(/::/g, "."));
      imports.push({
        sourcePath: fullPath,
        importedName: name,
        localName: name,
        isDefault: false,
        isNamespace: false,
        line,
      });
      break;
    }
    case "use_as_clause": {
      const path = node.childForFieldName("path");
      const alias = node.childForFieldName("alias");
      if (path) {
        const fullPath = pathPrefix ? `${pathPrefix}::${path.text}` : path.text;
        const name = bareName(fullPath.replace(/::/g, "."));
        imports.push({
          sourcePath: fullPath,
          importedName: name,
          localName: alias?.text ?? name,
          isDefault: false,
          isNamespace: false,
          line,
        });
      }
      break;
    }
    case "use_list": {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          extractUseImports(child, filePath, imports, line, pathPrefix);
        }
      }
      break;
    }
    case "scoped_use_list": {
      const path = node.childForFieldName("path");
      const list = node.childForFieldName("list");
      const newPrefix = pathPrefix
        ? `${pathPrefix}::${path?.text ?? ""}`
        : (path?.text ?? "");
      if (list) {
        extractUseImports(list, filePath, imports, line, newPrefix);
      }
      break;
    }
    case "use_wildcard": {
      const fullPath = pathPrefix || "*";
      imports.push({
        sourcePath: fullPath,
        importedName: "*",
        localName: "*",
        isDefault: false,
        isNamespace: true,
        line,
      });
      break;
    }
  }
}

function walkRustChildren(
  node: Parser.SyntaxNode,
  filePath: string,
  symbols: SymbolInfo[],
  references: ReferenceInfo[],
  imports: ImportInfo[],
  parentIndex?: number
) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) {
      walkRust(child, filePath, symbols, references, imports, parentIndex);
    }
  }
}

export const rustPlugin: LanguagePlugin = {
  id: "rust",
  extensions: [".rs"],
  getParser: () => rustParser,
  walk: walkRust,
};

registerLanguage(rustPlugin);
