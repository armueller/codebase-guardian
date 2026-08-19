"""b module: cross-file, external, and unresolved call sites for callgraph tests."""
from __future__ import annotations

from pkg.a import helper


def use() -> int:
    return helper()


def use_external(items: list) -> int:
    return len(items)


def use_undefined():
    return totally_undefined_function()
