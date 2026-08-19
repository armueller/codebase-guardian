import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import {
  insertFunction,
  insertDomains,
  insertTags,
  insertSystemLayers,
  insertComments,
  insertDocSections,
  deleteFunctionsByFilePath,
  getFileHash,
  setFileHash,
  hashContent,
  setMetadata,
} from './db.js';
import { generateEmbeddings, invalidateCache } from './embeddings.js';
import { resolveConfig } from '../config.js';
import { extractPythonFile, type PyExtracted } from './py-index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ParsedJSDoc {
  name: string;
  description: string;
  how: string;
  why: string;
  domains: string[];
  tags: string[];
  systemlayers: string[];
  sideEffects: string | null;
  declarationType: string;
  lineNumber: number;
  body: string;
  blockEnd?: number;
}

export interface ParsedDoc {
  name: string;
  description: string;
  how: string;
  why: string;
  domains: string[];
  tags: string[];
  body: string;
  filePath: string;
  lineNumber: number;
}

/**
 * @what Tracks statistics collected during a code indexing run
 * @domain code-index, metrics
 * @tags indexing, statistics, metrics, rebuild, counts
 */
export interface IndexStats {
  filesScanned: number;
  tier1Added: number;
  tier2Added: number;
  tier3Added: number;
  embeddingsGenerated: number;
  filesSkipped: number;
  commentsExtracted: number;
  docSectionsCreated: number;
}

// ─── Domain/Tag Normalization ────────────────────────────────────────────────

function normalizeDomainList(raw: string): string[] {
  return raw
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeTagList(raw: string): string[] {
  return raw
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeSystemLayers(raw: string): string[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// ─── JSDoc Parsing (Code Files) ─────────────────────────────────────────────


/**
 * @what Extracts a JSDoc tag value from a comment block with multi-line continuation support
 * @how Matches @tagName with case-insensitive regex, then scans continuation lines (starting with * followed by non-@ content) until reaching another tag or block end
 * @why JSDoc tag values may span multiple lines; without continuation support, multi-line @what descriptions get silently truncated
 *
 * @param {string} block The raw JSDoc comment block text
 * @param {string} tagName The tag name to extract (e.g., 'what', 'domain', 'tags')
 * @returns {string} The tag value with continuation lines joined by spaces, or empty string if not found
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain code-index, jsdoc-parsing
 * @tags jsdoc, tag-extraction, multi-line, parsing, indexer
 */
export function extractTag(block: string, tagName: string): string {
  // Case-insensitive tag matching with multi-line continuation support
  const regex = new RegExp(`@${tagName}\\s+(.+?)(?:\\n|\\*/)`, 'i');
  const match = block.match(regex);
  if (!match) return '';

  let value = match[1].replace(/\s*\*\s*$/, '').trim();

  // Scan continuation lines (lines starting with * followed by non-@ content)
  const matchEnd = (match.index ?? 0) + match[0].length;
  const remaining = block.slice(matchEnd);
  const lines = remaining.split('\n');
  for (const line of lines) {
    const cleaned = line.replace(/^\s*\*\s?/, '').trim();
    // Stop at next @tag or end of block
    if (!cleaned || cleaned.startsWith('@') || cleaned === '/') break;
    value += ' ' + cleaned;
  }

  return value;
}

/**
 * @what Parses a JSDoc comment block and extracts structured guardian-specific tags
 * @how Uses regex-based extractTag helper to pull tags from the block, then uses the caller-provided blockStartIndex for precise positioning to extract function name and body (avoids indexOf re-search which fails on duplicate blocks)
 * @why Core indexing logic that converts raw JSDoc comments into structured data for the semantic code index
 *
 * @param {string} block The raw JSDoc comment block text
 * @param {string} fileContent The full file content containing the JSDoc block
 * @param {number} blockStartIndex The character index in fileContent where the JSDoc block starts (from regex.exec match.index)
 * @returns {ParsedJSDoc | null} Structured JSDoc data or null if no @domain tag found
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain code-index, jsdoc-parsing
 * @tags jsdoc, parsing, indexer, tags, extraction, code-index
 */
export function parseJSDocBlock(block: string, fileContent: string, blockStartIndex: number): ParsedJSDoc | null {
  const what = extractTag(block, 'what');
  const domain = extractTag(block, 'domain');
  if (!domain) return null;

  const how = extractTag(block, 'how');
  const why = extractTag(block, 'why');
  const sideEffects = extractTag(block, 'sideeffects') || null;
  const systemlayer = extractTag(block, 'systemlayer');
  const tags = extractTag(block, 'tags');

  // Use the precise block position from regex.exec() rather than indexOf() re-search
  const blockEnd = blockStartIndex + block.length;
  const afterBlock = fileContent.slice(blockEnd, blockEnd + 500);
  const { name, declarationType } = extractFunctionName(afterBlock);

  if (!name) return null;

  // Calculate line number
  const lineNumber = fileContent.slice(0, blockEnd).split('\n').length;

  // Extract function body
  const body = extractFunctionBody(fileContent, blockEnd);

  return {
    name,
    description: what || extractDescriptionFromBlock(block),
    how,
    why,
    domains: normalizeDomainList(domain),
    tags: normalizeTagList(tags),
    systemlayers: normalizeSystemLayers(systemlayer),
    sideEffects: sideEffects && sideEffects.toLowerCase() !== 'none' ? sideEffects : null,
    declarationType,
    lineNumber,
    body,
    blockEnd,
  };
}

function extractDescriptionFromBlock(block: string): string {
  // Fallback: extract description lines before any @ tags
  const lines = block.split('\n');
  const descLines: string[] = [];
  for (const line of lines) {
    const cleaned = line.replace(/^\s*\/?\*+\s?/, '').trim();
    if (cleaned.startsWith('@')) break;
    if (cleaned && cleaned !== '/' && cleaned !== '*') {
      descLines.push(cleaned);
    }
  }
  return descLines.join(' ').trim();
}

/**
 * @what Extracts the function name and declaration type from code immediately following a JSDoc block
 * @how Tries regex patterns in order: function declaration, const/let/var, interface, type alias, class declaration
 * @why Identifies what entity a JSDoc block documents by parsing the code that follows it
 *
 * @param {string} afterBlock The code text immediately after the JSDoc closing asterisk-slash
 * @returns {{ name: string; declarationType: string }} The extracted name and declaration type, or empty name if no match
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain code-index, name-extraction
 * @tags function-name, declaration-type, regex, parsing, indexer
 */
export function extractFunctionName(afterBlock: string): { name: string; declarationType: string } {
  const trimmed = afterBlock.replace(/^\s*/, '');

  // export function name(
  const funcMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/);
  if (funcMatch) return { name: funcMatch[1], declarationType: 'function' };

  // export const name = (
  const constMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/);
  if (constMatch) return { name: constMatch[1], declarationType: 'const' };

  // interface Name {
  const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
  if (interfaceMatch) return { name: interfaceMatch[1], declarationType: 'interface' };

  // type Name =
  const typeMatch = trimmed.match(/^(?:export\s+)?type\s+(\w+)/);
  if (typeMatch) return { name: typeMatch[1], declarationType: 'type' };

  // class Name
  const classMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/);
  if (classMatch) return { name: classMatch[1], declarationType: 'class' };

  return { name: '', declarationType: 'unknown' };
}

