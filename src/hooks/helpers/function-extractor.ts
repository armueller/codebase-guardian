/**
 * @what Extracts functions from source code including their JSDoc comments
 * @how Finds function declarations, looks backwards for JSDoc, forwards for function end
 * @why Provides focused function context for validation without sending entire file
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain function-extraction, jsdoc-extraction, code-parsing
 * @tags function-extraction, jsdoc, code-parsing, brace-matching, validation-helper
 */

import { ExtractedFunction, ExtractedType } from './types.js';
import { parseJSDocTags } from './jsdoc-parser.js';

/**
 * @what Extracts a function from source code WITH its JSDoc comment if present
 * @how Finds function declaration, looks backwards for JSDoc, forwards to find closing brace
 * @why Needed to pass focused function context (with JSDoc) to headless Claude validation
 *
 * @param {string} fullFileContent Complete source code of the file
 * @param {string} functionName Name of function to extract
 * @param {number} approximateLine Approximate line number where function appears (optional, for optimization)
 * @returns {ExtractedFunction | null} Extracted function with metadata, or null if not found
 *
 * @sideeffects None
 * @systemlayer Code Extraction
 * @domain function-extraction, jsdoc-extraction
 * @tags function-extraction, jsdoc, brace-matching, code-parsing, validation-core
 */
export function extractFunctionWithJSDoc(
  fullFileContent: string,
  functionName: string,
  approximateLine?: number
): ExtractedFunction | null {
  // Find the function declaration
  const funcLocation = findFunctionDeclaration(fullFileContent, functionName, approximateLine);

  if (!funcLocation) {
    return null;
  }

  const { startIndex, lineNumber } = funcLocation;

  // Look backwards for JSDoc comment
  const jsdocStart = findJSDocStart(fullFileContent, startIndex);

  // Look forwards to find function end (closing brace)
  const funcEnd = findFunctionEnd(fullFileContent, startIndex);

  if (funcEnd === -1) {
    // Couldn't find function end - might be arrow function or single-line
    // Just take a reasonable chunk
    const endOfLine = fullFileContent.indexOf('\n', startIndex);
    const extractEnd = endOfLine !== -1 ? endOfLine : startIndex + 500;

    const fullCode = fullFileContent.substring(
      jsdocStart !== -1 ? jsdocStart : startIndex,
      extractEnd
    );

    return {
      name: functionName,
      fullCode,
      hasJSDoc: jsdocStart !== -1,
      isNew: false,  // Will be set by caller
      isModified: false,  // Will be set by caller
      lineInFile: lineNumber,
      jsdocTags: jsdocStart !== -1 ? parseJSDocTags(extractJSDocComment(fullFileContent, jsdocStart, startIndex)) || undefined : undefined
    };
  }

  // Extract from JSDoc start (or function start if no JSDoc) to function end
  const extractStart = jsdocStart !== -1 ? jsdocStart : startIndex;
  const fullCode = fullFileContent.substring(extractStart, funcEnd);

  // Parse JSDoc if present
  let jsdocTags;
  if (jsdocStart !== -1) {
    const jsdocComment = extractJSDocComment(fullFileContent, jsdocStart, startIndex);
    jsdocTags = parseJSDocTags(jsdocComment) || undefined;
  }

  return {
    name: functionName,
    fullCode,
    hasJSDoc: jsdocStart !== -1,
    isNew: false,  // Will be set by caller
    isModified: false,  // Will be set by caller
    lineInFile: lineNumber,
    jsdocTags
  };
}

/**
 * @what Finds the starting index of a function declaration in source code
 * @how Uses regex patterns to locate function declaration, optionally starting near approximate line
 * @why Need to know where function starts to extract it with JSDoc
 *
 * @param {string} content Source code to search
 * @param {string} functionName Name of function to find
 * @param {number} approximateLine Optional line hint for optimization
 * @returns {object | null} Object with startIndex and lineNumber, or null if not found
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain function-location, regex-search
 * @tags function-search, regex, code-parsing, location-finding, optimization
 */
