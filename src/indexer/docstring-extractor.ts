import Parser from "tree-sitter";

// Extract preceding comments and docstrings from AST nodes.
// Supports: JSDoc, Javadoc, Doxygen, Python docstrings, Go comments, Rust doc comments.
export function getPrecedingComment(node: Parser.SyntaxNode): string | undefined {
  const parent = node.parent;
  if (!parent) return undefined;

  // For decorated definitions (Python), check before the decorator
  const targetNode = parent.type === "decorated_definition" ? parent : node;
  const container = targetNode.parent;
  if (!container) return undefined;

  // Find this node's index in parent
  let nodeIndex = -1;
  for (let i = 0; i < container.childCount; i++) {
    if (container.child(i)?.id === targetNode.id) {
      nodeIndex = i;
      break;
    }
  }
  if (nodeIndex <= 0) return undefined;

  // Collect consecutive comment nodes immediately preceding this node
  const commentLines: string[] = [];
  for (let i = nodeIndex - 1; i >= 0; i--) {
    const sibling = container.child(i);
    if (!sibling) break;

    if (isCommentNode(sibling)) {
      commentLines.unshift(sibling.text);
    } else {
      break;
    }
  }

  if (commentLines.length === 0) return undefined;
  return cleanComment(commentLines.join("\n"));
}

/**
 * Extract Python docstring — first expression_statement containing a string
 * in the function/class body.
 */
export function getPythonDocstring(node: Parser.SyntaxNode): string | undefined {
  const body = node.childForFieldName("body");
  if (!body) return undefined;

  const firstStmt = body.namedChild(0);
  if (!firstStmt) return undefined;

  // Python docstring is an expression_statement containing a string
  if (firstStmt.type === "expression_statement") {
    const expr = firstStmt.namedChild(0);
    if (expr && (expr.type === "string" || expr.type === "concatenated_string")) {
      return cleanPythonDocstring(expr.text);
    }
  }

  return undefined;
}

function isCommentNode(node: Parser.SyntaxNode): boolean {
  return node.type === "comment" ||
    node.type === "line_comment" ||
    node.type === "block_comment" ||
    node.type === "doc_comment";
}

function cleanComment(text: string): string | undefined {
  return text
    .split("\n")
    .map(line => {
      let l = line.trim();
      // Remove block comment delimiters
      if (l.startsWith("/**")) l = l.slice(3);
      else if (l.startsWith("/*")) l = l.slice(2);
      if (l.endsWith("*/")) l = l.slice(0, -2);
      // Remove line comment prefix
      if (l.startsWith("///")) l = l.slice(3);
      else if (l.startsWith("//!")) l = l.slice(3);
      else if (l.startsWith("//")) l = l.slice(2);
      // Remove leading * from Javadoc/JSDoc/Doxygen style
      if (l.startsWith("*")) l = l.slice(1);
      // Remove leading # from Python comments
      if (l.startsWith("#")) l = l.slice(1);
      return l.trim();
    })
    .filter(l => l.length > 0)
    .join("\n")
    .trim() || undefined;
}

function cleanPythonDocstring(text: string): string {
  // Remove triple quotes
  let s = text;
  if (s.startsWith('"""') && s.endsWith('"""')) {
    s = s.slice(3, -3);
  } else if (s.startsWith("'''") && s.endsWith("'''")) {
    s = s.slice(3, -3);
  } else if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
  } else if (s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1);
  }

  return s
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join("\n")
    .trim();
}
