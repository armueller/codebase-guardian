/**
 * @what Extracts function calls and property accesses from code using regex
 * @how Uses regex patterns to identify function calls and property accesses, filtering out built-ins
 * @why Identifies domain-specific code elements that require research validation
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain code-analysis, regex-parsing, validation
 * @tags regex, code-analysis, function-extraction, property-extraction, validation-helper
 */

import { PropertyAccess, DeclaredType, TypeUsageAnalysis } from './types.js';

/**
 * @what Extracts all function calls from source code
 * @how Uses regex to find pattern `functionName(` and filters out keywords/built-ins
 * @why Identifies which functions are called so they can be validated against research
 *
 * @param {string} code Source code to analyze
 * @returns {string[]} Array of unique function names that are called
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain function-extraction, regex-parsing
 * @tags regex, function-calls, code-parsing, extraction, validation
 */
export function extractCalledFunctions(code: string): string[] {
  // Remove comments to avoid false positives
  const codeWithoutComments = removeComments(code);

  const functions = new Set<string>();

  // Pattern 1: Match function calls: functionName(
  const callPattern = /\b(\w+)\s*\(/g;
  for (const match of codeWithoutComments.matchAll(callPattern)) {
    const functionName = match[1];
    if (!isKeyword(functionName)) {
      functions.add(functionName);
    }
  }

  // Pattern 2: Match function references passed as arguments or assigned
  // Captures: useSelector(fn), map(fn), onClick={fn}, const x = fn
  // Positive lookbehind for [(,=] and lookahead for [,)\]]
  const refPattern = /(?<=[(,=])\s*(\w+)\s*(?=[,)\]])/g;
  for (const match of codeWithoutComments.matchAll(refPattern)) {
    const identifier = match[1];
    // Skip keywords, primitives like true/false/null, and single letters
    if (!isKeyword(identifier) && identifier.length > 1 &&
        !['true', 'false', 'null', 'undefined'].includes(identifier)) {
      functions.add(identifier);
    }
  }

  return Array.from(functions);
}

/**
 * @what Extracts all property accesses from source code
 * @how Uses regex to find pattern `object.property` and filters out built-in objects/methods
 * @why Identifies property accesses that need validation against researched models
 *
 * @param {string} code Source code to analyze
 * @returns {PropertyAccess[]} Array of unique property accesses
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain property-extraction, regex-parsing
 * @tags regex, property-access, object-properties, validation, code-parsing
 */
