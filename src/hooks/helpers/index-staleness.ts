/**
 * @fileoverview Estimates how many indexed files have changed since the code index was last built,
 * so the search-hint hook can suggest a rebuild when results would be stale. Signal: the index db's
 * mtime approximates the last build time (a rebuild is its only writer), and `git log --since=<mtime>`
 * over the indexed file globs counts the distinct files touched by commits landed since then. This
 * catches merges/pulls (the "significant changes have landed" case); it does not see uncommitted
 * working-tree edits. Strictly best-effort and fail-safe: any error (not a git repo, no db, git
 * missing) yields 0, so the caller simply omits the rebuild suggestion.
 */
import { statSync } from 'fs';
import { execFileSync } from 'child_process';

// File globs the index covers. Git pathspecs (`*.ts`) match at any depth.
const INDEXED_GLOBS = ['*.ts', '*.tsx', '*.py', '*.md'];

/**
 * @what Counts indexed files changed by commits landed since the index was last built
 * @how Uses the index db's mtime as the last-build time and runs `git log --since=<mtime> --name-only` over the indexed globs, returning the count of distinct changed files; returns 0 on any failure
 * @why Lets the search-hint hook append a "run rebuild_index" suggestion only when enough has landed to make the index meaningfully stale, without opening the SQLite db
 *
 * @param {string} projectRoot Absolute path to the project (git) root
 * @param {string} databasePath Absolute path to the project's code-quality.db (its mtime ≈ last build)
 * @returns {number} Count of distinct indexed files changed since the last build (0 on any error)
 *
 * @sideeffects Reads the db file's mtime and spawns a short, timeout-bounded `git log`
 * @systemlayer Business Logic
 * @domain search-hint, index-staleness, git
 * @tags staleness, git-log, rebuild-hint, fail-safe
 */
export function countChangesSinceBuild(projectRoot: string, databasePath: string): number {
  try {
    const builtAt = statSync(databasePath).mtime.toISOString();
    const out = execFileSync(
      'git',
      ['-C', projectRoot, 'log', `--since=${builtAt}`, '--name-only', '--pretty=format:', '--', ...INDEXED_GLOBS],
      { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const files = new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
    return files.size;
  } catch {
    return 0;
  }
}
