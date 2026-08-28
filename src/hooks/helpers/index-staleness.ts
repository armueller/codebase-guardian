/**
 * @fileoverview Estimates how many indexed files have changed since the code index was last built,
 * so the search-hint hook can suggest a rebuild when results would be stale. Signal: the index db's
 * mtime approximates the last build time (a rebuild is its only writer), and `git log --since=<mtime>`
 * over pathspecs derived from the project's indexing config (source dirs × configured extensions, plus
 * doc dirs × .md) counts the distinct files touched by commits landed since then. This catches
 * merges/pulls (the "significant changes have landed" case); it does not see uncommitted working-tree
 * edits. Runs ONLY on the rare nudge and is strictly best-effort and fail-safe: a tight time budget
 * bounds the block, and any error/timeout (not a git repo, no db, git missing/slow) yields 0, so the
 * caller simply omits the rebuild suggestion.
 */
import { statSync } from 'fs';
import { execFileSync } from 'child_process';

// Git log is on the (rare) nudge path but still blocks the requested tool from starting, so cap it
// hard. A slower repo simply produces no staleness hint rather than delaying the search.
const GIT_TIMEOUT_MS = 500;

/**
 * @what The subset of indexing config used to scope the staleness count to actually-indexed files
 * @domain search-hint, index-staleness
 * @tags staleness-scope, indexing-config, schema
 */
export interface StalenessScope {
  /** Source file extensions the index covers (e.g. ['.ts', '.tsx', '.py']). */
  extensions: string[];
  /** Directories the index scans for source files (e.g. ['src']). */
  sourceDirectories: string[];
  /** Directories the index scans for docs (matched against .md). */
  docsDirectories: string[];
}

/**
 * @what Builds git pathspecs matching the project's indexed files
 * @how Pairs each source directory with each configured extension, and each doc directory with .md; a '.'/'' directory yields a repo-wide glob, and an empty set falls back to extensions repo-wide
 * @why The staleness count must reflect what is actually indexed (configured extensions within source/doc dirs) rather than a hard-coded list that both over- and under-counts
 *
 * @param {StalenessScope} scope The indexing extensions and directories
 * @returns {string[]} Git pathspecs (git treats `*` as matching across '/', so `src/*.ts` covers any depth)
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain search-hint, index-staleness
 * @tags pathspec, indexing-config, git-glob
 */
function buildPathspecs(scope: StalenessScope): string[] {
  const specs: string[] = [];
  const spec = (dir: string, ext: string): string => {
    const d = dir === '.' || dir === '' ? '' : `${dir.replace(/\/+$/, '')}/`;
    return `${d}*${ext}`;
  };
  for (const dir of scope.sourceDirectories) for (const ext of scope.extensions) specs.push(spec(dir, ext));
  for (const dir of scope.docsDirectories) specs.push(spec(dir, '.md'));
  if (specs.length === 0) for (const ext of scope.extensions) specs.push(`*${ext}`);
  return specs;
}

/**
 * @what Counts indexed files changed by commits landed since the index was last built
 * @how Uses the index db's mtime as the last-build time and runs a time-bounded `git log --since=<mtime> --name-only` over pathspecs derived from the indexing config, returning the count of distinct changed files; returns 0 on any failure or timeout
 * @why Lets the search-hint hook append a "run rebuild_index" suggestion only when enough has landed to make the index meaningfully stale, without opening the SQLite db and without risk of a long block
 *
 * @param {string} projectRoot Absolute path to the project (git) root
 * @param {string} databasePath Absolute path to the project's code-quality.db (its mtime ≈ last build)
 * @param {StalenessScope} scope The indexing extensions/directories used to scope the count
 * @returns {number} Count of distinct indexed files changed since the last build (0 on any error/timeout)
 *
 * @sideeffects Reads the db file's mtime and spawns a short, timeout-bounded `git log`
 * @systemlayer Business Logic
 * @domain search-hint, index-staleness, git
 * @tags staleness, git-log, rebuild-hint, fail-safe
 */
export function countChangesSinceBuild(projectRoot: string, databasePath: string, scope: StalenessScope): number {
  try {
    const builtAt = statSync(databasePath).mtime.toISOString();
    const out = execFileSync(
      'git',
      ['-C', projectRoot, 'log', `--since=${builtAt}`, '--name-only', '--pretty=format:', '--', ...buildPathspecs(scope)],
      { encoding: 'utf-8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const files = new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
    return files.size;
  } catch {
    return 0;
  }
}
