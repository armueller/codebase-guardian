/**
 * @what Shared Python path predicates used by both the indexer (mcp-server) and the hook
 * @how Pure string checks — no filesystem, no runtime-context dependency — so they are safe to
 *   share across the CJS(hook)/ESM(mcp-server) boundary (unlike context-dependent utilities, which
 *   the project intentionally duplicates). The caller decides WHICH path to pass; the predicate only
 *   decides whether that path looks like a Python test file.
 * @why The indexer (skip test files during indexing) and the hook (exempt test files from docstring
 *   requirements) had independently-defined, already-divergent "is a Python test file" checks — a
 *   file could be docstring-exempt in the hook yet indexed (or vice versa). One predicate prevents drift.
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain python-support, path-classification
 * @tags python, test-file, predicate, shared, cjs-esm-safe
 */

/**
 * @what Whether a path looks like a Python test file
 * @how True if the basename matches `test_*.py` or `*_test.py`, or any path segment is `test`/`tests`
 * @why Test files are exempt from docstring requirements (hook) and skipped during indexing
 *
 * @param {string} filePath A file path. The indexer passes a path relative to its scan root (so the
 *   repo's own top-level `tests/` doesn't false-positive every file); the hook passes the edited
 *   file's path. The predicate itself is agnostic to which.
 * @returns {boolean} True if it looks like a Python test file
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain python-support, path-classification
 * @tags python, test-file, regex
 */
export function isPythonTestFile(filePath: string): boolean {
  const segments = filePath.split(/[\\/]/);
  const base = segments[segments.length - 1] ?? '';
  if (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base)) return true;
  return segments.includes('tests') || segments.includes('test');
}
