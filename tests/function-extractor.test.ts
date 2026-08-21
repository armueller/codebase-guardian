import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discoverAllDeclarations } from '../src/hooks/helpers/function-extractor.js';

describe('discoverFunctions — wrapped-callback double-counting', () => {
  it('captures the enclosing const but not the inner named function of a wrapper', () => {
    const content = `
export const Card = observer(function CardImpl(props) {
  const inner = () => props.value;
  return inner();
});
`;
    const { functions } = discoverAllDeclarations(content);
    assert.ok(functions.has('Card'), 'the wrapped const is captured');
    assert.ok(!functions.has('CardImpl'), 'the inner named function expression is NOT double-counted');
  });

  it('still skips const X = function X() {} (same-name guard preserved)', () => {
    const { functions } = discoverAllDeclarations('const Foo = function Foo() { return 1; };');
    assert.ok(functions.has('Foo'), 'the const is captured');
    // Foo appears once (from the variable declaration), not twice
    assert.equal(functions.get('Foo')!.length, 1, 'Foo is captured exactly once');
  });

  it('still tracks a standalone named callback (not assigned to a variable)', () => {
    const content = `items.forEach(function handleItem(item) { doThing(item); });`;
    const { functions } = discoverAllDeclarations(content);
    assert.ok(functions.has('handleItem'), 'standalone named callbacks are still tracked for change detection');
  });

  it('still tracks the inner function of a value-returning hook (useMemo is not captured by case 2)', () => {
    const content = `const { bounds } = useMemo(function computeBounds() { return { x: 0 }; }, [deps]);`;
    const { functions } = discoverAllDeclarations(content);
    assert.ok(functions.has('computeBounds'), 'useMemo inner function is still tracked (its const is not a function)');
    assert.ok(!functions.has('bounds'), 'the value-returning const is not a function');
  });

  it('captures ordinary declarations normally', () => {
    const content = `
function alpha() { return 1; }
const beta = () => 2;
`;
    const { functions } = discoverAllDeclarations(content);
    assert.ok(functions.has('alpha'), 'function declaration captured');
    assert.ok(functions.has('beta'), 'arrow const captured');
  });
});
