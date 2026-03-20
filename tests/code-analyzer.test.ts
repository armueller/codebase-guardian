import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCalledFunctions,
  extractPropertyAccesses,
  analyzeFunctionUsage,
  analyzeTypeUsage,
  extractDeclaredFunctions,
  extractDeclaredTypes,
  findEnclosingFunctions
} from '../src/hooks/helpers/code-analyzer.js';

describe('extractCalledFunctions', () => {
  it('extracts simple function calls', () => {
    const result = extractCalledFunctions('const x = calculateProfit(100);\nformatPrice(x);');
    assert.ok(result.includes('calculateProfit'));
    assert.ok(result.includes('formatPrice'));
  });

  it('filters out JavaScript keywords', () => {
    const result = extractCalledFunctions('if (true) { return foo(); }');
    assert.ok(!result.includes('if'));
    assert.ok(!result.includes('return'));
    assert.ok(result.includes('foo'));
  });

  it('ignores function calls inside comments', () => {
    const result = extractCalledFunctions('// calculateProfit(100)\nconst x = 1;');
    assert.ok(!result.includes('calculateProfit'));
  });

  it('ignores function calls inside block comments', () => {
    const result = extractCalledFunctions('/* calculateProfit(100) */\nconst x = 1;');
    assert.ok(!result.includes('calculateProfit'));
  });

  it('deduplicates multiple calls to same function', () => {
    const result = extractCalledFunctions('foo(1);\nfoo(2);\nfoo(3);');
    assert.equal(result.filter(f => f === 'foo').length, 1);
  });

  it('returns empty for code with no function calls', () => {
    const result = extractCalledFunctions('const x = 1;\nconst y = 2;');
    assert.equal(result.length, 0);
  });
});

describe('extractDeclaredFunctions', () => {
  it('finds function declarations', () => {
    const result = extractDeclaredFunctions('export function calculateProfit(x: number) { return x; }');
    assert.ok(result.includes('calculateProfit'));
  });

  it('finds const arrow functions', () => {
    const result = extractDeclaredFunctions('export const formatPrice = (price: number) => `$${price}`;');
    assert.ok(result.includes('formatPrice'));
  });

  it('finds async function declarations', () => {
    const result = extractDeclaredFunctions('export async function fetchData() {}');
    assert.ok(result.includes('fetchData'));
  });

  it('finds const async arrow functions', () => {
    const result = extractDeclaredFunctions('const loadStuff = async (id: string) => {}');
    assert.ok(result.includes('loadStuff'));
  });

  it('filters out Redux Toolkit lifecycle methods', () => {
    const result = extractDeclaredFunctions(`
      pending: (state) => { state.loading = true; },
      fulfilled: (state, action) => { state.data = action.payload; },
      rejected: (state) => { state.error = true; },
    `);
    assert.ok(!result.includes('pending'));
    assert.ok(!result.includes('fulfilled'));
    assert.ok(!result.includes('rejected'));
  });

  it('returns empty for code with no declarations', () => {
    const result = extractDeclaredFunctions('const x = 1;\nconst y = "hello";');
    assert.equal(result.length, 0);
  });
});

describe('extractDeclaredTypes', () => {
  it('finds interface declarations', () => {
    const result = extractDeclaredTypes('export interface StockData { price: number; }');
    assert.ok(result.some(t => t.name === 'StockData' && t.kind === 'interface'));
  });

  it('finds type alias declarations', () => {
    const result = extractDeclaredTypes('export type TickerType = "stocks" | "options";');
    assert.ok(result.some(t => t.name === 'TickerType' && t.kind === 'type'));
  });

  it('finds enum declarations', () => {
    const result = extractDeclaredTypes('export enum OrderStatus { OPEN, CLOSED }');
    assert.ok(result.some(t => t.name === 'OrderStatus' && t.kind === 'enum'));
  });

  it('handles interfaces with extends', () => {
    const result = extractDeclaredTypes('interface FundamentalData extends BaseData { revenue: number; }');
    assert.ok(result.some(t => t.name === 'FundamentalData'));
  });

  it('handles generic type aliases', () => {
    const result = extractDeclaredTypes('type Response<T> = { data: T; error?: string; }');
    assert.ok(result.some(t => t.name === 'Response'));
  });
});

