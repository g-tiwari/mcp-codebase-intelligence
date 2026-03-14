import Parser from "tree-sitter";
import Java from "tree-sitter-java";
import { SymbolInfo, ReferenceInfo, ImportInfo } from "../graph/code-graph.js";
import { type LanguagePlugin, registerLanguage } from "./language-plugin.js";
import { bareName } from "./tree-sitter-indexer.js";

const javaParser = new Parser();
javaParser.setLanguage(Java);

function hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
  const mods = node.childForFieldName("modifiers") ?? findChild(node, "modifiers");
  if (!mods) return false;
  for (let i = 0; i < mods.childCount; i++) {
    if (mods.child(i)?.text === modifier) return true;
  }
  return false;
}

function isPublicJava(node: Parser.SyntaxNode): boolean {
  return hasModifier(node, "public");
}

function findChild(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === type) return node.child(i);
  }
  return null;
}

function extractJavaMethodSig(node: Parser.SyntaxNode): string | undefined {
  const name = node.childForFieldName("name")?.text ?? "";
  const params = node.childForFieldName("parameters")?.text ?? "()";
  const retType = node.childForFieldName("type")?.text;
  return retType ? `${retType} ${name}${params}` : `${name}${params}`;
}

function walkJava(
  node: Parser.SyntaxNode,
  filePath: string,
  symbols: SymbolInfo[],
  references: ReferenceInfo[],
  imports: ImportInfo[],
  parentIndex?: number
) {
  switch (node.type) {
    case "class_declaration": {
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
          isExported: isPublicJava(node),
          signature: buildClassSignature(node, nameNode.text),
        };
        const idx = symbols.length;
        symbols.push(sym);

        // Track superclass — superclass node wraps a type_identifier
        const superclass = node.childForFieldName("superclass");
        if (superclass) {
          const superType = superclass.namedChild(0);
          const superName = superType?.text ?? superclass.text;
          references.push({
            fromSymbolId: idx,
            toSymbolName: superName,
            toSymbolBareName: bareName(superName),
            kind: "extends",
            line: superclass.startPosition.row + 1,
            col: superclass.startPosition.column,
          });
        }

        // Track interfaces — super_interfaces > type_list > type_identifier*
        const interfaces = node.childForFieldName("interfaces");
        if (interfaces) {
          const typeList = interfaces.namedChild(0); // type_list node
          const source = typeList ?? interfaces;
          for (let i = 0; i < source.namedChildCount; i++) {
            const iface = source.namedChild(i);
            if (iface) {
              references.push({
                fromSymbolId: idx,
                toSymbolName: iface.text,
                toSymbolBareName: bareName(iface.text),
                kind: "implements",
                line: iface.startPosition.row + 1,
                col: iface.startPosition.column,
              });
            }
          }
        }

        // Walk body
        const body = node.childForFieldName("body");
        if (body) {
          walkJavaChildren(body, filePath, symbols, references, imports, idx);
        }
        return;
      }
      break;
    }

    case "interface_declaration": {
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
          isExported: isPublicJava(node),
          signature: `interface ${nameNode.text}`,
        };
        const idx = symbols.length;
        symbols.push(sym);
        const body = node.childForFieldName("body");
        if (body) {
          walkJavaChildren(body, filePath, symbols, references, imports, idx);
        }
        return;
      }
      break;
    }

    case "enum_declaration": {
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
          isExported: isPublicJava(node),
          signature: `enum ${nameNode.text}`,
        };
        const idx = symbols.length;
        symbols.push(sym);
        const body = node.childForFieldName("body");
        if (body) {
          walkJavaChildren(body, filePath, symbols, references, imports, idx);
        }
        return;
      }
      break;
    }

    case "method_declaration":
    case "constructor_declaration": {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const sym: SymbolInfo = {
          name: nameNode.text,
          kind: "method",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: isPublicJava(node),
          signature: extractJavaMethodSig(node),
        };
        const idx = symbols.length;
        symbols.push(sym);
        walkJavaChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

    case "field_declaration": {
      // int x, y; or private String name;
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === "variable_declarator") {
          const nameNode = child.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "property",
              filePath,
              lineStart: node.startPosition.row + 1,
              lineEnd: node.endPosition.row + 1,
              colStart: node.startPosition.column,
              colEnd: node.endPosition.column,
              parentSymbolId: parentIndex,
              isExported: isPublicJava(node),
            });
          }
        }
      }
      break;
    }

    case "method_invocation": {
      const nameNode = node.childForFieldName("name");
      const object = node.childForFieldName("object");
      if (nameNode && parentIndex !== undefined) {
        const fullName = object ? `${object.text}.${nameNode.text}` : nameNode.text;
        references.push({
          fromSymbolId: parentIndex,
          toSymbolName: fullName,
          toSymbolBareName: bareName(fullName),
          kind: "call",
          line: node.startPosition.row + 1,
          col: node.startPosition.column,
        });
      }
      break;
    }

    case "object_creation_expression": {
      const typeNode = node.childForFieldName("type");
      if (typeNode && parentIndex !== undefined) {
        references.push({
          fromSymbolId: parentIndex,
          toSymbolName: typeNode.text,
          toSymbolBareName: bareName(typeNode.text),
          kind: "instantiation",
          line: node.startPosition.row + 1,
          col: node.startPosition.column,
        });
      }
      break;
    }

    case "import_declaration": {
      // import java.util.HashMap; or import java.util.*;
      const lastChild = node.namedChild(node.namedChildCount - 1);
      if (lastChild) {
        const fullPath = lastChild.text;
        const isWildcard = fullPath.endsWith("*");
        const name = isWildcard ? "*" : bareName(fullPath.replace(/\./g, "."));
        imports.push({
          sourcePath: fullPath,
          importedName: name,
          localName: name,
          isDefault: false,
          isNamespace: isWildcard,
          line: node.startPosition.row + 1,
        });
      }
      return;
    }

    case "package_declaration": {
      // package com.example.foo;
      const nameNode = node.namedChild(node.namedChildCount - 1);
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          kind: "variable",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          isExported: true,
          signature: `package ${nameNode.text}`,
        });
      }
      return;
    }

    case "annotation":
    case "marker_annotation": {
      // @Override, @Deprecated, @RequestMapping(...), etc.
      const nameNode = node.childForFieldName("name") ?? node.namedChild(0);
      if (nameNode && parentIndex !== undefined) {
        references.push({
          fromSymbolId: parentIndex,
          toSymbolName: nameNode.text,
          toSymbolBareName: bareName(nameNode.text),
          kind: "call",
          line: node.startPosition.row + 1,
          col: node.startPosition.column,
        });
      }
      break;
    }
  }

  walkJavaChildren(node, filePath, symbols, references, imports, parentIndex);
}

function buildClassSignature(node: Parser.SyntaxNode, name: string): string {
  const parts: string[] = [];
  if (hasModifier(node, "public")) parts.push("public");
  if (hasModifier(node, "abstract")) parts.push("abstract");
  if (hasModifier(node, "final")) parts.push("final");
  parts.push("class", name);

  const superclass = node.childForFieldName("superclass");
  if (superclass) parts.push("extends", superclass.text);

  const interfaces = node.childForFieldName("interfaces");
  if (interfaces) parts.push("implements", interfaces.text);

  return parts.join(" ");
}

function walkJavaChildren(
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
      walkJava(child, filePath, symbols, references, imports, parentIndex);
    }
  }
}

export const javaPlugin: LanguagePlugin = {
  id: "java",
  extensions: [".java"],
  getParser: () => javaParser,
  walk: walkJava,
};

registerLanguage(javaPlugin);
