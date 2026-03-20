import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJSDocTags, validateJSDocCompleteness, validateTypeJSDocCompleteness, extractFunctionParameterNames } from '../src/hooks/helpers/jsdoc-parser.js';

describe('parseJSDocTags', () => {
  it('parses a complete JSDoc block', () => {
    const jsdoc = `/**
 * @what Calculates profit
 * @how Subtracts cost from revenue
 * @why Business needs profit tracking
 * @param {number} revenue Total revenue
 * @param {number} cost Total cost
 * @returns {number} The profit amount
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain trading
 * @tags profit, calculation, revenue
 */`;
    const result = parseJSDocTags(jsdoc);
    assert.ok(result);
    assert.equal(result!.what, 'Calculates profit');
    assert.equal(result!.how, 'Subtracts cost from revenue');
    assert.equal(result!.why, 'Business needs profit tracking');
    assert.equal(result!.params.length, 2);
    assert.equal(result!.params[0].name, 'revenue');
    assert.equal(result!.params[1].name, 'cost');
    assert.ok(result!.returns?.includes('profit'));
    assert.equal(result!.sideeffects, 'None');
    assert.equal(result!.systemlayer, 'Business Logic');
    assert.equal(result!.domain, 'trading');
    assert.deepEqual(result!.tags, ['profit', 'calculation', 'revenue']);
  });

  it('returns null for non-JSDoc input', () => {
    assert.equal(parseJSDocTags('// just a comment'), null);
    assert.equal(parseJSDocTags('not a comment at all'), null);
  });

  it('handles JSDoc with missing optional tags', () => {
    const jsdoc = `/**\n * @what Something\n * @domain test\n */`;
    const result = parseJSDocTags(jsdoc);
    assert.ok(result);
    assert.equal(result!.what, 'Something');
    assert.equal(result!.how, undefined);
    assert.equal(result!.why, undefined);
  });

  it('parses @param without type annotation', () => {
    const jsdoc = `/**\n * @param name The user name\n */`;
    const result = parseJSDocTags(jsdoc);
    assert.ok(result);
    assert.equal(result!.params.length, 1);
    assert.equal(result!.params[0].name, 'name');
    assert.equal(result!.params[0].type, 'any');
  });

  it('returns empty tags array when @tags is missing', () => {
    const jsdoc = `/**\n * @what Something\n */`;
    const result = parseJSDocTags(jsdoc);
    assert.ok(result);
    assert.deepEqual(result!.tags, []);
  });
});

describe('validateJSDocCompleteness', () => {
  it('returns empty array for complete JSDoc', () => {
    const violations = validateJSDocCompleteness({
      what: 'Does something',
      how: 'Using a method',
      why: 'Because reasons',
      params: [],
      returns: 'void',
      sideeffects: 'None',
      systemlayer: 'Business Logic',
      domain: 'trading',
      tags: ['one', 'two', 'three']
    });
    assert.equal(violations.length, 0);
  });

  it('reports all missing required tags', () => {
    const violations = validateJSDocCompleteness({
      params: [],
      tags: []
    } as any);
    assert.ok(violations.some(v => v.includes('@what')));
    assert.ok(violations.some(v => v.includes('@how')));
    assert.ok(violations.some(v => v.includes('@why')));
    assert.ok(violations.some(v => v.includes('@returns')));
    assert.ok(violations.some(v => v.includes('@sideeffects')));
    assert.ok(violations.some(v => v.includes('@systemlayer')));
    assert.ok(violations.some(v => v.includes('@domain')));
    assert.ok(violations.some(v => v.includes('@tags')));
  });

  it('reports insufficient tags count', () => {
    const violations = validateJSDocCompleteness({
      what: 'x', how: 'y', why: 'z',
      params: [], returns: 'void',
      sideeffects: 'None', systemlayer: 'Util', domain: 'test',
      tags: ['one', 'two']
    });
    assert.equal(violations.length, 1);
    assert.ok(violations[0].includes('only 2'));
  });
});

describe('validateTypeJSDocCompleteness', () => {
  it('returns empty for type with @what and @domain and tags', () => {
    const violations = validateTypeJSDocCompleteness({
      what: 'Stock data model',
      params: [],
      tags: ['model', 'stock'],
      domain: 'trading'
    } as any);
    assert.equal(violations.length, 0);
  });

  it('requires @what for types', () => {
    const violations = validateTypeJSDocCompleteness({
      params: [], tags: ['a', 'b'], domain: 'test'
    } as any);
    assert.ok(violations.some(v => v.includes('@what')));
  });

  it('recommends @domain for types', () => {
    const violations = validateTypeJSDocCompleteness({
      what: 'Something', params: [], tags: ['a', 'b']
    } as any);
    assert.ok(violations.some(v => v.includes('@domain')));
  });
});

describe('extractFunctionParameterNames', () => {
  it('extracts params from function declaration', () => {
    const result = extractFunctionParameterNames('function foo(a: number, b: string) {');
    assert.deepEqual(result, ['a', 'b']);
  });

  it('extracts params from arrow function', () => {
    const result = extractFunctionParameterNames('const foo = (x: number, y: number) =>');
    assert.deepEqual(result, ['x', 'y']);
  });

  it('returns empty for no-param function', () => {
    const result = extractFunctionParameterNames('function foo() {');
    assert.deepEqual(result, []);
  });

  it('handles destructured parameters', () => {
    const result = extractFunctionParameterNames('function foo({ name, age }: Props) {');
    assert.ok(result.length > 0);
  });

  it('handles params with defaults', () => {
    const result = extractFunctionParameterNames('function foo(x = 10, y = 20) {');
    assert.deepEqual(result, ['x', 'y']);
  });
});
