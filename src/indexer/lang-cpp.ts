import Parser from "tree-sitter";
import C from "tree-sitter-c";
import Cpp from "tree-sitter-cpp";
import { SymbolInfo, ReferenceInfo, ImportInfo } from "../graph/code-graph.js";
import { type LanguagePlugin, registerLanguage } from "./language-plugin.js";
import { bareName } from "./tree-sitter-indexer.js";
import { getPrecedingComment } from "./docstring-extractor.js";

const cParser = new Parser();
cParser.setLanguage(C as unknown as Parser.Language);

const cppParser = new Parser();
cppParser.setLanguage(Cpp as unknown as Parser.Language);

function getCppParser(filePath: string): Parser {
  // C files use .c and .h extensions
  // C++ files use .cpp, .cc, .cxx, .hpp, .hxx, .hh extensions
  return filePath.endsWith(".c") || (filePath.endsWith(".h") && !filePath.endsWith(".hh"))
    ? cParser
    : cppParser;
}

function isPublicCpp(node: Parser.SyntaxNode): boolean {
  // Check if node has public: access specifier
  // In C++, class members are private by default, struct members are public by default
  let parent = node.parent;
  while (parent) {
    if (parent.type === "field_declaration_list") {
      // Check for access specifier before this node
      for (let i = 0; i < parent.childCount; i++) {
        const child = parent.child(i);
        if (child === node) break;
        if (child?.type === "access_specifier") {
          const text = child.text;
          if (text === "public:" || text === "public") return true;
          if (text === "private:" || text === "private") return false;
          if (text === "protected:" || text === "protected") return false;
        }
      }
      // If in struct, default is public; if in class, default is private
      const grandParent = parent.parent;
      if (grandParent?.type === "struct_specifier") return true;
      if (grandParent?.type === "class_specifier") return false;
      break;
    }
    parent = parent.parent;
  }
  return true; // Default for top-level declarations
}

function isExportedC(node: Parser.SyntaxNode): boolean {
  // In C, everything non-static is exported
  // Check for "static" storage class specifier
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "storage_class_specifier" && child.text === "static") {
      return false;
    }
  }
  return true;
}

function extractFunctionSignature(node: Parser.SyntaxNode, isCpp: boolean): string | undefined {
  const declarator = node.childForFieldName("declarator");
  if (!declarator) return undefined;

  // Extract function name from declarator
  const funcDeclarator = findFunctionDeclarator(declarator);
  if (!funcDeclarator) return undefined;

  const nameNode = funcDeclarator.childForFieldName("declarator");
  const name = nameNode ? extractIdentifierName(nameNode) : "";
  const params = funcDeclarator.childForFieldName("parameters")?.text ?? "()";

  // Extract return type
  const typeNode = node.childForFieldName("type");
  const returnType = typeNode?.text ?? "";

  return `${returnType} ${name}${params}`.trim();
}

function findFunctionDeclarator(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === "function_declarator") return node;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      const result = findFunctionDeclarator(child);
      if (result) return result;
    }
  }
  return null;
}

function extractIdentifierName(node: Parser.SyntaxNode): string {
  if (node.type === "identifier" || node.type === "field_identifier") return node.text;
  if (node.type === "qualified_identifier") {
    const name = node.childForFieldName("name");
    return name?.text ?? node.text;
  }
  if (node.type === "destructor_name") {
    return node.text;
  }
  if (node.type === "operator_name") {
    return node.text;
  }
  // Recurse to find identifier
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "identifier" || child?.type === "field_identifier") {
      return child.text;
    }
  }
  return node.text;
}