/**
 * @what Extracts the function body text starting from after a JSDoc block
 * @how Finds the first opening brace, then uses depth-tracking to find the matching closing brace
 * @why Captures function implementation for comment extraction and body-level indexing
 *
 * @param {string} fileContent The full file content
 * @param {number} startPos Position after the JSDoc block ends
 * @param {number} maxLength Maximum characters to return (default 1000, use 20000 for full body)
 * @returns {string} The function body text up to maxLength characters
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain code-index, code-extraction
 * @tags function-body, brace-matching, extraction, indexer, parsing
 */
export function extractFunctionBody(fileContent: string, startPos: number, maxLength: number = 1000): string {
  // Find the opening brace after the JSDoc block
  const searchArea = fileContent.slice(startPos, startPos + 2000);
  const bracePos = searchArea.indexOf('{');
  if (bracePos === -1) return '';

  const absoluteStart = startPos + bracePos;
  let depth = 1;
  let pos = absoluteStart + 1;
  const scanLimit = maxLength > 1000 ? maxLength + 2000 : 5000;
  const maxPos = Math.min(fileContent.length, absoluteStart + scanLimit);

  // Context-aware brace counting: skip braces inside strings, templates, regex, and comments
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplateLiteral = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (depth > 0 && pos < maxPos) {
    const char = fileContent[pos];
    const prev = pos > 0 ? fileContent[pos - 1] : '';

    // Handle line comment end
    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      pos++;
      continue;
    }

    // Handle block comment end
    if (inBlockComment) {
      if (char === '/' && prev === '*') inBlockComment = false;
      pos++;
      continue;
    }

    // Handle string/template literal end (check for escaped quotes)
    if (inSingleQuote) {
      if (char === '\'' && prev !== '\\') inSingleQuote = false;
      pos++;
      continue;
    }
    if (inDoubleQuote) {
      if (char === '"' && prev !== '\\') inDoubleQuote = false;
      pos++;
      continue;
    }
    if (inTemplateLiteral) {
      if (char === '`' && prev !== '\\') inTemplateLiteral = false;
      // Template expressions ${...} can contain braces, but they're inside the template
      pos++;
      continue;
    }

    // Detect context entry points (only in code context)
    if (char === '/' && pos + 1 < maxPos) {
      const next = fileContent[pos + 1];
      if (next === '/') { inLineComment = true; pos += 2; continue; }
      if (next === '*') { inBlockComment = true; pos += 2; continue; }
    }
    if (char === '\'') { inSingleQuote = true; pos++; continue; }
    if (char === '"') { inDoubleQuote = true; pos++; continue; }
    if (char === '`') { inTemplateLiteral = true; pos++; continue; }

    // Only count braces in code context
    if (char === '{') depth++;
    else if (char === '}') depth--;
    pos++;
  }

  return fileContent.slice(absoluteStart, pos).slice(0, maxLength);
}

