import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeOutput } from '../src/hooks/helpers/claude-headless.js';

describe('parseClaudeOutput', () => {
  it('parses a clean result envelope with allow decision', () => {
    const input = JSON.stringify({
      session_id: 'sess-123',
      result: JSON.stringify({
        decision: 'allow',
        violations: [],
        reasoning: 'Code looks good'
      })
    });
    const { response, headlessSessionId } = parseClaudeOutput(input);
    assert.equal(response.decision, 'allow');
    assert.equal(response.violations.length, 0);
    assert.equal(headlessSessionId, 'sess-123');
  });

  it('parses a deny decision with violations', () => {
    const input = JSON.stringify({
      session_id: 'sess-456',
      result: JSON.stringify({
        decision: 'deny',
        violations: [
          { rule: 'DRY', message: 'Duplicate of existingFunc' }
        ],
        reasoning: 'Found duplicate'
      })
    });
    const { response } = parseClaudeOutput(input);
    assert.equal(response.decision, 'deny');
    assert.equal(response.violations.length, 1);
  });

  it('extracts from response field (alternative envelope)', () => {
    const input = JSON.stringify({
      response: JSON.stringify({
        decision: 'allow',
        violations: [],
        reasoning: 'OK'
      })
    });
    const { response } = parseClaudeOutput(input);
    assert.equal(response.decision, 'allow');
  });

  it('extracts from content array (another envelope format)', () => {
    const input = JSON.stringify({
      session_id: 'sess-789',
      content: [{
        text: JSON.stringify({
          decision: 'deny',
          violations: [{ rule: 'JSDoc', message: 'Missing @what' }],
          reasoning: 'Incomplete JSDoc'
        })
      }]
    });
    const { response, headlessSessionId } = parseClaudeOutput(input);
    assert.equal(response.decision, 'deny');
    assert.equal(headlessSessionId, 'sess-789');
  });

  it('extracts JSON from markdown code blocks', () => {
    const inner = '```json\n{"decision":"allow","violations":[],"reasoning":"OK"}\n```';
    const input = JSON.stringify({ result: inner });
    const { response } = parseClaudeOutput(input);
    assert.equal(response.decision, 'allow');
  });

  it('extracts JSON from code block without json label', () => {
    const inner = '```\n{"decision":"allow","violations":[],"reasoning":"OK"}\n```';
    const input = JSON.stringify({ result: inner });
    const { response } = parseClaudeOutput(input);
    assert.equal(response.decision, 'allow');
  });

  it('extracts JSON embedded in surrounding text', () => {
    const inner = 'Here is my analysis:\n{"decision":"deny","violations":[{"rule":"DRY","message":"dup"}],"reasoning":"found dup"}\nEnd of analysis.';
    const input = JSON.stringify({ result: inner });
    const { response } = parseClaudeOutput(input);
    assert.equal(response.decision, 'deny');
  });

  it('returns null session_id when not present', () => {
    const input = JSON.stringify({
      result: JSON.stringify({
        decision: 'allow',
        violations: [],
        reasoning: 'OK'
      })
    });
    const { headlessSessionId } = parseClaudeOutput(input);
    assert.equal(headlessSessionId, null);
  });

  it('throws on invalid JSON input', () => {
    assert.throws(() => parseClaudeOutput('not json at all'));
  });

  it('throws when no JSON object found in response text', () => {
    const input = JSON.stringify({ result: 'Just plain text with no JSON' });
    assert.throws(() => parseClaudeOutput(input), /Could not extract JSON/);
  });

  it('throws on missing decision field', () => {
    const input = JSON.stringify({
      result: JSON.stringify({ violations: [], reasoning: 'OK' })
    });
    assert.throws(() => parseClaudeOutput(input), /Invalid validation response/);
  });

  it('throws on missing violations array', () => {
    const input = JSON.stringify({
      result: JSON.stringify({ decision: 'allow', reasoning: 'OK' })
    });
    assert.throws(() => parseClaudeOutput(input), /Invalid validation response/);
  });

  it('provides default reasoning when not present', () => {
    const input = JSON.stringify({
      result: JSON.stringify({ decision: 'allow', violations: [] })
    });
    const { response } = parseClaudeOutput(input);
    assert.equal(response.reasoning, 'No reasoning provided');
  });
});
