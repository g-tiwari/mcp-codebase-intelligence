import Parser from "tree-sitter";
import { SymbolInfo, ReferenceInfo, ImportInfo } from "../graph/code-graph.js";

export interface ParseResult {
  symbols: SymbolInfo[];
  references: ReferenceInfo[];
  imports: ImportInfo[];
  content: string;
}

export interface LanguagePlugin {
  /** Unique language identifier */
  id: string;
  /** File extensions this plugin handles (e.g., [".py"]) */
  extensions: string[];
  /** Get or create the parser for a given file */
  getParser(filePath: string): Parser;
  /** Walk the AST root and extract symbols, references, and imports */
  walk(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    symbols: SymbolInfo[],
    references: ReferenceInfo[],
    imports: ImportInfo[]
  ): void;
}

const registry = new Map<string, LanguagePlugin>();
const extMap = new Map<string, LanguagePlugin>();

export function registerLanguage(plugin: LanguagePlugin) {
  registry.set(plugin.id, plugin);
  for (const ext of plugin.extensions) {
    extMap.set(ext, plugin);
  }
}

export function getPluginForFile(filePath: string): LanguagePlugin | undefined {
  for (const [ext, plugin] of extMap) {
    if (filePath.endsWith(ext)) return plugin;
  }
  return undefined;
}

export function getAllExtensions(): string[] {
  return Array.from(extMap.keys());
}

export function getRegisteredLanguages(): string[] {
  return Array.from(registry.keys());
}