/**
 * @what Extracts inline comments from a function body, merging consecutive single-line comments
 * @how Iterates lines detecting // comments, /* blocks, and end-of-line comments; consecutive // lines merge into one entry
 * @why Enables sub-function-level DRY detection by indexing natural language step descriptions within function bodies
 *
 * @param {string} body The function body text (including braces)
 * @returns {{ text: string; type: string; lineOffset: number }[]} Extracted comments with type and position
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain code-index, comment-extraction
 * @tags comments, extraction, merge-consecutive, inline, dry-detection
 */
export function extractCommentsFromBody(body: string): { text: string; type: string; lineOffset: number }[] {
  const results: { text: string; type: string; lineOffset: number }[] = [];
  const lines = body.split('\n');

  let accumulatedLines: string[] = [];
  let accumulatedStart = 0;

  /**
   * @what Flushes accumulated consecutive // comment lines into a single merged entry
   * @how Joins accumulated lines, checks minimum length, detects section headers, pushes to results
   * @why Consecutive // lines should be treated as one logical comment for FTS indexing
   *
   * @returns {void}
   *
   * @sideeffects Mutates accumulatedLines and results arrays in closure scope
   * @systemlayer Utility
   * @domain comment-merging, flush-logic
   * @tags flush, accumulator, merge, comment-lines, section-header
   */
  function flushAccumulated(): void {
    if (accumulatedLines.length === 0) return;
    const text = accumulatedLines.join(' ').trim();
    if (text.length >= 5) {
      const isSectionHeader = /^[-─═=]{2,}\s*.+\s*[-─═=]{2,}$/.test(text) || /^[-─═=]{3,}$/.test(text);
      results.push({
        text,
        type: isSectionHeader ? 'section-header' : 'block',
        lineOffset: accumulatedStart,
      });
    }
    accumulatedLines = [];
  }

  let inBlockComment = false;
  let blockCommentText = '';
  let blockCommentStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Handle multi-line /* */ comments
    if (inBlockComment) {
      const endIdx = trimmed.indexOf('*/');
      if (endIdx !== -1) {
        blockCommentText += ' ' + trimmed.slice(0, endIdx).trim();
        inBlockComment = false;
        const cleaned = blockCommentText.replace(/^\*\s*/gm, '').trim();
        if (cleaned.length >= 5) {
          results.push({ text: cleaned, type: 'block', lineOffset: blockCommentStart });
        }
        blockCommentText = '';
      } else {
        blockCommentText += ' ' + trimmed.replace(/^\*\s?/, '');
      }
      continue;
    }

    // Check for /* start (but not JSDoc /** which is handled separately)
    const blockStart = trimmed.match(/^\/\*(?!\*)(.*)/);
    if (blockStart) {
      flushAccumulated();
      const endOnSameLine = blockStart[1].indexOf('*/');
      if (endOnSameLine !== -1) {
        const text = blockStart[1].slice(0, endOnSameLine).trim();
        if (text.length >= 5) {
          results.push({ text, type: 'block', lineOffset: i });
        }
      } else {
        inBlockComment = true;
        blockCommentStart = i;
        blockCommentText = blockStart[1];
      }
      continue;
    }

    // Full-line // comment
    const fullLineComment = trimmed.match(/^\/\/\s?(.*)/);
    if (fullLineComment) {
      if (accumulatedLines.length === 0) {
        accumulatedStart = i;
      }
      accumulatedLines.push(fullLineComment[1]);
      continue;
    }

    // Non-comment line — flush any accumulated // lines
    flushAccumulated();

    // End-of-line comment (code // comment) — skip if // appears inside a string or URL
    if (!trimmed.includes('://') && !trimmed.match(/(['"`]).*\/\/.*\1/)) {
      const endOfLineComment = trimmed.match(/[^/]\/\/\s?(.+)$/);
      if (endOfLineComment) {
        const commentText = endOfLineComment[1].trim();
        if (commentText.length >= 10) {
          results.push({ text: commentText, type: 'line', lineOffset: i });
        }
      }
    }
  }

  flushAccumulated();
  return results;
}

/**
 * @what Parses a markdown document into heading-level sections for granular FTS5 indexing
 * @how Splits content at ## through ##### headings, extracts code blocks separately, skips metadata headings
 * @why Replaces 1000-char body truncation with section-level chunks so each heading gets its own searchable entry
 *
 * @param {string} content The full markdown document content
 * @returns {{ heading: string; headingLevel: number; body: string; sectionType: string; order: number }[]} Parsed sections
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain code-index, documentation-chunking
 * @tags markdown, sections, headings, chunking, code-blocks, parsing
 */
export function parseDocSections(content: string): { heading: string; headingLevel: number; body: string; sectionType: string; order: number }[] {
  const sections: { heading: string; headingLevel: number; body: string; sectionType: string; order: number }[] = [];
  let order = 0;

  // Build a set of code block ranges so we can skip headings inside fenced code blocks
  const codeBlockRanges: { start: number; end: number }[] = [];
  const fenceRegex = /^```[^\n]*$/gm;
  let fenceMatch;
  let fenceOpen: number | null = null;
  while ((fenceMatch = fenceRegex.exec(content)) !== null) {
    if (fenceOpen === null) {
      fenceOpen = fenceMatch.index;
    } else {
      codeBlockRanges.push({ start: fenceOpen, end: fenceMatch.index + fenceMatch[0].length });
      fenceOpen = null;
    }
  }

  // Split into sections by headings (## through #####), skipping headings inside code blocks
  const headingRegex = /^(#{2,5})\s+(.+)$/gm;
  const headingMatches: { level: number; title: string; index: number }[] = [];

  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    // Skip headings that fall inside a fenced code block
    const inCodeBlock = codeBlockRanges.some(r => match!.index >= r.start && match!.index <= r.end);
    if (inCodeBlock) continue;

    headingMatches.push({
      level: match[1].length,
      title: match[2].trim(),
      index: match.index,
    });
  }

  if (headingMatches.length === 0) return sections;

  for (let i = 0; i < headingMatches.length; i++) {
    const heading = headingMatches[i];

    // Skip @-prefixed metadata headings (already captured in doc description)
    if (heading.title.startsWith('@')) continue;

    // Get body text between this heading and the next
    const bodyStart = heading.index + content.slice(heading.index).indexOf('\n') + 1;
    const bodyEnd = i < headingMatches.length - 1 ? headingMatches[i + 1].index : content.length;
    const body = content.slice(bodyStart, bodyEnd).trim();

    if (body.length < 20) continue;

    // Extract code blocks as separate entries (language hint can contain any non-newline chars)
    const codeBlockRegex = /```[^\n]*\n([\s\S]*?)```/g;
    let codeMatch;
    const codeBlocks: string[] = [];
    let proseBody = body;

    while ((codeMatch = codeBlockRegex.exec(body)) !== null) {
      const codeContent = codeMatch[1].trim();
      if (codeContent.length >= 20) {
        codeBlocks.push(codeContent);
      }
      proseBody = proseBody.replace(codeMatch[0], '');
    }

    // Add prose section
    const cleanedProse = proseBody.trim();
    if (cleanedProse.length >= 20) {
      sections.push({
        heading: heading.title,
        headingLevel: heading.level,
        body: cleanedProse,
        sectionType: 'prose',
        order: order++,
      });
    }

    // Add code block sections
    for (const code of codeBlocks) {
      sections.push({
        heading: heading.title,
        headingLevel: heading.level,
        body: code,
        sectionType: 'code',
        order: order++,
      });
    }
  }

  return sections;
}

// ─── Docs Parsing (Markdown Files) ──────────────────────────────────────────

function parseDocFile(content: string, filePath: string): ParsedDoc | null {
  // Extract title from first heading
  const titleMatch = content.match(/^#\s+(.+)/m);
  const name = titleMatch ? titleMatch[1].trim() : path.basename(filePath, '.md');

  // Extract ## @what section
  const whatMatch = content.match(/## @what\s*\n([\s\S]*?)(?=\n## @|\n## [^@]|$)/);
  const description = whatMatch ? whatMatch[1].trim() : '';

  // Extract ## @domain section
  const domainMatch = content.match(/## @domain\s*\n([\s\S]*?)(?=\n## @|\n## [^@]|$)/);
  const domainRaw = domainMatch ? domainMatch[1].trim() : '';

  // Extract ## @how section
  const howMatch = content.match(/## @how\s*\n([\s\S]*?)(?=\n## @|\n## [^@]|$)/);
  const how = howMatch ? howMatch[1].trim() : '';

  // Extract ## @why section
  const whyMatch = content.match(/## @why\s*\n([\s\S]*?)(?=\n## @|\n## [^@]|$)/);
  const why = whyMatch ? whyMatch[1].trim() : '';

  // Extract ## @tags section
  const tagsMatch = content.match(/## @tags\s*\n([\s\S]*?)(?=\n## @|\n## [^@]|$)/);
  const tagsRaw = tagsMatch ? tagsMatch[1].trim() : '';

  // Also check for JSDoc-style tags in a comment block (some docs use this format)
  let domains: string[] = [];
  let tags: string[] = [];
  let finalHow = how;
  let finalWhy = why;

  if (domainRaw) {
    domains = normalizeDomainList(domainRaw);
  } else {
    const jsdocDomain = content.match(/@domain\s+(.+)/);
    if (jsdocDomain) domains = normalizeDomainList(jsdocDomain[1]);
  }

  if (tagsRaw) {
    tags = normalizeTagList(tagsRaw);
  } else {
    const jsdocTags = content.match(/@tags\s+(.+)/);
    if (jsdocTags) tags = normalizeTagList(jsdocTags[1]);
  }

  if (!finalHow) {
    const jsdocHow = content.match(/@how\s+(.+)/);
    if (jsdocHow) finalHow = jsdocHow[1].replace(/\s*\*\s*$/, '').trim();
  }

  if (!finalWhy) {
    const jsdocWhy = content.match(/@why\s+(.+)/);
    if (jsdocWhy) finalWhy = jsdocWhy[1].replace(/\s*\*\s*$/, '').trim();
  }

  // Skip docs without any domain classification
  if (domains.length === 0) return null;

  // Enrich description with how/why (same as buildFullDescription for code)
  let fullDescription = description || name;
  if (finalHow) fullDescription += `. How: ${finalHow}`;
  if (finalWhy) fullDescription += `. Why: ${finalWhy}`;

  return {
    name,
    description: fullDescription,
    how: finalHow,
    why: finalWhy,
    domains,
    tags,
    body: content.slice(0, 1000),
    filePath,
    lineNumber: 1,
  };
}

// ─── File Walking ───────────────────────────────────────────────────────────

// Directories skipped by both walkDirectory and findReadmeFiles. Includes common
// non-source directories plus Python-specific ones (virtualenvs, bytecode caches,
// tool caches) now that .py files are walked too.
const WALK_EXCLUDE_DIRS = [
  'node_modules', 'dist', '.claude', 'cdk.out', 'build', '__snapshots__', '.next', '.turbo', 'coverage',
  '.venv', '__pycache__', '.pytest_cache', 'site-packages', '.mypy_cache', '.ruff_cache',
];

/**
 * @what Determines whether a Python file should be skipped as a test file during indexing
 * @how Matches the filename against `test_*.py` / `*_test.py`, OR checks whether the path relative
 *   to the directory being walked contains a `tests` path segment
 * @why Python test functions are low-value to index (docstring-exempt, not part of the public API
 *   surface) — mirrors the `.test.ts`/`.test.tsx` skip already applied to TypeScript
 *
 * @param {string} fileName The file's base name (e.g. `test_foo.py`)
 * @param {string} relFromScanRoot The file's path relative to the directory walkDirectory started from
 * @returns {boolean} True if the file should be skipped
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain code-index, python-support
 * @tags python, test-skip, indexer, walk
 */
function isPythonTestFile(fileName: string, relFromScanRoot: string): boolean {
  if (/^test_.*\.py$/.test(fileName) || /_test\.py$/.test(fileName)) return true;
  const segments = relFromScanRoot.split(path.sep);
  return segments.includes('tests');
}

function walkDirectory(dir: string, extensions: string[]): string[] {
  const files: string[] = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Skip common non-source directories
        if (WALK_EXCLUDE_DIRS.includes(entry.name)) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!extensions.includes(ext)) continue;
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
        if (ext === '.py' && isPythonTestFile(entry.name, path.relative(dir, fullPath))) continue;
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

function findReadmeFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (WALK_EXCLUDE_DIRS.includes(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'readme.md') {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

// ─── Python File Indexing ───────────────────────────────────────────────────

/**
 * @what Indexes a single Python file's module + unit definitions into the functions table
 * @how Invokes extractPythonFile() for the raw {module, units} payload (fail-open: null skips the
 *   file but still records its content hash). Wraps all inserts in a single transaction mirroring
 *   the TS code path: one row per module (declaration_type='module') plus one row per unit
 *   (function/method/class/dataclass), each tagged language='py'. A unit without its own Domain
 *   inherits the module's domains for both function_domains and its embedding input (denormalization).
 *   Tier rule: the module row is tier 1 if it has a Domain else tier 3; every unit row is tier 1 if it
 *   has a Domain else tier 2 (units are never tier 3). Embeddings are generated after the transaction
 *   commits, same as the TS path.
 * @why Makes buildPatternContext (siblings/similar/DRY/docs) work for Python by writing into the same
 *   functions/function_domains/function_tags/function_systemlayers/function_embeddings tables
 *   TypeScript uses, without duplicating the transaction/hash/embedding plumbing
 *
 * @param {Database.Database} db The database instance
 * @param {string} absPath Absolute path to the on-disk .py file
 * @param {string} relativePath Path relative to repoRoot, used as the file_path column (same normalization as the TS path)
 * @param {string} contentHash Precomputed hash of the file's on-disk content, stored via setFileHash regardless of extraction outcome
 * @param {IndexStats} stats Mutable stats accumulator, updated in place
 * @returns {Promise<void>}
 *
 * @sideeffects Spawns a Python subprocess (via extractPythonFile), writes rows to the functions/function_domains/function_tags/function_systemlayers/function_embeddings/file_hashes tables
 * @systemlayer Business Logic
 * @domain code-index, python-support
 * @tags python, indexer, extraction, tier-rule, denormalization
 */
async function indexPythonFile(
  db: Database.Database,
  absPath: string,
  relativePath: string,
  contentHash: string,
  stats: IndexStats
): Promise<void> {
  const extracted: PyExtracted | null = extractPythonFile(absPath);
  if (!extracted) {
    // Fail-open: guardian_py unavailable, subprocess error, syntax error, or parse failure.
    // Still record the file hash so incremental rebuilds don't retry it every run.
    setFileHash(db, relativePath, contentHash);
    return;
  }

  const { module, units } = extracted;

  type PendingEmbedding = {
    functionId: number;
    name: string;
    description: string;
    domains: string[];
    systemlayers: string[];
    tags: string[];
    body: string;
  };
  const pendingEmbeddings: PendingEmbedding[] = [];

  const insertFileData = db.transaction(() => {
    // Module row
    const moduleName = path.basename(relativePath, '.py');
    const moduleDescription = module.summary ?? '';
    const moduleSystemlayers = module.layer ? [module.layer] : [];
    const moduleId = insertFunction(db, {
      name: moduleName,
      description: moduleDescription,
      file_path: relativePath,
      line_number: 1,
      is_exported: true,
      declaration_type: 'module',
      side_effects: null,
      system_layer: module.layer,
      tier: module.domains.length ? 1 : 3,
      language: 'py',
    });
    insertDomains(db, moduleId, module.domains);
    insertTags(db, moduleId, module.tags);
    insertSystemLayers(db, moduleId, moduleSystemlayers);
    if (module.domains.length) stats.tier1Added++; else stats.tier3Added++;

    pendingEmbeddings.push({
      functionId: moduleId,
      name: moduleName,
      description: moduleDescription,
      domains: module.domains,
      systemlayers: moduleSystemlayers,
      tags: module.tags,
      body: module.docstring ?? '',
    });

    // Each function/method/class/dataclass unit
    for (const unit of units) {
      const description = unit.summary ?? unit.docstring ?? '';
      // Denormalization: a unit without its own Domain inherits the module's Domain so
      // search/embeddings still surface it under the module's classification.
      const domains = unit.domains.length ? unit.domains : module.domains;
      const systemlayers = unit.layer ? [unit.layer] : [];
      const tier = unit.domains.length ? 1 : 2; // never tier 3 for units

      const unitId = insertFunction(db, {
        name: unit.name,
        description,
        file_path: relativePath,
        line_number: unit.line,
        is_exported: unit.is_exported,
        declaration_type: unit.kind,
        side_effects: null,
        system_layer: unit.layer,
        tier,
        language: 'py',
      });

      insertDomains(db, unitId, domains);
      insertTags(db, unitId, unit.tags);
      insertSystemLayers(db, unitId, systemlayers);
      if (tier === 1) stats.tier1Added++; else stats.tier2Added++;

      pendingEmbeddings.push({
        functionId: unitId,
        name: unit.name,
        description,
        domains,
        systemlayers,
        tags: unit.tags,
        body: unit.docstring ?? '',
      });
    }

    setFileHash(db, relativePath, contentHash);
  });

  insertFileData();

  // Generate embeddings outside the transaction (async operation), same as the TS path
  for (const emb of pendingEmbeddings) {
    const result = await generateEmbeddings(db, emb);
    if (result.signatureGenerated || result.bodyGenerated) {
      stats.embeddingsGenerated++;
    }
  }
}

// ─── Index Building ─────────────────────────────────────────────────────────

export async function buildIndex(
  db: Database.Database,
  repoRoot: string,
  options: {
    incremental?: boolean;
    dirtyFiles?: string[];
  } = {}
): Promise<IndexStats> {
  const stats: IndexStats = {
    filesScanned: 0,
    tier1Added: 0,
    tier2Added: 0,
    tier3Added: 0,
    embeddingsGenerated: 0,
    filesSkipped: 0,
    commentsExtracted: 0,
    docSectionsCreated: 0,
  };

  const config = resolveConfig(repoRoot);
  const sourceDirs = config.sourceDirectories.map(d => path.join(repoRoot, d));
  const docsDirs = config.docsDirectories.map(d => path.join(repoRoot, d));

  // Collect files to process
  let codeFiles: string[];
  let docFiles: string[];

  if (options.incremental && options.dirtyFiles && options.dirtyFiles.length > 0) {
    // Incremental: only process dirty files
    codeFiles = options.dirtyFiles.filter(f => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.py'));
    docFiles = options.dirtyFiles.filter(f => f.endsWith('.md'));
  } else {
    // Full rebuild: scan everything
    codeFiles = sourceDirs.flatMap(dir => walkDirectory(dir, config.fileExtensions));
    docFiles = [
      ...docsDirs.flatMap(dir => walkDirectory(dir, ['.md'])),
      ...sourceDirs.flatMap(dir => findReadmeFiles(dir)),
    ];
  }

  // Process code files (Tier 1)
  for (const filePath of codeFiles) {
    const relativePath = path.relative(repoRoot, filePath);
    stats.filesScanned++;

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Check if file has changed (incremental optimization)
    const contentHash = hashContent(content);
    if (options.incremental && !options.dirtyFiles) {
      const existingHash = getFileHash(db, relativePath);
      if (existingHash === contentHash) {
        stats.filesSkipped++;
        continue;
      }
    }

    // Remove old entries for this file
    deleteFunctionsByFilePath(db, relativePath);

    if (filePath.endsWith('.py')) {
      await indexPythonFile(db, filePath, relativePath, contentHash, stats);
      continue;
    }

    // Parse JSDoc blocks using regex.exec() loop for precise position tracking
    const jsdocRegex = /\/\*\*[\s\S]*?@domain[\s\S]*?\*\//g;
    let jsdocMatch: RegExpExecArray | null;
    let foundAnyBlock = false;

    // Collect embedding inputs during sync inserts, generate after transaction
    const pendingEmbeddings: { functionId: number; parsed: ParsedJSDoc; description: string }[] = [];

    // Wrap all synchronous DB inserts for this file in a transaction
    const insertFileData = db.transaction(() => {
      while ((jsdocMatch = jsdocRegex.exec(content)) !== null) {
        foundAnyBlock = true;
        const block = jsdocMatch[0];
        const blockStartIndex = jsdocMatch.index;

        const parsed = parseJSDocBlock(block, content, blockStartIndex);
        if (!parsed) continue;

        const description = buildFullDescription(parsed);
        const funcId = insertFunction(db, {
          name: parsed.name,
          description,
          file_path: relativePath,
          line_number: parsed.lineNumber,
          is_exported: true,
          declaration_type: parsed.declarationType,
          side_effects: parsed.sideEffects,
          system_layer: parsed.systemlayers[0] || null,
          tier: 1,
        });

        insertDomains(db, funcId, parsed.domains);
        insertTags(db, funcId, parsed.tags);
        insertSystemLayers(db, funcId, parsed.systemlayers);
        stats.tier1Added++;

        // Extract inline comments using the precise blockEnd position from parsing
        const fullBody = extractFunctionBody(content, parsed.blockEnd!, 20000);
        const comments = extractCommentsFromBody(fullBody);
        if (comments.length > 0) {
          insertComments(db, funcId, comments.map(c => ({
            comment_text: c.text,
            comment_type: c.type,
            line_offset: c.lineOffset,
          })));
          stats.commentsExtracted += comments.length;
        }

        // Collect embedding work for after the transaction
        pendingEmbeddings.push({ functionId: funcId, parsed, description });
      }

      setFileHash(db, relativePath, contentHash);
    });

    insertFileData();

    if (!foundAnyBlock) continue;

    // Generate embeddings outside the transaction (async operation)
    for (const { functionId, parsed, description } of pendingEmbeddings) {
      const result = await generateEmbeddings(db, {
        functionId,
        name: parsed.name,
        description,
        domains: parsed.domains,
        systemlayers: parsed.systemlayers,
        tags: parsed.tags,
        body: parsed.body,
      });
      if (result.signatureGenerated || result.bodyGenerated) {
        stats.embeddingsGenerated++;
      }
    }
  }

  // Process doc files (Tier 3)
  for (const filePath of docFiles) {
    const relativePath = path.relative(repoRoot, filePath);
    stats.filesScanned++;

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const contentHash = hashContent(content);
    if (options.incremental && !options.dirtyFiles) {
      const existingHash = getFileHash(db, relativePath);
      if (existingHash === contentHash) {
        stats.filesSkipped++;
        continue;
      }
    }

    deleteFunctionsByFilePath(db, relativePath);

    const parsed = parseDocFile(content, relativePath);
    if (!parsed) {
      setFileHash(db, relativePath, contentHash);
      continue;
    }

    // Wrap all synchronous doc inserts in a transaction
    let docFuncId = 0;
    const insertDocData = db.transaction(() => {
      docFuncId = insertFunction(db, {
        name: parsed.name,
        description: parsed.description,
        file_path: relativePath,
        line_number: 1,
        is_exported: true,
        declaration_type: 'document',
        side_effects: null,
        system_layer: null,
        tier: 3,
      });

      insertDomains(db, docFuncId, parsed.domains);
      insertTags(db, docFuncId, parsed.tags);
      stats.tier3Added++;

      // Parse doc into heading-level sections for granular FTS5 search
      const docSections = parseDocSections(content);
      if (docSections.length > 0) {
        insertDocSections(db, docFuncId, docSections.map(s => ({
          heading: s.heading,
          heading_level: s.headingLevel,
          body: s.body,
          section_type: s.sectionType,
          section_order: s.order,
        })));
        stats.docSectionsCreated += docSections.length;
      }

      setFileHash(db, relativePath, contentHash);
    });

    insertDocData();

    // Generate embeddings outside the transaction (async operation)
    const result = await generateEmbeddings(db, {
      functionId: docFuncId,
      name: parsed.name,
      description: parsed.description,
      domains: parsed.domains,
      systemlayers: [],
      tags: parsed.tags,
      body: parsed.body,
    });
    if (result.signatureGenerated || result.bodyGenerated) {
      stats.embeddingsGenerated++;
    }
  }

  // Invalidate embedding cache after rebuild
  invalidateCache();

  // Update metadata
  setMetadata(db, 'last_rebuilt', new Date().toISOString());
  setMetadata(db, 'files_scanned', String(stats.filesScanned));

  // RISK-2: source-dir auto-detection is tsconfig-driven, so a Python package
  // outside the TypeScript roots is silently never walked (Tier B indexes zero
  // Python). On a full rebuild, if Python is enabled but nothing Python got
  // indexed while the repo clearly contains .py files, warn loudly with the fix.
  // Best-effort — never fail the build over a diagnostic.
  if (!options.incremental) {
    try {
      const cfg = resolveConfig(repoRoot);
      if (cfg.fileExtensions.includes('.py')) {
        const pyCount = (db.prepare("SELECT COUNT(*) AS c FROM functions WHERE language = 'py'").get() as { c: number }).c;
        if (pyCount === 0 && walkDirectory(repoRoot, ['.py']).length > 0) {
          console.error(
            `[guardian] WARNING: found Python files under ${repoRoot} but indexed 0 — they are outside ` +
            `the configured sourceDirectories (${cfg.sourceDirectories.join(', ')}). Add your Python ` +
            `package dir(s) to "sourceDirectories" in guardian.config.json so Python is indexed and validated.`
          );
        }
      }
    } catch {
      // diagnostic only — ignore
    }
  }

  return stats;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildFullDescription(parsed: ParsedJSDoc): string {
  let desc = parsed.description;
  if (parsed.how) desc += `. How: ${parsed.how}`;
  if (parsed.why) desc += `. Why: ${parsed.why}`;
  return desc;
}

// ─── Dirty Files ────────────────────────────────────────────────────────────

export function readDirtyFiles(dirtyFilePath: string): string[] {
  try {
    const content = fs.readFileSync(dirtyFilePath, 'utf-8');
    const files = content.split('\n').filter(Boolean);
    return [...new Set(files)]; // deduplicate
  } catch {
    return [];
  }
}

export function clearDirtyFiles(dirtyFilePath: string): void {
  try {
    fs.writeFileSync(dirtyFilePath, '');
  } catch {
    // Ignore
  }
}
