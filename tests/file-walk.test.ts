import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { reloadConfig } from '../src/config.js';
import {
  listIndexFiles, isExcludedDir, isExcludedPath, classifyIndexFile, configuredDirectoryProblems,
} from '../src/mcp-server/file-walk.js';
import { makeTempDir, cleanupTempDirs } from './helpers/ts-subdir-repo.js';

after(cleanupTempDirs);

// Built at test time, not committed as a fixture: .gitignore drops node_modules/.
const TREE = [
  'web/app/a.ts',
  'web/app/a.test.ts',
  'web/app/README.md',
  'web/app/node_modules/p/x.ts',
  'web/app/build/y.ts',
  'web/app/data/z.ts',
  'web/app/nested/data/keep.ts',
  'docs/guide.md',
];

let root: string;

/** Writes guardian.config.json and returns the listed files relative to the root. */
function list(configFile: Record<string, unknown>): { codeFiles: string[]; docFiles: string[] } {
  writeFileSync(path.join(root, 'guardian.config.json'), JSON.stringify(configFile));
  const set = listIndexFiles(reloadConfig(root));
  const rel = (files: string[]): string[] => files.map(f => path.relative(root, f));
  return { codeFiles: rel(set.codeFiles), docFiles: rel(set.docFiles) };
}

describe('listIndexFiles', () => {
  before(() => {
    root = makeTempDir('guardian-file-walk-');
    for (const file of TREE) {
      const full = path.join(root, file);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, '// fixture\n');
    }
  });

  const base = { sourceDirectories: ['web/app'], docsDirectories: ['docs'] };

  it('applies the default exclude list and skips test files', () => {
    const { codeFiles, docFiles } = list(base);
    assert.deepEqual(codeFiles, ['web/app/a.ts', 'web/app/data/z.ts', 'web/app/nested/data/keep.ts']);
    assert.deepEqual(docFiles, ['docs/guide.md', 'web/app/README.md']);
  });

  it('a configured list adds to the defaults; a bare name matches at any depth', () => {
    // build/ and node_modules/ stay excluded although the config does not repeat them.
    const { codeFiles } = list({ ...base, excludeDirectories: ['data'] });
    assert.deepEqual(codeFiles, ['web/app/a.ts']);
  });

  it('an entry with a slash matches only that path from the project root', () => {
    const { codeFiles } = list({ ...base, excludeDirectories: ['web/app/data'] });
    assert.deepEqual(codeFiles, ['web/app/a.ts', 'web/app/nested/data/keep.ts']);
  });

  it('tolerates a leading ./ and a trailing slash on a path entry', () => {
    const { codeFiles } = list({ ...base, excludeDirectories: ['./web/app/data/'] });
    assert.deepEqual(codeFiles, ['web/app/a.ts', 'web/app/nested/data/keep.ts']);
  });

  it('lists each file once when source directories overlap', () => {
    const { codeFiles, docFiles } = list({ ...base, sourceDirectories: ['.', 'web/app'] });
    assert.deepEqual(codeFiles, ['web/app/a.ts', 'web/app/data/z.ts', 'web/app/nested/data/keep.ts']);
    assert.deepEqual(docFiles, ['docs/guide.md', 'web/app/README.md']);
  });

  it('walks a source directory even when its own name is on the exclude list', () => {
    const { codeFiles } = list({ ...base, sourceDirectories: ['web/app/build'] });
    assert.deepEqual(codeFiles, ['web/app/build/y.ts']);
  });

  it('returns nothing for a source directory that does not exist', () => {
    const { codeFiles } = list({ ...base, sourceDirectories: ['nope'] });
    assert.deepEqual(codeFiles, []);
  });
});

describe('configuredDirectoryProblems', () => {
  it('says what is wrong with each configured source or docs directory', () => {
    const dir = makeTempDir('guardian-dir-problems-');
    mkdirSync(path.join(dir, 'web/app'), { recursive: true });
    mkdirSync(path.join(dir, 'docs'));
    writeFileSync(path.join(dir, 'notadir'), '');
    writeFileSync(path.join(dir, 'guardian.config.json'), JSON.stringify({
      sourceDirectories: ['web/app', 'web/ap', 'notadir'],
      docsDirectories: ['docs', 'dox'],
    }));
    assert.deepEqual(configuredDirectoryProblems(reloadConfig(dir)), [
      'configured directory does not exist: web/ap',
      'configured directory is a file, not a folder: notadir',
      'configured directory does not exist: dox',
    ]);
  });

  it('is empty when every configured directory exists', () => {
    const dir = makeTempDir('guardian-dir-problems-');
    assert.deepEqual(configuredDirectoryProblems(reloadConfig(dir)), []);
  });
});

