import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { countChangesSinceBuild } from '../src/hooks/helpers/index-staleness.js';

describe('countChangesSinceBuild', () => {
  it('returns 0 (fail-safe) when the db does not exist', () => {
    assert.equal(countChangesSinceBuild(process.cwd(), '/no/such/code-quality.db'), 0);
  });

  it('returns 0 (fail-safe) when the project root is not a git repo', () => {
    assert.equal(countChangesSinceBuild('/', '/no/such/code-quality.db'), 0);
  });

  it('returns a non-negative number for a real repo + db mtime', () => {
    // Use this repo's own package.json as a stand-in "db" (its mtime is a valid --since anchor);
    // the count is data-dependent, so we only assert it's a sane non-negative integer.
    const n = countChangesSinceBuild(process.cwd(), 'package.json');
    assert.ok(Number.isInteger(n) && n >= 0);
  });
});