function findFunctionDeclaration(
  content: string,
  functionName: string,
  approximateLine?: number
): { startIndex: number; lineNumber: number } | null {
  // Escape special regex characters in function name
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Patterns for different function/class declaration styles
  const patterns = [
    `(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${escapedName}\\s*\\(`,                             // function name( or export default function name(
    `(?:export\\s+)?const\\s+${escapedName}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>`,                           // const name = () => or const name = async () =>
    `(?:export\\s+)?const\\s+${escapedName}\\s*=\\s*(?:async\\s*)?function`,                                    // const name = function
    `(?:export\\s+)?const\\s+${escapedName}\\s*=\\s*(?:createSelector|createAsyncThunk|createSlice)\\(`,        // const name = createSelector|createAsyncThunk|createSlice(
    `(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${escapedName}(?:\\s+extends\\s+\\S+)?\\s*\\{`,   // class name { or class name extends Base {
    `(?:private|protected|public)\\s+(?:static\\s+)?(?:async\\s+)?${escapedName}\\s*\\(`,                        // class method: private name( or public async name(
    `${escapedName}\\s*:\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?:=>|{)`,                                              // name: (params) => or name() {
    `(?:export\\s+)?(?:async\\s+)?${escapedName}\\s*\\(`,                                                        // async name( (method style)
  ];

  // Try each pattern
  for (const patternStr of patterns) {
    const pattern = new RegExp(patternStr, 'g');
    let match;

    while ((match = pattern.exec(content)) !== null) {
      const startIndex = match.index;
      const lineNumber = calculateLineNumber(content, startIndex);

      // If we have an approximate line, prefer matches near it
      if (approximateLine !== undefined && Math.abs(lineNumber - approximateLine) > 20) {
        continue; // Too far from expected line, keep searching
      }

      return { startIndex, lineNumber };
    }
  }

  return null;
}

/**
 * @what Finds the start of JSDoc comment before a function declaration
 * @how Looks backwards from function start to find /** delimiter
 * @why JSDoc comment precedes function declaration and must be extracted with it
 *
 * @param {string} content Source code
 * @param {number} functionStartIndex Index where function declaration starts
 * @returns {number} Index where JSDoc starts, or -1 if no JSDoc found
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain jsdoc-location, backward-search
 * @tags jsdoc-search, backward-scan, comment-extraction, code-parsing, jsdoc-detection
 */
function findJSDocStart(content: string, functionStartIndex: number): number {
  // Look backwards from function start to find /**
  const beforeFunction = content.substring(0, functionStartIndex);

  // Find the last occurrence of /** before the function
  const jsdocPattern = /\/\*\*[\s\S]*?\*\//g;
  let lastMatch: RegExpExecArray | null = null;
  let match;

  while ((match = jsdocPattern.exec(beforeFunction)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) {
    return -1; // No JSDoc found
  }

  // Check if the JSDoc is "close enough" to the function
  // Allow up to 200 chars to handle blank lines, export keywords, and decorators between JSDoc and declaration
  const distanceToFunction = functionStartIndex - (lastMatch.index + lastMatch[0].length);
  const textBetween = content.slice(lastMatch.index + lastMatch[0].length, functionStartIndex).trim();
  // Only whitespace or export/default keywords should appear between JSDoc and function
  if (distanceToFunction > 200 || (textBetween && !/^(export\s+)?(default\s+)?(async\s+)?$/.test(textBetween))) {
    return -1; // JSDoc is too far away or there's code between, probably belongs to something else
  }

  return lastMatch.index;
}

/**
 * @what Extracts JSDoc comment text between JSDoc start and function start
 * @how Substring extraction from jsdocStart to functionStart
 * @why Need isolated JSDoc text for parsing
 *
 * @param {string} content Source code
 * @param {number} jsdocStart Index where /** starts
 * @param {number} functionStart Index where function declaration starts
 * @returns {string} JSDoc comment including /** and *\/
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain jsdoc-extraction, substring-extraction
 * @tags jsdoc, extraction, substring, comment-parsing, utility-helper
 */
function extractJSDocComment(
  content: string,
  jsdocStart: number,
  functionStart: number
): string {
  // Find the end of JSDoc (*/)
  const jsdocEnd = content.indexOf('*/', jsdocStart);

  if (jsdocEnd === -1 || jsdocEnd > functionStart) {
    return ''; // Invalid JSDoc
  }

  return content.substring(jsdocStart, jsdocEnd + 2); // +2 to include */
}

/**
 * @what Finds the end of a function by matching braces
 * @how Scans forward from function start, counting { and } until balanced
 * @why Need to extract complete function body including all nested blocks
 *
 * @param {string} content Source code
 * @param {number} functionStartIndex Index where function declaration starts
 * @returns {number} Index of closing brace + 1, or -1 if not found
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain brace-matching, scope-detection
 * @tags brace-matching, scope-analysis, function-end, code-parsing, nesting-handling
 */
function findFunctionEnd(content: string, functionStartIndex: number): number {
  let braceCount = 0;
  let inFunction = false;
  let inString = false;
  let stringChar = '';
  let inComment = false;
  let inMultiLineComment = false;

  for (let i = functionStartIndex; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    // Handle multi-line comments
    if (!inString && char === '/' && nextChar === '*') {
      inMultiLineComment = true;
      i++; // Skip next char
      continue;
    }
    if (inMultiLineComment && char === '*' && nextChar === '/') {
      inMultiLineComment = false;
      i++; // Skip next char
      continue;
    }
    if (inMultiLineComment) {
      continue;
    }

    // Handle single-line comments
    if (!inString && char === '/' && nextChar === '/') {
      inComment = true;
      continue;
    }
    if (inComment && char === '\n') {
      inComment = false;
      continue;
    }
    if (inComment) {
      continue;
    }

    // Handle strings
    if (!inString && (char === '"' || char === "'" || char === '`')) {
      inString = true;
      stringChar = char;
      continue;
    }
    if (inString && char === stringChar && content[i - 1] !== '\\') {
      inString = false;
      continue;
    }
    if (inString) {
      continue;
    }

    // Count braces (only when not in strings or comments)
    if (char === '{') {
      braceCount++;
      inFunction = true;
    } else if (char === '}') {
      braceCount--;

      // If we've balanced all braces and we're in a function, we found the end
      if (inFunction && braceCount === 0) {
        return i + 1; // Return index after closing brace
      }
    }
  }

  return -1; // Couldn't find matching closing brace
}

/**
 * @what Calculates line number for a given character index in source code
 * @how Counts newline characters from start to index
 * @why Line numbers are useful for debugging and error messages
 *
 * @param {string} content Source code
 * @param {number} index Character index
 * @returns {number} Line number (1-indexed)
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain line-calculation, position-mapping
 * @tags line-number, position-tracking, utility-helper, debugging-aid, error-reporting
 */
function calculateLineNumber(content: string, index: number): number {
  let lineNumber = 1;

  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') {
      lineNumber++;
    }
  }

  return lineNumber;
}

