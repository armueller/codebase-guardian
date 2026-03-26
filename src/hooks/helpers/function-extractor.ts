/**
 * @what Extracts functions and types from source code including their JSDoc comments
 * @how Uses ts-morph AST parsing to find declarations and their associated JSDoc
 * @why Provides focused function/type context for validation without sending entire file.
 *   AST parsing handles all declaration patterns correctly (named function expressions,
 *   wrapped functions, class methods, etc.) unlike regex-based approaches.
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain function-extraction, jsdoc-extraction, code-parsing
 * @tags function-extraction, jsdoc, ast-parsing, ts-morph, validation-helper
 */

import { ExtractedFunction, ExtractedType } from './types.js';
import { parseJSDocTags } from './jsdoc-parser.js';
import { Project, SourceFile, SyntaxKind, Node } from 'ts-morph';

// Lazily initialized ts-morph project — reused across all extractions in a single hook invocation
let cachedProject: Project | null = null;

// Cache parsed source file by content hash to avoid re-parsing for multiple function extractions
let cachedFileContent: string | null = null;
let cachedSourceFile: SourceFile | null = null;

/**
 * @what Gets or creates a ts-morph Project for parsing
 * @how Lazy-initializes a minimal Project with no tsconfig (in-memory only)
 * @why Reusing the Project avoids repeated initialization overhead
 *
 * @returns {Project} ts-morph Project instance
 *
 * @sideeffects Creates a cached Project on first call
 * @systemlayer Utility
 * @domain ast-parsing, initialization
 * @tags ts-morph, project, lazy-init, caching, performance
 */
function getProject(): Project {
  if (!cachedProject) {
    cachedProject = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        allowJs: true,
        jsx: 2, // React
      },
    });
  }
  return cachedProject;
}

/**
 * @what Parses file content into a ts-morph SourceFile, caching by content
 * @how Creates an in-memory source file from the content string, reuses if content unchanged
 * @why Multiple function extractions from the same file should share one parse
 *
 * @param {string} content Source code to parse
 * @returns {SourceFile} Parsed ts-morph SourceFile
 *
 * @sideeffects Updates cached source file
 * @systemlayer Code Parsing
 * @domain ast-parsing, caching
 * @tags ts-morph, source-file, parsing, caching, performance
 */
function parseFile(content: string): SourceFile {
  if (cachedFileContent === content && cachedSourceFile) {
    return cachedSourceFile;
  }

  const project = getProject();

  // Remove previous cached file if any
  if (cachedSourceFile) {
    try { project.removeSourceFile(cachedSourceFile); } catch { /* ignore */ }
  }

  cachedSourceFile = project.createSourceFile('__validation_target__.tsx', content, { overwrite: true });
  cachedFileContent = content;
  return cachedSourceFile;
}

/**
 * @what Finds the JSDoc comment text immediately preceding a node
 * @how Walks backwards from the node to find a JSDoc comment, checking distance and intervening text
 * @why ts-morph's getJsDocs() only works on certain node types; this handles all cases including
 *   variable declarations where JSDoc is on the statement, not the declaration
 *
 * @param {string} content Full file content
 * @param {number} nodeStart Character index where the declaration node starts
 * @returns {string} JSDoc comment text including delimiters, or empty string if none found
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain jsdoc-extraction, backward-search
 * @tags jsdoc, backward-scan, comment-extraction, ast-parsing
 */
