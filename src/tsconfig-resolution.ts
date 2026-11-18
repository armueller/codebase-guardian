/**
 * Which tsconfig applies to a project, and which source directories it implies.
 *
 * Deliberately dependency-free (node built-ins only, no TypeScript compiler): `config.ts` uses this,
 * and the search-hint hook resolves config on every grep, so nothing heavy may load here. That is
 * why tsconfig files are read with the small comment-tolerant parser below instead of the
 * TypeScript reader.
 */
import fs from 'fs';
import path from 'path';
import { toPosixRelative } from './shared/util.js';

/**
 * @what Outcome of deciding which tsconfig applies to a project
 *
 * - `file`: an existing file inside the project, either the configured one or `<root>/tsconfig.json`
 * - `none`: nothing configured and no `<root>/tsconfig.json`
 * - `invalid`: configured but unusable; consumers must report the reason and never fall back to another file
 *
 * @domain config, call-graph
 * @tags tsconfig, guardian-config, discriminated-union, resolution
 */
export type TsconfigResolution =
  | { kind: 'file'; path: string }
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string };

/**
 * @what Reports whether a path exists and is a regular file
 * @how statSync inside try/catch; any error counts as "no"
 * @why existsSync is also true for folders, which let a folder be accepted as a tsconfig
 *
 * @param {string} target Absolute path
 * @returns {boolean} True for an existing regular file
 *
 * @sideeffects Reads the filesystem (stat)
 * @systemlayer Utility
 * @domain config
 * @tags filesystem, stat, file-check, fail-open
 */
export function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * @what Reports whether a path exists and is a folder
 * @how statSync inside try/catch; any error counts as "no"
 * @why A tsconfig `include` may name files (vite.config.ts, next-env.d.ts); only folders can be source directories
 *
 * @param {string} target Absolute path
 * @returns {boolean} True for an existing folder
 *
 * @sideeffects Reads the filesystem (stat)
 * @systemlayer Utility
 * @domain config
 * @tags filesystem, stat, directory-check, fail-open
 */
export function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @what Finds where a JSON string literal ends
 * @how Starting after the opening quote, steps one character at a time, or two for a backslash escape, until the closing quote
 * @why Both passes of parseJsonc must skip string contents the same way, so that comment markers, commas and brackets inside a string are never treated as syntax
 *
 * @param {string} src The text being scanned
 * @param {number} start Index of the opening double quote
 * @returns {number} Index just past the closing quote (or the end of the text when the string is unterminated)
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain config
 * @tags jsonc, string-literal, scanner, pure
 */
function stringLiteralEnd(src: string, start: number): number {
  let end = start + 1;
  while (end < src.length && src[end] !== '"') {
    end += src[end] === '\\' ? 2 : 1;
  }
  return Math.min(end + 1, src.length);
}

/**
 * @what Parses JSON that may contain comments and trailing commas, as tsconfig files do
 * @how Strips a leading byte-order mark, then makes two passes that copy string literals untouched (stringLiteralEnd): the first drops line and block comments, the second drops a comma whose next significant character is a closing bracket or brace. The result goes to JSON.parse.
 * @why `tsc --init` writes a commented tsconfig, and JSON.parse rejected it, so the `include` list was silently lost. The TypeScript reader would handle it but must not be loaded here (see the module note).
 *
 * @param {string} text JSON-with-comments source
 * @returns {unknown} The parsed value
 * @throws {SyntaxError} When the text is not valid JSON after comments and trailing commas are removed
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain config
 * @tags jsonc, tsconfig, parser, comments, trailing-commas, pure
 */
export function parseJsonc(text: string): unknown {
  const source = text.replace(/^﻿/, '');

  let withoutComments = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '"') {
      const end = stringLiteralEnd(source, i);
      withoutComments += source.slice(i, end);
      i = end;
    } else if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 2;
    } else {
      withoutComments += ch;
      i++;
    }
  }

  // Comments are gone, so a trailing comma is a comma followed only by whitespace and a closer.
  const closerAhead = /\s*[}\]]/y;
  let cleaned = '';
  let j = 0;
  while (j < withoutComments.length) {
    const ch = withoutComments[j];
    if (ch === '"') {
      const end = stringLiteralEnd(withoutComments, j);
      cleaned += withoutComments.slice(j, end);
      j = end;
      continue;
    }
    closerAhead.lastIndex = j + 1;
    if (ch !== ',' || !closerAhead.test(withoutComments)) cleaned += ch;
    j++;
  }

  return JSON.parse(cleaned);
}

/**
 * @what Decides which tsconfig applies to a project: the configured one, the root one, none, or invalid
 * @how A `tsconfig` value in guardian.config.json (undefined and null both mean "not set") must be a non-empty string; it is trimmed, resolved against the project root, and must name a regular file inside the project root. Anything else configured is `invalid` with a reason that says which rule failed. With nothing configured, `<root>/tsconfig.json` is used when it is a file, else `none`.
 * @why The TypeScript app may live in a sub-folder with no tsconfig at the git root. A configured path that is wrong must be reported, never silently replaced by another file. A path outside the root is rejected because source-directory detection is anchored at the tsconfig's folder and would otherwise index folders outside the project.
 *
 * @param {string} projectRoot Absolute project root
 * @param {unknown} configured The raw `tsconfig` value from guardian.config.json (undefined when absent)
 * @returns {TsconfigResolution} `file` with an absolute path, `none`, or `invalid` with a reason
 *
 * @sideeffects Reads the filesystem (stat only)
 * @systemlayer Configuration
 * @domain config, call-graph
 * @tags tsconfig, guardian-config, resolution, monorepo, validation
 */
