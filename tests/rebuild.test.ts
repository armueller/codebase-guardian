import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reloadConfig, type GuardianConfig } from '../src/config.js';
import { openDatabase, insertFunction } from '../src/mcp-server/db.js';
import type { IndexStats } from '../src/mcp-server/indexer.js';
import { runRebuild, formatRebuildReport, type RebuildDeps, type PhaseName } from '../src/mcp-server/rebuild.js';
import { makeTsSubdirRepo, putFiles } from './helpers/ts-subdir-repo.js';

type Db = ReturnType<typeof openDatabase>;

const STATS: IndexStats = {
  filesScanned: 3, tier1Added: 2, tier2Added: 0, tier3Added: 1,
  embeddingsGenerated: 3, filesSkipped: 0, commentsExtracted: 4, docSectionsCreated: 5,
  pythonFilesSkipped: 0,
};

/** Stub deps that all succeed, recording which ones ran. Individual tests override entries. */
function stubs(calls: string[], overrides: Partial<RebuildDeps> = {}): RebuildDeps {
  return {
    clearAllData: () => { calls.push('clear'); },
    buildIndex: async () => { calls.push('index'); return STATS; },
    buildCallGraph: async () => {
      calls.push('ts');
      return { exportsDiscovered: 7, edgesCreated: 9, status: 'ok', note: null };
    },
    buildPythonCallGraph: async () => { calls.push('py'); return { edgesCreated: 2, note: null }; },
    clearValidationArtifacts: () => { calls.push('cache'); return ['.validation-cache.json']; },
    invalidateCache: () => { calls.push('invalidate'); },
    ...overrides,
  };
}

/** A config for an empty temp project (nothing on disk is read by the stubbed phases). */
function emptyConfig(): GuardianConfig {
  return reloadConfig(mkdtempSync(path.join(tmpdir(), 'guardian-rebuild-')));
}

/** Status of one phase in a result. */
function statusOf(result: Awaited<ReturnType<typeof runRebuild>>, name: PhaseName): string {
  return result.phases.find(p => p.name === name)!.status;
}

/** Detail of one phase in a result. */
function detailOf(result: Awaited<ReturnType<typeof runRebuild>>, name: PhaseName): string | null {
  return result.phases.find(p => p.name === name)!.detail;
}