/**
 * @what Extracts an interface, type alias, or enum from source code WITH its JSDoc comment if present
 * @how Finds type declaration, looks backwards for JSDoc, forwards using brace matching (interface/enum) or semicolon scan (type alias)
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
 * @tags type-extraction, interface, enum, jsdoc, brace-matching, validation-core
 */
export function extractTypeWithJSDoc(
  fullFileContent: string,
  typeName: string,
  kind: 'interface' | 'type' | 'enum'
): ExtractedType | null {
  const typeLocation = findTypeDeclaration(fullFileContent, typeName, kind);

  if (!typeLocation) {
    return null;
  }

  const { startIndex, lineNumber } = typeLocation;

  // Look backwards for JSDoc comment
  const jsdocStart = findJSDocStart(fullFileContent, startIndex);

  // Find the end of the type declaration
  let typeEnd: number;

  if (kind === 'type') {
    // Type aliases don't always use braces — scan for semicolon or next declaration
    typeEnd = findTypeAliasEnd(fullFileContent, startIndex);
  } else {
    // Interfaces and enums use braces — reuse brace matching
    typeEnd = findFunctionEnd(fullFileContent, startIndex);
  }

  if (typeEnd === -1) {
    // Fallback: take a reasonable chunk
    const endOfLine = fullFileContent.indexOf('\n', startIndex);
    const extractEnd = endOfLine !== -1 ? endOfLine : startIndex + 500;

    const fullCode = fullFileContent.substring(
      jsdocStart !== -1 ? jsdocStart : startIndex,
      extractEnd
    );

    return {
      name: typeName,
      kind,
      fullCode,
      hasJSDoc: jsdocStart !== -1,
      isNew: false,
      isModified: false,
      lineInFile: lineNumber,
      jsdocTags: jsdocStart !== -1 ? parseJSDocTags(extractJSDocComment(fullFileContent, jsdocStart, startIndex)) || undefined : undefined
    };
  }

  const extractStart = jsdocStart !== -1 ? jsdocStart : startIndex;
  const fullCode = fullFileContent.substring(extractStart, typeEnd);

  let jsdocTags;
  if (jsdocStart !== -1) {
    const jsdocComment = extractJSDocComment(fullFileContent, jsdocStart, startIndex);
    jsdocTags = parseJSDocTags(jsdocComment) || undefined;
  }

  return {
    name: typeName,
    kind,
    fullCode,
    hasJSDoc: jsdocStart !== -1,
    isNew: false,
    isModified: false,
    lineInFile: lineNumber,
    jsdocTags
  };
}