export function extractPropertyAccesses(code: string): PropertyAccess[] {
  // Remove comments to avoid false positives
  const codeWithoutComments = removeComments(code);

  // Match property access: object.property (but NOT method calls like object.method())
  const propertyPattern = /\b(\w+)\.(\w+)(?!\s*\()/g;
  const matches = codeWithoutComments.matchAll(propertyPattern);

  const accesses = new Map<string, PropertyAccess>();

  for (const match of matches) {
    const [, object, property] = match;

    // Skip if it's a built-in object or common pattern
    if (shouldSkipPropertyAccess(object, property)) {
      continue;
    }

    // Use composite key to avoid duplicates
    const key = `${object}.${property}`;
    if (!accesses.has(key)) {
      accesses.set(key, { object, property });
    }
  }

  return Array.from(accesses.values());
}

/**
 * @what Removes comments from code to avoid parsing JSDoc or inline comments
 * @how Uses regex to strip both single-line (//) and multi-line (/* *\/) comments
 * @why Comments can contain code-like patterns that shouldn't be analyzed
 *
 * @param {string} code Source code with comments
 * @returns {string} Code with all comments removed
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain code-preprocessing, comment-removal
 * @tags regex, comment-removal, preprocessing, code-cleanup, parsing-helper
 */
function removeComments(code: string): string {
  return code
    .replace(/\/\/.*$/gm, '')          // Remove // comments
    .replace(/\/\*[\s\S]*?\*\//g, ''); // Remove /* */ comments
}

/**
 * @what Checks if a word is a JavaScript/TypeScript keyword
 * @how Compares against a set of known keywords
 * @why Keywords like 'if', 'for', 'while' look like function calls but aren't
 *
 * @param {string} word Word to check
 * @returns {boolean} True if word is a keyword
 *
 * @sideeffects None
 * @systemlayer Validation
 * @domain keyword-detection, filtering
 * @tags keywords, javascript, typescript, filtering, validation-helper
 */
function isKeyword(word: string): boolean {
  const keywords = new Set([
    'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue',
    'return', 'throw', 'try', 'catch', 'finally', 'function', 'class',
    'const', 'let', 'var', 'typeof', 'instanceof', 'new', 'delete',
    'void', 'yield', 'await', 'async', 'import', 'export', 'default',
    'extends', 'implements', 'interface', 'type', 'enum', 'namespace'
  ]);

  return keywords.has(word);
}

/**
 * @what Determines if a property access should be skipped (built-in or common pattern)
 * @how Checks object and property names against lists of built-ins and common patterns
 * @why Avoids false positives from JavaScript built-ins and common method calls
 *
 * @param {string} object Object name (left side of dot)
 * @param {string} property Property name (right side of dot)
 * @returns {boolean} True if this access should be skipped
 *
 * @sideeffects None
 * @systemlayer Validation
 * @domain filtering, built-in-detection
 * @tags filtering, built-ins, false-positive-prevention, validation-helper, smart-filtering
 */
function shouldSkipPropertyAccess(object: string, property: string): boolean {
  // Skip single-letter variables (likely loop counters, etc.)
  if (object.length === 1 || property.length === 1) {
    return true;
  }

  // Skip built-in JavaScript/TypeScript objects
  const builtInObjects = new Set([
    'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
    'Date', 'Promise', 'Set', 'Map', 'Error', 'RegExp', 'Boolean',
    'process', 'Buffer', 'global', 'window', 'document', 'location',
    'this', 'super', 'Symbol', 'BigInt', 'Proxy', 'Reflect',
    'Intl', 'WebAssembly', 'Atomics', 'DataView', 'Int8Array',
    'Uint8Array', 'Int16Array', 'Uint16Array', 'Int32Array',
    'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
    'BigUint64Array', 'ArrayBuffer', 'SharedArrayBuffer', 'WeakMap',
    'WeakSet'
  ]);

  if (builtInObjects.has(object)) {
    return true;
  }

  // Skip logger objects (any object with "log" or "logger" in the name)
  if (object.toLowerCase().includes('log')) {
    return true;
  }

  // Skip common built-in properties
  const builtInProperties = new Set([
    'length', 'prototype', 'constructor', 'toString', 'valueOf',
    'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
    'toLocaleString', '__proto__', 'name', 'message', 'stack'
  ]);

  if (builtInProperties.has(property)) {
    return true;
  }

  // Skip common Date methods
  const dateMethods = new Set([
    'now', 'getTime', 'getDate', 'getMonth', 'getFullYear', 'getHours',
    'getMinutes', 'getSeconds', 'getMilliseconds', 'getDay', 'toISOString',
    'toDateString', 'toTimeString', 'toLocaleDateString', 'toLocaleTimeString'
  ]);

  if (dateMethods.has(property)) {
    return true;
  }

  // Skip common console methods
  const consoleMethods = new Set([
    'log', 'error', 'warn', 'info', 'debug', 'trace', 'dir', 'table',
    'group', 'groupEnd', 'time', 'timeEnd', 'assert', 'clear'
  ]);

  if (consoleMethods.has(property)) {
    return true;
  }

  // Skip common array/collection methods (these are method calls, not data access)
  const commonMethods = new Set([
    'map', 'filter', 'reduce', 'forEach', 'find', 'some', 'every',
    'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat',
    'join', 'split', 'trim', 'replace', 'match', 'search', 'toLowerCase',
    'toUpperCase', 'includes', 'startsWith', 'endsWith', 'indexOf',
    'lastIndexOf', 'keys', 'values', 'entries', 'flat', 'flatMap',
    'sort', 'reverse', 'fill', 'copyWithin', 'at', 'findIndex',
    'findLast', 'findLastIndex', 'toSorted', 'toReversed', 'toSpliced',
    'with', 'get', 'set', 'has', 'delete', 'clear', 'add', 'then',
    'catch', 'finally', 'resolve', 'reject', 'all', 'race', 'allSettled',
    'any'
  ]);

  if (commonMethods.has(property)) {
    return true;
  }

  // Skip properties that start with common method prefixes (likely methods, not data)
  if (/^(get|set|is|has|to|from|create|update|delete|fetch|load|save)[A-Z]/.test(property)) {
    return true;
  }

  // If we got here, it's likely a domain-specific property access worth validating
  return false;
}

/**
 * @what Analyzes an edit to categorize all function usage
 * @how Compares functions in old_string vs new_string to determine which are called, modified, or created
 * @why Provides structured analysis of how functions are being used in the edit
 *
 * @param {string} oldString Code before edit (empty string for new files)
 * @param {string} newString Code after edit
 * @returns {object} Functions categorized by usage type
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain function-analysis, diff-analysis
 * @tags code-diff, function-analysis, usage-categorization, validation-helper, edit-analysis
 */
export function analyzeFunctionUsage(
  oldString: string,
  newString: string
): { called: string[]; modified: string[]; created: string[] } {
  // Extract functions declared in old and new code
  const oldDeclared = extractDeclaredFunctions(oldString);
  const newDeclared = extractDeclaredFunctions(newString);

  // Extract functions called in new code
  const called = extractCalledFunctions(newString);

  // Functions that existed before and still exist (modified)
  const modified = newDeclared.filter(name => oldDeclared.includes(name));

  // Functions that are new (created)
  const created = newDeclared.filter(name => !oldDeclared.includes(name));

  return { called, modified, created };
}

/**
 * @what Extracts function declarations from code
 * @how Uses regex patterns to find all function declaration patterns
 * @why Need to identify which functions are being declared/defined
 *
 * @param {string} code Source code to analyze
 * @returns {string[]} Array of declared function names
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain function-extraction, declaration-detection
 * @tags regex, function-declarations, code-parsing, extraction, validation-helper
 */
export function extractDeclaredFunctions(code: string): string[] {
  const declared = new Set<string>();

  // Remove comments
  const codeWithoutComments = removeComments(code);

  // Function declaration patterns
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g,                                              // function name(
    /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,                                 // const name = () => or const name = async () =>
    /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?function/g,                                       // const name = function
    /(?:export\s+)?const\s+(\w+)\s*=\s*(?:createSelector|createAsyncThunk|createSlice)\(/g,           // const name = createSelector|createAsyncThunk|createSlice(
    /(\w+)\s*:\s*(?:async\s*)?\([^)]*\)\s*(?:=>|{)/g                                                  // name: (params) => or name: () {
  ];

  for (const pattern of patterns) {
    const matches = codeWithoutComments.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        declared.add(match[1]);
      }
    }
  }

  // Filter out Redux Toolkit lifecycle properties and known inline callback property names
  // These are configuration callbacks inside factory calls, not standalone functions needing JSDoc
  const inlineCallbackNames = new Set([
    'pending', 'rejected', 'fulfilled', 'settled',     // createAsyncThunk lifecycle
    'reducers', 'extraReducers', 'selectors',           // createSlice/createAppSlice config
    'prepare',                                          // createSlice reducer prepare callback
    'handler', 'callback', 'listener', 'middleware',    // Common inline callback property names
    'onSuccess', 'onError', 'onComplete', 'onCancel',  // Event handler callbacks
    'resolve', 'reject',                                // Promise callbacks
  ]);

  return Array.from(declared).filter(name => !inlineCallbackNames.has(name));
}