describe('unreadable directories', () => {
  it('are listed, not skipped silently', { skip: process.getuid?.() === 0 }, () => {
    const dir = makeTempDir('guardian-unreadable-');
    mkdirSync(path.join(dir, 'src/locked'), { recursive: true });
    writeFileSync(path.join(dir, 'src/a.ts'), '// a\n');
    writeFileSync(path.join(dir, 'src/locked/b.ts'), '// b\n');
    writeFileSync(path.join(dir, 'guardian.config.json'), JSON.stringify({ sourceDirectories: ['src'] }));
    chmodSync(path.join(dir, 'src/locked'), 0o000);
    try {
      const set = listIndexFiles(reloadConfig(dir));
      assert.deepEqual(set.codeFiles.map(f => path.relative(dir, f)), ['src/a.ts']);
      assert.deepEqual(set.unreadableDirectories, ['src/locked']);
    } finally {
      chmodSync(path.join(dir, 'src/locked'), 0o755);
    }
  });

  it('is an empty list when everything can be read', () => {
    const dir = makeTempDir('guardian-unreadable-');
    assert.deepEqual(listIndexFiles(reloadConfig(dir)).unreadableDirectories, []);
  });
});

describe('classifyIndexFile', () => {
  it('gives every file the verdict a full walk would', () => {
    const dir = makeTempDir('guardian-classify-');
    writeFileSync(path.join(dir, 'guardian.config.json'), JSON.stringify({
      sourceDirectories: ['src', 'tests/support'],
      docsDirectories: ['docs'],
      excludeDirectories: ['generated'],
      fileExtensions: ['.ts', '.py'],
    }));
    const config = reloadConfig(dir);
    const verdict = (rel: string): string | null => classifyIndexFile(path.join(dir, rel), config);

    assert.equal(verdict('src/a.ts'), 'code');
    assert.equal(verdict('src/deep/b.py'), 'code');
    assert.equal(verdict('src/view.tsx'), null, 'extension not configured');
    assert.equal(verdict('src/a.test.ts'), null, 'test file');
    assert.equal(verdict('src/generated/g.ts'), null, 'excluded by the project');
    assert.equal(verdict('src/node_modules/p/x.ts'), null, 'excluded by default');
    assert.equal(verdict('scripts/x.ts'), null, 'outside the source directories');
    // The Python test-file rule is judged from the source directory, as the walk does.
    assert.equal(verdict('tests/support/helper.py'), 'code');
    assert.equal(verdict('src/tests/helper.py'), null);

    assert.equal(verdict('docs/guide.md'), 'doc');
    assert.equal(verdict('docs/generated/api.md'), null);
    assert.equal(verdict('src/README.md'), 'doc');
    assert.equal(verdict('src/deep/readme.md'), 'doc');
    assert.equal(verdict('src/NOTES.md'), null, 'only READMEs are read from source directories');
    assert.equal(verdict('CHANGELOG.md'), null);
  });

  it('agrees with listIndexFiles on a real tree', () => {
    const dir = makeTempDir('guardian-classify-');
    for (const file of ['src/a.ts', 'src/a.test.ts', 'src/build/y.ts', 'src/README.md', 'docs/g.md', 'other/x.ts']) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), '// x\n');
    }
    writeFileSync(path.join(dir, 'guardian.config.json'), JSON.stringify({ sourceDirectories: ['src'], docsDirectories: ['docs'] }));
    const config = reloadConfig(dir);
    const set = listIndexFiles(config);
    for (const file of set.codeFiles) assert.equal(classifyIndexFile(file, config), 'code', file);
    for (const file of set.docFiles) assert.equal(classifyIndexFile(file, config), 'doc', file);
    for (const rel of ['src/a.test.ts', 'src/build/y.ts', 'other/x.ts']) {
      assert.equal(classifyIndexFile(path.join(dir, rel), config), null, rel);
    }
  });
});

describe('isExcludedPath', () => {
  it('is true for a file under an excluded folder at any level', () => {
    const scope = { projectRoot: '/repo', exclude: ['node_modules', 'web/data'] };
    assert.equal(isExcludedPath('/repo/web/app/node_modules/p/x.ts', scope), true);
    assert.equal(isExcludedPath('/repo/web/data/seed.ts', scope), true);
    assert.equal(isExcludedPath('/repo/web/app/data/keep.ts', scope), false);
    assert.equal(isExcludedPath('/repo/web/app/a.ts', scope), false);
  });
});

describe('isExcludedDir', () => {
  it('matches a path entry exactly', () => {
    assert.equal(isExcludedDir('web/app/data', ['web/app/data']), true);
    assert.equal(isExcludedDir('other/data', ['web/app/data']), false);
    assert.equal(isExcludedDir('web/app/data/sub', ['web/app/data']), false);
  });

  it('matches a bare name against the last path segment', () => {
    assert.equal(isExcludedDir('x/y/node_modules', ['node_modules']), true);
    assert.equal(isExcludedDir('node_modules', ['node_modules']), true);
    assert.equal(isExcludedDir('x/node_modules_backup', ['node_modules']), false);
  });

  it('treats ./name and /name as a path from the project root, not a bare name', () => {
    for (const entry of ['./data', '/data', './data/']) {
      assert.equal(isExcludedDir('data', [entry]), true, `${entry} excludes the top-level folder`);
      assert.equal(isExcludedDir('web/app/nested/data', [entry]), false, `${entry} must not match at depth`);
    }
  });

  it('ignores empty entries', () => {
    assert.equal(isExcludedDir('web', ['', './', '/']), false);
  });
});
