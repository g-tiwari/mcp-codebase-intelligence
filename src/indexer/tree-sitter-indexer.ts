import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import { readFileSync } from "fs";
import { SymbolInfo, ReferenceInfo, ImportInfo } from "../graph/code-graph.js";
import { logger } from "../utils/logger.js";
import {
  type LanguagePlugin,
  type ParseResult,
  registerLanguage,
  getPluginForFile,
} from "./language-plugin.js";

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

const tsxParser = new Parser();
tsxParser.setLanguage(TypeScript.tsx);

function getTsParser(filePath: string): Parser {
  return filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? tsxParser : tsParser;
}

/**
 * Extract the bare (rightmost) name from an expression.
 * "schema.parse" -> "parse"
 * "this.handler" -> "handler"
 * "a.b.c.method" -> "method"
 * "foo" -> "foo"
 */
export function bareName(fullName: string): string {
  const lastDot = fullName.lastIndexOf(".");
  return lastDot === -1 ? fullName : fullName.substring(lastDot + 1);
}

function hasExportModifier(node: Parser.SyntaxNode): boolean {
  // Check if the node or its parent has an export keyword
  if (node.parent?.type === "export_statement") return true;
  // Check children for export keyword
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "export" || child?.text === "export") return true;
  }
  return false;
}

function extractSignature(node: Parser.SyntaxNode, kind: string): string | undefined {
  if (kind === "function" || kind === "method") {
    const params = node.childForFieldName("parameters");
    const returnType = node.childForFieldName("return_type");
    const name = node.childForFieldName("name")?.text ?? "";
    const paramText = params?.text ?? "()";
    const retText = returnType ? `: ${returnType.text}` : "";
    return `${name}${paramText}${retText}`;
  }
  if (kind === "class" || kind === "interface") {
    return node.children
      .filter((c) => c.type !== "class_body" && c.type !== "interface_body" && c.type !== "object_type")
      .map((c) => c.text)
      .join(" ")
      .trim();
  }
  return undefined;
}

