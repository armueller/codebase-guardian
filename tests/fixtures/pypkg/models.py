"""Domain: data-models, fixtures. Layer: Data Layer.

Module docstring for the pypkg fixture models. Used by tests/py-index.test.ts
to verify the indexer's Python extraction branch.
"""

from dataclasses import dataclass


@dataclass
class Widget:
    """A widget record.

    Domain: widgets. Tags: dataclass, fixture.
    """

    name: str
    count: int = 0


class PlainRecord:
    """A plain class with no domain of its own.

    Should inherit the module's domain when indexed (denormalization).
    """

    label: str
