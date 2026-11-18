/**
 * The single answer to "which files are in the index".
 *
 * Both rebuild phases read this list: the indexer (Tier 1 / Tier 3 rows) and the TypeScript
 * call graph (Tier 2 rows and call edges). They used to enumerate files separately, with
 * different exclusions, so the call graph loaded node_modules and build output that the
 * indexer skipped. A rebuild computes the list once and hands it to both phases.
 */
import fs from 'fs';
import path from 'path';
import type { GuardianConfig } from '../config.js';
import { isPythonTestFile } from '../shared/py-paths.js';
import { toPosixRelative } from '../shared/util.js';

/**
 * @what The files a full index rebuild reads, as absolute paths, plus the folders it could not read
 * @domain code-index, file-walk
 * @tags file-list, source-files, doc-files, index-rebuild
 */
export interface IndexFileSet {
  /** Source files with a configured extension, minus test files. De-duplicated and sorted. */
  codeFiles: string[];
  /** Markdown under the docs directories plus every README.md under the source directories. De-duplicated and sorted. */
  docFiles: string[];
  /** Folders (root-relative) that could not be listed, for example for lack of permission. De-duplicated and sorted. */
  unreadableDirectories: string[];
}

/**
 * @what Where a walk is anchored, which folders it leaves out, and where it records folders it could not read
 * @domain code-index, file-walk
 * @tags exclude-directories, project-root, walk-scope
 */
export interface WalkScope {
  /** Absolute project root; path-style exclude entries are relative to it */
  projectRoot: string;
  /** The project's excludeDirectories */
  exclude: string[];
  /** When given, root-relative paths of folders that could not be listed are pushed here */
  unreadable?: string[];
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
 * @what Reports whether a file sits under an excluded folder at any level
 * @how Walks the file's ancestor folders from the project root downwards and applies isExcludedDir to each; a file outside the project root is never excluded by this rule
 * @why The full walk never enters an excluded folder, but the incremental path is handed file paths directly and must reach the same answer the walk would
 *
 * @param {string} absFile Absolute file path
 * @param {WalkScope} scope Project root and exclude list (the unreadable accumulator is not used)
 * @returns {boolean} True when the walk would not have reached this file
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain code-index, file-walk
 * @tags exclude-directories, incremental, path-matching, pure
 */
export function isExcludedPath(absFile: string, scope: WalkScope): boolean {
  const segments = toPosixRelative(scope.projectRoot, path.dirname(absFile)).split('/');
  if (segments[0] === '..' || segments[0] === '') return false;
  let relDir = '';
  for (const segment of segments) {
    relDir = relDir ? `${relDir}/${segment}` : segment;
    if (isExcludedDir(relDir, scope.exclude)) return true;
  }
  return false;
}

/**
 * @what Visits every file under a directory, skipping excluded folders
 * @how Depth-first readdir. A sub-folder is skipped when isExcludedDir matches its path relative to the project root. The starting directory itself is always walked. A folder that cannot be listed is skipped and, when the scope carries an `unreadable` list, recorded there. A path that does not exist or is a file is skipped without being recorded: for a configured directory that case is reported by configuredDirectoryProblems.
 * @why Shared traversal for the code/doc walk and the README walk, so the exclusion rule lives in one place. Unreadable folders are recorded because this walk decides the whole index: a permissions error must not shrink it unnoticed.
 *
 * @param {string} dir Absolute directory to walk
 * @param {WalkScope} scope Project root, exclude list and the optional unreadable-folder accumulator
 * @param {(fullPath: string, name: string) => void} onFile Called for each regular file
 * @returns {void}
 *
 * @sideeffects Reads the filesystem; pushes onto scope.unreadable when given
 * @systemlayer Data Layer
 * @domain code-index, file-walk
 * @tags filesystem, traversal, exclude-directories, fail-open
 */
function visitFiles(dir: string, scope: WalkScope, onFile: (fullPath: string, name: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      scope.unreadable?.push(toPosixRelative(scope.projectRoot, dir));
    }
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isExcludedDir(toPosixRelative(scope.projectRoot, fullPath), scope.exclude)) continue;
      visitFiles(fullPath, scope, onFile);
    } else if (entry.isFile()) {
      onFile(fullPath, entry.name);
    }
  }
}

