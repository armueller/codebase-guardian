import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { reloadConfig } from '../src/config.js';
import { openDatabase, getFunctionByName, countPythonFunctions, insertFunction } from '../src/mcp-server/db.js';
import { buildIndex } from '../src/mcp-server/indexer.js';
import { listIndexFiles } from '../src/mcp-server/file-walk.js';
import { makeTempDir, cleanupTempDirs, putFiles, documentedFunction as documented } from './helpers/ts-subdir-repo.js';

after(cleanupTempDirs);

/** A temp project with the given files; returns its root. */
function project(files: Record<string, string>): string {
  const root = makeTempDir('guardian-build-index-');
  putFiles(root, files);
  return root;
}

describe('buildIndex with an explicit file list', () => {
  it('indexes exactly the files it is given', async () => {
    const root = project({
      'guardian.config.json': JSON.stringify({ sourceDirectories: ['src'] }),
      'src/a.ts': documented('alpha'),
      'src/b.ts': documented('beta'),
    });
    const config = reloadConfig(root);
    const all = listIndexFiles(config);
    const onlyA = { ...all, codeFiles: all.codeFiles.filter(f => f.endsWith('a.ts')) };

    const db = openDatabase(':memory:');
    const stats = await buildIndex(db, root, { config, files: onlyA });

    assert.ok(getFunctionByName(db, 'alpha'));
    assert.equal(getFunctionByName(db, 'beta'), null);
    assert.equal(stats.codeFilesScanned, 1);
    db.close();
  });

  it('refuses a config that belongs to a different project root', async () => {
    const root = project({ 'src/a.ts': documented('alpha') });
    const other = project({});
    const db = openDatabase(':memory:');
    await assert.rejects(
      () => buildIndex(db, other, { config: reloadConfig(root) }),
      /does not match the config's project root/,
    );
    db.close();
  });
});

describe('buildIndex incremental path', () => {
  it('applies fileExtensions and excludeDirectories to dirty files, like a full rebuild', async () => {
    const root = project({
      'guardian.config.json': JSON.stringify({
        sourceDirectories: ['src'],
        excludeDirectories: ['generated'],
        fileExtensions: ['.ts'],
      }),
      'src/kept.ts': documented('kept'),
      'src/generated/g.ts': documented('inGenerated'),
      'src/node_modules/p/x.ts': documented('inNodeModules'),
      'src/view.tsx': documented('inTsx'),
      'src/kept.test.ts': documented('inTest'),
    });
    const config = reloadConfig(root);
    const db = openDatabase(':memory:');
    const dirtyFiles = ['src/kept.ts', 'src/generated/g.ts', 'src/node_modules/p/x.ts', 'src/view.tsx', 'src/kept.test.ts']
      .map(f => path.join(root, f));

    await buildIndex(db, root, { config, incremental: true, dirtyFiles });

    assert.ok(getFunctionByName(db, 'kept'));
    assert.equal(getFunctionByName(db, 'inGenerated'), null, 'excluded by the project config');
    assert.equal(getFunctionByName(db, 'inNodeModules'), null, 'excluded by default');
    assert.equal(getFunctionByName(db, 'inTsx'), null, '.tsx is not in fileExtensions');
    assert.equal(getFunctionByName(db, 'inTest'), null, 'test files are never indexed');
    db.close();
  });
});

describe('buildIndex Python reporting', () => {
  it('counts and names Python files it could not extract', async () => {
    const originalHome = process.env.GUARDIAN_HOME;
    process.env.GUARDIAN_HOME = makeTempDir('guardian-home-nopy-'); // no interpreter here
    try {
      const files: Record<string, string> = { 'guardian.config.json': JSON.stringify({ sourceDirectories: ['pkg'] }) };
      for (const n of [1, 2, 3, 4, 5, 6, 7]) files[`pkg/m${n}.py`] = '"""Module."""\n';
      const root = project(files);
      const db = openDatabase(':memory:');
      const stats = await buildIndex(db, root, { config: reloadConfig(root) });

      assert.equal(stats.pythonFilesSkipped, 7);
      assert.deepEqual(stats.pythonFilesSkippedSample, ['pkg/m1.py', 'pkg/m2.py', 'pkg/m3.py', 'pkg/m4.py', 'pkg/m5.py']);
      assert.equal(stats.pythonFilesOutsideSources, 0);
      db.close();
    } finally {
      if (originalHome === undefined) delete process.env.GUARDIAN_HOME;
      else process.env.GUARDIAN_HOME = originalHome;
    }
  });

  it('counts Python files that sit outside the source directories when no Python was indexed', async () => {
    const root = project({
      'guardian.config.json': JSON.stringify({ sourceDirectories: ['src'] }),
      'src/a.ts': documented('alpha'),
      'tools/one.py': '"""One."""\n',
      'tools/two.py': '"""Two."""\n',
      'tools/.venv/lib/x.py': '"""Excluded."""\n',
    });
    const db = openDatabase(':memory:');
    const stats = await buildIndex(db, root, { config: reloadConfig(root) });

    assert.equal(stats.pythonFilesOutsideSources, 2);
    assert.equal(stats.pythonFilesSkipped, 0);
    db.close();
  });

  it('reports folders it could not read', { skip: process.getuid?.() === 0 }, async () => {
    const { chmodSync } = await import('node:fs');
    const root = project({
      'guardian.config.json': JSON.stringify({ sourceDirectories: ['src'] }),
      'src/a.ts': documented('alpha'),
      'src/locked/b.ts': documented('beta'),
    });
    chmodSync(path.join(root, 'src/locked'), 0o000);
    try {
      const db = openDatabase(':memory:');
      const stats = await buildIndex(db, root, { config: reloadConfig(root) });
      assert.deepEqual(stats.unreadableDirectories, ['src/locked']);
      db.close();
    } finally {
      chmodSync(path.join(root, 'src/locked'), 0o755);
    }
  });
});

describe('countPythonFunctions', () => {
  it('counts only rows whose language is Python', () => {
    const db = openDatabase(':memory:');
    const base = {
      description: 'd', line_number: 1, is_exported: true, declaration_type: 'function',
      side_effects: null, system_layer: null, tier: 2,
    };
    insertFunction(db, { ...base, name: 'tsFn', file_path: 'a.ts' });
    insertFunction(db, { ...base, name: 'pyFn', file_path: 'a.py', language: 'py' });
    assert.equal(countPythonFunctions(db), 1);
    db.close();
  });
});
