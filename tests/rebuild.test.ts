import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { reloadConfig, type GuardianConfig } from '../src/config.js';
import { openDatabase, insertFunction, getFunctionByName } from '../src/mcp-server/db.js';
import type { IndexStats } from '../src/mcp-server/indexer.js';
import type { IndexFileSet } from '../src/mcp-server/file-walk.js';
import {
  runRebuild, formatRebuildReport, readLastRebuildStatus, rebuildExitCode, type RebuildDeps, type PhaseName,
} from '../src/mcp-server/rebuild.js';
import { makeTsSubdirRepo, makeTempDir, cleanupTempDirs, putFiles } from './helpers/ts-subdir-repo.js';

after(cleanupTempDirs);

type Db = ReturnType<typeof openDatabase>;
type Result = Awaited<ReturnType<typeof runRebuild>>;

const STATS: IndexStats = {
  filesScanned: 3, codeFilesScanned: 2, tier1Added: 2, tier2Added: 0, tier3Added: 1,
  embeddingsGenerated: 3, filesSkipped: 0, commentsExtracted: 4, docSectionsCreated: 5,
  pythonFilesSkipped: 0, pythonFilesSkippedSample: [], pythonFilesOutsideSources: 0, unreadableDirectories: [],
};

const FILES: IndexFileSet = { codeFiles: ['/x/a.ts'], docFiles: [], unreadableDirectories: [] };

/** Stub deps that all succeed, recording which phases ran. Individual tests override entries. */
function stubs(calls: string[], overrides: Partial<RebuildDeps> = {}): RebuildDeps {
  return {
    checkTsconfigLoads: () => null,
    listIndexFiles: () => FILES,
    clearAllData: () => { calls.push('clear'); },
    buildIndex: async () => { calls.push('index'); return STATS; },
    buildCallGraph: async () => {
      calls.push('ts');
      return { exportsDiscovered: 7, edgesCreated: 9, status: 'ok', note: null };
    },
    buildPythonCallGraph: async () => { calls.push('py'); return { edgesCreated: 2, note: null }; },
    clearValidationArtifacts: () => { calls.push('cache'); return ['.validation-cache.json']; },
    invalidateCache: () => { calls.push('invalidate'); },
    clearDirtyFiles: () => {},
    ...overrides,
  };
}

/** A config for an empty temp project (nothing on disk is read by the stubbed phases). */
function emptyConfig(): GuardianConfig {
  return reloadConfig(makeTempDir('guardian-rebuild-'));
}

/** Status of one phase in a result. */
function statusOf(result: Result, name: PhaseName): string {
  return result.phases.find(p => p.name === name)!.status;
}

/** Detail of one phase in a result. */
function detailOf(result: Result, name: PhaseName): string | null {
  return result.phases.find(p => p.name === name)!.detail;
}