/**
 * @what Reports whether a file, given by its walk-relative path, is one the index reads for the given extensions
 * @how True when the extension is listed and the file is not a test file: *.test.ts / *.test.tsx by name, Python test files by the path (its folder names count, for example a tests/ segment)
 * @why One rule for the full walk and the incremental path, so auto-sync cannot index a file a full rebuild would skip
 *
 * @param {string} relPath The file's path relative to the directory being walked
 * @param {string[]} extensions Extensions to keep, with the dot
 * @returns {boolean} True when the file belongs in the index
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain code-index, file-walk
 * @tags file-extensions, test-files, source-files, pure
 */
export function isIndexableFile(relPath: string, extensions: string[]): boolean {
  const name = path.basename(relPath);
  const ext = path.extname(name);
  if (!extensions.includes(ext)) return false;
  if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) return false;
  if (ext === '.py' && isPythonTestFile(relPath)) return false;
  return true;
}

/**
 * @what Lists the files under a directory that have one of the given extensions, minus test files
 * @how Walks with visitFiles and keeps the files isIndexableFile accepts (judged on the path relative to the walked directory)
 * @why Test files are not indexed; excluded folders are never entered
 *
 * @param {string} dir Absolute directory to walk
 * @param {string[]} extensions Extensions to keep, with the dot (e.g. ['.ts', '.tsx', '.py'])
 * @param {WalkScope} scope Project root, exclude list and the optional unreadable-folder accumulator
 * @returns {string[]} Absolute file paths, in walk order
 *
 * @sideeffects Reads the filesystem; pushes onto scope.unreadable when given
 * @systemlayer Data Layer
 * @domain code-index, file-walk
 * @tags filesystem, source-files, test-files, exclude-directories
 */
export function walkDirectory(dir: string, extensions: string[], scope: WalkScope): string[] {
  const files: string[] = [];
  visitFiles(dir, scope, (fullPath) => {
    if (isIndexableFile(path.relative(dir, fullPath), extensions)) files.push(fullPath);
  });
  return files;
}

/**
 * @what Lists every README.md under a directory
 * @how Walks with visitFiles and keeps files named readme.md in any letter case
 * @why READMEs next to source are indexed as docs even when they are outside the docs directories
 *
 * @param {string} dir Absolute directory to walk
 * @param {WalkScope} scope Project root, exclude list and the optional unreadable-folder accumulator
 * @returns {string[]} Absolute README paths, in walk order
 *
 * @sideeffects Reads the filesystem; pushes onto scope.unreadable when given
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
 * @what Returns a path relative to a base directory when the path is inside it
 * @how toPosixRelative, rejected when the result is empty, absolute, or climbs out with ".."
 * @why classifyIndexFile needs "is this file under that source or docs directory, and where" as one answer
 *
 * @param {string} baseDir Absolute directory
 * @param {string} absFile Absolute file path
 * @returns {string | null} The '/'-separated path inside baseDir, or null when the file is not inside it
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain code-index, file-walk
 * @tags relative-path, containment, pure
 */
