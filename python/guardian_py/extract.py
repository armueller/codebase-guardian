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

    units: list[dict] = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            units.append(_class_unit(node, exported))
            for child in node.body:
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    units.append(_func_unit(child, exported, kind="method"))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            units.append(_func_unit(node, exported, kind="function"))

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


def _exported_names(tree: ast.Module) -> set[str] | None:
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "__all__":
                    if isinstance(node.value, (ast.List, ast.Tuple)):
                        return {
                            el.value
                            for el in node.value.elts
                            if isinstance(el, ast.Constant) and isinstance(el.value, str)
                        }
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


def _class_unit(node: ast.ClassDef, exported: set[str] | None) -> dict:
    decorators = _decorators(node)
    is_dc = any(d == "dataclass" or d.startswith("dataclass(") for d in decorators)
    doc = ast.get_docstring(node)
    return {
        "kind": "dataclass" if is_dc else "class",
        "name": node.name,
        "line": node.lineno,
        "end_line": getattr(node, "end_lineno", node.lineno),
        "is_exported": _is_exported(node.name, exported),
        "decorators": decorators,
        "summary": _summary(doc),
        "docstring": doc,
        **parse_doc_metadata(doc),
        "signature": None,
    }


def _func_unit(node, exported: set[str] | None, *, kind: str) -> dict:
    doc = ast.get_docstring(node)
    return {
        "kind": kind,
        "name": node.name,
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