describe('runRebuild', () => {
  it('runs all five phases in order and reports complete when every phase is ok', async () => {
    const calls: string[] = [];
    const db: Db = openDatabase(':memory:');
    const result = await runRebuild(db, emptyConfig(), stubs(calls));

    assert.deepEqual(result.phases.map(p => p.name), ['clear', 'index', 'ts-call-graph', 'py-call-graph', 'validation-cache']);
    assert.deepEqual(result.phases.map(p => p.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
    assert.deepEqual(calls, ['clear', 'index', 'ts', 'py', 'invalidate', 'cache']);
    assert.equal(result.allOk, true);
    assert.equal(result.indexingFailed, false);

    const report = formatRebuildReport(result);
    assert.equal(report[0], '## Index Rebuild Complete');
    assert.ok(report.includes('- **TypeScript call graph:** ok'));
    assert.ok(report.includes('**Tier 2 (exports):** 7'));
    assert.ok(report.includes('**Call edges:** 9'));
    assert.ok(report.includes('**Python call edges:** 2'));
    assert.ok(report.includes('**Tier 3 (docs):** 1'));
    assert.ok(report.includes('**Validation cache:** cleared (.validation-cache.json)'));
    db.close();
  });

  it('keeps going when the TypeScript call graph throws, and names the failure', async () => {
    const calls: string[] = [];
    const db: Db = openDatabase(':memory:');
    const result = await runRebuild(db, emptyConfig(), stubs(calls, {
      buildCallGraph: async () => { calls.push('ts'); throw new Error('boom'); },
    }));

    assert.equal(statusOf(result, 'ts-call-graph'), 'failed');
    assert.equal(detailOf(result, 'ts-call-graph'), 'boom');
    assert.deepEqual(calls, ['clear', 'index', 'ts', 'py', 'invalidate', 'cache']);
    assert.equal(statusOf(result, 'py-call-graph'), 'ok');
    assert.equal(statusOf(result, 'validation-cache'), 'ok');
    assert.equal(result.allOk, false);
    assert.equal(result.indexingFailed, false);
    assert.equal(result.graphStats, null);

    const report = formatRebuildReport(result);
    assert.equal(report[0], '## Index Rebuild Finished With Problems');
    assert.ok(report.includes('- **TypeScript call graph:** failed (boom)'));
    assert.ok(report.includes('**Tier 2 (exports):** not run'));
    assert.ok(report.includes('**Call edges:** not run'));
    assert.ok(report.includes('**Tier 1 (JSDoc):** 2'));
    db.close();
  });

  it('skips both call graphs when indexing throws, and still clears the validation cache', async () => {
    const calls: string[] = [];
    const db: Db = openDatabase(':memory:');
    const result = await runRebuild(db, emptyConfig(), stubs(calls, {
      buildIndex: async () => { calls.push('index'); throw new Error('disk gone'); },
    }));

    assert.equal(statusOf(result, 'index'), 'failed');
    assert.equal(detailOf(result, 'index'), 'disk gone');
    assert.equal(statusOf(result, 'ts-call-graph'), 'skipped');
    assert.equal(detailOf(result, 'ts-call-graph'), 'indexing failed');
    assert.equal(statusOf(result, 'py-call-graph'), 'skipped');
    assert.equal(detailOf(result, 'py-call-graph'), 'indexing failed');
    assert.equal(statusOf(result, 'validation-cache'), 'ok');
    assert.deepEqual(calls, ['clear', 'index', 'invalidate', 'cache']);
    assert.equal(result.indexingFailed, true);
    assert.equal(result.allOk, false);
    db.close();
  });

  it('skips indexing and both call graphs when clearing the old index throws', async () => {
    const calls: string[] = [];
    const db: Db = openDatabase(':memory:');
    const result = await runRebuild(db, emptyConfig(), stubs(calls, {
      clearAllData: () => { calls.push('clear'); throw new Error('locked'); },
    }));

    assert.equal(statusOf(result, 'clear'), 'failed');
    assert.equal(statusOf(result, 'index'), 'skipped');
    assert.equal(detailOf(result, 'index'), 'clearing the old index failed');
    assert.equal(statusOf(result, 'ts-call-graph'), 'skipped');
    assert.equal(statusOf(result, 'py-call-graph'), 'skipped');
    assert.deepEqual(calls, ['clear', 'invalidate', 'cache']);
    assert.equal(result.indexingFailed, true);
    db.close();
  });

  it('reports a degraded TypeScript call graph with its note', async () => {
    const db: Db = openDatabase(':memory:');
    const result = await runRebuild(db, emptyConfig(), stubs([], {
      buildCallGraph: async () => ({ exportsDiscovered: 1, edgesCreated: 1, status: 'degraded', note: 'n' }),
    }));

    assert.equal(statusOf(result, 'ts-call-graph'), 'degraded');
    assert.equal(detailOf(result, 'ts-call-graph'), 'n');
    assert.equal(result.allOk, false);
    assert.equal(result.indexingFailed, false);
    assert.equal(formatRebuildReport(result)[0], '## Index Rebuild Finished With Problems');
    db.close();
  });

  it('reports the Python call graph as degraded when it produced nothing and Python is indexed', async () => {
    const db: Db = openDatabase(':memory:');
    const result = await runRebuild(db, emptyConfig(), stubs([], {
      buildIndex: async (database) => {
        insertFunction(database, {
          name: 'mod', description: 'm', file_path: 'pkg/mod.py', line_number: 1, is_exported: true,
          declaration_type: 'module', side_effects: null, system_layer: null, tier: 3, language: 'py',
        });
        return STATS;
      },
      buildPythonCallGraph: async () => ({ edgesCreated: 0, note: 'Python interpreter not found' }),
    }));

    assert.equal(statusOf(result, 'py-call-graph'), 'degraded');
    assert.equal(detailOf(result, 'py-call-graph'), 'Python interpreter not found');
    assert.equal(result.allOk, false);
    db.close();
  });

  it('reports the Python call graph as ok when it produced nothing and no Python is indexed', async () => {
    const db: Db = openDatabase(':memory:');
    const result = await runRebuild(db, emptyConfig(), stubs([], {
      buildPythonCallGraph: async () => ({ edgesCreated: 0, note: 'Python interpreter not found' }),
    }));

    assert.equal(statusOf(result, 'py-call-graph'), 'ok');
    assert.equal(detailOf(result, 'py-call-graph'), 'no Python files indexed');
    assert.equal(result.allOk, true);
    db.close();
  });

  it('marks indexing degraded when guardian.config.json could not be parsed', async () => {
    const db: Db = openDatabase(':memory:');
    const config = { ...emptyConfig(), configFileError: 'Unexpected token' };
    const result = await runRebuild(db, config, stubs([]));

    assert.equal(statusOf(result, 'index'), 'degraded');
    assert.equal(
      detailOf(result, 'index'),
      'guardian.config.json could not be parsed (Unexpected token); auto-detected settings were used',
    );
    assert.equal(result.allOk, false);
    assert.equal(result.indexingFailed, false);
    db.close();
  });

  it('marks indexing degraded, naming the directory, when a configured directory does not exist', async () => {
    const db: Db = openDatabase(':memory:');
    const config = { ...emptyConfig(), sourceDirectories: ['.', 'web/ap'], docsDirectories: ['dox'] };
    const result = await runRebuild(db, config, stubs([]));

    assert.equal(statusOf(result, 'index'), 'degraded');
    assert.equal(detailOf(result, 'index'), 'configured directories do not exist: web/ap, dox');
    assert.equal(result.allOk, false);
    assert.equal(result.indexingFailed, false);
    db.close();
  });

  it('marks indexing degraded with a config warning', async () => {
    const db: Db = openDatabase(':memory:');
    const warning = '"excludeDirectories" in guardian.config.json must be a list of strings; the default was used';
    const result = await runRebuild(db, { ...emptyConfig(), configWarnings: [warning] }, stubs([]));

    assert.equal(statusOf(result, 'index'), 'degraded');
    assert.equal(detailOf(result, 'index'), warning);
    db.close();
  });

  it('marks indexing and the Python call graph degraded when Python files could not be indexed', async () => {
    const db: Db = openDatabase(':memory:');
    const result = await runRebuild(db, emptyConfig(), stubs([], {
      buildIndex: async () => ({ ...STATS, pythonFilesSkipped: 2 }),
      buildPythonCallGraph: async () => ({ edgesCreated: 0, note: 'Python interpreter not found' }),
    }));

    assert.equal(statusOf(result, 'index'), 'degraded');
    assert.equal(
      detailOf(result, 'index'),
      '2 Python files were not indexed (extraction failed, or the Python interpreter is missing)',
    );
    assert.equal(statusOf(result, 'py-call-graph'), 'degraded');
    assert.equal(detailOf(result, 'py-call-graph'), 'Python interpreter not found');
    assert.equal(result.allOk, false);
    assert.equal(formatRebuildReport(result)[0], '## Index Rebuild Finished With Problems');
    db.close();
  });

  it('lists every reason when indexing is degraded for more than one', async () => {
    const db: Db = openDatabase(':memory:');
    const config = { ...emptyConfig(), configFileError: 'Unexpected token', sourceDirectories: ['.', 'nope'] };
    const result = await runRebuild(db, config, stubs([], {
      buildIndex: async () => ({ ...STATS, pythonFilesSkipped: 1 }),
    }));

    assert.equal(
      detailOf(result, 'index'),
      'guardian.config.json could not be parsed (Unexpected token); auto-detected settings were used; ' +
      'configured directory does not exist: nope; ' +
      '1 Python file was not indexed (extraction failed, or the Python interpreter is missing)',
    );
    db.close();
  });

  it('passes the given config to the phases that read project settings', async () => {
    const db: Db = openDatabase(':memory:');
    const config = emptyConfig();
    const seen: unknown[] = [];
    await runRebuild(db, config, stubs([], {
      buildIndex: async (_db, root, options) => { seen.push(root, options?.config); return STATS; },
      buildCallGraph: async (_db, root, opts) => {
        seen.push(root, opts?.config);
        return { exportsDiscovered: 0, edgesCreated: 0, status: 'ok', note: null };
      },
      clearValidationArtifacts: (databasePath) => { seen.push(databasePath); return []; },
    }));

    assert.deepEqual(seen, [config.projectRoot, config, config.projectRoot, config, config.databasePath]);
    db.close();
  });
});

describe('runRebuild with the real phases', () => {
  it('does not read complete for a Python project when there is no Python interpreter', async () => {
    const originalHome = process.env.GUARDIAN_HOME;
    process.env.GUARDIAN_HOME = mkdtempSync(path.join(tmpdir(), 'guardian-home-nopy-'));
    try {
      const root = mkdtempSync(path.join(tmpdir(), 'guardian-pyproject-'));
      putFiles(root, {
        'guardian.config.json': JSON.stringify({ sourceDirectories: ['pkg'] }),
        'pkg/mod.py': '"""A module.\n\nDomain: demo\n"""\n\ndef f():\n    """Do f."""\n    return 1\n',
      });
      const db: Db = openDatabase(':memory:');
      const result = await runRebuild(db, reloadConfig(root));

      assert.equal(statusOf(result, 'index'), 'degraded');
      assert.match(detailOf(result, 'index') ?? '', /^1 Python file was not indexed/);
      assert.equal(statusOf(result, 'py-call-graph'), 'degraded');
      assert.equal(detailOf(result, 'py-call-graph'), 'Python interpreter not found');
      assert.equal(result.allOk, false);
      assert.equal(formatRebuildReport(result)[0], '## Index Rebuild Finished With Problems');
      db.close();
    } finally {
      if (originalHome === undefined) delete process.env.GUARDIAN_HOME;
      else process.env.GUARDIAN_HOME = originalHome;
    }
  });

  it('finishes, with every other phase ok, when the configured tsconfig is malformed', async () => {
    const originalHome = process.env.GUARDIAN_HOME;
    // An empty guardian home: no Python interpreter there, and nothing of the user's to clear.
    process.env.GUARDIAN_HOME = mkdtempSync(path.join(tmpdir(), 'guardian-home-rebuild-'));
    try {
      const root = makeTsSubdirRepo({
        'guardian.config.json': JSON.stringify({ sourceDirectories: ['web/app'], tsconfig: 'web/tsconfig.json' }),
        'web/tsconfig.json': '{ not json',
      });
      const db: Db = openDatabase(':memory:');
      const result = await runRebuild(db, reloadConfig(root));

      assert.equal(statusOf(result, 'clear'), 'ok');
      assert.equal(statusOf(result, 'index'), 'ok');
      assert.equal(statusOf(result, 'ts-call-graph'), 'failed');
      assert.match(detailOf(result, 'ts-call-graph') ?? '', /^could not load tsconfig "web\/tsconfig\.json": /);
      assert.equal(statusOf(result, 'py-call-graph'), 'ok');
      assert.equal(statusOf(result, 'validation-cache'), 'ok');
      assert.equal(result.indexingFailed, false);
      db.close();
    } finally {
      if (originalHome === undefined) delete process.env.GUARDIAN_HOME;
      else process.env.GUARDIAN_HOME = originalHome;
    }
  });
});
