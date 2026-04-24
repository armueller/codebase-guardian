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
        target: 99,     // ESNext
        module: 199,    // ESNext
        lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
        allowJs: true,
        jsx: 2, // React
        strict: false,  // Don't flag strict-mode issues in isolated parsing
        noEmit: true,
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
export interface DiscoveredFunction {
  name: string;
  fullStart: number;
  fullEnd: number;
  lineNumber: number;
  jsdocText: string;
  requiresJSDoc: boolean;  // true for declarations (function statements, const assignments, class methods); false for inline callbacks (arguments to .map, useMemo, etc.)
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
        requiresJSDoc: true,  // Function declarations are always real declarations
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
      // Value-returning hooks (useMemo, useRef, etc.) are excluded — they return values, not functions.
      let isWrappedFuncLike = false;
      if (initKind === SyntaxKind.CallExpression) {
        const callExpr = init.asKindOrThrow(SyntaxKind.CallExpression);
        const calleeName = callExpr.getExpression().getText();

        const valueReturningHooks = new Set(['useMemo', 'useRef', 'useState', 'useReducer', 'useContext']);
        if (!valueReturningHooks.has(calleeName)) {
          const callArgs = callExpr.getArguments();
          if (callArgs.length > 0) {
            const firstArgKind = callArgs[0].getKind();
            isWrappedFuncLike = firstArgKind === SyntaxKind.ArrowFunction ||
                                firstArgKind === SyntaxKind.FunctionExpression;
          }
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
        requiresJSDoc: true,  // Const assignments to functions are real declarations
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
        requiresJSDoc: true,  // Class methods are real declarations
      });
    }

    // 4. Named function expressions passed as arguments: .map(function foo() {}), useMemo(function bar() {})
    //    These are inline callbacks — tracked for change detection but don't require JSDoc.
    //    Named for stack traces/debugging, not as standalone declarations.
    if (node.getKind() === SyntaxKind.FunctionExpression) {
      const funcExpr = node.asKindOrThrow(SyntaxKind.FunctionExpression);
      const name = funcExpr.getName();
      if (!name) return;

      // Skip if already captured by case 2 (const name = function name() {})
      const parent = funcExpr.getParent();
      if (parent?.getKind() === SyntaxKind.VariableDeclaration) {
        const parentName = (parent as any).getName?.();
        if (parentName === name) return;
      }

      const nodeStart = funcExpr.getStart();
      const jsdocText = findJSDocBefore(content, nodeStart);
      const fullStart = jsdocText ? content.lastIndexOf(jsdocText, nodeStart) : nodeStart;

      addResult(name, {
        name,
        fullStart,
        fullEnd: funcExpr.getEnd(),
        lineNumber: getLineNumber(nodeStart),
        jsdocText,
        requiresJSDoc: false,  // Inline callbacks don't require JSDoc
      });
    }

    // 5. Object property assignments with function values: { name: function() {} } or { name: () => {} }
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
        requiresJSDoc: false,  // Object property methods are internal to the parent object — the parent const/export carries the JSDoc
      });
    }
  });

  return results;
}

/**
 * @what Represents a discovered type/interface/enum declaration in the AST
 * @domain type-extraction, ast-parsing
 * @tags ast-node, type-declaration, intermediate-result
 */
export interface DiscoveredType {
  name: string;
  kind: 'interface' | 'type' | 'enum';
  fullStart: number;
  fullEnd: number;
  lineNumber: number;
  jsdocText: string;
}

/**
 * @what Discovers all type/interface/enum declarations in a source file
 * @how Uses ts-morph's getInterfaces(), getTypeAliases(), getEnums() to find all type declarations
 * @why Builds a lookup map for type change detection and JSDoc extraction
 *
 * @param {SourceFile} sourceFile Parsed ts-morph source file
 * @param {string} content Original file content string
 * @returns {Map<string, DiscoveredType[]>} Map of type name to discovered declarations
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain type-discovery, ast-walking
 * @tags ast-walk, interface, type-alias, enum, discovery
 */
