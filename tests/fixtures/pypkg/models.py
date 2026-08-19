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

    def to_dict(self) -> dict:
        """Serializes the widget to a plain dict.

        Domain: widgets. Tags: serialization, fixture.
        """
        return {"name": self.name, "count": self.count}


class PlainRecord:
    """A plain class with no domain of its own.

    Should inherit the module's domain when indexed (denormalization).
    """

    label: str

    def to_dict(self) -> dict:
        """Serializes the plain record to a dict.

        Same method name as Widget.to_dict in this same file — used by
        tests/py-call-graph.test.ts to prove call-edge resolution picks the
        correct same-named method row via (file, definition-line), not just
        (name, file).
        """
        return {"label": self.label}
