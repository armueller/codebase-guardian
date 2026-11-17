#!/usr/bin/env node
/**
 * CLI script to build/rebuild the Codebase Guardian code index.
 *
 * Usage:
 *   npm run build-index                    # Full rebuild with embeddings
 */
import { openDatabase } from './db.js';
import { runRebuild, formatRebuildReport, rebuildExitCode } from './rebuild.js';
import { resolveConfig, ensureDirectories, registerProject } from '../config.js';

const config = resolveConfig();
ensureDirectories(config);
registerProject(config);

/**
 * @what Runs a full index rebuild from the command line and prints the rebuild report
 * @how Opens the project's index database, runs the shared rebuild pipeline (runRebuild), prints the report and the elapsed time, and sets the exit code from rebuildExitCode: 1 when the rebuild did not start or a phase failed, 0 otherwise (a degraded phase is reported but does not fail the command). The database is closed whether or not the rebuild throws.
 * @why The CLI and the rebuild_index MCP tool must run the same phases and report them the same way; this used to be a second copy of the sequence
 *
 * @returns {Promise<void>} Resolves when the report has been printed
 *
 * @sideeffects Rewrites the project's index database (the pipeline also empties the dirty-file list and clears the validation cache); prints to stdout; sets process.exitCode
 * @systemlayer CLI
 * @domain index-rebuild, code-index
 * @tags cli, index-rebuild, build-index, exit-code, reporting
 */
async function main(): Promise<void> {
  console.log(`=== Codebase Guardian Index Builder (${config.projectName}) ===`);
  console.log(`Repository: ${config.projectRoot}`);
  console.log(`Database: ${config.databasePath}`);
  console.log('');

  const db = openDatabase(config.databasePath);
  const startTime = Date.now();
  try {
    const result = await runRebuild(db, config);

    console.log(formatRebuildReport(result).join('\n'));
    console.log('');
    console.log(`=== Finished in ${((Date.now() - startTime) / 1000).toFixed(1)}s ===`);

    // Set the exit code and return; do not call process.exit(), which can abort the embedding
    // runtime's native threads mid-teardown.
    process.exitCode = rebuildExitCode(result);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error('Build failed:', error);
  process.exitCode = 1;
});
