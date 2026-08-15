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

    price: float
    stale_sessions: int


def score_strike(contract: "Contract", weights: float = DEFAULT_WEIGHTS) -> float:
    """Return the weighted score for one candidate strike."""
    return weights


def _private_helper(x):
    return x
