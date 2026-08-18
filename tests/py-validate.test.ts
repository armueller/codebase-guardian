import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatePythonEdit } from '../src/hooks/helpers/py-validate.js';
import type { HookInput } from '../src/hooks/helpers/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeInput(filePath: string, content: string): HookInput {
  return {
    session_id: 'test-session-py-validate',
    tool_name: 'Write',
    tool_input: {
      file_path: filePath,
      content,
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────
//
// Only the fail-open early returns are covered here — they resolve before
// headless Claude is ever invoked. The full allow/deny path makes a real
// ~15s headless Claude call and is verified empirically in the deploy task
// (P2.5), not in this unit suite.

describe('validatePythonEdit (fail-open early returns)', () => {
  it('allows without invoking headless Claude when Python tooling is unavailable', async () => {
    const original = process.env.GUARDIAN_HOME;
    process.env.GUARDIAN_HOME = '/tmp/guardian-home-does-not-exist-xyz';
    try {
      const content = 'x = 1\n';
      const input = makeInput('/tmp/guardian-py-validate-test/whatever.py', content);
      const result = await validatePythonEdit(input, content, '', Date.now());
      assert.equal(result.action, 'allow');
      assert.match(result.message ?? '', /unavailable/i);
    } finally {
      if (original === undefined) {
        delete process.env.GUARDIAN_HOME;
      } else {
        process.env.GUARDIAN_HOME = original;
      }
    }
  });

  it('allows an intermediate/partial-parse Python edit without invoking headless Claude', async () => {
    const content = 'def oops(:\n';
    const input = makeInput('/tmp/guardian-py-validate-test/broken.py', content);
    const result = await validatePythonEdit(input, content, '', Date.now());
    assert.equal(result.action, 'allow');
    assert.match(result.message ?? '', /partial|intermediate/i);
  });
});
