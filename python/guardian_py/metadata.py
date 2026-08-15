"""Parse the guardian metadata lines (Domain/Tags/Layer) out of a docstring.

Domain: code-index, python-support. Tags: metadata, docstring, domain, tags.
"""
from __future__ import annotations

import re

# A docstring line may carry more than one label, e.g. "Domain: x. Tags: y."
# Case-insensitive on the label; values keep original case until normalized below.
# Each value runs up to the next period (labels are period-terminated by convention).
_INLINE_RE = re.compile(r"(?i)\b(Domain|Tags|Layer)\s*:\s*([^.]+)")


def _split(value: str, *, lower: bool) -> list[str]:
    parts = [p.strip() for p in value.split(",")]
    parts = [p for p in parts if p]
    return [p.lower() for p in parts] if lower else parts


def parse_doc_metadata(docstring: str | None) -> dict:
    """Return {domains, tags, layer} parsed from a docstring's metadata lines.

    Domains and tags are lowercased; layer preserves case. Missing labels yield
    empty lists / None. Safe on None or metadata-free docstrings.
    """
    domains: list[str] = []
    tags: list[str] = []
    layer: str | None = None
    if not docstring:
        return {"domains": domains, "tags": tags, "layer": layer}

    for label, value in _INLINE_RE.findall(docstring):
        label = label.lower()
        value = value.strip()
        if label == "domain":
            domains = _split(value, lower=True)
        elif label == "tags":
            tags = _split(value, lower=True)
        elif label == "layer":
            picked = _split(value, lower=False)
            layer = picked[0] if picked else None
    return {"domains": domains, "tags": tags, "layer": layer}