describe('analyzeFunctionUsage', () => {
  it('identifies created functions (new, not in old)', () => {
    const old = '';
    const new_ = 'export function newFunc() { return 1; }';
    const result = analyzeFunctionUsage(old, new_);
    assert.ok(result.created.includes('newFunc'));
    assert.equal(result.modified.length, 0);
  });

  it('identifies modified functions (exist in both old and new)', () => {
    const old = 'function existingFunc() { return 1; }';
    const new_ = 'function existingFunc() { return 2; }';
    const result = analyzeFunctionUsage(old, new_);
    assert.ok(result.modified.includes('existingFunc'));
    assert.equal(result.created.length, 0);
  });

  it('identifies called functions in new code', () => {
    const old = '';
    const new_ = 'const x = calculateProfit(100);';
    const result = analyzeFunctionUsage(old, new_);
    assert.ok(result.called.includes('calculateProfit'));
  });

  it('handles mix of created, modified, and called', () => {
    const old = 'function existing() { return 1; }';
    const new_ = 'function existing() { return helper(); }\nfunction brand_new() {}';
    const result = analyzeFunctionUsage(old, new_);
    assert.ok(result.modified.includes('existing'));
    assert.ok(result.created.includes('brand_new'));
    assert.ok(result.called.includes('helper'));
  });
});

describe('analyzeTypeUsage', () => {
  it('identifies created types', () => {
    const result = analyzeTypeUsage('', 'interface NewType { x: number; }');
    assert.ok(result.created.includes('NewType'));
  });

  it('identifies modified types', () => {
    const result = analyzeTypeUsage(
      'interface ExistingType { x: number; }',
      'interface ExistingType { x: number; y: string; }'
    );
    assert.ok(result.modified.includes('ExistingType'));
    assert.equal(result.created.length, 0);
  });
});

describe('extractPropertyAccesses', () => {
  it('extracts object.property accesses', () => {
    const result = extractPropertyAccesses('const x = order.quantity;');
    assert.ok(result.some(a => a.object === 'order' && a.property === 'quantity'));
  });

  it('filters out built-in objects', () => {
    const result = extractPropertyAccesses('const x = Math.floor(1.5);');
    assert.ok(!result.some(a => a.object === 'Math'));
  });

  it('filters out common array methods', () => {
    const result = extractPropertyAccesses('const x = items.length;');
    assert.ok(!result.some(a => a.property === 'length'));
  });

  it('deduplicates repeated accesses', () => {
    const result = extractPropertyAccesses('order.price;\norder.price;\norder.price;');
    const priceAccesses = result.filter(a => a.object === 'order' && a.property === 'price');
    assert.equal(priceAccesses.length, 1);
  });
});

describe('findEnclosingFunctions', () => {
  it('finds the enclosing function for a body-only edit', () => {
    const file = `export function calculateProfit(revenue: number, cost: number) {\n  const margin = revenue - cost;\n  return margin;\n}\n`;
    const oldCode = 'const margin = revenue - cost;';
    const newCode = 'const margin = revenue - cost - fees;';
    const postEdit = file.replace(oldCode, newCode);
    const result = findEnclosingFunctions(postEdit, oldCode, newCode);
    assert.deepEqual(result, ['calculateProfit']);
  });

  it('finds enclosing const arrow function', () => {
    const file = 'export const formatPrice = (price: number) => {\n  return price * 100;\n};\n';
    const oldCode = 'return price * 100;';
    const newCode = 'return price * 200;';
    const postEdit = file.replace(oldCode, newCode);
    const result = findEnclosingFunctions(postEdit, oldCode, newCode);
    assert.deepEqual(result, ['formatPrice']);
  });

  it('returns empty when edit is not inside any function', () => {
    const file = `const x = 1;\nconst y = 2;\n`;
    const oldCode = 'const x = 1;';
    const newCode = 'const x = 42;';
    const postEdit = file.replace(oldCode, newCode);
    const result = findEnclosingFunctions(postEdit, oldCode, newCode);
    assert.deepEqual(result, []);
  });

  it('returns empty when newString not found in file', () => {
    const result = findEnclosingFunctions('some file content', 'old', 'not present');
    assert.deepEqual(result, []);
  });

  it('finds enclosing async function', () => {
    const file = `export async function fetchData(url: string) {\n  const response = await fetch(url);\n  return response.json();\n}\n`;
    const oldCode = 'return response.json();';
    const newCode = 'return response.text();';
    const postEdit = file.replace(oldCode, newCode);
    const result = findEnclosingFunctions(postEdit, oldCode, newCode);
    assert.deepEqual(result, ['fetchData']);
  });

  it('does not match a function that has already closed before the edit', () => {
    const file = `function first() {\n  return 1;\n}\n\nconst x = 42;\n`;
    const oldCode = 'const x = 42;';
    const newCode = 'const x = 99;';
    const postEdit = file.replace(oldCode, newCode);
    const result = findEnclosingFunctions(postEdit, oldCode, newCode);
    assert.deepEqual(result, []);
  });
});