function walkCpp(
  node: Parser.SyntaxNode,
  filePath: string,
  symbols: SymbolInfo[],
  references: ReferenceInfo[],
  imports: ImportInfo[],
  parentIndex?: number
) {
  const isCpp = !filePath.endsWith(".c") && !filePath.endsWith(".h");

  switch (node.type) {
    case "function_definition": {
      const declarator = node.childForFieldName("declarator");
      if (declarator) {
        const funcDeclarator = findFunctionDeclarator(declarator);
        const nameNode = funcDeclarator?.childForFieldName("declarator");
        if (nameNode) {
          const name = extractIdentifierName(nameNode);
          const sym: SymbolInfo = {
            name,
            kind: "function",
            filePath,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            colStart: node.startPosition.column,
            colEnd: node.endPosition.column,
            parentSymbolId: parentIndex,
            isExported: isCpp ? isPublicCpp(node) : isExportedC(node),
            signature: extractFunctionSignature(node, isCpp),
            docstring: getPrecedingComment(node),
          };
          const idx = symbols.length;
          symbols.push(sym);
          walkCppChildren(node, filePath, symbols, references, imports, idx);
          return;
        }
      }
      break;
    }

    case "declaration": {
      // Handle function declarations (prototypes)
      const declarator = node.childForFieldName("declarator");
      if (declarator) {
        const funcDeclarator = findFunctionDeclarator(declarator);
        if (funcDeclarator) {
          const nameNode = funcDeclarator.childForFieldName("declarator");
          if (nameNode) {
            const name = extractIdentifierName(nameNode);
            symbols.push({
              name,
              kind: "function",
              filePath,
              lineStart: node.startPosition.row + 1,
              lineEnd: node.endPosition.row + 1,
              colStart: node.startPosition.column,
              colEnd: node.endPosition.column,
              parentSymbolId: parentIndex,
              isExported: isCpp ? isPublicCpp(node) : isExportedC(node),
              signature: extractFunctionSignature(node, isCpp),
            });
            return;
          }
        }
      }
      break;
    }

    case "struct_specifier":
    case "union_specifier": {
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
          isExported: isCpp ? isPublicCpp(node) : isExportedC(node),
          signature: `${node.type === "struct_specifier" ? "struct" : "union"} ${nameNode.text}`,
          docstring: getPrecedingComment(node),
        };
        const idx = symbols.length;
        symbols.push(sym);
        walkCppChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

    case "class_specifier": {
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
          isExported: isExportedC(node),
          signature: `class ${nameNode.text}`,
          docstring: getPrecedingComment(node),
        };
        const idx = symbols.length;
        symbols.push(sym);

        // Extract base classes (inheritance)
        // base_class_clause is a direct child of class_specifier, not a field
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child?.type === "base_class_clause") {
            // base_class_clause contains access_specifier + type_identifier children
            for (let j = 0; j < child.namedChildCount; j++) {
              const baseChild = child.namedChild(j);
              if (baseChild?.type === "type_identifier" || baseChild?.type === "qualified_identifier") {
                const baseName = baseChild.text;
                references.push({
                  fromSymbolId: idx,
                  toSymbolName: baseName,
                  toSymbolBareName: bareName(baseName),
                  kind: "extends",
                  line: baseChild.startPosition.row + 1,
                  col: baseChild.startPosition.column,
                });
              }
            }
          }
        }

        walkCppChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

    case "enum_specifier": {
      const nameNode = node.childForFieldName("name");
      // Only extract enum definitions (with body), not enum type references in parameters
      const hasBody = node.childForFieldName("body") !== null ||
        node.namedChildren.some(c => c.type === "enumerator_list");
      if (nameNode && hasBody) {
        symbols.push({
          name: nameNode.text,
          kind: "enum",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: isCpp ? isPublicCpp(node) : isExportedC(node),
          signature: `enum ${nameNode.text}`,
        });
      }
      return; // don't walk children — avoids double-counting from parent declaration
    }

    case "namespace_definition": {
      const nameNode = node.childForFieldName("name");
      if (nameNode && isCpp) {
        const sym: SymbolInfo = {
          name: nameNode.text,
          kind: "variable",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: true,
          signature: `namespace ${nameNode.text}`,
        };
        const idx = symbols.length;
        symbols.push(sym);
        walkCppChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

    case "type_definition": {
      // typedef or using alias
      const declarator = node.childForFieldName("declarator");
      if (declarator) {
        const name = extractIdentifierName(declarator);
        if (name) {
          symbols.push({
            name,
            kind: "type",
            filePath,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            colStart: node.startPosition.column,
            colEnd: node.endPosition.column,
            parentSymbolId: parentIndex,
            isExported: isCpp ? isPublicCpp(node) : isExportedC(node),
          });
        }
      }
      break;
    }

    case "alias_declaration": {
      // C++ using alias
      const nameNode = node.childForFieldName("name");
      if (nameNode && isCpp) {
        symbols.push({
          name: nameNode.text,
          kind: "type",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: true,
        });
      }
      break;
    }

    case "field_declaration": {
      // Struct/class member (method or field)
      const declarator = node.childForFieldName("declarator");
      if (declarator && parentIndex !== undefined) {
        const funcDeclarator = findFunctionDeclarator(declarator);
        if (funcDeclarator) {
          // Method declaration
          const nameNode = funcDeclarator.childForFieldName("declarator");
          if (nameNode) {
            const name = extractIdentifierName(nameNode);
            symbols.push({
              name,
              kind: "method",
              filePath,
              lineStart: node.startPosition.row + 1,
              lineEnd: node.endPosition.row + 1,
              colStart: node.startPosition.column,
              colEnd: node.endPosition.column,
              parentSymbolId: parentIndex,
              isExported: false,
              signature: extractFunctionSignature(node, isCpp),
            });
          }
        } else {
          // Field
          const name = extractIdentifierName(declarator);
          if (name) {
            symbols.push({
              name,
              kind: "property",
              filePath,
              lineStart: node.startPosition.row + 1,
              lineEnd: node.endPosition.row + 1,
              colStart: node.startPosition.column,
              colEnd: node.endPosition.column,
              parentSymbolId: parentIndex,
              isExported: false,
            });
          }
        }
      }
      break;
    }

    case "preproc_include": {
      // #include <stdio.h> or #include "myfile.h"
      const pathNode = node.childForFieldName("path");
      if (pathNode) {
        const includePath = pathNode.text.replace(/[<>"]/g, "");
        imports.push({
          sourcePath: includePath,
          importedName: bareName(includePath),
          localName: bareName(includePath),
          isDefault: false,
          isNamespace: true,
          line: node.startPosition.row + 1,
        });
      }
      return;
    }

    case "call_expression": {
      const func = node.childForFieldName("function");
      if (func && parentIndex !== undefined) {
        const name = extractIdentifierName(func);
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

    case "new_expression": {
      // C++ new operator: new Foo()
      const typeNode = node.childForFieldName("type");
      if (typeNode && parentIndex !== undefined && isCpp) {
        const typeName = extractIdentifierName(typeNode);
        references.push({
          fromSymbolId: parentIndex,
          toSymbolName: typeName,
          toSymbolBareName: bareName(typeName),
          kind: "instantiation",
          line: node.startPosition.row + 1,
          col: node.startPosition.column,
        });
      }
      break;
    }

    case "declaration": {
      // Variable declarations that might be struct/class instantiations
      // Example: MyClass obj; or MyClass* ptr = new MyClass();
      const typeNode = node.childForFieldName("type");
      if (typeNode && parentIndex !== undefined) {
        const typeName = extractIdentifierName(typeNode);
        // Only track user-defined types (not primitives like int, char, etc.)
        if (!isPrimitiveType(typeName)) {
          references.push({
            fromSymbolId: parentIndex,
            toSymbolName: typeName,
            toSymbolBareName: bareName(typeName),
            kind: "instantiation",
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
          });
        }
      }
      break;
    }
  }

  walkCppChildren(node, filePath, symbols, references, imports, parentIndex);
}

function isPrimitiveType(typeName: string): boolean {
  const primitives = new Set([
    "void", "char", "short", "int", "long", "float", "double",
    "bool", "signed", "unsigned", "auto", "const", "volatile",
    "static", "extern", "register", "inline", "typedef",
    "size_t", "ptrdiff_t", "wchar_t", "nullptr_t",
  ]);
  return primitives.has(typeName);
}

function walkCppChildren(
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
      walkCpp(child, filePath, symbols, references, imports, parentIndex);
    }
  }
}

// Register C language plugin
export const cPlugin: LanguagePlugin = {
  id: "c",
  extensions: [".c", ".h"],
  getParser: () => cParser,
  walk: walkCpp,
};

// Register C++ language plugin
export const cppPlugin: LanguagePlugin = {
  id: "cpp",
  extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".hh"],
  getParser: () => cppParser,
  walk: walkCpp,
};

registerLanguage(cPlugin);
registerLanguage(cppPlugin);