/**
 * @what Finds the starting index of a type declaration (interface, type alias, or enum) in source code
 * @how Uses kind-specific regex patterns to locate the declaration
 * @why Need to know where type starts to extract it with JSDoc
 *
 * @param {string} content Source code to search
 * @param {string} typeName Name of the type to find
 * @param {'interface' | 'type' | 'enum'} kind What kind of declaration to look for
 * @returns {object | null} Object with startIndex and lineNumber, or null if not found
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain type-location, regex-search
 * @tags type-search, regex, interface, enum, location-finding
 */
function findTypeDeclaration(
  content: string,
  typeName: string,
  kind: 'interface' | 'type' | 'enum'
): { startIndex: number; lineNumber: number } | null {
  const escapedName = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  let patternStr: string;
  switch (kind) {
    case 'interface':
      patternStr = `(?:export\\s+)?interface\\s+${escapedName}(?:\\s+extends\\s+[^{]+)?\\s*\\{`;
      break;
    case 'type':
      patternStr = `(?:export\\s+)?type\\s+${escapedName}\\s*(?:<[^>]*>)?\\s*=`;
      break;
    case 'enum':
      patternStr = `(?:export\\s+)?(?:const\\s+)?enum\\s+${escapedName}\\s*\\{`;
      break;
  }

  const pattern = new RegExp(patternStr, 'g');
  const match = pattern.exec(content);

  if (!match) {
    return null;
  }

  return {
    startIndex: match.index,
    lineNumber: calculateLineNumber(content, match.index)
  };
}

/**
 * @what Finds the end of a type alias declaration
 * @how Scans forward handling nested braces, parentheses, template literals, and strings until finding the terminating semicolon
 * @why Type aliases can be complex (union types, mapped types, conditional types) and don't always end with a closing brace
 *
 * @param {string} content Source code
 * @param {number} startIndex Index where the type alias declaration starts
 * @returns {number} Index after the semicolon, or -1 if not found
 *
 * @sideeffects None
 * @systemlayer Code Analysis
 * @domain type-parsing, end-detection
 * @tags type-alias, semicolon-scan, scope-analysis, code-parsing
 */
function findTypeAliasEnd(content: string, startIndex: number): number {
  let braceCount = 0;
  let parenCount = 0;
  let inString = false;
  let stringChar = '';
  let inComment = false;
  let inMultiLineComment = false;
  let passedEquals = false;

  for (let i = startIndex; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    // Handle multi-line comments
    if (!inString && char === '/' && nextChar === '*') {
      inMultiLineComment = true;
      i++;
      continue;
    }
    if (inMultiLineComment && char === '*' && nextChar === '/') {
      inMultiLineComment = false;
      i++;
      continue;
    }
    if (inMultiLineComment) continue;

    // Handle single-line comments
    if (!inString && char === '/' && nextChar === '/') {
      inComment = true;
      continue;
    }
    if (inComment && char === '\n') {
      inComment = false;
      continue;
    }
    if (inComment) continue;

    // Handle strings
    if (!inString && (char === '"' || char === "'" || char === '`')) {
      inString = true;
      stringChar = char;
      continue;
    }
    if (inString && char === stringChar && content[i - 1] !== '\\') {
      inString = false;
      continue;
    }
    if (inString) continue;

    // Track when we've passed the = sign
    if (!passedEquals && char === '=') {
      passedEquals = true;
      continue;
    }

    if (!passedEquals) continue;

    // Track nesting
    if (char === '{') braceCount++;
    if (char === '}') braceCount--;
    if (char === '(') parenCount++;
    if (char === ')') parenCount--;

    // Semicolon at top level ends the type alias
    if (char === ';' && braceCount === 0 && parenCount === 0) {
      return i + 1;
    }
  }

  return -1;
}

/**
 * @what Extracts multiple functions from source code in a single pass
 * @how Calls extractFunctionWithJSDoc for each function name
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
