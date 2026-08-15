"""Module with a nested class to exercise recursive unit extraction.

Domain: code-index, python-support.
"""


class Outer:
    """Outer class with a nested Meta class."""

    class Meta:
        """Nested configuration class."""

        ordering = "name"

        def describe(self) -> str:
            return "meta"

    def outer_method(self) -> str:
        return "outer"
