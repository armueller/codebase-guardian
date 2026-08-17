import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractPython } from '../src/hooks/helpers/adapters/py-adapter.js';

const VALID_SOURCE = `"""Sample module for adapter test.

Domain: sample-domain.
"""

from dataclasses import dataclass


@dataclass
class Widget:
    """A sample widget.

    Domain: widgets. Tags: sample, fixture.
    """

    name: str
    price: float  # dollars per unit


def compute_total(widget: Widget, count: int) -> float:
    """Compute total price."""
    return widget.price * count


class Container:
    def get_widget(self) -> Widget:
        """Return a widget."""
        return Widget(name="x", price=1.0)
`;

describe('extractPython', () => {
  it('extracts functions, classes, and module metadata from valid Python source', () => {
    const result = extractPython('/tmp/widget.py', VALID_SOURCE);

    assert.equal(result.ok, true);
    if (!result.ok) return;

    // Top-level function is exported (no leading underscore, no __all__) —
    // requiresJSDoc should reflect that.
    const computeTotal = result.functions.find(f => f.name === 'compute_total');
    assert.ok(computeTotal, 'expected compute_total to be extracted');
    assert.equal(computeTotal!.requiresJSDoc, true);
    assert.equal(computeTotal!.hasJSDoc, true);

    // Dataclass mapping: kind, fields (with the trailing-comment field), domains/tags.
    const widget = result.classes.find(c => c.name === 'Widget');
    assert.ok(widget, 'expected Widget to be extracted');
    assert.equal(widget!.kind, 'dataclass');
    const fieldNames = widget!.fields.map(f => f.name);
    assert.ok(fieldNames.includes('name'));
    assert.ok(fieldNames.includes('price'));
    const priceField = widget!.fields.find(f => f.name === 'price');
    assert.equal(priceField?.comment, 'dollars per unit');
    assert.deepEqual(widget!.domains, ['widgets']);
    assert.deepEqual(widget!.tags, ['sample', 'fixture']);

    // ExtractedFunction has no `parent` field (only ExtractedClass does per the
    // brief's interface), so the method's enclosing class is encoded into the
    // reconstructed fullCode as readable context (`class Container: ...`).
    const getWidget = result.functions.find(f => f.name === 'get_widget');
    assert.ok(getWidget, 'expected get_widget method to be extracted');
    assert.match(getWidget!.fullCode, /class Container:/);

    // Module metadata is carried through.
    assert.deepEqual(result.module.domains, ['sample-domain']);
  });

  it('returns a syntax sentinel for unparseable source', () => {
    const result = extractPython('/tmp/broken.py', 'def oops(:\n  pass\n');
    assert.deepEqual(result, { ok: false, reason: 'syntax' });
  });

  it('returns an unavailable sentinel when the guardian pyenv is missing', () => {
    const original = process.env.GUARDIAN_HOME;
    process.env.GUARDIAN_HOME = '/tmp/guardian-home-does-not-exist-xyz';
    try {
      const result = extractPython('/tmp/whatever.py', 'x = 1\n');
      assert.deepEqual(result, { ok: false, reason: 'unavailable' });
    } finally {
      if (original === undefined) {
        delete process.env.GUARDIAN_HOME;
      } else {
        process.env.GUARDIAN_HOME = original;
      }
    }
  });
});
