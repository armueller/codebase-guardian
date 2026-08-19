#!/usr/bin/env node
/**
 * CLI script to build/rebuild the Codebase Guardian code index.
 *
 * Usage:
 *   npm run build-index                    # Full rebuild with embeddings
 */
import path from 'path';
import { openDatabase, clearAllData } from './db.js';
import { buildIndex, clearDirtyFiles } from './indexer.js';
import { buildCallGraph } from './call-graph.js';
import { buildPythonCallGraph } from './py-call-graph.js';
import { invalidateCache } from './embeddings.js';
import { clearValidationArtifacts } from './validation-artifacts.js';
import { resolveConfig, ensureDirectories, registerProject } from '../config.js';

const config = resolveConfig();
ensureDirectories(config);
registerProject(config);

const REPO_ROOT = config.projectRoot;
const DB_PATH = config.databasePath;
const DIRTY_FILES_PATH = path.resolve(path.dirname(config.databasePath), '.dirty-files');

async function main(): Promise<void> {
  console.log(`=== Codebase Guardian Index Builder (${config.projectName}) ===`);
  console.log(`Repository: ${REPO_ROOT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log('');

  const db = openDatabase(DB_PATH);

  // Full rebuild: clear existing data
  console.log('Clearing existing index data...');
  clearAllData(db);

  // Phase 1: Index code files (Tier 1) and docs (Tier 3)
  console.log('Phase 1: Scanning code and documentation...');
  const startTime = Date.now();
  const indexStats = await buildIndex(db, REPO_ROOT);

  console.log(`  Files scanned: ${indexStats.filesScanned}`);
  console.log(`  Tier 1 (JSDoc): ${indexStats.tier1Added}`);
  console.log(`  Tier 3 (docs): ${indexStats.tier3Added}`);
  console.log(`  Inline comments: ${indexStats.commentsExtracted}`);
  console.log(`  Doc sections: ${indexStats.docSectionsCreated}`);
  console.log(`  Embeddings: ${indexStats.embeddingsGenerated}`);
  console.log(`  Time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log('');

  // Phase 2: Build call graph and discover Tier 2 exports
  console.log('Phase 2: Building call graph...');
  const graphStart = Date.now();
  const graphStats = await buildCallGraph(db, REPO_ROOT);

  console.log(`  Tier 2 (exports): ${graphStats.exportsDiscovered}`);
  console.log(`  Call edges: ${graphStats.edgesCreated}`);
  console.log(`  Time: ${((Date.now() - graphStart) / 1000).toFixed(1)}s`);
  console.log('');

  // Phase 2b: Build Python call graph (cross-file edges resolved against P3.3's functions rows)
  console.log('Phase 2b: Building Python call graph...');
  const pyGraphStart = Date.now();
  const pyGraphStats = await buildPythonCallGraph(db, REPO_ROOT);

  console.log(`  Python call edges: ${pyGraphStats.edgesCreated}`);
  console.log(`  Time: ${((Date.now() - pyGraphStart) / 1000).toFixed(1)}s`);
  console.log('');

  // Clear dirty files
  clearDirtyFiles(DIRTY_FILES_PATH);
  invalidateCache();

  // Bust the hook's validation cache + session store — their verdicts were
  // computed against the pre-rebuild index and would otherwise serve stale
  // false positives (e.g. a phantom DRY duplicate from the old snapshot).
  const clearedArtifacts = clearValidationArtifacts(DB_PATH);
  if (clearedArtifacts.length > 0) {
    console.log(`Cleared stale validation artifacts: ${clearedArtifacts.join(', ')}`);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`=== Build complete in ${totalTime}s ===`);
  console.log(`Total indexed: ${indexStats.tier1Added + graphStats.exportsDiscovered + indexStats.tier3Added} entries`);

  db.close();
}

main().catch((error) => {
  console.error('Build failed:', error);
  process.exit(1);
});