function walkNode(
  node: Parser.SyntaxNode,
  filePath: string,
  symbols: SymbolInfo[],
  references: ReferenceInfo[],
  imports: ImportInfo[],
  parentIndex?: number
) {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration": {
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
          isExported: hasExportModifier(node),
          signature: extractSignature(node, "function"),
        };
        if (parentIndex !== undefined) sym.parentSymbolId = parentIndex;
        const idx = symbols.length;
        symbols.push(sym);
        walkChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

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
          isExported: hasExportModifier(node),
          signature: extractSignature(node, "class"),
        };
        if (parentIndex !== undefined) sym.parentSymbolId = parentIndex;
        const idx = symbols.length;
        symbols.push(sym);

        // Extract superclass reference
        const heritage = node.childForFieldName("superclass") ?? findChild(node, "extends_clause");
        if (heritage) {
          const superName = heritage.type === "extends_clause"
            ? heritage.child(1)?.text
            : heritage.text;
          if (superName) {
            references.push({
              fromSymbolId: idx,
              toSymbolName: superName,
              toSymbolBareName: bareName(superName),
              kind: "extends",
              line: heritage.startPosition.row + 1,
              col: heritage.startPosition.column,
            });
          }
        }

        walkChildren(node, filePath, symbols, references, imports, idx);
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
          isExported: hasExportModifier(node),
          signature: extractSignature(node, "interface"),
        };
        if (parentIndex !== undefined) sym.parentSymbolId = parentIndex;
        const idx = symbols.length;
        symbols.push(sym);
        walkChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

    case "type_alias_declaration": {
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
          isExported: hasExportModifier(node),
        });
      }
      break;
    }

    case "enum_declaration": {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          kind: "enum",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: hasExportModifier(node),
        });
      }
      break;
    }

    case "method_definition":
    case "public_field_definition": {
      const nameNode = node.childForFieldName("name");
      if (nameNode && parentIndex !== undefined) {
        const sym: SymbolInfo = {
          name: nameNode.text,
          kind: node.type === "method_definition" ? "method" : "property",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: false,
          signature:
            node.type === "method_definition"
              ? extractSignature(node, "method")
              : undefined,
        };
        const idx = symbols.length;
        symbols.push(sym);
        walkChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

    case "lexical_declaration":
    case "variable_declaration": {
      const isExported = hasExportModifier(node);
      for (let i = 0; i < node.namedChildCount; i++) {
        const declarator = node.namedChild(i);
        if (declarator?.type === "variable_declarator") {
          const nameNode = declarator.childForFieldName("name");
          const value = declarator.childForFieldName("value");

          if (nameNode) {
            // Check if it's an arrow function or function expression
            const isFunc =
              value?.type === "arrow_function" || value?.type === "function_expression";
            const sym: SymbolInfo = {
              name: nameNode.text,
              kind: isFunc ? "function" : "variable",
              filePath,
              lineStart: node.startPosition.row + 1,
              lineEnd: node.endPosition.row + 1,
              colStart: node.startPosition.column,
              colEnd: node.endPosition.column,
              parentSymbolId: parentIndex,
              isExported,
              signature: isFunc ? extractSignature(value!, "function") : undefined,
            };
            const idx = symbols.length;
            symbols.push(sym);

            // Walk the value for references
            if (value) {
              walkNode(value, filePath, symbols, references, imports, idx);
            }
          }
        }
      }
      return; // Already handled children
    }

    case "call_expression": {
      const func = node.childForFieldName("function");

      // Check for require('./foo') calls
      if (func?.text === "require") {
        const args = node.childForFieldName("arguments");
        if (args && args.namedChildCount > 0) {
          const firstArg = args.namedChild(0);
          if (firstArg && (firstArg.type === "string" || firstArg.type === "template_string")) {
            const sourcePath = firstArg.text.replace(/['"]/g, "").replace(/`/g, "");
            imports.push({
              sourcePath,
              importedName: "*",
              localName: "*",
              isDefault: false,
              isNamespace: true,
              line: node.startPosition.row + 1,
            });
          }
        }
      }

      // Handle regular function calls
      if (func && parentIndex !== undefined) {
        const name =
          func.type === "member_expression"
            ? func.text
            : func.type === "identifier"
              ? func.text
              : undefined;
        if (name) {
          references.push({
            fromSymbolId: parentIndex,
            toSymbolName: name,
            toSymbolBareName: bareName(name),
            kind: "call",
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
          });
        }
      }
      break;
    }

    case "import_call_expression": {
      // Handle dynamic imports: import('./foo')
      const source = node.childForFieldName("source");
      if (source) {
        const sourcePath = source.text.replace(/['"]/g, "").replace(/`/g, "");
        imports.push({
          sourcePath,
          importedName: "*",
          localName: "*",
          isDefault: false,
          isNamespace: true,
          line: node.startPosition.row + 1,
        });
      }
      break;
    }

    case "new_expression": {
      const constructor = node.childForFieldName("constructor");
      if (constructor && parentIndex !== undefined) {
        references.push({
          fromSymbolId: parentIndex,
          toSymbolName: constructor.text,
          toSymbolBareName: bareName(constructor.text),
          kind: "instantiation",
          line: node.startPosition.row + 1,
          col: node.startPosition.column,
        });
      }
      break;
    }

    case "import_statement": {
      const source = node.childForFieldName("source");
      if (!source) break;
      const sourcePath = source.text.replace(/['"]/g, "");

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;

        if (child.type === "import_clause") {
          for (let j = 0; j < child.namedChildCount; j++) {
            const clause = child.namedChild(j);
            if (!clause) continue;

            if (clause.type === "identifier") {
              // Default import
              imports.push({
                sourcePath,
                importedName: "default",
                localName: clause.text,
                isDefault: true,
                isNamespace: false,
                line: node.startPosition.row + 1,
              });
            } else if (clause.type === "named_imports") {
              for (let k = 0; k < clause.namedChildCount; k++) {
                const specifier = clause.namedChild(k);
                if (specifier?.type === "import_specifier") {
                  const importedName = specifier.childForFieldName("name")?.text ?? specifier.text;
                  const alias = specifier.childForFieldName("alias")?.text;
                  imports.push({
                    sourcePath,
                    importedName,
                    localName: alias ?? importedName,
                    isDefault: false,
                    isNamespace: false,
                    line: node.startPosition.row + 1,
                  });
                }
              }
            } else if (clause.type === "namespace_import") {
              const name = clause.childForFieldName("name")?.text ?? clause.text.replace("* as ", "");
              imports.push({
                sourcePath,
                importedName: "*",
                localName: name,
                isDefault: false,
                isNamespace: true,
                line: node.startPosition.row + 1,
              });
            }
          }
        }
      }
      return; // Don't walk children of imports
    }

    case "export_statement": {
      // Check for re-exports: export { foo } from './bar' or export * from './bar'
      const source = node.childForFieldName("source");
      if (source) {
        const sourcePath = source.text.replace(/['"]/g, "");

        // Handle export * from './bar'
        const exportClause = findChild(node, "export_clause");
        if (!exportClause) {
          // export * from './bar' - namespace re-export
          const isExportAll = node.text.startsWith("export *");
          if (isExportAll) {
            imports.push({
              sourcePath,
              importedName: "*",
              localName: "*",
              isDefault: false,
              isNamespace: true,
              line: node.startPosition.row + 1,
            });
          }
        } else {
          // export { foo, bar as baz } from './bar'
          for (let k = 0; k < exportClause.namedChildCount; k++) {
            const specifier = exportClause.namedChild(k);
            if (specifier?.type === "export_specifier") {
              const nameNode = specifier.childForFieldName("name");
              const aliasNode = specifier.childForFieldName("alias");
              const importedName = nameNode?.text ?? specifier.text;
              const exportedName = aliasNode?.text ?? importedName;

              // Track as import (what we're importing from source)
              imports.push({
                sourcePath,
                importedName,
                localName: importedName,
                isDefault: importedName === "default",
                isNamespace: false,
                line: node.startPosition.row + 1,
              });

              // Track as exported symbol (what we're exporting to consumers)
              symbols.push({
                name: exportedName,
                kind: "variable",
                filePath,
                lineStart: node.startPosition.row + 1,
                lineEnd: node.endPosition.row + 1,
                colStart: node.startPosition.column,
                colEnd: node.endPosition.column,
                parentSymbolId: parentIndex,
                isExported: true,
              });
            }
          }
        }
        return; // Don't walk children, we've handled everything
      }

      // Check for default exports: export default function/class/expression
      const declarationChild = node.namedChild(0);
      if (declarationChild) {
        const isDefaultExport = node.text.startsWith("export default");

        if (isDefaultExport) {
          // Handle: export default function foo() {} or export default class Bar {}
          if (declarationChild.type === "function_declaration" ||
              declarationChild.type === "class_declaration") {
            const nameNode = declarationChild.childForFieldName("name");
            if (nameNode) {
              // Named default export - process the declaration and mark it as exported default
              walkNode(declarationChild, filePath, symbols, references, imports, parentIndex);
              // The symbol was already added, mark it as default export
              if (symbols.length > 0) {
                const lastSymbol = symbols[symbols.length - 1];
                if (lastSymbol.name === nameNode.text) {
                  lastSymbol.isExported = true;
                }
              }
              return;
            }
          }

          // Handle: export default <expression> - anonymous default export
          symbols.push({
            name: "default",
            kind: "variable",
            filePath,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            colStart: node.startPosition.column,
            colEnd: node.endPosition.column,
            parentSymbolId: parentIndex,
            isExported: true,
          });
          return;
        }
      }

      // Walk the declaration inside the export (for regular export statements)
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          walkNode(child, filePath, symbols, references, imports, parentIndex);
        }
      }
      return;
    }

    case "expression_statement": {
      // Handle CJS exports: module.exports = ..., exports.foo = ...
      const expr = node.namedChild(0);
      if (expr?.type === "assignment_expression") {
        const left = expr.childForFieldName("left");
        const right = expr.childForFieldName("right");
        if (left && right) {
          const leftText = left.text;

          if (leftText === "module.exports") {
            // module.exports = foo  OR  module.exports = { ... }
            if (right.type === "identifier") {
              // module.exports = someFunction — mark that symbol as exported
              // Also create a reference so we track the connection
              symbols.push({
                name: right.text,
                kind: "variable",
                filePath,
                lineStart: node.startPosition.row + 1,
                lineEnd: node.endPosition.row + 1,
                colStart: node.startPosition.column,
                colEnd: node.endPosition.column,
                parentSymbolId: parentIndex,
                isExported: true,
              });
            } else if (right.type === "object") {
              // module.exports = { foo, bar: baz }
              for (let i = 0; i < right.namedChildCount; i++) {
                const prop = right.namedChild(i);
                if (prop?.type === "shorthand_property_identifier") {
                  symbols.push({
                    name: prop.text,
                    kind: "variable",
                    filePath,
                    lineStart: prop.startPosition.row + 1,
                    lineEnd: prop.endPosition.row + 1,
                    colStart: prop.startPosition.column,
                    colEnd: prop.endPosition.column,
                    parentSymbolId: parentIndex,
                    isExported: true,
                  });
                } else if (prop?.type === "pair") {
                  const key = prop.childForFieldName("key");
                  if (key) {
                    symbols.push({
                      name: key.text,
                      kind: "variable",
                      filePath,
                      lineStart: prop.startPosition.row + 1,
                      lineEnd: prop.endPosition.row + 1,
                      colStart: prop.startPosition.column,
                      colEnd: prop.endPosition.column,
                      parentSymbolId: parentIndex,
                      isExported: true,
                    });
                  }
                }
              }
            }
            // Walk the right side for any nested references
            walkNode(right, filePath, symbols, references, imports, parentIndex);
            return;
          } else if (leftText.startsWith("exports.") || leftText.startsWith("module.exports.")) {
            // exports.foo = ... or module.exports.foo = ...
            const exportName = bareName(leftText);
            symbols.push({
              name: exportName,
              kind: "variable",
              filePath,
              lineStart: node.startPosition.row + 1,
              lineEnd: node.endPosition.row + 1,
              colStart: node.startPosition.column,
              colEnd: node.endPosition.column,
              parentSymbolId: parentIndex,
              isExported: true,
            });
            // Walk the right side
            walkNode(right, filePath, symbols, references, imports, parentIndex);
            return;
          }
        }
      }
      break;
    }
  }

  // Default: walk children
  walkChildren(node, filePath, symbols, references, imports, parentIndex);
}

function walkChildren(
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
      walkNode(child, filePath, symbols, references, imports, parentIndex);
    }
  }
}

function findChild(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === type) return child;
  }
  return null;
}

// --- TypeScript/JavaScript Language Plugin ---

export const typescriptPlugin: LanguagePlugin = {
  id: "typescript",
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
  getParser: getTsParser,
  walk: walkNode,
};

// Register on import
registerLanguage(typescriptPlugin);

// --- Generic parse functions (dispatch to plugins) ---

export function parseFile(filePath: string): ParseResult | null {
  try {
    const plugin = getPluginForFile(filePath);
    if (!plugin) {
      logger.debug(`No language plugin for: ${filePath}`);
      return null;
    }

    const content = readFileSync(filePath, "utf-8");
    const parser = plugin.getParser(filePath);
    const tree = parser.parse(content);

    const symbols: SymbolInfo[] = [];
    const references: ReferenceInfo[] = [];
    const imports: ImportInfo[] = [];

    plugin.walk(tree.rootNode, filePath, symbols, references, imports);

    logger.debug(`Parsed ${filePath}: ${symbols.length} symbols, ${references.length} refs, ${imports.length} imports`);

    return { symbols, references, imports, content };
  } catch (err) {
    logger.error(`Failed to parse ${filePath}`, err);
    return null;
  }
}

export function parseSource(source: string, filePath: string): ParseResult {
  const plugin = getPluginForFile(filePath);
  if (!plugin) {
    return { symbols: [], references: [], imports: [], content: source };
  }

  const parser = plugin.getParser(filePath);
  const tree = parser.parse(source);

  const symbols: SymbolInfo[] = [];
  const references: ReferenceInfo[] = [];
  const imports: ImportInfo[] = [];

  plugin.walk(tree.rootNode, filePath, symbols, references, imports);

  return { symbols, references, imports, content: source };
}
