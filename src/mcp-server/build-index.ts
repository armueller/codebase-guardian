#!/usr/bin/env node
/**
 * CLI script to build/rebuild the Codebase Guardian code index.
 *
 * Usage:
 *   npm run build-index                    # Full rebuild with embeddings
 */
import path from 'path';
import { openDatabase } from './db.js';
import { clearDirtyFiles } from './indexer.js';
import { runRebuild, formatRebuildReport } from './rebuild.js';
import { resolveConfig, ensureDirectories, registerProject } from '../config.js';

const config = resolveConfig();
ensureDirectories(config);
registerProject(config);

const REPO_ROOT = config.projectRoot;
const DB_PATH = config.databasePath;
const DIRTY_FILES_PATH = path.resolve(path.dirname(config.databasePath), '.dirty-files');

/**
 * @what Runs a full index rebuild from the command line and prints the rebuild report
 * @how Opens the project's index database, runs the shared rebuild pipeline (runRebuild), prints the per-phase report and the elapsed time, and sets a non-zero exit code when any phase failed. A degraded phase is reported but does not fail the command.
 * @why The CLI and the rebuild_index MCP tool must run the same phases and report them the same way; this used to be a second copy of the sequence
 *
 * @returns {Promise<void>} Resolves when the report has been printed
 *
 * @sideeffects Rewrites the project's index database; clears .dirty-files and the validation cache; prints to stdout; sets process.exitCode
 * @systemlayer CLI
 * @domain rebuild, code-index
 * @tags cli, rebuild, build-index, exit-code, reporting
 */
async function main(): Promise<void> {
  console.log(`=== Codebase Guardian Index Builder (${config.projectName}) ===`);
  console.log(`Repository: ${REPO_ROOT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log('');

  const db = openDatabase(DB_PATH);
  const startTime = Date.now();

  const result = await runRebuild(db, config);
  clearDirtyFiles(DIRTY_FILES_PATH);

  console.log(formatRebuildReport(result).join('\n'));
  console.log('');
  console.log(`=== Finished in ${((Date.now() - startTime) / 1000).toFixed(1)}s ===`);

  db.close();

  // Set the exit code and return; do not call process.exit(), which can abort the embedding
  // runtime's native threads mid-teardown.
  if (result.phases.some(p => p.status === 'failed')) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Build failed:', error);
  process.exitCode = 1;
});
