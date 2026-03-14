import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import { readFileSync } from "fs";
import { SymbolInfo, ReferenceInfo, ImportInfo } from "../graph/code-graph.js";
import { logger } from "../utils/logger.js";

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

const tsxParser = new Parser();
tsxParser.setLanguage(TypeScript.tsx);

interface ParseResult {
  symbols: SymbolInfo[];
  references: ReferenceInfo[];
  imports: ImportInfo[];
  content: string;
}

function getParser(filePath: string): Parser {
  return filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? tsxParser : tsParser;
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
            kind: "call",
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
          });
        }
      }
      break;
    }

    case "new_expression": {
      const constructor = node.childForFieldName("constructor");
      if (constructor && parentIndex !== undefined) {
        references.push({
          fromSymbolId: parentIndex,
          toSymbolName: constructor.text,
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
      // Walk the declaration inside the export
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          walkNode(child, filePath, symbols, references, imports, parentIndex);
        }
      }
      return;
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

export function parseFile(filePath: string): ParseResult | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const parser = getParser(filePath);
    const tree = parser.parse(content);

    const symbols: SymbolInfo[] = [];
    const references: ReferenceInfo[] = [];
    const imports: ImportInfo[] = [];

    walkNode(tree.rootNode, filePath, symbols, references, imports);

    logger.debug(`Parsed ${filePath}: ${symbols.length} symbols, ${references.length} refs, ${imports.length} imports`);

    return { symbols, references, imports, content };
  } catch (err) {
    logger.error(`Failed to parse ${filePath}`, err);
    return null;
  }
}

export function parseSource(source: string, filePath: string): ParseResult {
  const parser = getParser(filePath);
  const tree = parser.parse(source);

  const symbols: SymbolInfo[] = [];
  const references: ReferenceInfo[] = [];
  const imports: ImportInfo[] = [];

  walkNode(tree.rootNode, filePath, symbols, references, imports);

  return { symbols, references, imports, content: source };
}
