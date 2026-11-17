/**
 * The single answer to "which files are in the index".
 *
 * Both rebuild phases read this list: the indexer (Tier 1 / Tier 3 rows) and the TypeScript
 * call graph (Tier 2 rows and call edges). They used to enumerate files separately, with
 * different exclusions, so the call graph loaded node_modules and build output that the
 * indexer skipped.
 */
import fs from 'fs';
import path from 'path';
import type { GuardianConfig } from '../config.js';
import { isPythonTestFile } from '../shared/py-paths.js';

/**
 * @what The files a full index rebuild reads, as absolute paths
 * @domain code-index, file-walk
 * @tags file-list, source-files, doc-files, rebuild
 */
export interface IndexFileSet {
  /** Source files with a configured extension, minus test files. De-duplicated and sorted. */
  codeFiles: string[];
  /** Markdown under the docs directories plus every README.md under the source directories. De-duplicated and sorted. */
  docFiles: string[];
}

/**
 * @what Where a walk is anchored and which folders it leaves out
 * @domain code-index, file-walk
 * @tags exclude-directories, project-root, walk-scope
 */
export interface WalkScope {
  /** Absolute project root; path-style exclude entries are relative to it */
  projectRoot: string;
  /** The project's excludeDirectories */
  exclude: string[];
}

/**
 * @what Reports whether a folder is left out of the index by the project's excludeDirectories
 * @how Normalises each entry (backslashes to slashes, trailing slashes dropped), then decides its kind before stripping any leading "./" or "/": an entry that still contains a slash is a path and matches only when it equals relDir exactly; an entry with no slash is a bare name and matches a folder of that name at any depth, compared against the last segment of relDir. So "./data" and "/data" mean the top-level data folder only, while "data" means every folder named data.
 * @why A bare name covers folders that recur at any depth (node_modules, __pycache__); a path names one specific folder. Both forms appear in real configs, and before this neither was honoured. Deciding the kind after stripping the prefix would turn "./data" into a bare name and silently drop nested folders from the index.
 *
 * @param {string} relDir Folder path relative to the project root, '/'-separated
 * @param {string[]} exclude The project's excludeDirectories
 * @returns {boolean} True when the folder should not be walked
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain code-index, file-walk
 * @tags exclude-directories, path-matching, guardian-config, pure
 */
export function isExcludedDir(relDir: string, exclude: string[]): boolean {
  const name = relDir.split('/').pop() ?? '';
  for (const raw of exclude) {
    const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    const isPath = normalized.includes('/');
    const entry = normalized.replace(/^(\.?\/)+/, '');
    if (entry === '' || entry === '.') continue;
    if (isPath) {
      if (entry === relDir) return true;
    } else if (entry === name) {
      return true;
    }
  }
  return false;
}

/**
 * @what Visits every file under a directory, skipping excluded folders
 * @how Depth-first readdir. A sub-folder is skipped when isExcludedDir matches its path relative to the project root. The starting directory itself is always walked. Unreadable directories are skipped silently.
 * @why Shared traversal for the code/doc walk and the README walk, so the exclusion rule lives in one place
 *
 * @param {string} dir Absolute directory to walk
 * @param {WalkScope} scope Project root and exclude list
 * @param {(fullPath: string, name: string) => void} onFile Called for each regular file
 * @returns {void}
 *
 * @sideeffects Reads the filesystem
 * @systemlayer Data Layer
 * @domain code-index, file-walk
 * @tags filesystem, traversal, exclude-directories, fail-open
 */
function visitFiles(dir: string, scope: WalkScope, onFile: (fullPath: string, name: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const relDir = path.relative(scope.projectRoot, fullPath).split(path.sep).join('/');
      if (isExcludedDir(relDir, scope.exclude)) continue;
      visitFiles(fullPath, scope, onFile);
    } else if (entry.isFile()) {
      onFile(fullPath, entry.name);
    }
  }
}

/**
 * @what Lists the files under a directory that have one of the given extensions, minus test files
 * @how Walks with visitFiles and keeps files whose extension is listed, dropping *.test.ts / *.test.tsx and Python test files (judged on the path relative to the walked directory)
 * @why Test files are not indexed; excluded folders are never entered
 *
 * @param {string} dir Absolute directory to walk
 * @param {string[]} extensions Extensions to keep, with the dot (e.g. ['.ts', '.tsx', '.py'])
 * @param {WalkScope} scope Project root and exclude list
 * @returns {string[]} Absolute file paths, in walk order
 *
 * @sideeffects Reads the filesystem
 * @systemlayer Data Layer
 * @domain code-index, file-walk
 * @tags filesystem, source-files, test-files, exclude-directories
 */