function discoverTypes(sourceFile: SourceFile, content: string): Map<string, DiscoveredType[]> {
  const results = new Map<string, DiscoveredType[]>();

  function getLineNumber(pos: number): number {
    let line = 1;
    for (let i = 0; i < pos && i < content.length; i++) {
      if (content[i] === '\n') line++;
    }
    return line;
  }

  function addResult(name: string, entry: DiscoveredType): void {
    const existing = results.get(name) || [];
    existing.push(entry);
    results.set(name, existing);
  }

  function processNode(node: Node, kind: 'interface' | 'type' | 'enum'): void {
    const name = (node as any).getName?.();
    if (!name) return;

    const nodeStart = node.getStart();
    const jsdocText = findJSDocBefore(content, nodeStart);
    const fullStart = jsdocText ? content.lastIndexOf(jsdocText, nodeStart) : nodeStart;

    addResult(name, {
      name,
      kind,
      fullStart,
      fullEnd: node.getEnd(),
      lineNumber: getLineNumber(nodeStart),
      jsdocText,
    });
  }

  for (const iface of sourceFile.getInterfaces()) {
    processNode(iface, 'interface');
  }
  for (const alias of sourceFile.getTypeAliases()) {
    processNode(alias, 'type');
  }
  for (const enumDecl of sourceFile.getEnums()) {
    processNode(enumDecl, 'enum');
  }

  return results;
}

/**
 * @what Discovers all function and type declarations in a source file via AST
 * @how Parses content with ts-morph, runs discoverFunctions() and discoverTypes() on the AST
 * @why Provides complete declaration maps for change detection without regex parsing
 *
 * @param {string} content Source code to analyze
 * @returns {object} Maps of function and type declarations found in the content
 *
 * @sideeffects Updates cached ts-morph SourceFile
 * @systemlayer Code Analysis
 * @domain declaration-discovery, ast-parsing
 * @tags ast-parsing, function-discovery, type-discovery, change-detection
 */
export function discoverAllDeclarations(content: string): {
  functions: Map<string, DiscoveredFunction[]>;
  types: Map<string, DiscoveredType[]>;
} {
  if (!content || content.trim().length === 0) {
    return { functions: new Map(), types: new Map() };
  }

  try {
    const sourceFile = parseFile(content);
    return {
      functions: discoverFunctions(sourceFile, content),
      types: discoverTypes(sourceFile, content),
    };
  } catch {
    return { functions: new Map(), types: new Map() };
  }
}

/**
 * @what Checks if source code has syntax errors that would make AST analysis unreliable
 * @how Parses content with ts-morph and checks for syntax-level diagnostics
 * @why When an edit creates invalid intermediate syntax (e.g., partial function deletion),
 *   validation should allow the edit rather than flagging issues on broken code
 *
 * @param {string} content Source code to check
 * @returns {string[]} Array of syntax error messages, empty if valid
 *
 * @sideeffects Updates cached ts-morph SourceFile
 * @systemlayer Code Analysis
 * @domain syntax-validation, ast-parsing
 * @tags syntax-check, parse-errors, ts-morph, validation-gate
 */
export function getSyntaxErrors(content: string): string[] {
  if (!content || content.trim().length === 0) return [];

  // Diagnostic codes to IGNORE — these are semantic errors from the isolated parser
  // not being able to resolve imports, not actual syntax problems with the code.
  const ignoredCodes = new Set([
    2307, // Cannot find module '...' or its corresponding type declarations
    2304, // Cannot find name '...' (unresolved identifiers from missing imports)
    2305, // Module '...' has no exported member '...'
    2306, // '...' is not a module
    2552, // Cannot find name '...' — Did you mean '...'?
    2580, // Cannot find name 'require'
    2584, // Cannot find name 'module'
    6133, // '...' is declared but its value is never read (unused import)
    6196, // '...' is declared but never used
  ]);

  try {
    const sourceFile = parseFile(content);
    const diagnostics = sourceFile.getPreEmitDiagnostics();
    return diagnostics
      .filter(d => d.getCategory() === 1 && !ignoredCodes.has(d.getCode()))
      .map(d => d.getMessageText().toString())
      .slice(0, 5);
  } catch {
    return ['Failed to parse file'];
  }
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
      requiresJSDoc: best.requiresJSDoc,
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
