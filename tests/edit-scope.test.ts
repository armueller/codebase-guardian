import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeEditScope } from '../src/hooks/helpers/edit-scope.js';
import { buildRetryPrompt } from '../src/hooks/helpers/claude-headless.js';

describe('describeEditScope', () => {
  it('reports a new file as entirely in scope', () => {
    const s = describeEditScope({ isNewFile: true, oldString: '', newString: '', currentFileOnDisk: '', newContent: 'export const a = 1;' });
    assert.match(s, /NEW FILE/);
  });

  it('shows the old → new replacement for an Edit', () => {
    const s = describeEditScope({
      isNewFile: false,
      oldString: 'const a = 1;',
      newString: 'const a = 2;',
      currentFileOnDisk: 'const a = 1;',
      newContent: 'const a = 2;',
    });
    assert.match(s, /REPLACED/);
    assert.ok(s.includes('const a = 1;'), 'shows removed text');
    assert.ok(s.includes('const a = 2;'), 'shows added text');
  });

  it('isolates the changed region of a full-file Write and excludes unchanged lines', () => {
    const oldContent = ['keepA', 'keepB', 'TARGET_OLD', 'keepC', 'keepD'].join('\n');
    const newContent = ['keepA', 'keepB', 'TARGET_NEW', 'keepC', 'keepD'].join('\n');
    const s = describeEditScope({ isNewFile: false, oldString: '', newString: '', currentFileOnDisk: oldContent, newContent });
    assert.ok(s.includes('TARGET_OLD'), 'shows the removed line');
    assert.ok(s.includes('TARGET_NEW'), 'shows the added line');
    assert.ok(!s.includes('keepA'), 'excludes unchanged surrounding lines');
  });
});

describe('buildRetryPrompt change-scope wiring', () => {
  const base = {
    filePath: 'x.ts',
    extractedFunctions: [],
    extractedTypes: [],
    jsdocViolations: new Map<string, string[]>(),
    typeJsdocViolations: new Map<string, string[]>(),
  };

  it('renders the change-scope block when editScope is provided', () => {
    const prompt = buildRetryPrompt({ ...base, editScope: 'SENTINEL_SCOPE_MARKER' });
    assert.match(prompt, /SENTINEL_SCOPE_MARKER/);
    assert.match(prompt, /WHAT THIS EDIT ACTUALLY CHANGED/);
  });

  it('omits the block when editScope is absent', () => {
    const prompt = buildRetryPrompt({ ...base });
    assert.ok(!prompt.includes('WHAT THIS EDIT ACTUALLY CHANGED'));
  });
});
