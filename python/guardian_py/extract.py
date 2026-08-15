"""Extract module + unit metadata from a Python file using the stdlib AST.

Domain: code-index, python-support. Tags: extraction, ast, signatures, docstrings.
"""
from __future__ import annotations

import ast

from guardian_py.metadata import parse_doc_metadata


def extract_file(path: str) -> dict:
    """Read a file and return the extraction contract dict (see plan)."""
    with open(path, "r", encoding="utf-8") as fh:
        source = fh.read()
    return extract_source(source, path)


def extract_source(source: str, file: str) -> dict:
    """Parse source; on SyntaxError return the fail-open syntax payload."""
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return {"language": "py", "file": file, "error": "syntax", "detail": str(exc)}

    module_doc = ast.get_docstring(tree)
    module_meta = parse_doc_metadata(module_doc)
    exported = _exported_names(tree)
    source_lines = source.splitlines()

    units: list[dict] = []
    _walk_body(tree.body, exported, source_lines, None, units)

    return {
        "language": "py",
        "file": file,
        "module": {
            "summary": _summary(module_doc),
            "docstring": module_doc,
            **module_meta,
        },
        "units": units,
    }


def _walk_body(
    body: list[ast.stmt],
    exported: set[str] | None,
    source_lines: list[str],
    parent: str | None,
    units: list[dict],
) -> None:
    """Recursively collect class/function/method units from a statement body.

    Only `ClassDef` bodies are recursed into (to reach nested classes and their
    methods) — function bodies are never walked, so nested functions inside a
    method are not treated as units. `parent` is the enclosing class name, or
    `None` at module level (and for module-level functions/classes).
    """
    for node in body:
        if isinstance(node, ast.ClassDef):
            units.append(_class_unit(node, exported, source_lines, parent=parent))
            _walk_body(node.body, exported, source_lines, node.name, units)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            kind = "function" if parent is None else "method"
            units.append(_func_unit(node, exported, kind=kind, parent=parent))


def _all_string_elements(value: ast.expr | None) -> set[str] | None:
    if isinstance(value, (ast.List, ast.Tuple)):
        return {
            el.value
            for el in value.elts
            if isinstance(el, ast.Constant) and isinstance(el.value, str)
        }
    return None


def _exported_names(tree: ast.Module) -> set[str] | None:
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "__all__":
                    names = _all_string_elements(node.value)
                    if names is not None:
                        return names
        elif isinstance(node, ast.AnnAssign):
            # __all__: list[str] = [...] — a single `.target`, not `.targets`.
            if isinstance(node.target, ast.Name) and node.target.id == "__all__":
                names = _all_string_elements(node.value)
                if names is not None:
                    return names
    return None


def _is_exported(name: str, exported: set[str] | None) -> bool:
    if exported is not None:
        return name in exported
    return not name.startswith("_")


def _decorators(node) -> list[str]:
    return [ast.unparse(d) for d in node.decorator_list]


def _summary(doc: str | None) -> str | None:
    if not doc:
        return None
    return doc.strip().splitlines()[0].strip()


def _line_comment(source_lines: list[str], lineno: int) -> str | None:
    """Trailing `# ...` comment text on a 1-indexed source line, or None.

    Last-`#`-on-line heuristic: good enough since field declaration lines
    rarely contain a literal `#` inside a string.
    """
    if lineno < 1 or lineno > len(source_lines):
        return None
    line = source_lines[lineno - 1]
    idx = line.rfind("#")
    if idx == -1:
        return None
    return line[idx + 1 :].strip() or None


