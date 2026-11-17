import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reloadConfig, DEFAULT_EXCLUDE } from '../src/config.js';
import { listIndexFiles, isExcludedDir } from '../src/mcp-server/file-walk.js';

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
    root = mkdtempSync(path.join(tmpdir(), 'guardian-file-walk-'));
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

  it('a configured list replaces the defaults; a bare name matches at any depth', () => {
    const { codeFiles } = list({ ...base, excludeDirectories: ['data'] });
    assert.deepEqual(codeFiles, ['web/app/a.ts', 'web/app/build/y.ts', 'web/app/node_modules/p/x.ts']);
  });

  it('an entry with a slash matches only that path from the project root', () => {
    const { codeFiles } = list({ ...base, excludeDirectories: [...DEFAULT_EXCLUDE, 'web/app/data'] });
    assert.deepEqual(codeFiles, ['web/app/a.ts', 'web/app/nested/data/keep.ts']);
  });

  it('tolerates a leading ./ and a trailing slash on a path entry', () => {
    const { codeFiles } = list({ ...base, excludeDirectories: [...DEFAULT_EXCLUDE, './web/app/data/'] });
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

  it('ignores empty entries', () => {
    assert.equal(isExcludedDir('web', ['', './', '/']), false);
  });
});