/**
 * @what Extracts interface, type alias, and enum declarations from code
 * @how Uses regex patterns for interface Name {, type Name =, and enum Name { declarations
 * @why Need to identify which types are being declared for JSDoc validation
 *
 * @param {string} code Source code to analyze
 * @returns {DeclaredType[]} Array of declared types with their kind
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain type-extraction, declaration-detection
 * @tags regex, type-declarations, interface, enum, code-parsing
 */
export function extractDeclaredTypes(code: string): DeclaredType[] {
  const declared = new Map<string, DeclaredType>();

  // Remove comments
  const codeWithoutComments = removeComments(code);

  const patterns: Array<{ pattern: RegExp; kind: 'interface' | 'type' | 'enum' }> = [
    { pattern: /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[^{]+)?\s*\{/g, kind: 'interface' },
    { pattern: /(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/g, kind: 'type' },
    { pattern: /(?:export\s+)?(?:const\s+)?enum\s+(\w+)\s*\{/g, kind: 'enum' },
  ];

  for (const { pattern, kind } of patterns) {
    for (const match of codeWithoutComments.matchAll(pattern)) {
      if (match[1] && !declared.has(match[1])) {
        declared.set(match[1], { name: match[1], kind });
      }
    }
  }

  return Array.from(declared.values());
}

/**
 * @what Analyzes an edit to categorize type/interface/enum usage as modified or created
 * @how Compares types in old_string vs new_string to determine which are new vs changed
 * @why Provides structured analysis of type declarations for JSDoc validation
 *
 * @param {string} oldString Code before edit (empty string for new files)
 * @param {string} newString Code after edit
 * @returns {TypeUsageAnalysis} Types categorized as modified or created
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain type-analysis, diff-analysis
 * @tags code-diff, type-analysis, usage-categorization, validation-helper, edit-analysis
 */
export function analyzeTypeUsage(
  oldString: string,
  newString: string
): TypeUsageAnalysis {
  const oldDeclared = extractDeclaredTypes(oldString);
  const newDeclared = extractDeclaredTypes(newString);

  const oldNames = new Set(oldDeclared.map(t => t.name));

  const modified = newDeclared
    .filter(t => oldNames.has(t.name))
    .map(t => t.name);

  const created = newDeclared
    .filter(t => !oldNames.has(t.name))
    .map(t => t.name);

  return { modified, created };
}

/**
 * @what Finds the innermost named scope (function, method, constructor, or class) that encloses the edit region
 * @how Scans the entire file for all declarations, determines each one's brace range with context-aware matching (handles strings, comments, template literals), then returns the innermost scope containing the edit position
 * @why When an edit modifies code inside a function body without changing the declaration, analyzeFunctionUsage misses it — this catches body-only edits. Using innermost scope ensures we validate just the affected method, not an entire class.
 *
 * @param {string} fullFileContent The complete file content after the edit is applied
 * @param {string} oldString The original text that was replaced (used to locate the edit region)
 * @param {string} newString The replacement text
 * @returns {string[]} Names of functions whose bodies contain the edit region (usually 0 or 1)
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain function-detection, edit-containment, body-change-detection
 * @tags enclosing-function, body-edit, containment, scope-analysis, validation-trigger
 */
export function findEnclosingFunctions(
  fullFileContent: string,
  oldString: string,
  newString: string
): string[] {
  const editPos = fullFileContent.indexOf(newString);
  if (editPos === -1) return [];

  // Find all named scopes in the file with their brace ranges
  const scopes = findAllNamedScopes(fullFileContent);

  // Find scopes that contain the edit position
  const containing = scopes.filter(s => editPos > s.braceStart && editPos < s.braceEnd);

  if (containing.length === 0) return [];

  // Sort by range size ascending — smallest range = innermost scope
  containing.sort((a, b) => (a.braceEnd - a.braceStart) - (b.braceEnd - b.braceStart));

  // Return the innermost scope
  return [containing[0].name];
}

interface NamedScope {
  name: string;
  type: 'function' | 'method' | 'class';
  declStart: number;
  braceStart: number;
  braceEnd: number;
}

/**
 * @what Finds all named scopes (functions, methods, classes) in a file with their brace ranges
 * @how Uses regex to find declarations, then context-aware brace matching to determine each scope's range
 * @why Needed by findEnclosingFunctions to determine which scope contains the edit position
 *
 * @param {string} content The full file content
 * @returns {NamedScope[]} All named scopes with their brace ranges
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain scope-detection, brace-matching
 * @tags scope-analysis, brace-matching, declarations, context-aware, parsing
 */
function findAllNamedScopes(content: string): NamedScope[] {
  const scopes: NamedScope[] = [];

  // Declaration patterns — each captures the name in group 1
  const patterns: Array<{ regex: RegExp; type: 'function' | 'method' | 'class' }> = [
    // Standalone functions: function name( or export async function name(
    { regex: /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g, type: 'function' },
    // Arrow/function-expression assignments: const name = (...) => { or const name = function
    { regex: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|\bfunction\b)/g, type: 'function' },
    // Class declarations: class Name or export default class Name
    { regex: /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/g, type: 'class' },
    // Class methods with access modifiers: private/protected/public [async] name(
    { regex: /(?:private|protected|public)\s+(?:static\s+)?(?:async\s+)?(\w+)\s*\(/g, type: 'method' },
    // Constructor
    { regex: /\b(constructor)\s*\(/g, type: 'method' },
  ];

  for (const { regex, type } of patterns) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      const declStart = match.index;

      // Find the opening brace for this declaration
      // Start from declStart (not after match) so we properly track paren depth
      // through the parameter list — the regex match may include the opening (
      const braceStart = findNextOpenBrace(content, declStart);
      if (braceStart === -1) continue;

      // Find the matching closing brace using context-aware matching
      const braceEnd = findMatchingCloseBrace(content, braceStart);
      if (braceEnd === -1) continue;

      scopes.push({ name, type, declStart, braceStart, braceEnd });
    }
  }

  return scopes;
}

/**
 * @what Finds the next opening brace after a position, skipping parenthesized parameter lists
 * @how Scans forward, tracking paren depth to skip over parameter lists, then finds the first {
 * @why Declarations like `function foo(a, b)` or `private method(x: {complex: Type})` have parens before the brace
 *
 * @param {string} content The file content
 * @param {number} startPos Position to start scanning from (after the declaration keyword)
 * @returns {number} Index of the opening brace, or -1 if not found within 2000 chars
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain brace-finding, parameter-skipping
 * @tags brace-search, paren-tracking, forward-scan, parsing
 */
function findNextOpenBrace(content: string, startPos: number): number {
  let parenDepth = 0;
  const limit = Math.min(content.length, startPos + 2000);

  for (let i = startPos; i < limit; i++) {
    const ch = content[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    else if (ch === '{' && parenDepth === 0) return i;
    // Arrow function without braces — give up
    else if (ch === ';' && parenDepth === 0) return -1;
  }
  return -1;
}

/**
 * @what Finds the matching closing brace for an opening brace, with context-aware scanning
 * @how Tracks brace depth while skipping braces inside strings, template literals, line comments, and block comments
 * @why Naive brace counting fails on code containing string literals with braces, template expressions, or commented-out code
 *
 * @param {string} content The file content
 * @param {number} openBracePos Index of the opening brace
 * @returns {number} Index of the matching closing brace, or -1 if not found
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain brace-matching, context-aware-parsing
 * @tags brace-matching, string-aware, comment-aware, template-aware, robust-parsing
 */
function findMatchingCloseBrace(content: string, openBracePos: number): number {
  let depth = 1;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplateLiteral = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openBracePos + 1; i < content.length; i++) {
    const ch = content[i];
    const prev = i > 0 ? content[i - 1] : '';

    // Line comment end
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }

    // Block comment end
    if (inBlockComment) {
      if (ch === '/' && prev === '*') inBlockComment = false;
      continue;
    }

    // String ends (check for escaped quotes)
    if (inSingleQuote) {
      if (ch === '\'' && prev !== '\\') inSingleQuote = false;
      continue;
    }
    if (inDoubleQuote) {
      if (ch === '"' && prev !== '\\') inDoubleQuote = false;
      continue;
    }
    if (inTemplateLiteral) {
      if (ch === '`' && prev !== '\\') inTemplateLiteral = false;
      continue;
    }

    // Detect context entry points
    if (ch === '/' && i + 1 < content.length) {
      const next = content[i + 1];
      if (next === '/') { inLineComment = true; i++; continue; }
      if (next === '*') { inBlockComment = true; i++; continue; }
    }
    if (ch === '\'') { inSingleQuote = true; continue; }
    if (ch === '"') { inDoubleQuote = true; continue; }
    if (ch === '`') { inTemplateLiteral = true; continue; }

    // Count braces in code context only
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}