def _fields(node: ast.ClassDef, source_lines: list[str]) -> list[dict]:
    """Class-level attribute fields (dataclass-style AnnAssign, plus plain Assign).

    Skips methods (FunctionDef/AsyncFunctionDef) and nested classes (ClassDef) —
    those are emitted as their own units, not fields.
    """
    fields: list[dict] = []
    for child in node.body:
        if isinstance(child, ast.AnnAssign):
            if isinstance(child.target, ast.Name):
                fields.append(
                    {
                        "name": child.target.id,
                        "annotation": _annotation(child.annotation),
                        "default": ast.unparse(child.value) if child.value is not None else None,
                        "comment": _line_comment(source_lines, child.lineno),
                    }
                )
        elif isinstance(child, ast.Assign):
            for target in child.targets:
                if isinstance(target, ast.Name):
                    fields.append(
                        {
                            "name": target.id,
                            "annotation": None,
                            "default": ast.unparse(child.value) if child.value is not None else None,
                            "comment": _line_comment(source_lines, child.lineno),
                        }
                    )
    return fields


def _is_dataclass_decorator(decorator_text: str) -> bool:
    # Bare `dataclass` / `dataclass(...)`, and qualified `dataclasses.dataclass`
    # / `dataclasses.dataclass(...)`. Strip any call args, then compare the text
    # after the last `.` to `dataclass`. Aliased imports (`import dataclasses as
    # dc`) are out of scope — no import tracking is attempted.
    base = decorator_text.split("(", 1)[0]
    return base.rsplit(".", 1)[-1] == "dataclass"


def _class_unit(
    node: ast.ClassDef,
    exported: set[str] | None,
    source_lines: list[str],
    *,
    parent: str | None,
) -> dict:
    decorators = _decorators(node)
    is_dc = any(_is_dataclass_decorator(d) for d in decorators)
    doc = ast.get_docstring(node)
    return {
        "kind": "dataclass" if is_dc else "class",
        "name": node.name,
        "parent": parent,
        "line": node.lineno,
        "end_line": getattr(node, "end_lineno", node.lineno),
        "is_exported": _is_exported(node.name, exported),
        "decorators": decorators,
        "summary": _summary(doc),
        "docstring": doc,
        **parse_doc_metadata(doc),
        "signature": None,
        "fields": _fields(node, source_lines),
    }


def _func_unit(node, exported: set[str] | None, *, kind: str, parent: str | None) -> dict:
    doc = ast.get_docstring(node)
    return {
        "kind": kind,
        "name": node.name,
        "parent": parent,
        "line": node.lineno,
        "end_line": getattr(node, "end_lineno", node.lineno),
        "is_exported": _is_exported(node.name, exported),
        "decorators": _decorators(node),
        "summary": _summary(doc),
        "docstring": doc,
        **parse_doc_metadata(doc),
        "signature": _signature(node),
    }


def _annotation(ann) -> str | None:
    if ann is None:
        return None
    # Forward-reference string annotations (e.g. `x: "Contract"`) should surface as
    # `Contract`, not `'Contract'` — ast.unparse would keep the quotes.
    if isinstance(ann, ast.Constant) and isinstance(ann.value, str):
        return ann.value
    return ast.unparse(ann)


def _signature(node) -> dict:
    a = node.args
    params: list[dict] = []
    pos = list(a.posonlyargs) + list(a.args)
    defaults = list(a.defaults)
    # defaults align to the tail of `pos`
    offset = len(pos) - len(defaults)
    for i, arg in enumerate(pos):
        default = defaults[i - offset] if i >= offset else None
        params.append(
            {
                "name": arg.arg,
                "annotation": _annotation(arg.annotation),
                "default": ast.unparse(default) if default is not None else None,
                "kind": "positional",
            }
        )
    for i, arg in enumerate(a.kwonlyargs):
        kd = a.kw_defaults[i]
        params.append(
            {
                "name": arg.arg,
                "annotation": _annotation(arg.annotation),
                "default": ast.unparse(kd) if kd is not None else None,
                "kind": "keyword_only",
            }
        )
    return {
        "params": params,
        "returns": _annotation(node.returns),
        "has_varargs": a.vararg is not None,
        "has_kwargs": a.kwarg is not None,
    }
