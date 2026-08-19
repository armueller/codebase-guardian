import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  markUnitNovelty,
  checkPythonDocCompleteness,
} from '../src/hooks/helpers/py-doc-check.js';
import type { ExtractedFunction, ExtractedClass } from '../src/hooks/helpers/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeFunction(overrides: Partial<ExtractedFunction> = {}): ExtractedFunction {
  return {
    name: 'do_thing',
    fullCode: 'def do_thing():\n    pass',
    hasJSDoc: false,
    isNew: false,
    isModified: false,
    lineInFile: 1,
    requiresJSDoc: true,
    ...overrides,
  };
}

function makeClass(overrides: Partial<ExtractedClass> = {}): ExtractedClass {
  return {
    name: 'Widget',
    kind: 'class',
    fields: [],
    parent: null,
    docstring: 'A widget.\n\nDomain: widgets.',
    domains: ['widgets'],
    tags: [],
    layer: null,
    isNew: false,
    isModified: false,
    lineInFile: 1,
    ...overrides,
  };
}

const CLEAN_MODULE = { docstring: 'A clean module.\n\nDomain: sample.', domains: ['sample'], tags: [], layer: null };

// ─── markUnitNovelty ────────────────────────────────────────────────────────

describe('markUnitNovelty', () => {
  it('marks names present in the old set as modified (not new)', () => {
    const fn = makeFunction({ name: 'existing_fn' });
    const cls = makeClass({ name: 'ExistingClass' });
    markUnitNovelty(new Set(['existing_fn', 'ExistingClass']), [fn], [cls]);

    assert.equal(fn.isModified, true);
    assert.equal(fn.isNew, false);
    assert.equal(cls.isModified, true);
    assert.equal(cls.isNew, false);
  });

  it('marks names absent from the old set as new (not modified)', () => {
    const fn = makeFunction({ name: 'brand_new_fn' });
    const cls = makeClass({ name: 'BrandNewClass' });
    markUnitNovelty(new Set(['some_other_fn']), [fn], [cls]);

    assert.equal(fn.isNew, true);
    assert.equal(fn.isModified, false);
    assert.equal(cls.isNew, true);
    assert.equal(cls.isModified, false);
  });

  it('marks everything new when given an empty old-name set (new file)', () => {
    const fn = makeFunction({ name: 'anything' });
    const cls = makeClass({ name: 'Anything' });
    markUnitNovelty(new Set(), [fn], [cls]);

    assert.equal(fn.isNew, true);
    assert.equal(fn.isModified, false);
    assert.equal(cls.isNew, true);
    assert.equal(cls.isModified, false);
  });
});

// ─── checkPythonDocCompleteness ─────────────────────────────────────────────

describe('checkPythonDocCompleteness', () => {
  it('flags a class missing a Domain line', () => {
    const cls = makeClass({ name: 'NoDomain', docstring: 'A widget with no domain.', domains: [] });
    const violations = checkPythonDocCompleteness([], [cls], CLEAN_MODULE);

    const classViolations = violations.get('NoDomain');
    assert.ok(classViolations, 'expected violations for NoDomain');
    assert.ok(classViolations!.some(v => v.includes('Domain')));
  });

  it('flags a class missing a docstring entirely', () => {
    const cls = makeClass({ name: 'NoDocstring', docstring: null, domains: [] });
    const violations = checkPythonDocCompleteness([], [cls], CLEAN_MODULE);

    const classViolations = violations.get('NoDocstring');
    assert.ok(classViolations, 'expected violations for NoDocstring');
    assert.ok(classViolations!.some(v => v.includes('docstring')));
  });

  it('flags a public function missing a docstring', () => {
    const fn = makeFunction({ name: 'public_fn', requiresJSDoc: true, hasJSDoc: false });
    const violations = checkPythonDocCompleteness([fn], [], CLEAN_MODULE);

    const fnViolations = violations.get('public_fn');
    assert.ok(fnViolations, 'expected violations for public_fn');
    assert.ok(fnViolations!.some(v => v.includes('docstring')));
  });

  it('does NOT flag a private function missing a docstring', () => {
    const fn = makeFunction({ name: '_private_fn', requiresJSDoc: false, hasJSDoc: false });
    const violations = checkPythonDocCompleteness([fn], [], CLEAN_MODULE);

    assert.equal(violations.has('_private_fn'), false);
  });

  it('does not flag a class with both docstring and domains present', () => {
    const cls = makeClass({ name: 'CleanClass', docstring: 'Clean.\n\nDomain: sample.', domains: ['sample'] });
    const violations = checkPythonDocCompleteness([], [cls], CLEAN_MODULE);

    assert.equal(violations.has('CleanClass'), false);
  });

  it('flags a module missing a docstring and Domain under __module__', () => {
    const violations = checkPythonDocCompleteness([], [], { docstring: null, domains: [], tags: [], layer: null });

    const moduleViolations = violations.get('__module__');
    assert.ok(moduleViolations, 'expected violations under __module__');
    assert.ok(moduleViolations!.some(v => v.includes('docstring')));
    assert.ok(moduleViolations!.some(v => v.includes('Domain')));
  });

  it('does not flag a clean module', () => {
    const violations = checkPythonDocCompleteness([], [], CLEAN_MODULE);
    assert.equal(violations.has('__module__'), false);
  });

  it('returns an empty map when everything is clean', () => {
    const fn = makeFunction({ name: 'public_fn', requiresJSDoc: true, hasJSDoc: true });
    const privateFn = makeFunction({ name: '_private_fn', requiresJSDoc: false, hasJSDoc: false });
    const cls = makeClass();
    const violations = checkPythonDocCompleteness([fn, privateFn], [cls], CLEAN_MODULE);

    assert.equal(violations.size, 0);
  });

  it('does not require Args/Returns/Tags on a public function or class', () => {
    // A function with a docstring but no Args/Returns section, and a class with
    // domains but no Tags, should NOT be flagged — those are not required by the
    // pragmatic convention.
    const fn = makeFunction({ name: 'simple_fn', requiresJSDoc: true, hasJSDoc: true });
    const cls = makeClass({ name: 'NoTags', docstring: 'Has a docstring.\n\nDomain: sample.', domains: ['sample'], tags: [] });
    const violations = checkPythonDocCompleteness([fn], [cls], CLEAN_MODULE);

    assert.equal(violations.has('simple_fn'), false);
    assert.equal(violations.has('NoTags'), false);
  });

  it('ignores a module-kind entry in the classes array (module info comes from the module param)', () => {
    const moduleUnit = makeClass({ name: '__module_unit__', kind: 'module', docstring: null, domains: [] });
    const violations = checkPythonDocCompleteness([], [moduleUnit], CLEAN_MODULE);

    assert.equal(violations.has('__module_unit__'), false);
  });
});
