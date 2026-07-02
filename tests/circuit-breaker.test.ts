import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldStandDown, MAX_CONSECUTIVE_DENIALS } from '../src/hooks/helpers/circuit-breaker.js';

describe('shouldStandDown (circuit breaker)', () => {
  it('defaults to a threshold of 3', () => {
    assert.equal(MAX_CONSECUTIVE_DENIALS, 3);
  });

  it('blocks the first three attempts (denial counts 0, 1, 2) and releases on the fourth (3)', () => {
    // attemptCount = consecutive denials recorded so far for the session.
    // attempt #1 (first, count 0) → block; #2 (count 1) → block; #3 (count 2) → block;
    // #4 (count 3) → release.
    assert.equal(shouldStandDown(0), false, 'attempt #1 must be validated');
    assert.equal(shouldStandDown(1), false, 'attempt #2 must be validated');
    assert.equal(shouldStandDown(2), false, 'attempt #3 must be validated');
    assert.equal(shouldStandDown(3), true, 'attempt #4 must be released');
  });

  it('stays released for any count beyond the threshold', () => {
    assert.equal(shouldStandDown(4), true);
    assert.equal(shouldStandDown(10), true);
  });

  it('honors a custom threshold', () => {
    assert.equal(shouldStandDown(1, 2), false);
    assert.equal(shouldStandDown(2, 2), true);
  });
});
