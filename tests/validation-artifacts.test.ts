import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { clearValidationArtifacts, VALIDATION_ARTIFACT_FILES } from '../src/mcp-server/validation-artifacts.js';

describe('clearValidationArtifacts', () => {
  it('deletes both validation artifacts beside the DB and reports them', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guardian-artifacts-'));
    try {
      const dbPath = path.join(dir, 'code-quality.db');
      writeFileSync(dbPath, 'db');
      for (const name of VALIDATION_ARTIFACT_FILES) writeFileSync(path.join(dir, name), '{}');

      const cleared = clearValidationArtifacts(dbPath);

      assert.deepEqual(cleared.sort(), [...VALIDATION_ARTIFACT_FILES].sort());
      for (const name of VALIDATION_ARTIFACT_FILES) {
        assert.equal(existsSync(path.join(dir, name)), false, `${name} should be deleted`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when artifacts are absent (returns empty list, does not throw)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guardian-artifacts-'));
    try {
      const cleared = clearValidationArtifacts(path.join(dir, 'code-quality.db'));
      assert.deepEqual(cleared, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the database and other files untouched', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guardian-artifacts-'));
    try {
      const dbPath = path.join(dir, 'code-quality.db');
      writeFileSync(dbPath, 'db');
      writeFileSync(path.join(dir, '.validation-cache.json'), '{}');
      writeFileSync(path.join(dir, 'keep.txt'), 'keep');

      clearValidationArtifacts(dbPath);

      assert.equal(existsSync(dbPath), true, 'db must survive');
      assert.equal(existsSync(path.join(dir, 'keep.txt')), true, 'unrelated files must survive');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
