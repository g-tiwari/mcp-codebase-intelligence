import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import { SymbolInfo, ReferenceInfo, ImportInfo } from "../graph/code-graph.js";
import { type LanguagePlugin, registerLanguage } from "./language-plugin.js";
import { bareName } from "./tree-sitter-indexer.js";

const pyParser = new Parser();
pyParser.setLanguage(Python as unknown as Parser.Language);

function extractPySignature(node: Parser.SyntaxNode): string | undefined {
  const name = node.childForFieldName("name")?.text ?? "";
  const params = node.childForFieldName("parameters");
  const returnType = node.childForFieldName("return_type");
  const paramText = params?.text ?? "()";
  const retText = returnType ? ` -> ${returnType.text}` : "";
  return `${name}${paramText}${retText}`;
}

function isDecorated(node: Parser.SyntaxNode, decoratorName: string): boolean {
  if (node.parent?.type === "decorated_definition") {
    for (let i = 0; i < node.parent.namedChildCount; i++) {
      const child = node.parent.namedChild(i);
      if (child?.type === "decorator" && child.text.includes(decoratorName)) return true;
    }
  }
  return false;
}

function walkPython(
  node: Parser.SyntaxNode,
  filePath: string,
  symbols: SymbolInfo[],
  references: ReferenceInfo[],
  imports: ImportInfo[],
  parentIndex?: number
) {
  switch (node.type) {
    case "function_definition": {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isMethod = parentIndex !== undefined && symbols[parentIndex]?.kind === "class";
        const isPrivate = nameNode.text.startsWith("_") && !nameNode.text.startsWith("__");
        const isDunder = nameNode.text.startsWith("__") && nameNode.text.endsWith("__");
        const sym: SymbolInfo = {
          name: nameNode.text,
          kind: isMethod ? "method" : "function",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: !isPrivate || isDunder,
          signature: extractPySignature(node),
        };
        const idx = symbols.length;
        symbols.push(sym);
        walkPyChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

    case "class_definition": {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isPrivate = nameNode.text.startsWith("_");
        const sym: SymbolInfo = {
          name: nameNode.text,
          kind: "class",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: !isPrivate,
          signature: `class ${nameNode.text}`,
        };

        // Track superclasses
        const superclasses = node.childForFieldName("superclasses");
        if (superclasses) {
          for (let i = 0; i < superclasses.namedChildCount; i++) {
            const arg = superclasses.namedChild(i);
            if (arg && arg.type !== "keyword_argument") {
              references.push({
                fromSymbolId: symbols.length,
                toSymbolName: arg.text,
                toSymbolBareName: bareName(arg.text),
                kind: "extends",
                line: arg.startPosition.row + 1,
                col: arg.startPosition.column,
              });
              sym.signature += superclasses.text ? `(${superclasses.text})` : "";
            }
          }
        }

        const idx = symbols.length;
        symbols.push(sym);
        walkPyChildren(node, filePath, symbols, references, imports, idx);
        return;
      }
      break;
    }

    case "assignment": {
      // Module-level assignments: MY_CONST = ... or __all__ = [...]
      const left = node.childForFieldName("left");
      if (left?.type === "identifier" && parentIndex === undefined) {
        const name = left.text;
        // Track __all__ for export info, or top-level constants (UPPER_CASE)
        if (name === "__all__") {
          // Don't create a symbol, but we could parse the list
          break;
        }
        const isUpper = name === name.toUpperCase() && name.length > 1;
        symbols.push({
          name,
          kind: "variable",
          filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          colStart: node.startPosition.column,
          colEnd: node.endPosition.column,
          parentSymbolId: parentIndex,
          isExported: !name.startsWith("_"),
        });
      }
      break;
    }

    case "call": {
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

    case "import_statement": {
      // import foo, import foo.bar
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === "dotted_name") {
          imports.push({
            sourcePath: child.text,
            importedName: child.text,
            localName: bareName(child.text),
            isDefault: false,
            isNamespace: true,
            line: node.startPosition.row + 1,
          });
        } else if (child?.type === "aliased_import") {
          const name = child.childForFieldName("name")?.text ?? "";
          const alias = child.childForFieldName("alias")?.text ?? name;
          imports.push({
            sourcePath: name,
            importedName: name,
            localName: alias,
            isDefault: false,
            isNamespace: true,
            line: node.startPosition.row + 1,
          });
        }
      }
      return;
    }

    case "import_from_statement": {
      // from foo import bar, baz
      const moduleNode = node.childForFieldName("module_name");
      const moduleName = moduleNode?.text ?? "";

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === "dotted_name" && child !== moduleNode) {
          imports.push({
            sourcePath: moduleName,
            importedName: child.text,
            localName: child.text,
            isDefault: false,
            isNamespace: false,
            line: node.startPosition.row + 1,
          });
        } else if (child?.type === "aliased_import") {
          const name = child.childForFieldName("name")?.text ?? "";
          const alias = child.childForFieldName("alias")?.text ?? name;
          imports.push({
            sourcePath: moduleName,
            importedName: name,
            localName: alias,
            isDefault: false,
            isNamespace: false,
            line: node.startPosition.row + 1,
          });
        } else if (child?.type === "wildcard_import") {
          imports.push({
            sourcePath: moduleName,
            importedName: "*",
            localName: "*",
            isDefault: false,
            isNamespace: true,
            line: node.startPosition.row + 1,
          });
        }
      }
      return;
    }

    case "decorated_definition": {
      // Walk into the decorated function/class
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && child.type !== "decorator") {
          walkPython(child, filePath, symbols, references, imports, parentIndex);
        }
      }
      return;
    }
  }

  // Default: walk children
  walkPyChildren(node, filePath, symbols, references, imports, parentIndex);
}

function walkPyChildren(
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
      walkPython(child, filePath, symbols, references, imports, parentIndex);
    }
  }
}

export const pythonPlugin: LanguagePlugin = {
  id: "python",
  extensions: [".py", ".pyi"],
  getParser: () => pyParser,
  walk: walkPython,
};

registerLanguage(pythonPlugin);
