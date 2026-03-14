import Parser from "tree-sitter";
import Go from "tree-sitter-go";
import { SymbolInfo, ReferenceInfo, ImportInfo } from "../graph/code-graph.js";
import { type LanguagePlugin, registerLanguage } from "./language-plugin.js";
import { bareName } from "./tree-sitter-indexer.js";

const goParser = new Parser();
goParser.setLanguage(Go as unknown as Parser.Language);

function extractGoFuncSignature(node: Parser.SyntaxNode): string | undefined {
  const name = node.childForFieldName("name")?.text ?? "";
  const params = node.childForFieldName("parameters")?.text ?? "()";
  const result = node.childForFieldName("result");
  const retText = result ? ` ${result.text}` : "";
  return `${name}${params}${retText}`;
}

function isExportedGo(name: string): boolean {
  // Go exports are capitalized identifiers
  return name.length > 0 && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
}

function walkGo(
  node: Parser.SyntaxNode,
  filePath: string,
  symbols: SymbolInfo[],
  references: ReferenceInfo[],
  imports: ImportInfo[],
  parentIndex?: number
) {
  switch (node.type) {
    case "function_declaration": {
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
          isExported: isExportedGo(nameNode.text),
          signature: extractGoFuncSignature(node),
        };
        const idx = symbols.length;
        symbols.push(sym);
        walkGoChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

    case "method_declaration": {
      const nameNode = node.childForFieldName("name");
      const receiver = node.childForFieldName("receiver");
      if (nameNode) {
        // Extract receiver type name for context
        let receiverType = "";
        if (receiver) {
          // receiver is like (t *Type) or (t Type)
          for (let i = 0; i < receiver.namedChildCount; i++) {
            const param = receiver.namedChild(i);
            const typeNode = param?.childForFieldName("type");
            if (typeNode) {
              receiverType = typeNode.text.replace("*", "");
              break;
            }
          }
        }

        const sig = extractGoFuncSignature(node);
        const sym: SymbolInfo = {
          name: nameNode.text,
          kind: "method",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: isExportedGo(nameNode.text),
          signature: receiverType ? `(${receiverType}) ${sig}` : sig,
        };
        const idx = symbols.length;
        symbols.push(sym);
        walkGoChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

    case "type_declaration": {
      // type Foo struct/interface/...
      for (let i = 0; i < node.namedChildCount; i++) {
        const spec = node.namedChild(i);
        if (spec?.type === "type_spec") {
          const nameNode = spec.childForFieldName("name");
          const typeNode = spec.childForFieldName("type");
          if (nameNode) {
            const isInterface = typeNode?.type === "interface_type";
            const isStruct = typeNode?.type === "struct_type";
            const kind = isInterface ? "interface" : isStruct ? "class" : "type";

            const sym: SymbolInfo = {
              name: nameNode.text,
              kind,
              filePath,
              lineStart: spec.startPosition.row + 1,
              lineEnd: spec.endPosition.row + 1,
              colStart: spec.startPosition.column,
              colEnd: spec.endPosition.column,
              parentSymbolId: parentIndex,
              isExported: isExportedGo(nameNode.text),
              signature: `type ${nameNode.text} ${typeNode?.type === "interface_type" ? "interface" : typeNode?.type === "struct_type" ? "struct" : typeNode?.text ?? ""}`,
            };
            const idx = symbols.length;
            symbols.push(sym);

            // Walk struct/interface body for embedded types
            if (typeNode) {
              walkGoChildren(typeNode, filePath, symbols, references, imports, idx);
            }
          }
        }
      }
      return;
    }

    case "const_declaration":
    case "var_declaration": {
      for (let i = 0; i < node.namedChildCount; i++) {
        const spec = node.namedChild(i);
        if (spec?.type === "const_spec" || spec?.type === "var_spec") {
          const nameNode = spec.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "variable",
              filePath,
              lineStart: spec.startPosition.row + 1,
              lineEnd: spec.endPosition.row + 1,
              colStart: spec.startPosition.column,
              colEnd: spec.endPosition.column,
              parentSymbolId: parentIndex,
              isExported: isExportedGo(nameNode.text),
            });
          }
        }
      }
      return;
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

    case "composite_literal": {
      // Struct instantiation: Foo{...}
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
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === "import_spec") {
          const pathNode = child.childForFieldName("path");
          const nameNode = child.childForFieldName("name");
          if (pathNode) {
            const importPath = pathNode.text.replace(/"/g, "");
            const localName = nameNode?.text ?? bareName(importPath);
            imports.push({
              sourcePath: importPath,
              importedName: importPath,
              localName: localName === "." ? "*" : localName,
              isDefault: false,
              isNamespace: nameNode?.text !== ".",
              line: child.startPosition.row + 1,
            });
          }
        } else if (child?.type === "import_spec_list") {
          for (let j = 0; j < child.namedChildCount; j++) {
            const spec = child.namedChild(j);
            if (spec?.type === "import_spec") {
              const pathNode = spec.childForFieldName("path");
              const nameNode = spec.childForFieldName("name");
              if (pathNode) {
                const importPath = pathNode.text.replace(/"/g, "");
                const localName = nameNode?.text ?? bareName(importPath);
                imports.push({
                  sourcePath: importPath,
                  importedName: importPath,
                  localName: localName === "." ? "*" : localName,
                  isDefault: false,
                  isNamespace: nameNode?.text !== ".",
                  line: spec.startPosition.row + 1,
                });
              }
            }
          }
        }
      }
      return;
    }

    case "package_clause": {
      // Track the package name as a symbol
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
          isExported: true,
          signature: `package ${nameNode.text}`,
        });
      }
      return;
    }
  }

  // Default: walk children
  walkGoChildren(node, filePath, symbols, references, imports, parentIndex);
}

function walkGoChildren(
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
      walkGo(child, filePath, symbols, references, imports, parentIndex);
    }
  }
}

export const goPlugin: LanguagePlugin = {
  id: "go",
  extensions: [".go"],
  getParser: () => goParser,
  walk: walkGo,
};

registerLanguage(goPlugin);