function findJSDocBefore(content: string, nodeStart: number): string {
  const before = content.substring(0, nodeStart);
  const jsdocPattern = /\/\*\*[\s\S]*?\*\//g;
  let lastMatch: RegExpExecArray | null = null;
  let match;

  while ((match = jsdocPattern.exec(before)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) return '';

  // Check proximity — only whitespace, export, default, async, const, let, var allowed between
  const textBetween = content.slice(lastMatch.index + lastMatch[0].length, nodeStart).trim();
  if (lastMatch.index + lastMatch[0].length + 300 < nodeStart) return '';
  if (textBetween && !/^(export\s+)?(default\s+)?(async\s+)?(const\s+|let\s+|var\s+)?(\w+\s*=\s*)?$/.test(textBetween)) {
    return '';
  }

  return content.substring(lastMatch.index, lastMatch.index + lastMatch[0].length);
}

/**
 * @what Represents a discovered function-like declaration in the AST
 * @domain function-extraction, ast-parsing
 * @tags ast-node, declaration, intermediate-result
 */
interface DiscoveredFunction {
  name: string;
  fullStart: number;
  fullEnd: number;
  lineNumber: number;
  jsdocText: string;
}

/**
 * @what Discovers all function-like declarations in a source file
 * @how Walks the ts-morph AST to find function declarations, variable declarations with
 *   function/arrow initializers, class methods, and object method properties
 * @why Builds a lookup map so extractFunctionWithJSDoc can find any function by name
 *
 * @param {SourceFile} sourceFile Parsed ts-morph source file
 * @param {string} content Original file content string
 * @returns {Map<string, DiscoveredFunction[]>} Map of function name to discovered declarations
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain function-discovery, ast-walking
 * @tags ast-walk, function-declarations, arrow-functions, class-methods, discovery
 */
function discoverFunctions(sourceFile: SourceFile, content: string): Map<string, DiscoveredFunction[]> {
  const results = new Map<string, DiscoveredFunction[]>();

  function addResult(name: string, entry: DiscoveredFunction): void {
    const existing = results.get(name) || [];
    existing.push(entry);
    results.set(name, existing);
  }

  function getLineNumber(pos: number): number {
    let line = 1;
    for (let i = 0; i < pos && i < content.length; i++) {
      if (content[i] === '\n') line++;
    }
    return line;
  }

  // Walk all top-level and nested statements
  sourceFile.forEachDescendant((node) => {
    // 1. Function declarations: function foo() {} or export function foo() {}
    if (node.getKind() === SyntaxKind.FunctionDeclaration) {
      const funcDecl = node.asKindOrThrow(SyntaxKind.FunctionDeclaration);
      const name = funcDecl.getName();
      if (!name) return;

      const nodeStart = funcDecl.getStart();
      const jsdocText = findJSDocBefore(content, nodeStart);
      const fullStart = jsdocText ? content.lastIndexOf(jsdocText, nodeStart) : nodeStart;

      addResult(name, {
        name,
        fullStart,
        fullEnd: funcDecl.getEnd(),
        lineNumber: getLineNumber(nodeStart),
        jsdocText,
      });
    }

    // 2. Variable declarations: const foo = () => {}, const foo = function() {}, const foo = function foo() {}
    if (node.getKind() === SyntaxKind.VariableDeclaration) {
      const varDecl = node.asKindOrThrow(SyntaxKind.VariableDeclaration);
      const name = varDecl.getName();
      const init = varDecl.getInitializer();
      if (!init) return;

      const initKind = init.getKind();

      // Direct arrow or function expression
      const isFuncLike = initKind === SyntaxKind.ArrowFunction ||
                          initKind === SyntaxKind.FunctionExpression;

      // Wrapped: React.memo(function...), observer(function...), useCallback(() => ...), etc.
      let isWrappedFuncLike = false;
      if (initKind === SyntaxKind.CallExpression) {
        const callArgs = init.asKindOrThrow(SyntaxKind.CallExpression).getArguments();
        if (callArgs.length > 0) {
          const firstArgKind = callArgs[0].getKind();
          isWrappedFuncLike = firstArgKind === SyntaxKind.ArrowFunction ||
                              firstArgKind === SyntaxKind.FunctionExpression;
        }
      }

      if (!isFuncLike && !isWrappedFuncLike) return;

      // JSDoc is on the variable statement (parent of variable declaration list)
      const varStatement = varDecl.getParent()?.getParent();
      const statementStart = varStatement ? varStatement.getStart() : varDecl.getStart();
      const jsdocText = findJSDocBefore(content, statementStart);
      const fullStart = jsdocText ? content.lastIndexOf(jsdocText, statementStart) : statementStart;

      addResult(name, {
        name,
        fullStart,
        fullEnd: varStatement ? varStatement.getEnd() : varDecl.getEnd(),
        lineNumber: getLineNumber(statementStart),
        jsdocText,
      });
    }

    // 3. Class methods and constructors
    if (node.getKind() === SyntaxKind.MethodDeclaration ||
        node.getKind() === SyntaxKind.Constructor) {
      const methodNode = node as Node;
      const name = node.getKind() === SyntaxKind.Constructor
        ? 'constructor'
        : (methodNode as any).getName?.() || '';
      if (!name) return;

      const nodeStart = methodNode.getStart();
      const jsdocText = findJSDocBefore(content, nodeStart);
      const fullStart = jsdocText ? content.lastIndexOf(jsdocText, nodeStart) : nodeStart;

      addResult(name, {
        name,
        fullStart,
        fullEnd: methodNode.getEnd(),
        lineNumber: getLineNumber(nodeStart),
        jsdocText,
      });
    }

    // 4. Object property assignments with function values: { name: function() {} } or { name: () => {} }
    if (node.getKind() === SyntaxKind.PropertyAssignment) {
      const propAssign = node.asKindOrThrow(SyntaxKind.PropertyAssignment);
      const name = propAssign.getName();
      const init = propAssign.getInitializer();
      if (!init) return;

      const initKind = init.getKind();
      if (initKind !== SyntaxKind.ArrowFunction && initKind !== SyntaxKind.FunctionExpression) return;

      const nodeStart = propAssign.getStart();
      const jsdocText = findJSDocBefore(content, nodeStart);
      const fullStart = jsdocText ? content.lastIndexOf(jsdocText, nodeStart) : nodeStart;

      addResult(name, {
        name,
        fullStart,
        fullEnd: propAssign.getEnd(),
        lineNumber: getLineNumber(nodeStart),
        jsdocText,
      });
    }
  });

  return results;
}

/**
 * @what Extracts a function from source code WITH its JSDoc comment if present
 * @how Parses file with ts-morph, finds function by name in AST, extracts full code with JSDoc
 * @why Needed to pass focused function context (with JSDoc) to headless Claude validation
 *
 * @param {string} fullFileContent Complete source code of the file
 * @param {string} functionName Name of function to extract
 * @param {number} approximateLine Approximate line number where function appears (optional, for disambiguation)
 * @returns {ExtractedFunction | null} Extracted function with metadata, or null if not found
 *
 * @sideeffects None
 * @systemlayer Code Extraction
 * @domain function-extraction, jsdoc-extraction
 * @tags function-extraction, jsdoc, ast-parsing, ts-morph, validation-core
 */
export function extractFunctionWithJSDoc(
  fullFileContent: string,
  functionName: string,
  approximateLine?: number
): ExtractedFunction | null {
  try {
    const sourceFile = parseFile(fullFileContent);
    const allFunctions = discoverFunctions(sourceFile, fullFileContent);
    const candidates = allFunctions.get(functionName);

    if (!candidates || candidates.length === 0) {
      return null;
    }

    // Pick best candidate — prefer one closest to approximateLine if provided
    let best = candidates[0];
    if (approximateLine !== undefined && candidates.length > 1) {
      for (const candidate of candidates) {
        if (Math.abs(candidate.lineNumber - approximateLine) < Math.abs(best.lineNumber - approximateLine)) {
          best = candidate;
        }
      }
    }

    const fullCode = fullFileContent.substring(best.fullStart, best.fullEnd);
    const hasJSDoc = best.jsdocText.length > 0;
    const jsdocTags = hasJSDoc ? parseJSDocTags(best.jsdocText) || undefined : undefined;

    return {
      name: functionName,
      fullCode,
      hasJSDoc,
      isNew: false,
      isModified: false,
      lineInFile: best.lineNumber,
      jsdocTags,
    };
  } catch {
    // If ts-morph parsing fails (e.g., severely malformed code), return null
    return null;
  }
}

/**
 * @what Extracts an interface, type alias, or enum from source code WITH its JSDoc comment if present
 * @how Parses file with ts-morph, finds type by name and kind in AST, extracts full code with JSDoc
 * @why Needed to validate JSDoc completeness on types/interfaces/enums alongside functions
 *
 * @param {string} fullFileContent Complete source code of the file
 * @param {string} typeName Name of the type to extract
 * @param {'interface' | 'type' | 'enum'} kind What kind of type declaration to look for
 * @returns {ExtractedType | null} Extracted type with metadata, or null if not found
 *
 * @sideeffects None
 * @systemlayer Code Extraction
 * @domain type-extraction, jsdoc-extraction
 * @tags type-extraction, interface, enum, jsdoc, ast-parsing, validation-core
 */
export function extractTypeWithJSDoc(
  fullFileContent: string,
  typeName: string,
  kind: 'interface' | 'type' | 'enum'
): ExtractedType | null {
  try {
    const sourceFile = parseFile(fullFileContent);

    let targetNode: Node | undefined;

    if (kind === 'interface') {
      targetNode = sourceFile.getInterface(typeName);
    } else if (kind === 'type') {
      targetNode = sourceFile.getTypeAlias(typeName);
    } else if (kind === 'enum') {
      targetNode = sourceFile.getEnum(typeName);
    }

    if (!targetNode) return null;

    const nodeStart = targetNode.getStart();
    const content = fullFileContent;
    const jsdocText = findJSDocBefore(content, nodeStart);
    const fullStart = jsdocText ? content.lastIndexOf(jsdocText, nodeStart) : nodeStart;
    const fullCode = content.substring(fullStart, targetNode.getEnd());

    const hasJSDoc = jsdocText.length > 0;
    const jsdocTags = hasJSDoc ? parseJSDocTags(jsdocText) || undefined : undefined;

    // Calculate line number
    let lineNumber = 1;
    for (let i = 0; i < nodeStart && i < content.length; i++) {
      if (content[i] === '\n') lineNumber++;
    }

    return {
      name: typeName,
      kind,
      fullCode,
      hasJSDoc,
      isNew: false,
      isModified: false,
      lineInFile: lineNumber,
      jsdocTags,
    };
  } catch {
    return null;
  }
}

/**
 * @what Extracts multiple functions from source code in a single pass
 * @how Calls extractFunctionWithJSDoc for each function name (shares cached parse)
 * @why More efficient than extracting one at a time when multiple functions needed
 *
 * @param {string} fullFileContent Complete source code
 * @param {string[]} functionNames Array of function names to extract
 * @returns {Map<string, ExtractedFunction>} Map of function name to extracted function
 *
 * @sideeffects None
 * @systemlayer Code Extraction
 * @domain batch-extraction, optimization
 * @tags batch-processing, multi-extraction, optimization, performance, validation-helper
 */
export function extractMultipleFunctions(
  fullFileContent: string,
  functionNames: string[]
): Map<string, ExtractedFunction> {
  const extracted = new Map<string, ExtractedFunction>();

  for (const name of functionNames) {
    const func = extractFunctionWithJSDoc(fullFileContent, name);
    if (func) {
      extracted.set(name, func);
    }
  }

  return extracted;
}
