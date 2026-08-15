"""Module using the qualified dataclasses.dataclass decorator form.

Domain: code-index, python-support.
"""
import dataclasses


@dataclasses.dataclass
class QualifiedBare:
    """Dataclass declared via the bare qualified decorator."""

    value: int


@dataclasses.dataclass(frozen=True)
class QualifiedCalled:
    """Dataclass declared via the qualified decorator with call args."""

    value: int
