import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSkipValidation,
  VALIDATABLE_EXTENSIONS
} from '../src/hooks/helpers/skip-validation.js';

describe('shouldSkipValidation (allow-list)', () => {
  it('validates TypeScript sources', () => {
    assert.equal(shouldSkipValidation('/repo/app/foo.ts'), false);
    assert.equal(shouldSkipValidation('/repo/app/Button.tsx'), false);
    // Test files are validated (with relaxed rules downstream), not skipped here.
    assert.equal(shouldSkipValidation('/repo/app/foo.test.ts'), false);
  });

  it('skips unsupported languages so they are not mangled by the TS parser', () => {
    // The regression that motivated the allow-list: Python files in RMWM2's ml/ tree.
    assert.equal(shouldSkipValidation('/repo/ml/labelgen/marking.py'), true);
    assert.equal(shouldSkipValidation('/repo/ml/models.pyi'), true);
    // Other unsupported languages the deny-list would have wrongly validated.
    assert.equal(shouldSkipValidation('/repo/src/app.js'), true);
    assert.equal(shouldSkipValidation('/repo/src/app.jsx'), true);
    assert.equal(shouldSkipValidation('/repo/src/app.mjs'), true);
    assert.equal(shouldSkipValidation('/repo/main.go'), true);
    assert.equal(shouldSkipValidation('/repo/lib.rs'), true);
  });

  it('skips docs, config, and data files (previously deny-listed)', () => {
    assert.equal(shouldSkipValidation('/repo/README.md'), true);
    assert.equal(shouldSkipValidation('/repo/notes.txt'), true);
    assert.equal(shouldSkipValidation('/repo/data.json'), true);
    assert.equal(shouldSkipValidation('/repo/package.json'), true);
    assert.equal(shouldSkipValidation('/repo/tsconfig.json'), true);
    assert.equal(shouldSkipValidation('/repo/.gitignore'), true);
  });

  it('skips secret/local config and validation infrastructure even when .ts', () => {
    assert.equal(shouldSkipValidation('/repo/.env'), true);
    assert.equal(shouldSkipValidation('/repo/.env.production'), true);
    assert.equal(shouldSkipValidation('/repo/CLAUDE.local.md'), true);
    // A .ts file inside .claude/hooks/ is validation infrastructure — must be skipped
    // despite its otherwise-validatable extension.
    assert.equal(shouldSkipValidation('/repo/.claude/hooks/my-hook.ts'), true);
  });

  it('is case-insensitive on the extension', () => {
    assert.equal(shouldSkipValidation('/repo/app/Foo.TS'), false);
    assert.equal(shouldSkipValidation('/repo/app/Foo.PY'), true);
  });

  it('does not yet include Python — added only when a Python extractor exists', () => {
    // Guards against adding .py to the allow-list without a matching extraction path,
    // which would reintroduce the TS-parser-on-Python breakage.
    assert.equal(VALIDATABLE_EXTENSIONS.has('.py'), false);
  });
});