export function resolveTsconfig(projectRoot: string, configured: unknown): TsconfigResolution {
  if (configured !== undefined && configured !== null) {
    if (typeof configured !== 'string' || configured.trim() === '') {
      return {
        kind: 'invalid',
        reason: `"tsconfig" in guardian.config.json must be a non-empty string (got ${JSON.stringify(configured)})`,
      };
    }

    const shown = configured.trim();
    const configuredPath = path.resolve(projectRoot, shown);
    const relative = path.relative(projectRoot, configuredPath);
    if (relative === '') {
      return { kind: 'invalid', reason: `tsconfig "${shown}" from guardian.config.json is the project root, not a file` };
    }
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { kind: 'invalid', reason: `tsconfig "${shown}" from guardian.config.json is outside the project root` };
    }
    if (isDirectory(configuredPath)) {
      return { kind: 'invalid', reason: `tsconfig "${shown}" from guardian.config.json is a folder, not a file` };
    }
    if (!isFile(configuredPath)) {
      return { kind: 'invalid', reason: `tsconfig "${shown}" from guardian.config.json does not exist` };
    }
    return { kind: 'file', path: configuredPath };
  }

  const rootPath = path.join(projectRoot, 'tsconfig.json');
  if (isFile(rootPath)) return { kind: 'file', path: rootPath };
  return { kind: 'none' };
}

/**
 * @what Lists the folder names a tsconfig's own `include` patterns start with
 * @how Reads the file with parseJsonc, takes the first path segment of each string pattern (after a leading "./"), and drops wildcards, dot-names and repeats. Returns an empty list when the file cannot be read or has no `include`. An `include` inherited through `extends` is not followed.
 * @why Shared first step of source-directory detection; whether a name is really a folder is decided by the caller, because `include` also lists plain files
 *
 * @param {string} tsconfigFile Absolute path of the tsconfig
 * @returns {string[]} Candidate names, in the order they appear
 *
 * @sideeffects Reads the tsconfig file
 * @systemlayer Configuration
 * @domain config, code-index
 * @tags tsconfig, include, source-directories, fail-open
 */
function includeRoots(tsconfigFile: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseJsonc(fs.readFileSync(tsconfigFile, 'utf-8'));
  } catch {
    return [];
  }

  const include = (parsed as { include?: unknown } | null)?.include;
  if (!Array.isArray(include)) return [];

  const roots: string[] = [];
  for (const pattern of include) {
    if (typeof pattern !== 'string') continue;
    const first = pattern.replace(/^(\.\/)+/, '').split('/')[0];
    if (first === '' || first.startsWith('.') || first.includes('*')) continue;
    if (!roots.includes(first)) roots.push(first);
  }
  return roots;
}

/**
 * @what Joins a folder name onto a root-relative base folder
 * @how Returns `base/dir`, or just `dir` when the base is the project root (the empty string)
 * @why Detected source directories are written relative to the project root, and the tsconfig's folder may or may not be the root
 *
 * @param {string} base Root-relative folder of the tsconfig ('' for the project root)
 * @param {string} dir Folder name inside the base
 * @returns {string} The '/'-separated root-relative path
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain config
 * @tags relative-path, source-directories, join, pure
 */
function joinUnderBase(base: string, dir: string): string {
  return base ? `${base}/${dir}` : dir;
}

/**
 * @what Auto-detects the source directories of a project, relative to the project root
 * @how Takes the names from the tsconfig's `include` (includeRoots), placed under that tsconfig's folder, and keeps those that are folders. If that yields nothing, tries src/app/lib/packages under the same folder. If that also yields nothing, returns the tsconfig's folder itself, or '.' when the tsconfig is at the root or absent.
 * @why Only runs when guardian.config.json does not set sourceDirectories. Following the resolved tsconfig keeps one notion of "the project's tsconfig" shared with the call graph. Only folders are kept: an `include` entry such as vite.config.ts or next-env.d.ts is a file, and returning it made the rebuild report a missing directory that nobody configured, or index nothing at all.
 *
 * @param {string} projectRoot Absolute project root
 * @param {string | null} tsconfigFile Absolute path of the resolved tsconfig (inside the project root), or null when there is none
 * @returns {string[]} Source directories relative to the project root ('/'-separated)
 *
 * @sideeffects Reads the tsconfig file and stats candidate folders
 * @systemlayer Configuration
 * @domain config, code-index
 * @tags tsconfig, source-directories, auto-detection, monorepo
 */
export function detectSourceDirectories(projectRoot: string, tsconfigFile: string | null): string[] {
  const base = tsconfigFile ? toPosixRelative(projectRoot, path.dirname(tsconfigFile)) : '';

  const candidateLists = [
    tsconfigFile ? includeRoots(tsconfigFile) : [],
    ['src', 'app', 'lib', 'packages'],
  ];
  for (const names of candidateLists) {
    const folders = names
      .map(name => joinUnderBase(base, name))
      .filter(relDir => isDirectory(path.join(projectRoot, relDir)));
    if (folders.length > 0) return folders;
  }

  return [base || '.'];
}
