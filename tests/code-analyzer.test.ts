import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCalledFunctions,
  extractPropertyAccesses,
  analyzeChanges
} from '../src/hooks/helpers/code-analyzer.js';
import { discoverAllDeclarations } from '../src/hooks/helpers/function-extractor.js';

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

describe('analyzeChanges', () => {
  it('detects created functions in a new file', () => {
    const postEdit = 'export function newFunc() { return 1; }';
    const result = analyzeChanges('', postEdit, postEdit);
    assert.ok(result.functionUsage.created.includes('newFunc'));
    assert.equal(result.functionUsage.modified.length, 0);
  });

  it('detects modified functions when body changes', () => {
    const preEdit = 'function existingFunc() { return 1; }';
    const postEdit = 'function existingFunc() { return 2; }';
    const result = analyzeChanges(preEdit, postEdit, 'return 2;');
    assert.ok(result.functionUsage.modified.includes('existingFunc'));
    assert.equal(result.functionUsage.created.length, 0);
  });

  it('detects body-only edits inside functions automatically', () => {
    const preEdit = 'export function calculateProfit(revenue: number, cost: number) {\n  const margin = revenue - cost;\n  return margin;\n}\n';
    const postEdit = preEdit.replace('revenue - cost', 'revenue - cost - fees');
    const result = analyzeChanges(preEdit, postEdit, 'revenue - cost - fees');
    assert.ok(result.functionUsage.modified.includes('calculateProfit'));
  });

  it('detects called functions from newString', () => {
    const result = analyzeChanges('', 'const x = calculateProfit(100);', 'const x = calculateProfit(100);');
    assert.ok(result.functionUsage.called.includes('calculateProfit'));
  });

  it('does NOT detect type property signatures as functions', () => {
    const preEdit = 'type Props = {\n  onRemoveSpecificInstance: (instanceNodeId: string) => void;\n};';
    const postEdit = 'type Props = {\n  onRemoveSpecificInstance: (instanceNodeId: string) => void;\n  projectName?: string | null;\n};';
    const result = analyzeChanges(preEdit, postEdit, 'projectName');
    assert.ok(!result.functionUsage.modified.includes('onRemoveSpecificInstance'));
    assert.ok(!result.functionUsage.created.includes('onRemoveSpecificInstance'));
  });

  it('detects useMemo(function name() {}) pattern', () => {
    const preEdit = 'const { bounds } = useMemo(\n  function computeBounds() {\n    return { x: 0 };\n  },\n  [deps]\n);';
    const postEdit = 'const { bounds } = useMemo(\n  function computeBounds() {\n    return { x: 1 };\n  },\n  [deps]\n);';
    const result = analyzeChanges(preEdit, postEdit, 'return { x: 1 };');
    assert.ok(result.functionUsage.modified.includes('computeBounds'));
  });

  it('detects renamed functions via position proximity', () => {
    const preEdit = 'function oldName() {\n  return 1;\n}';
    const postEdit = 'function newName() {\n  return 1;\n}';
    const result = analyzeChanges(preEdit, postEdit, 'function newName');
    assert.ok(result.functionUsage.renamed.some(r => r.oldName === 'oldName' && r.newName === 'newName'));
    // Renamed functions should be in modified, not created
    assert.ok(result.functionUsage.modified.includes('newName'));
    assert.ok(!result.functionUsage.created.includes('newName'));
  });

  it('detects created types', () => {
    const result = analyzeChanges('', 'interface NewType { x: number; }', 'interface NewType');
    assert.ok(result.typeUsage.created.includes('NewType'));
  });

  it('detects modified types', () => {
    const preEdit = 'interface ExistingType { x: number; }';
    const postEdit = 'interface ExistingType { x: number; y: string; }';
    const result = analyzeChanges(preEdit, postEdit, 'y: string');
    assert.ok(result.typeUsage.modified.includes('ExistingType'));
    assert.equal(result.typeUsage.created.length, 0);
  });

  it('provides type kind map', () => {
    const postEdit = 'interface Foo { x: number; }\ntype Bar = string;\nenum Baz { A, B }';
    const result = analyzeChanges('', postEdit, postEdit);
    assert.equal(result.typeKindMap.get('Foo'), 'interface');
    assert.equal(result.typeKindMap.get('Bar'), 'type');
    assert.equal(result.typeKindMap.get('Baz'), 'enum');
  });

  it('handles const arrow functions', () => {
    const preEdit = 'export const formatPrice = (price: number) => `$${price}`;';
    const postEdit = 'export const formatPrice = (price: number) => `$${price.toFixed(2)}`;';
    const result = analyzeChanges(preEdit, postEdit, 'price.toFixed(2)');
    assert.ok(result.functionUsage.modified.includes('formatPrice'));
  });

  it('handles const function expressions', () => {
    const postEdit = 'export const handler = function handler(req: any) { return req; }';
    const result = analyzeChanges('', postEdit, postEdit);
    assert.ok(
      result.functionUsage.created.includes('handler'),
      `Expected 'handler' in created, got: ${JSON.stringify(result.functionUsage.created)}`
    );
  });

  it('does NOT detect useMemo const as a function (it returns a value, not a function)', () => {
    const code = `
export function MyComponent() {
  const bounds = useMemo(
    function computeBounds() { return { x: 0 }; },
    [deps]
  );
  return null;
}`;
    const result = analyzeChanges('', code, code);
    assert.ok(!result.functionUsage.created.includes('bounds'),
      `'bounds' should not be detected as a function — useMemo returns a value`);
    // But the inner named function expression SHOULD be detected
    assert.ok(result.functionUsage.created.includes('computeBounds'),
      `'computeBounds' should be detected as a named function expression`);
  });

  it('DOES detect useCallback const as a function', () => {
    const code = `
export function MyComponent() {
  const handler = useCallback(() => { console.log('hi'); }, []);
  return null;
}`;
    const result = analyzeChanges('', code, code);
    assert.ok(result.functionUsage.created.includes('handler'),
      `'handler' should be detected — useCallback wraps a function`);
  });

  it('DOES detect React.memo wrapped component as a function', () => {
    const code = `export const MyComp = React.memo(function MyComp(props: any) { return null; });`;
    const result = analyzeChanges('', code, code);
    // Should detect either the const name or the inner function name (or both)
    const created = result.functionUsage.created;
    assert.ok(created.includes('MyComp'),
      `'MyComp' should be detected — React.memo wraps a component function`);
  });

  it('handles new file with no declarations', () => {
    const result = analyzeChanges('', 'const x = 1;\nconst y = 2;', 'const x = 1;');
    assert.equal(result.functionUsage.modified.length, 0);
    assert.equal(result.functionUsage.created.length, 0);
    assert.equal(result.typeUsage.modified.length, 0);
    assert.equal(result.typeUsage.created.length, 0);
  });
});

