/**
 * Locates the real body of each declaration in a TypeScript/TSX file with the
 * TypeScript parser, so the indexer never mistakes a destructured parameter or
 * an object type in a signature for the start of a function body.
 */
import { ts } from 'ts-morph';

/**
 * @what Character range [start, end) of a declaration's body in the file text
 * @domain code-index, code-extraction
 * @tags body-range, typescript-ast, offsets
 */
export interface BodyRange {
  start: number;
  end: number;
}

/**
 * @what Finds the function body inside an expression, looking through wrappers
 * @how Unwraps parentheses, `as`, `satisfies`, `!` and type assertions; returns a function or arrow's body; for a call such as observer(...), memo(...), forwardRef(...) or useCallback(...), returns the first argument that is itself a function
 * @why Components and hooks are often declared as `const X = observer(function X(...) {...})`, whose body is an argument of a call, not the initializer itself
 *
 * @param {ts.Expression | undefined} expr The initializer or argument to search
 * @returns {ts.Node | undefined} The body node (a block, or an arrow's expression body), or undefined when there is no function
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain code-index, code-extraction
 * @tags typescript-ast, function-body, wrapper-unwrapping, react-components
 */
function functionBodyOf(expr: ts.Expression | undefined): ts.Node | undefined {
  if (!expr) return undefined;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)
    || ts.isNonNullExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    return functionBodyOf(expr.expression);
  }
  if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) return expr.body;
  if (ts.isCallExpression(expr)) {
    for (const arg of expr.arguments) {
      const body = functionBodyOf(arg);
      if (body) return body;
    }
  }
  return undefined;
}

/**
 * @what Finds the body of a declaration that a JSDoc block can document
 * @how Function declarations, methods, accessors and constructors use their body; variable statements, property assignments, class properties and `export default` search their expression through wrappers; classes use the span from their opening brace
 * @why The indexer needs the body a JSDoc block describes in order to extract its inline comments and embed its code
 *
 * @param {ts.Node} node A statement or member that may carry JSDoc
 * @param {ts.SourceFile} sf The parsed file, needed for node positions
 * @returns {BodyRange | undefined} The body's range, or undefined for declarations without one (interfaces, type aliases)
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain code-index, code-extraction
 * @tags typescript-ast, function-body, declaration-kinds
 */
function declarationBody(node: ts.Node, sf: ts.SourceFile): BodyRange | undefined {
  let body: ts.Node | undefined;
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    body = node.body;
  } else if (ts.isVariableStatement(node)) {
    body = functionBodyOf(node.declarationList.declarations[0]?.initializer);
  } else if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
    body = functionBodyOf(node.initializer);
  } else if (ts.isExportAssignment(node)) {
    body = functionBodyOf(node.expression);
  } else if (ts.isClassDeclaration(node)) {
    const openBrace = node.getChildren(sf).find(c => c.kind === ts.SyntaxKind.OpenBraceToken);
    return openBrace ? { start: openBrace.getStart(sf), end: node.getEnd() } : undefined;
  }
  if (!body) return undefined;
  // An arrow's expression body starts right after `=>`, so a comment between the
  // two (`=> // note \n value`) stays inside the body; getStart would skip it.
  const arrow = body.parent;
  if (ts.isArrowFunction(arrow) && arrow.body === body && !ts.isBlock(body)) {
    return { start: arrow.equalsGreaterThanToken.getEnd(), end: body.getEnd() };
  }
  return { start: body.getStart(sf), end: body.getEnd() };
}

/**
 * @what Records a node's body range, then does the same for every node inside it
 * @how Keys the range by the node's start position (after any JSDoc), then recurses into the node's children
 * @why Documented functions can be nested (a useCallback inside a component), so every level must be mapped, not just top-level statements
 *
 * @param {ts.Node} node The node to record and descend into
 * @param {ts.SourceFile} sf The parsed file
 * @param {Map<number, BodyRange>} bodies The map being filled
 * @returns {void}
 *
 * @sideeffects Adds entries to `bodies`
 * @systemlayer Utility
 * @domain code-index, code-extraction
 * @tags ast-walk, recursion, body-range
 */
function collectBodies(node: ts.Node, sf: ts.SourceFile, bodies: Map<number, BodyRange>): void {
  const range = declarationBody(node, sf);
  if (range) bodies.set(node.getStart(sf), range);
  ts.forEachChild(node, child => collectBodies(child, sf, bodies));
}

/**
 * @what Maps each declaration's start position to the character range of its real body
 * @how Parses the file once with the TypeScript parser and records every declaration with a body, nested ones included, keyed by where its code starts (just after any JSDoc block)
 * @why Replaces "first `{` after the JSDoc" body detection, which takes a destructured parameter such as `function X({ a }: Props)` for the body and so indexed the parameter list instead of the code
 *
 * @param {string} content The file text
 * @param {string} fileName The file name; a .tsx/.jsx name parses JSX
 * @returns {Map<number, BodyRange>} Declaration start offset → body range; empty if the file cannot be parsed
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain code-index, code-extraction
 * @tags typescript-ast, function-body, body-range, comment-extraction
 */
export function locateBodies(content: string, fileName: string): Map<number, BodyRange> {
  const bodies = new Map<number, BodyRange>();
  try {
    const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, kind);
    ts.forEachChild(sf, child => collectBodies(child, sf, bodies));
  } catch {
    // An unparseable file falls back to text-based body detection in the indexer
  }
  return bodies;
}

/**
 * @what Blanks out ranges of a body's text, keeping its line structure
 * @how Replaces every character in each range (relative to the body start) with a space, except newlines
 * @why Comments inside a nested documented function belong to that function; blanking them in the parent's body keeps each comment indexed once without shifting the parent's line offsets
 *
 * @param {string} body The body text
 * @param {number} bodyStart The body's offset in the file
 * @param {BodyRange[]} ranges File ranges to blank, each inside the body
 * @returns {string} The body with those ranges replaced by whitespace
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain code-index, comment-extraction
 * @tags masking, nested-functions, comment-attribution
 */
export function maskRanges(body: string, bodyStart: number, ranges: BodyRange[]): string {
  if (ranges.length === 0) return body;
  const chars = body.split('');
  for (const r of ranges) {
    for (let i = Math.max(0, r.start - bodyStart); i < Math.min(chars.length, r.end - bodyStart); i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}
