"""Shared dataclasses for the label generator.

Domain: covered-calls, labels.
"""
from dataclasses import dataclass

__all__ = ["Mark", "score_strike"]

DEFAULT_WEIGHTS = 1.0


@dataclass(frozen=True)
class Mark:
    """A contract's mark on a date.

    Domain: options, marking. Tags: mark, carry-forward, staleness.
    """

    price: float  # dollars per share
    stale_sessions: int = 0

    def is_stale(self) -> bool:
        """Whether this mark is too old to trust."""
        return self.stale_sessions > 0


def score_strike(contract: "Contract", weights: float = DEFAULT_WEIGHTS) -> float:
    """Return the weighted score for one candidate strike."""
    return weights


def _private_helper(x):
    return x
