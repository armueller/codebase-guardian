"""Module with __all__ and class methods — regression fixture for the __all__/method bug.

Domain: testing.
"""

__all__ = ["Widget"]


class Widget:
    """A widget."""

    def to_dict(self):
        """Return a dict."""
        return {}

    def _private(self):
        pass
