/**
 * @what Deletes the validation cache and session-store files that sit alongside the code index
 * @how Resolves the two JSON artifacts in the index directory (the directory of the DB path) and unlinks any that exist, returning which were removed
 * @why After a FULL index rebuild, cached validation verdicts and denial sessions were computed against the OLD index and are stale — serving them repeats false positives (e.g. a phantom DRY "duplicate" from a pre-merge snapshot). Clearing them forces fresh validation against the rebuilt index. Separate from the hook's own `clearCache` (validation-cache.ts): the hook clears via its module-resolved path from inside the hook process, whereas rebuilds run in the MCP server / CLI and clear by the DB path they already hold.
 *
 * @param {string} databasePath Absolute path to the project's code-quality.db (its directory holds the cache/session files)
 * @returns {string[]} Names of the artifact files that were actually deleted (empty if there was nothing to clear)
 *
 * @sideeffects Deletes .validation-cache.json and .validation-sessions.json from the index directory
 * @systemlayer Utility
 * @domain index-rebuild, cache-invalidation, validation
 * @tags cache-busting, index-rebuild, validation-cache, session-store, stale-index
 */
import { existsSync, unlinkSync } from 'fs';
import path from 'path';

export const VALIDATION_ARTIFACT_FILES = ['.validation-cache.json', '.validation-sessions.json'] as const;

export function clearValidationArtifacts(databasePath: string): string[] {
  const indexDir = path.dirname(databasePath);
  const cleared: string[] = [];
  for (const name of VALIDATION_ARTIFACT_FILES) {
    const filePath = path.join(indexDir, name);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      cleared.push(name);
    }
  }
  return cleared;
}
