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

import { PropertyAccess, FunctionUsageAnalysis, TypeUsageAnalysis } from './types.js';
import { discoverAllDeclarations } from './function-extractor.js';

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
 * @what Analyzes all function and type changes between pre-edit and post-edit file states
 * @how Parses both files with ts-morph AST, compares declarations by name and full text.
 *   New names = created, same name but different text = modified. Detects renames via
 *   position proximity when a function disappears and a new one appears nearby.
 * @why Replaces regex-based snippet parsing which was fragile on incomplete code fragments.
 *   Full-file AST comparison correctly handles all declaration patterns and body-only edits.
 *
 * @param {string} currentFileOnDisk File content before the edit (empty for new files)
 * @param {string} fullFileContent File content after the edit is applied
 * @param {string} newString The new_string from the edit (used for extractCalledFunctions)
 * @returns {object} Function usage, type usage, and type kind map
 *
 * @sideeffects Updates ts-morph parse cache (post-edit stays cached for extraction)
 * @systemlayer Code Analysis
 * @domain change-detection, ast-comparison, diff-analysis
 * @tags ast-parsing, function-analysis, type-analysis, change-detection, validation-helper
 */
export function analyzeChanges(
  currentFileOnDisk: string,
  fullFileContent: string,
  newString: string
): {
  functionUsage: FunctionUsageAnalysis;
  typeUsage: TypeUsageAnalysis;
  typeKindMap: Map<string, 'interface' | 'type' | 'enum'>;
} {
  // Parse pre-edit first, then post-edit (so post-edit stays cached for extractFunctionWithJSDoc)
  const preDeclare = discoverAllDeclarations(currentFileOnDisk);
  const postDeclare = discoverAllDeclarations(fullFileContent);

  // --- Function change detection ---
  const modified: string[] = [];
  const created: string[] = [];
  const deleted: string[] = [];
  const renamed: Array<{ oldName: string; newName: string }> = [];

  for (const [name, postEntries] of postDeclare.functions) {
    const preEntries = preDeclare.functions.get(name);
    if (!preEntries) {
      created.push(name);
    } else {
      // Compare text — if any entry's text differs, it's modified
      const postText = postEntries.map(e => fullFileContent.substring(e.fullStart, e.fullEnd)).join('\n');
      const preText = preEntries.map(e => currentFileOnDisk.substring(e.fullStart, e.fullEnd)).join('\n');
      if (postText !== preText) {
        modified.push(name);
      }
    }
  }

  // Find deleted functions (in pre but not post) for rename detection
  for (const [name] of preDeclare.functions) {
    if (!postDeclare.functions.has(name)) {
      deleted.push(name);
    }
  }

  // Rename detection: match deleted functions with created functions by position proximity
  if (deleted.length > 0 && created.length > 0) {
    const unmatchedCreated = new Set(created);

    for (const oldName of deleted) {
      const oldEntries = preDeclare.functions.get(oldName);
      if (!oldEntries || oldEntries.length === 0) continue;
      const oldLine = oldEntries[0].lineNumber;

      // Find the closest created function within 10 lines
      let bestMatch: string | null = null;
      let bestDistance = Infinity;

      for (const newName of unmatchedCreated) {
        const newEntries = postDeclare.functions.get(newName);
        if (!newEntries || newEntries.length === 0) continue;
        const newLine = newEntries[0].lineNumber;
        const distance = Math.abs(newLine - oldLine);

        if (distance <= 10 && distance < bestDistance) {
          bestDistance = distance;
          bestMatch = newName;
        }
      }

      if (bestMatch) {
        renamed.push({ oldName, newName: bestMatch });
        unmatchedCreated.delete(bestMatch);
        // Treat renamed functions as modified (for validation) rather than created
        modified.push(bestMatch);
      }
    }

    // Remove renamed functions from created list
    const renamedNewNames = new Set(renamed.map(r => r.newName));
    const filteredCreated = created.filter(name => !renamedNewNames.has(name));
    created.length = 0;
    created.push(...filteredCreated);
  }

  // Called functions (still regex-based on newString — works fine for call detection)
  const called = extractCalledFunctions(newString);

  // --- Type change detection ---
  const typeModified: string[] = [];
  const typeCreated: string[] = [];
  const typeKindMap = new Map<string, 'interface' | 'type' | 'enum'>();

  for (const [name, postEntries] of postDeclare.types) {
    // Build kind map from post-edit types
    if (postEntries.length > 0) {
      typeKindMap.set(name, postEntries[0].kind);
    }

    const preEntries = preDeclare.types.get(name);
    if (!preEntries) {
      typeCreated.push(name);
    } else {
      const postText = postEntries.map(e => fullFileContent.substring(e.fullStart, e.fullEnd)).join('\n');
      const preText = preEntries.map(e => currentFileOnDisk.substring(e.fullStart, e.fullEnd)).join('\n');
      if (postText !== preText) {
        typeModified.push(name);
      }
    }
  }

  return {
    functionUsage: { called, modified, created, deleted, renamed },
    typeUsage: { modified: typeModified, created: typeCreated },
    typeKindMap,
  };
}
