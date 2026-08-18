"""Domain: data-models, fixtures.

Helper functions for the pypkg fixture. Used by tests/py-index.test.ts.
"""


def public_helper(value: int) -> int:
    """Doubles a value.

    Domain: fixtures, math. Tags: helper, public.
    """
    return value * 2


def _private_helper(value: int) -> int:
    """Internal helper, not exported (leading underscore, no __all__)."""
    return value + 1
