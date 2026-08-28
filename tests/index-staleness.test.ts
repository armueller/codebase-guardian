import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { countChangesSinceBuild } from '../src/hooks/helpers/index-staleness.js';

const SCOPE = { extensions: ['.ts', '.py'], sourceDirectories: ['.'], docsDirectories: ['docs'] };

const IDENT = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};

function git(repo: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', env: { ...process.env, ...IDENT, ...env } });
}

function commitAt(repo: string, iso: string, message: string): void {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
}

describe('countChangesSinceBuild', () => {
  it('returns 0 (fail-safe) when the db does not exist', () => {
    assert.equal(countChangesSinceBuild(process.cwd(), '/no/such/code-quality.db', SCOPE), 0);
  });

  it('returns 0 (fail-safe) when the project root is not a git repo', () => {
    assert.equal(countChangesSinceBuild('/', '/no/such/code-quality.db', SCOPE), 0);
  });

  it('counts distinct indexed files changed since the db mtime, ignoring pre-build and non-indexed files', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'guardian-staleness-'));
    git(repo, ['init', '-q']);

    // Baseline: a source file + the "db", committed BEFORE the build time.
    const db = path.join(repo, 'code-quality.db');
    writeFileSync(db, 'x');
    writeFileSync(path.join(repo, 'base.ts'), '1');
    commitAt(repo, '2020-01-01T00:00:00', 'base');

    // Pin the db mtime to the "last build" time (2020-06-01). --since compares against this.
    const builtAt = new Date('2020-06-01T00:00:00Z');
    utimesSync(db, builtAt, builtAt);

    // Commits AFTER the build: a.ts touched twice (1 distinct), b.py once (1 distinct),
    // notes.txt (non-indexed, ignored). base.ts is untouched and pre-build (ignored).
    writeFileSync(path.join(repo, 'a.ts'), '1');
    commitAt(repo, '2020-07-01T00:00:00', 'c1');
    writeFileSync(path.join(repo, 'a.ts'), '2');
    writeFileSync(path.join(repo, 'notes.txt'), 'x');
    commitAt(repo, '2020-07-02T00:00:00', 'c2');
    writeFileSync(path.join(repo, 'b.py'), '1');
    commitAt(repo, '2020-07-03T00:00:00', 'c3');

    assert.equal(countChangesSinceBuild(repo, db, SCOPE), 2);
  });

  it('scopes to source directories, excluding matching extensions outside them', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'guardian-staleness-'));
    git(repo, ['init', '-q']);
    const db = path.join(repo, 'code-quality.db');
    writeFileSync(db, 'x');
    commitAt(repo, '2020-01-01T00:00:00', 'base');
    const builtAt = new Date('2020-06-01T00:00:00Z');
    utimesSync(db, builtAt, builtAt);

    mkdirSync(path.join(repo, 'src'), { recursive: true });
    mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'a.ts'), '1');       // indexed (under src/)
    writeFileSync(path.join(repo, 'scripts', 'b.ts'), '1');   // not indexed (outside src/)
    commitAt(repo, '2020-07-01T00:00:00', 'c1');

    // Only src/ is indexed → 1 file (src/a.ts); scripts/b.ts excluded.
    assert.equal(countChangesSinceBuild(repo, db, { extensions: ['.ts'], sourceDirectories: ['src'], docsDirectories: [] }), 1);
  });
});