export function walkDirectory(dir: string, extensions: string[], scope: WalkScope): string[] {
  const files: string[] = [];
  visitFiles(dir, scope, (fullPath, name) => {
    const ext = path.extname(name);
    if (!extensions.includes(ext)) return;
    if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) return;
    if (ext === '.py' && isPythonTestFile(path.relative(dir, fullPath))) return;
    files.push(fullPath);
  });
  return files;
}

/**
 * @what Lists every README.md under a directory
 * @how Walks with visitFiles and keeps files named readme.md in any letter case
 * @why READMEs next to source are indexed as docs even when they are outside the docs directories
 *
 * @param {string} dir Absolute directory to walk
 * @param {WalkScope} scope Project root and exclude list
 * @returns {string[]} Absolute README paths, in walk order
 *
 * @sideeffects Reads the filesystem
 * @systemlayer Data Layer
 * @domain code-index, file-walk
 * @tags filesystem, readme, doc-files, exclude-directories
 */
function findReadmeFiles(dir: string, scope: WalkScope): string[] {
  const files: string[] = [];
  visitFiles(dir, scope, (fullPath, name) => {
    if (name.toLowerCase() === 'readme.md') files.push(fullPath);
  });
  return files;
}

/**
 * @what Lists the configured source and docs directories that are not directories on disk
 * @how Checks each entry of sourceDirectories, then docsDirectories, against the project root with statSync; an entry that is missing or is a file is returned as written in the config
 * @why A mistyped directory is walked as empty and silently contributes nothing. The rebuild report uses this list to say so, instead of reading complete with part of the project left out.
 *
 * @param {GuardianConfig} config Resolved project config
 * @returns {string[]} The configured entries that do not exist as directories, source directories first
 *
 * @sideeffects Reads the filesystem (stat only)
 * @systemlayer Data Layer
 * @domain code-index, file-walk
 * @tags source-directories, docs-directories, validation, rebuild-report
 */
export function missingConfiguredDirectories(config: GuardianConfig): string[] {
  return [...config.sourceDirectories, ...config.docsDirectories].filter(dir => {
    try {
      return !fs.statSync(path.join(config.projectRoot, dir)).isDirectory();
    } catch {
      return true;
    }
  });
}

/**
 * @what Returns the distinct values of a list of paths, sorted
 * @how Passes the list through a Set and sorts the result with the default string comparison
 * @why Overlapping source directories would otherwise list a file twice, and readdir order differs between filesystems; a sorted list builds the index in the same order on every machine
 *
 * @param {string[]} files Paths, possibly repeated and in any order
 * @returns {string[]} Each path once, sorted
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain code-index, file-walk
 * @tags dedupe, sort, deterministic, pure
 */
function sortedUnique(files: string[]): string[] {
  return [...new Set(files)].sort();
}

/**
 * @what Lists the files a full index rebuild reads for a project
 * @how Code files are the configured extensions under each source directory; doc files are markdown under each docs directory plus READMEs under the source directories. Both lists go through sortedUnique.
 * @why One list for the indexer and the call graph keeps the two rebuild phases looking at the same files, with excludeDirectories applied to both
 *
 * @param {GuardianConfig} config Resolved project config
 * @returns {IndexFileSet} Absolute code and doc file paths
 *
 * @sideeffects Reads the filesystem
 * @systemlayer Data Layer
 * @domain code-index, file-walk
 * @tags file-list, source-directories, docs-directories, exclude-directories, rebuild
 */
export function listIndexFiles(config: GuardianConfig): IndexFileSet {
  const scope: WalkScope = { projectRoot: config.projectRoot, exclude: config.excludeDirectories };
  const sourceDirs = config.sourceDirectories.map(d => path.join(config.projectRoot, d));
  const docsDirs = config.docsDirectories.map(d => path.join(config.projectRoot, d));

  return {
    codeFiles: sortedUnique(sourceDirs.flatMap(dir => walkDirectory(dir, config.fileExtensions, scope))),
    docFiles: sortedUnique([
      ...docsDirs.flatMap(dir => walkDirectory(dir, ['.md'], scope)),
      ...sourceDirs.flatMap(dir => findReadmeFiles(dir, scope)),
    ]),
  };
}
