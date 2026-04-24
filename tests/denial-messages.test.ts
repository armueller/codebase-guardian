import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enhanceViolationWithQueryHint } from '../src/hooks/helpers/denial-hints.js';

describe('enhanceViolationWithQueryHint', () => {
  it('adds semanticSearch hint for DRY violations', () => {
    const violation = "Function 'calculateFees' duplicates existing 'computeFees' in utils/fees.ts:23";
    const enhanced = enhanceViolationWithQueryHint(violation);
    assert.ok(enhanced.includes(violation), 'Should preserve original violation');
    assert.ok(enhanced.includes('api.semanticSearch'), 'Should suggest semanticSearch');
  });

  it('adds functionsByDirectory hint for pattern violations', () => {
    const violation = "Function 'snake_case_name' does not follow camelCase naming convention used by sibling functions";
    const enhanced = enhanceViolationWithQueryHint(violation);
    assert.ok(enhanced.includes('api.functionsByDirectory'), 'Should suggest functionsByDirectory');
  });

  it('adds callers hint for blast radius violations', () => {
    const violation = "Function 'processOrder' signature changed — 3 callers may break";
    const enhanced = enhanceViolationWithQueryHint(violation);
    assert.ok(enhanced.includes('api.callers'), 'Should suggest callers');
  });

  it('adds searchDocs hint for documentation violations', () => {
    const violation = "Function violates documented error handling pattern in docs/error-patterns.md";
    const enhanced = enhanceViolationWithQueryHint(violation);
    assert.ok(enhanced.includes('api.searchDocs'), 'Should suggest searchDocs');
  });

  it('does not add hint for JSDoc violations', () => {
    const violation = "Function 'formatDate' missing @returns tag";
    const enhanced = enhanceViolationWithQueryHint(violation);
    assert.equal(enhanced, violation, 'JSDoc violations should not get hints');
  });

  it('does not double-hint if violation already contains api reference', () => {
    const violation = "Use api.lookup('existingHelper') — duplicate detected";
    const enhanced = enhanceViolationWithQueryHint(violation);
    assert.equal(enhanced, violation, 'Should not add hint if api reference already present');
  });
});