function pathInside(baseDir: string, absFile: string): string | null {
  const rel = toPosixRelative(baseDir, absFile);
  if (rel === '' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return null;
  return rel;
}

/**
 * @what Says whether a single file belongs in the index, and as what, by the rules a full walk applies
 * @how A file under an excluded folder is out. It is `code` when it sits under a source directory and isIndexableFile accepts its path relative to that directory (the same path the walk judges). It is `doc` when it is markdown under a docs directory, or a README.md under a source directory. Anything else is null.
 * @why The incremental path is handed file paths directly instead of walking. Without one shared verdict it indexed files a full rebuild skips: code outside the source directories, any markdown at all, and files in excluded folders.
 *
 * @param {string} absFile Absolute file path
 * @param {GuardianConfig} config Resolved project config
 * @returns {'code' | 'doc' | null} How the index treats the file, or null when it is not indexed
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain code-index, file-walk
 * @tags incremental, file-list, source-directories, docs-directories, exclude-directories, pure
 */
export function classifyIndexFile(absFile: string, config: GuardianConfig): 'code' | 'doc' | null {
  if (isExcludedPath(absFile, { projectRoot: config.projectRoot, exclude: config.excludeDirectories })) return null;

  const name = path.basename(absFile);
  const insideSource = config.sourceDirectories
    .map(dir => pathInside(path.join(config.projectRoot, dir), absFile))
    .filter((rel): rel is string => rel !== null);

  if (insideSource.some(rel => isIndexableFile(rel, config.fileExtensions))) return 'code';
  if (insideSource.length > 0 && name.toLowerCase() === 'readme.md') return 'doc';

  const insideDocs = config.docsDirectories.some(dir => pathInside(path.join(config.projectRoot, dir), absFile) !== null);
  if (insideDocs && isIndexableFile(name, ['.md'])) return 'doc';

  return null;
}

/**
 * @what Says what is wrong with each configured source or docs directory that cannot be used
 * @how Stats each entry of sourceDirectories, then docsDirectories, against the project root. A missing entry, an entry that is a file, and an entry that cannot be read each get their own sentence; a usable folder gets none.
 * @why A mistyped directory is walked as empty and silently contributes nothing. The rebuild report uses these sentences to say so. The three cases are told apart because "does not exist" sends the reader to the wrong place when the real cause is a permissions error.
 *
 * @param {GuardianConfig} config Resolved project config
 * @returns {string[]} One sentence per unusable directory, source directories first; empty when all are usable
 *
 * @sideeffects Reads the filesystem (stat only)
 * @systemlayer Data Layer
 * @domain code-index, file-walk
 * @tags source-directories, docs-directories, validation, index-rebuild
 */
export function configuredDirectoryProblems(config: GuardianConfig): string[] {
  const problems: string[] = [];
  for (const dir of [...config.sourceDirectories, ...config.docsDirectories]) {
    try {
      if (!fs.statSync(path.join(config.projectRoot, dir)).isDirectory()) {
        problems.push(`configured directory is a file, not a folder: ${dir}`);
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      problems.push(code === 'ENOENT'
        ? `configured directory does not exist: ${dir}`
        : `configured directory could not be read (${code ?? 'unknown error'}): ${dir}`);
    }
  }
  return problems;
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
 * @how Code files are the configured extensions under each source directory; doc files are markdown under each docs directory plus READMEs under the source directories. Folders that could not be listed during those walks are collected too. All three lists go through sortedUnique.
 * @why One list for the indexer and the call graph keeps the two rebuild phases looking at the same files, with excludeDirectories applied to both
 *
 * @param {GuardianConfig} config Resolved project config
 * @returns {IndexFileSet} Absolute code and doc file paths, and the root-relative folders that could not be read
 *
 * @sideeffects Reads the filesystem
 * @systemlayer Data Layer
 * @domain code-index, file-walk
 * @tags file-list, source-directories, docs-directories, exclude-directories, index-rebuild
 */
export function listIndexFiles(config: GuardianConfig): IndexFileSet {
  const unreadable: string[] = [];
  const scope: WalkScope = { projectRoot: config.projectRoot, exclude: config.excludeDirectories, unreadable };
  const sourceDirs = config.sourceDirectories.map(d => path.join(config.projectRoot, d));
  const docsDirs = config.docsDirectories.map(d => path.join(config.projectRoot, d));

  const codeFiles = sortedUnique(sourceDirs.flatMap(dir => walkDirectory(dir, config.fileExtensions, scope)));
  const docFiles = sortedUnique([
    ...docsDirs.flatMap(dir => walkDirectory(dir, ['.md'], scope)),
    ...sourceDirs.flatMap(dir => findReadmeFiles(dir, scope)),
  ]);

  return { codeFiles, docFiles, unreadableDirectories: sortedUnique(unreadable) };
}
