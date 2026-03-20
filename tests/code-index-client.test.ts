import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractInlineComments } from '../src/hooks/helpers/code-index-client.js';

describe('extractInlineComments', () => {
  it('extracts single-line comments', () => {
    const code = '// Map asset fields from Polygon API\nconst assets = mapFields(raw);';
    const result = extractInlineComments(code);
    assert.equal(result.length, 1);
    assert.equal(result[0], 'Map asset fields from Polygon API');
  });

  it('merges consecutive // lines', () => {
    const code = '// Calculate the weighted average price by dividing\n// total invested capital by total shares purchased\nconst avg = total / shares;';
    const result = extractInlineComments(code);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('weighted average'));
    assert.ok(result[0].includes('total shares'));
  });

  it('separates comments broken by code', () => {
    const code = '// First comment here for testing\nconst x = 1;\n// Second comment here for testing\nconst y = 2;';
    const result = extractInlineComments(code);
    assert.equal(result.length, 2);
  });

  it('filters comments shorter than 5 characters', () => {
    const code = '// Hi\nconst x = 1;';
    const result = extractInlineComments(code);
    assert.equal(result.length, 0);
  });

  it('keeps comments exactly 5 characters', () => {
    const code = '// Hello\nconst x = 1;';
    const result = extractInlineComments(code);
    assert.equal(result.length, 1);
  });

  it('returns empty for code with no comments', () => {
    const result = extractInlineComments('const x = 1;\nconst y = 2;');
    assert.equal(result.length, 0);
  });

  it('handles empty input', () => {
    const result = extractInlineComments('');
    assert.equal(result.length, 0);
  });

  it('handles code with only blank lines', () => {
    const result = extractInlineComments('\n\n\n');
    assert.equal(result.length, 0);
  });

  it('flushes accumulated comments at end of input', () => {
    const code = '// Trailing comment at end of file';
    const result = extractInlineComments(code);
    assert.equal(result.length, 1);
  });

  it('does not extract end-of-line comments (only full-line)', () => {
    const code = 'const x = 1; // inline comment here for testing';
    const result = extractInlineComments(code);
    // extractInlineComments only captures full-line // comments, not end-of-line
    assert.equal(result.length, 0);
  });
});
