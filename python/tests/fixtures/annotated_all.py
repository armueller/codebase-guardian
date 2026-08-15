"""Module whose __all__ uses a variable annotation.

Domain: code-index, python-support.
"""
from __future__ import annotations

__all__: list[str] = ["public_fn"]


def public_fn():
    return 1


def looks_public_but_not_exported():
    # Public-looking name (no leading underscore) that is deliberately left out
    # of __all__. If AnnAssign __all__ detection is broken, this wrongly falls
    # back to the underscore-convention heuristic and reports is_exported=True.
    return 2
