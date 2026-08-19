"""Domain: data-models, fixtures.

Helper functions for the pypkg fixture. Used by tests/py-index.test.ts and
tests/py-call-graph.test.ts.
"""

from pypkg.models import Widget


def public_helper(value: int) -> int:
    """Doubles a value.

    Domain: fixtures, math. Tags: helper, public.
    """
    return value * 2


def _private_helper(value: int) -> int:
    """Internal helper, not exported (leading underscore, no __all__)."""
    return value + 1


def widget_summary() -> dict:
    """Builds a Widget and returns its dict representation.

    Domain: fixtures, widgets. Tags: helper, cross-file.

    Cross-file call into Widget.to_dict (models.py) — the fixture's
    call-graph edge used by tests/py-call-graph.test.ts to prove def-line
    resolution picks Widget.to_dict, not the same-named PlainRecord.to_dict
    also defined in models.py.
    """
    widget = Widget(name="fixture")
    return widget.to_dict()
