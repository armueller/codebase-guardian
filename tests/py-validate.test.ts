import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatePythonEdit, extractPythonComments } from '../src/hooks/helpers/py-validate.js';
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

// ─── extractPythonComments ───────────────────────────────────────────────────
//
// Feeds buildPatternContext's step-level DRY comment search (mirrors extractInlineComments'
// role for the TypeScript path — see code-index-client.test.ts for that extractor's tests).

describe('extractPythonComments', () => {
  it('extracts a standalone `#` comment line', () => {
    const result = extractPythonComments('# calculate total price\nx = compute(y)\n');
    assert.deepEqual(result, ['calculate total price']);
  });

  it('extracts a trailing `# ...` comment after code (unlike the TS // extractor)', () => {
    const result = extractPythonComments('total = price * count  # apply quantity multiplier\n');
    assert.deepEqual(result, ['apply quantity multiplier']);
  });

  it('extracts one comment per line for multiple commented lines', () => {
    const source = '# step one: validate input\nvalidate(x)\n# step two: persist result\nsave(x)\n';
    const result = extractPythonComments(source);
    assert.deepEqual(result, ['step one: validate input', 'step two: persist result']);
  });

  it('ignores lines with no comment', () => {
    const result = extractPythonComments('x = 1\ny = 2\n');
    assert.deepEqual(result, []);
  });

  it('filters comments shorter than 5 characters', () => {
    const result = extractPythonComments('# ok\n');
    assert.deepEqual(result, []);
  });

  it('keeps comments exactly 5 characters', () => {
    const result = extractPythonComments('# hello\n');
    assert.deepEqual(result, ['hello']);
  });

  it('handles empty input', () => {
    assert.deepEqual(extractPythonComments(''), []);
  });
});