describe('runRebuild: phases', () => {
  it('runs all five phases in order and reports complete when every phase is ok', async () => {
    const calls: string[] = [];
    const db: Db = openDatabase(':memory:');
    const result = await runRebuild(db, emptyConfig(), stubs(calls));

    assert.deepEqual(result.phases.map(p => p.name), ['clear', 'index', 'ts-call-graph', 'py-call-graph', 'validation-cache']);
    assert.deepEqual(result.phases.map(p => p.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
    assert.deepEqual(calls, ['clear', 'index', 'ts', 'py', 'invalidate', 'cache']);
    assert.equal(result.allOk, true);
    assert.equal(result.indexingFailed, false);
    assert.equal(result.notStarted, null);

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

  it('computes the file list once and gives the same list and config to every phase', async () => {
    const db: Db = openDatabase(':memory:');
    const config = emptyConfig();
    const seen: unknown[] = [];
    let listed = 0;
    await runRebuild(db, config, stubs([], {
      listIndexFiles: (given) => { listed++; seen.push(given); return FILES; },
      buildIndex: async (_db, root, options) => { seen.push(root, options?.config, options?.files); return STATS; },
      buildCallGraph: async (_db, root, opts) => {
        seen.push(root, opts?.config, opts?.files);
        return { exportsDiscovered: 0, edgesCreated: 0, status: 'ok', note: null };
      },
      buildPythonCallGraph: async (_db, root, opts) => { seen.push(root, opts?.config); return { edgesCreated: 0, note: null }; },
      clearValidationArtifacts: (databasePath) => { seen.push(databasePath); return []; },
    }));

    assert.equal(listed, 1);
    assert.deepEqual(seen, [
      config,
      config.projectRoot, config, FILES,
      config.projectRoot, config, FILES,
      config.projectRoot, config,
      config.databasePath,
    ]);
    db.close();
  });

  it('clears the dirty-file list after indexing succeeds, and leaves it when indexing fails', async () => {
    const config = emptyConfig();
    const cleared: string[] = [];
    const record = { clearDirtyFiles: (file: string) => { cleared.push(file); } };

    await runRebuild(openDatabase(':memory:'), config, stubs([], record));
    assert.deepEqual(cleared, [path.join(path.dirname(config.databasePath), '.dirty-files')]);

    cleared.length = 0;
    await runRebuild(openDatabase(':memory:'), config, stubs([], {
      ...record,
      buildIndex: async () => { throw new Error('disk gone'); },
    }));
    assert.deepEqual(cleared, []);
  });
});

describe('runRebuild: Python call graph status', () => {
  it('is degraded when it produced nothing and Python is indexed', async () => {
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

  it('is ok when it produced nothing and the project has no Python', async () => {
    const db: Db = openDatabase(':memory:');
    const result = await runRebuild(db, emptyConfig(), stubs([], {
      buildPythonCallGraph: async () => ({ edgesCreated: 0, note: 'Python interpreter not found' }),
    }));

    assert.equal(statusOf(result, 'py-call-graph'), 'ok');
    assert.equal(detailOf(result, 'py-call-graph'), 'no Python files indexed');
    assert.equal(result.allOk, true);
    db.close();
  });
});

describe('runRebuild: what indexing had to leave out', () => {
  it('names a configured directory that does not exist', async () => {
    const db: Db = openDatabase(':memory:');
    const config = { ...emptyConfig(), sourceDirectories: ['.', 'web/ap'], docsDirectories: ['dox'] };
    const result = await runRebuild(db, config, stubs([]));

    assert.equal(statusOf(result, 'index'), 'degraded');
    assert.equal(
      detailOf(result, 'index'),
      'configured directory does not exist: web/ap; configured directory does not exist: dox',
    );
    assert.equal(result.allOk, false);
    assert.equal(result.indexingFailed, false);
    db.close();
  });

  it('names Python files that could not be indexed, and degrades the Python call graph too', async () => {
    const db: Db = openDatabase(':memory:');
    const result = await runRebuild(db, emptyConfig(), stubs([], {
      buildIndex: async () => ({ ...STATS, pythonFilesSkipped: 2, pythonFilesSkippedSample: ['pkg/a.py', 'pkg/b.py'] }),
      buildPythonCallGraph: async () => ({ edgesCreated: 0, note: 'Python interpreter not found' }),
    }));

    assert.equal(statusOf(result, 'index'), 'degraded');
    assert.equal(
      detailOf(result, 'index'),
      '2 Python files were not indexed (extraction failed, or the Python interpreter is missing): pkg/a.py, pkg/b.py',
    );
    assert.equal(statusOf(result, 'py-call-graph'), 'degraded');
    assert.equal(detailOf(result, 'py-call-graph'), 'Python interpreter not found');
    assert.equal(formatRebuildReport(result)[0], '## Index Rebuild Finished With Problems');
    db.close();
  });

  it('says how many more Python files there were beyond the ones it names', async () => {
    const db: Db = openDatabase(':memory:');
    const result = await runRebuild(db, emptyConfig(), stubs([], {
      buildIndex: async () => ({ ...STATS, pythonFilesSkipped: 7, pythonFilesSkippedSample: ['a.py', 'b.py'] }),
    }));
    assert.match(detailOf(result, 'index') ?? '', /: a\.py, b\.py and 5 more$/);
    db.close();
  });

  it('reports Python that sits outside the source directories', async () => {
    const db: Db = openDatabase(':memory:');
    const config = { ...emptyConfig(), sourceDirectories: ['.'] };
    const result = await runRebuild(db, config, stubs([], {
      buildIndex: async () => ({ ...STATS, pythonFilesOutsideSources: 3 }),
    }));

    assert.equal(statusOf(result, 'index'), 'degraded');
    assert.equal(
      detailOf(result, 'index'),
      '3 Python files under the project are outside the source directories (.) and were not indexed; ' +
      'add their folder to "sourceDirectories" in guardian.config.json',
    );
    db.close();
  });

  it('reports folders that could not be read', async () => {
    const db: Db = openDatabase(':memory:');
    const result = await runRebuild(db, emptyConfig(), stubs([], {
      buildIndex: async () => ({ ...STATS, unreadableDirectories: ['src/locked', 'src/other'] }),
    }));
    assert.equal(detailOf(result, 'index'), '2 folders could not be read: src/locked, src/other');
    db.close();
  });

  it('reports a rebuild that found no code files', async () => {
    const db: Db = openDatabase(':memory:');
    const config = { ...emptyConfig(), sourceDirectories: ['.'], fileExtensions: ['.ts'] };
    const result = await runRebuild(db, config, stubs([], {
      buildIndex: async () => ({ ...STATS, codeFilesScanned: 0 }),
    }));
    assert.equal(
      detailOf(result, 'index'),
      'no code files were found in the source directories (.) with the configured extensions (.ts)',
    );
    assert.equal(result.allOk, false);
    db.close();
  });

  it('lists every reason when there is more than one', async () => {
    const db: Db = openDatabase(':memory:');
    const config = { ...emptyConfig(), sourceDirectories: ['.', 'nope'] };
    const result = await runRebuild(db, config, stubs([], {
      buildIndex: async () => ({ ...STATS, pythonFilesSkipped: 1, pythonFilesSkippedSample: ['m.py'], unreadableDirectories: ['x'] }),
    }));

    assert.equal(
      detailOf(result, 'index'),
      'configured directory does not exist: nope; ' +
      '1 folder could not be read: x; ' +
      '1 Python file was not indexed (extraction failed, or the Python interpreter is missing): m.py',
    );
    db.close();
  });
});

describe('runRebuild: a configuration that is known to be broken', () => {
  it('does not start, touches nothing, and lists every problem', async () => {
    const calls: string[] = [];
    const db: Db = openDatabase(':memory:');
    insertFunction(db, {
      name: 'existing', description: 'd', file_path: 'a.ts', line_number: 1, is_exported: true,
      declaration_type: 'function', side_effects: null, system_layer: null, tier: 2,
    });
    const config: GuardianConfig = {
      ...emptyConfig(),
      configFileError: 'Unexpected token',
      configWarnings: ['"excludeDirectories" in guardian.config.json must be a list of strings'],
      tsconfig: { kind: 'invalid', reason: 'tsconfig "nope.json" from guardian.config.json does not exist' },
    };
    const cleared: string[] = [];
    const result = await runRebuild(db, config, stubs(calls, { clearDirtyFiles: (f) => { cleared.push(f); } }));

    assert.deepEqual(result.notStarted, [
      'guardian.config.json could not be used: Unexpected token',
      '"excludeDirectories" in guardian.config.json must be a list of strings',
      'tsconfig "nope.json" from guardian.config.json does not exist',
    ]);
    assert.deepEqual(calls, [], 'no phase ran, and the validation cache was not cleared');
    assert.deepEqual(cleared, []);
    assert.ok(getFunctionByName(db, 'existing'), 'the existing index is untouched');
    assert.deepEqual(result.phases.map(p => p.status), ['skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    assert.equal(result.allOk, false);

    const report = formatRebuildReport(result);
    assert.equal(report[0], '## Index Rebuild Not Started');
    assert.ok(report.includes('- tsconfig "nope.json" from guardian.config.json does not exist'));
    assert.ok(report.some(line => line.includes('The existing index was left as it was')));
    assert.ok(!report.some(line => line.startsWith('**Files scanned:**')), 'no counts for a rebuild that did not run');
    db.close();
  });

  it('does not start when the tsconfig exists but cannot be loaded', async () => {
    const calls: string[] = [];
    const db: Db = openDatabase(':memory:');
    // The load check only applies when the config resolved to a tsconfig file.
    const config: GuardianConfig = { ...emptyConfig(), tsconfig: { kind: 'file', path: '/x/web/tsconfig.json' } };
    const result = await runRebuild(db, config, stubs(calls, {
      checkTsconfigLoads: () => 'could not load tsconfig "web/tsconfig.json": \',\' expected.',
    }));

    assert.deepEqual(result.notStarted, ['could not load tsconfig "web/tsconfig.json": \',\' expected.']);
    assert.deepEqual(calls, []);
    db.close();
  });
});

describe('rebuild status is kept for index_status', () => {
  it('stores the per-phase outcome of the last rebuild that ran', async () => {
    const db: Db = openDatabase(':memory:');
    assert.equal(readLastRebuildStatus(db), null);

    await runRebuild(db, emptyConfig(), stubs([], {
      buildCallGraph: async () => ({ exportsDiscovered: 1, edgesCreated: 1, status: 'degraded', note: 'no tsconfig' }),
    }));
    const lines = readLastRebuildStatus(db);
    assert.ok(lines);
    assert.equal(lines![0], '**Last rebuild:** finished with problems');
    assert.ok(lines!.includes('- **TypeScript call graph:** degraded (no tsconfig)'));
    assert.ok(lines!.includes('- **Index code and docs:** ok'));

    await runRebuild(db, emptyConfig(), stubs([]));
    assert.equal(readLastRebuildStatus(db)![0], '**Last rebuild:** complete');
    db.close();
  });

  it('is not overwritten by a rebuild that did not start', async () => {
    const db: Db = openDatabase(':memory:');
    await runRebuild(db, emptyConfig(), stubs([]));
    await runRebuild(db, { ...emptyConfig(), configFileError: 'broken' }, stubs([]));
    assert.equal(readLastRebuildStatus(db)![0], '**Last rebuild:** complete');
    db.close();
  });
});

describe('runRebuild with the real phases', () => {
  /** Runs a test body with GUARDIAN_HOME pointed at an empty temp directory (no Python interpreter there). */
  async function withEmptyGuardianHome(body: () => Promise<void>): Promise<void> {
    const originalHome = process.env.GUARDIAN_HOME;
    process.env.GUARDIAN_HOME = makeTempDir('guardian-home-rebuild-');
    try {
      await body();
    } finally {
      if (originalHome === undefined) delete process.env.GUARDIAN_HOME;
      else process.env.GUARDIAN_HOME = originalHome;
    }
  }

  it('does not read complete for a Python project when there is no Python interpreter', async () => {
    await withEmptyGuardianHome(async () => {
      const root = makeTempDir('guardian-pyproject-');
      putFiles(root, {
        'guardian.config.json': JSON.stringify({ sourceDirectories: ['pkg'] }),
        'pkg/mod.py': '"""A module.\n\nDomain: demo\n"""\n\ndef f():\n    """Do f."""\n    return 1\n',
      });
      const db: Db = openDatabase(':memory:');
      const result = await runRebuild(db, reloadConfig(root));

      assert.equal(statusOf(result, 'index'), 'degraded');
      assert.match(detailOf(result, 'index') ?? '', /^1 Python file was not indexed .*: pkg\/mod\.py$/);
      assert.equal(statusOf(result, 'py-call-graph'), 'degraded');
      assert.equal(detailOf(result, 'py-call-graph'), 'Python interpreter not found');
      assert.equal(result.allOk, false);
      assert.equal(formatRebuildReport(result)[0], '## Index Rebuild Finished With Problems');
      db.close();
    });
  });

  it('does not read complete when the project\'s Python sits outside the source directories', async () => {
    await withEmptyGuardianHome(async () => {
      const root = makeTsSubdirRepo({
        'guardian.config.json': JSON.stringify({ sourceDirectories: ['web/app'], tsconfig: 'web/tsconfig.json' }),
        'engine/run.py': '"""Engine."""\n',
      });
      const db: Db = openDatabase(':memory:');
      const result = await runRebuild(db, reloadConfig(root));

      assert.equal(statusOf(result, 'index'), 'degraded');
      assert.match(detailOf(result, 'index') ?? '', /^1 Python file under the project is outside the source directories \(web\/app\)/);
      assert.equal(statusOf(result, 'ts-call-graph'), 'ok');
      assert.equal(formatRebuildReport(result)[0], '## Index Rebuild Finished With Problems');
      db.close();
    });
  });

  it('does not start, and keeps the old index, when the configured tsconfig is malformed', async () => {
    await withEmptyGuardianHome(async () => {
      const root = makeTsSubdirRepo({
        'guardian.config.json': JSON.stringify({ sourceDirectories: ['web/app'], tsconfig: 'web/tsconfig.json' }),
      });
      const db: Db = openDatabase(':memory:');
      const good = await runRebuild(db, reloadConfig(root));
      assert.equal(good.allOk, true, formatRebuildReport(good).join('\n'));
      assert.ok(getFunctionByName(db, 'run'));

      putFiles(root, { 'web/tsconfig.json': '{ not json' });
      const result = await runRebuild(db, reloadConfig(root));

      assert.equal(result.notStarted?.length, 1);
      assert.match(result.notStarted![0], /^could not load tsconfig "web\/tsconfig\.json": /);
      assert.ok(getFunctionByName(db, 'run'), 'the index from the good rebuild is still there');
      assert.equal(readLastRebuildStatus(db)![0], '**Last rebuild:** complete');
      db.close();
    });
  });

  it('clears the real dirty-file list', async () => {
    await withEmptyGuardianHome(async () => {
      const root = makeTsSubdirRepo({
        'guardian.config.json': JSON.stringify({ sourceDirectories: ['web/app'], tsconfig: 'web/tsconfig.json' }),
      });
      const config = reloadConfig(root);
      const dirtyFile = path.join(path.dirname(config.databasePath), '.dirty-files');
      mkdirSync(path.dirname(dirtyFile), { recursive: true });
      writeFileSync(dirtyFile, 'web/app/main.ts\n');

      await runRebuild(openDatabase(':memory:'), config);

      assert.ok(existsSync(dirtyFile));
      assert.equal(readFileSync(dirtyFile, 'utf-8'), '');
    });
  });
});

describe('rebuildExitCode', () => {
  it('is 0 for a complete rebuild and for a degraded one', async () => {
    const complete = await runRebuild(openDatabase(':memory:'), emptyConfig(), stubs([]));
    assert.equal(rebuildExitCode(complete), 0);

    const degraded = await runRebuild(openDatabase(':memory:'), emptyConfig(), stubs([], {
      buildCallGraph: async () => ({ exportsDiscovered: 0, edgesCreated: 0, status: 'degraded', note: 'n' }),
    }));
    assert.equal(rebuildExitCode(degraded), 0);
  });

  it('is 1 when a phase failed, and when the rebuild did not start', async () => {
    const failed = await runRebuild(openDatabase(':memory:'), emptyConfig(), stubs([], {
      buildCallGraph: async () => { throw new Error('boom'); },
    }));
    assert.equal(rebuildExitCode(failed), 1);

    const notStarted = await runRebuild(openDatabase(':memory:'), { ...emptyConfig(), configFileError: 'broken' }, stubs([]));
    assert.equal(rebuildExitCode(notStarted), 1);
  });
});
