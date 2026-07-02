import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPreToolUseDecision } from '../src/hooks/helpers/hook-output.js';

describe('buildPreToolUseDecision', () => {
  it('builds a blocking deny in the exact schema Claude Code honors', () => {
    const out = buildPreToolUseDecision('deny', 'BLOCKED: duplicates existing helper');
    assert.deepEqual(out, {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'BLOCKED: duplicates existing helper'
      }
    });
  });

  it('nests the decision under hookSpecificOutput — NOT the flat stderr shape that never blocked', () => {
    // Regression guard for the enforcement bug: a deny is only honored when it
    // arrives via `hookSpecificOutput` on stdout. The old flat
    // `{ permissionDecision: 'deny' }` on stderr + exit(2) was classified by
    // Claude Code 2.1.x as `hook_non_blocking_error`, so every deny was a no-op.
    const out = buildPreToolUseDecision('deny', 'x') as Record<string, unknown>;
    assert.equal(out.permissionDecision, undefined, 'must not use the flat top-level shape');
    assert.equal(out.action, undefined, 'must not use the legacy {action} shape');
    assert.equal(out.hookSpecificOutput !== undefined, true, 'must nest under hookSpecificOutput');
  });

  it('supports allow and ask decisions', () => {
    assert.deepEqual(buildPreToolUseDecision('allow'), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
    });
    assert.deepEqual(buildPreToolUseDecision('ask', 'needs review'), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'needs review'
      }
    });
  });

  it('omits permissionDecisionReason when no reason is given', () => {
    const out = buildPreToolUseDecision('allow');
    assert.equal('permissionDecisionReason' in out.hookSpecificOutput, false);
  });
});
