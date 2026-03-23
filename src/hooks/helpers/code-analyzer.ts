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
 * @what Finds function names that enclose the edit region in the full file content
 * @how Locates the edit position via oldString match, then walks backward through the file to find the nearest function/const/class declaration that contains that position
 * @why When an edit modifies code inside a function body without changing the declaration, the standard analyzeFunctionUsage misses it entirely — this catches body-only edits so they still get validated for JSDoc accuracy, DRY, and code quality
 *
 * @param {string} fullFileContent The complete file content after the edit is applied
 * @param {string} oldString The original text that was replaced (used to locate the edit region)
 * @param {string} newString The replacement text
 * @returns {string[]} Names of functions whose bodies contain the edit region (usually 0 or 1)
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain function-detection, edit-containment, body-change-detection
 * @tags enclosing-function, body-edit, containment, walkback, validation-trigger
 */
export function findEnclosingFunctions(
  fullFileContent: string,
  oldString: string,
  newString: string
): string[] {
  // Find where the edit landed in the post-edit file content
  const editPos = fullFileContent.indexOf(newString);
  if (editPos === -1) return [];

  // Walk backward from the edit position to find the enclosing function declaration
  const before = fullFileContent.slice(0, editPos);
  const lines = before.split('\n');

  // Scan backward through lines looking for a function declaration
  const declarationPatterns = [
    /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
    /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?:=>|{)/,
    /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?function/,
    /(?:export\s+)?(?:default\s+)?class\s+(\w+)/,
  ];

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    for (const pattern of declarationPatterns) {
      const match = line.match(pattern);
      if (match && match[1]) {
        // Verify this declaration actually encloses the edit by checking brace depth
        const declarationPos = before.lastIndexOf(lines[i]);
        const textBetween = fullFileContent.slice(declarationPos, editPos);

        // Count unmatched opening braces — if depth > 0, the edit is inside this function
        let depth = 0;
        for (const char of textBetween) {
          if (char === '{') depth++;
          else if (char === '}') depth--;
        }

        if (depth > 0) {
          return [match[1]];
        }
      }
    }
  }

  return [];
}