describe('requiresJSDoc flag', () => {
  it('function declarations require JSDoc', () => {
    const { functions } = discoverAllDeclarations('function foo() { return 1; }');
    const foo = functions.get('foo');
    assert.ok(foo && foo[0].requiresJSDoc === true);
  });

  it('const arrow functions require JSDoc', () => {
    const { functions } = discoverAllDeclarations('const bar = () => { return 1; };');
    const bar = functions.get('bar');
    assert.ok(bar && bar[0].requiresJSDoc === true);
  });

  it('useCallback wrapped functions require JSDoc', () => {
    const { functions } = discoverAllDeclarations('const handler = useCallback(() => { }, []);');
    const handler = functions.get('handler');
    assert.ok(handler && handler[0].requiresJSDoc === true);
  });

  it('named function expressions in .map() do NOT require JSDoc', () => {
    const code = 'function outer() { items.map(function mapItem(item) { return item; }); }';
    const { functions } = discoverAllDeclarations(code);
    const mapItem = functions.get('mapItem');
    assert.ok(mapItem && mapItem[0].requiresJSDoc === false,
      'Inline .map callback should not require JSDoc');
  });

  it('named function expressions in useMemo do NOT require JSDoc', () => {
    const code = 'const { x } = useMemo(function computeX() { return { x: 1 }; }, []);';
    const { functions } = discoverAllDeclarations(code);
    const computeX = functions.get('computeX');
    assert.ok(computeX && computeX[0].requiresJSDoc === false,
      'useMemo named callback should not require JSDoc');
  });

  it('named function expressions in .filter() do NOT require JSDoc', () => {
    const code = 'function outer() { items.filter(function hasValue(item) { return !!item; }); }';
    const { functions } = discoverAllDeclarations(code);
    const hasValue = functions.get('hasValue');
    assert.ok(hasValue && hasValue[0].requiresJSDoc === false,
      'Inline .filter callback should not require JSDoc');
  });

  it('class methods require JSDoc', () => {
    const code = 'class Foo { bar() { return 1; } }';
    const { functions } = discoverAllDeclarations(code);
    const bar = functions.get('bar');
    assert.ok(bar && bar[0].requiresJSDoc === true);
  });

  it('React.memo wrapped components require JSDoc', () => {
    const code = 'export const MyComp = React.memo(function MyComp(props: any) { return null; });';
    const { functions } = discoverAllDeclarations(code);
    const myComp = functions.get('MyComp');
    assert.ok(myComp && myComp.some(e => e.requiresJSDoc === true),
      'React.memo wrapped component should require JSDoc');
  });
});
