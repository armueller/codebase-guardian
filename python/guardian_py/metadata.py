"""Parse the guardian metadata lines (Domain/Tags/Layer) out of a docstring.

Domain: code-index, python-support. Tags: metadata, docstring, domain, tags.
"""
from __future__ import annotations

import re

# A docstring line may carry more than one label, e.g. "Domain: x. Tags: y."
# Case-insensitive on the label; values keep original case until normalized below.
# Each value runs up to the next period or end-of-line (labels are period-terminated
# by convention), and is never allowed to swallow text past a newline.
#
# A plain `^`-anchored, multiline regex over the whole docstring cannot both (a)
# reject a label embedded mid-sentence (e.g. "See the Domain: model layer for
# details.") and (b) still recognize a second chained label on the same physical
# line (e.g. "Domain: x. Tags: y."), because `^` only matches immediately after a
# real newline — never after a mid-line ". ". So matching is two-staged: a line
# first has to *start* with a label (this gate is genuinely line-anchored) before
# any label:value pairs on that line are extracted; extraction within a qualifying
# line then allows further chained labels.
_LABEL_STARTS_LINE_RE = re.compile(r"(?i)^\s*(?:Domain|Tags|Layer)\s*:")
_INLINE_RE = re.compile(r"(?i)(Domain|Tags|Layer)\s*:\s*([^.\n]+)")


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

    for line in docstring.splitlines():
        if not _LABEL_STARTS_LINE_RE.match(line):
            continue
        for label, value in _INLINE_RE.findall(line):
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
