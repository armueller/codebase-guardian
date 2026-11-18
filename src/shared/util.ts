/**
 * Two tiny helpers used on both sides of the hook / MCP-server boundary. This module imports only
 * `path`, so the lightweight hooks (which load config on every call) can use it for free.
 */
import path from 'path';

/**
 * @what Returns the message of a thrown value, whatever its type
 * @how The `message` of an Error, otherwise the value converted with String()
 * @why `catch` binds `unknown`; every fail-open path that reports a reason needs the same two-way conversion
 *
 * @param {unknown} err The caught value
 * @returns {string} A printable message
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain error-handling
 * @tags error-message, catch, unknown, pure
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @what Returns a path relative to a root, written with forward slashes
 * @how path.relative, then the platform separator replaced by '/'
 * @why Index file paths, exclude entries and report text are all '/'-separated and root-relative; the expression was repeated in several modules
 *
 * @param {string} root Absolute root directory
 * @param {string} target Absolute path under (or outside) the root
 * @returns {string} The '/'-separated relative path ('' when target is the root itself)
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain file-walk, config
 * @tags relative-path, posix, normalisation, pure
 */
export function toPosixRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}
