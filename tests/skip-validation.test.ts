import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSkipValidation,
  VALIDATABLE_EXTENSIONS,
  isPythonFile,
  requiresCodeIndex
} from '../src/hooks/helpers/skip-validation.js';

describe('shouldSkipValidation (allow-list)', () => {
  it('validates TypeScript sources', () => {
    assert.equal(shouldSkipValidation('/repo/app/foo.ts'), false);
    assert.equal(shouldSkipValidation('/repo/app/Button.tsx'), false);
    // Test files are validated (with relaxed rules downstream), not skipped here.
    assert.equal(shouldSkipValidation('/repo/app/foo.test.ts'), false);
  });

  it('validates Python sources now that the guardian_py extraction path exists', () => {
    // Python got its own extractor (py-adapter.ts) wired into a dedicated
    // validation path (py-validate.ts), so .py is no longer routed through the
    // TS-only pipeline this allow-list originally guarded against.
    assert.equal(shouldSkipValidation('/repo/ml/labelgen/marking.py'), false);
  });

  it('still skips unsupported languages so they are not mangled by the TS parser', () => {
    // .pyi stub files have no guardian_py extraction path (yet) — still skipped.
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
    assert.equal(shouldSkipValidation('/repo/app/Foo.PY'), false);
  });

  it('includes Python now that a matching Python extraction path exists', () => {
    // .py is only safe in this allow-list because py-validate.ts dispatches it
    // to the guardian_py extractor instead of the TS-only pipeline.
    assert.equal(VALIDATABLE_EXTENSIONS.has('.py'), true);
  });
});

describe('isPythonFile', () => {
  it('recognizes .py files', () => {
    assert.equal(isPythonFile('/repo/ml/labelgen/marking.py'), true);
  });

  it('is case-insensitive on the extension', () => {
    assert.equal(isPythonFile('/repo/ml/Foo.PY'), true);
  });

  it('rejects non-Python files', () => {
    assert.equal(isPythonFile('/repo/app/foo.ts'), false);
    assert.equal(isPythonFile('/repo/app/Button.tsx'), false);
    assert.equal(isPythonFile('/repo/ml/models.pyi'), false);
  });
});

describe('requiresCodeIndex', () => {
  it('Python files do not require the TS code index (they have their own validation path)', () => {
    assert.equal(requiresCodeIndex('/repo/ml/labelgen/marking.py'), false);
  });

  it('TypeScript files require the TS code index', () => {
    assert.equal(requiresCodeIndex('/repo/app/foo.ts'), true);
    assert.equal(requiresCodeIndex('/repo/app/Button.tsx'), true);
  });
});
