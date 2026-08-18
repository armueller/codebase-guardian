"""Cross-file call graph extraction for a Python package, resolved via Jedi.

Domain: code-index, python-support. Tags: callgraph, jedi, ast, cross-file.

This is the Python analog of the TypeScript `call-graph.ts` (ts-morph): walk
every `.py` file under a package root, find call sites via the stdlib `ast`,
and resolve each callee's defining file across module boundaries using Jedi
static analysis. Node (P3.4) later joins these edges against indexed function
rows primarily by (file, definition-line) — `callee_def_line` (Jedi's
resolved `defs[0].line`) and `caller_line` (the enclosing def's own
`lineno`) — falling back to name+file only when a def-line is unavailable,
since Python method names collide across classes in one file. So the
contract here is deliberately conservative: keep every call site as an edge,
but only fill in `callee_file`/`callee_def_line` when Jedi resolves it to a
location *inside* the given package root. Unresolved or external
(stdlib/third-party) callees are kept with `callee_file`/`callee_def_line:
null` rather than dropped, so the caller can decide what to do with them.

Fail-open, like `extract.py`: any file that fails to parse, or any single
call that Jedi can't resolve, is skipped/nulled rather than raising. The one
exception is genuinely catastrophic setup failure (e.g. Jedi itself can't be
imported, or `jedi.Project` construction blows up) — that surfaces as a
top-level `error` field with `edges: []`, matching `extract`'s contract for
its own error cases.
"""
from __future__ import annotations

import ast
import os

# Directories that are never worth walking for call-site extraction: virtual
# envs, caches, and build output. Same rationale as the Node-side indexer's
# skip list, kept here so guardian_py doesn't have to trust the caller to
# have already filtered the tree.
EXCLUDED_DIRS = {
    ".venv",
    "__pycache__",
    ".pytest_cache",
    "site-packages",
    "build",
    "dist",
    ".mypy_cache",
    ".ruff_cache",
}


def build_callgraph(package_root: str) -> dict:
    """Walk `package_root` and return the callgraph JSON contract dict.

    Always returns a dict with `language`/`root`/`edges` (and `error` on
    failure) — never raises. `root` echoes the caller's argument verbatim
    (matching `extract`'s `file` field), while file discovery and Jedi
    resolution both operate on the absolute path internally.
    """
    try:
        import jedi  # local import: keep `jedi` optional for callers that
        # only need `extract` (no hard dependency at module import time).
    except Exception as exc:  # pragma: no cover - jedi is pinned in prod
        return {"language": "py", "root": package_root, "error": f"jedi_unavailable: {exc}", "edges": []}

    root_abs = os.path.abspath(package_root)

    try:
        files = _find_py_files(root_abs)
    except Exception as exc:
        return {"language": "py", "root": package_root, "error": f"walk_failed: {exc}", "edges": []}

    try:
        parent = os.path.dirname(root_abs)
        # `added_sys_path=[parent]` is required for real packages: a module
        # inside the package root that does `from mypkg.sibling import x`
        # (an absolute import naming the package itself) only resolves if
        # the *parent* of the package root is on sys.path — smart_sys_path
        # does not infer this from the project path alone. Verified
        # empirically against RMWM2/ml/labelgen (see task report).
        project = jedi.Project(root_abs, added_sys_path=[parent] if parent else [])
    except Exception as exc:
        return {"language": "py", "root": package_root, "error": f"project_init_failed: {exc}", "edges": []}

    edges: list[dict] = []
    seen: set[tuple] = set()

    for file_path in files:
        try:
            with open(file_path, "r", encoding="utf-8") as fh:
                source = fh.read()
            tree = ast.parse(source, filename=file_path)
        except Exception:
            # Syntax errors, decoding errors, permission errors, etc. — skip
            # this file only; the rest of the package still gets processed.
            continue

        calls = _collect_calls(tree)
        if not calls:
            continue

        try:
            script = jedi.Script(code=source, path=file_path, project=project)
        except Exception:
            continue

        for caller_name, caller_lineno, call_lineno, callee_name, line, col in calls:
            callee_file, callee_def_line = _resolve_callee(script, line, col, root_abs)
            key = (file_path, caller_name, callee_name, callee_file, callee_def_line)
            if key in seen:
                continue
            seen.add(key)
            edges.append(
                {
                    "caller_name": caller_name,
                    "caller_file": file_path,
                    "caller_line": caller_lineno,
                    "callee_name": callee_name,
                    "callee_file": callee_file,
                    "callee_def_line": callee_def_line,
                    "line": call_lineno,
                    "edge_type": "calls",
                }
            )

    return {"language": "py", "root": package_root, "edges": edges}


def _find_py_files(root: str) -> list[str]:
    """Recursively list `.py` files under `root`, skipping EXCLUDED_DIRS.

    `os.walk` on a nonexistent path yields nothing (no exception), so a
    missing package root naturally produces an empty file list rather than
    an error — consistent with the fail-open contract.
    """
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS]
        for filename in filenames:
            if filename.endswith(".py"):
                found.append(os.path.join(dirpath, filename))
    return sorted(found)


def _resolve_callee(script, line: int, col: int, root_abs: str) -> tuple[str | None, int | None]:
    """Jedi-resolve one call site to its definition's absolute file path + def line.

    Returns `(None, None)` when Jedi can't resolve the call, when the
    definition has no backing file (e.g. a C-extension builtin), or when it
    resolves outside `root_abs` (stdlib/third-party — treated as external per
    the task contract, not an error). Any Jedi exception is swallowed here so
    one bad call site never aborts the file.
    """
    try:
        # Everything here — including `.module_path`/`.line`, which do further
        # lazy inference internally and can themselves raise — must stay
        # inside this one try/except. A prior version only wrapped `goto()`;
        # a raise from `.module_path` on a single flaky call would otherwise
        # escape this function, abort the whole `for file_path in files:` loop
        # in `build_callgraph`, and get caught only by __main__.py's
        # last-resort handler — which discards every edge collected so far,
        # not just the one bad call. See task-p3.1 fix report. `.line` is
        # subject to the same lazy-inference risk as `.module_path`, so
        # capturing it here (rather than in a second, separate try/except)
        # preserves that guarantee for task-p3.4.
        defs = script.goto(line, col, follow_imports=True)
        if not defs:
            return None, None
        module_path = defs[0].module_path
        if module_path is None:
            return None, None
        module_path = str(module_path)
        if not _is_within(module_path, root_abs):
            return None, None
        return module_path, defs[0].line
    except Exception:
        return None, None


def _is_within(path: str, root: str) -> bool:
    """True if `path` resolves to a location inside `root` (or is `root`).

    Both sides are run through `realpath` so symlinked venvs/caches don't
    produce false negatives/positives on the containment check.
    """
    real_path = os.path.realpath(path)
    real_root = os.path.realpath(root)
    rel = os.path.relpath(real_path, real_root)
    return rel == os.curdir or not rel.startswith(os.pardir)


class _CallCollector(ast.NodeVisitor):
    """Walks a module's AST, recording each call site's enclosing def + callee position.

    `caller_name` is the nearest enclosing `FunctionDef`/`AsyncFunctionDef`
    name, or `"<module>"` for a call made at module scope (matching the
    contract's `caller_name` rule). `caller_lineno` is that enclosing def's
    own `lineno` (i.e. the `def` line, matching the indexer's
    `functions.line_number` for the same unit), or `None` for a module-level
    call. Only `ast.Name` (`func()`) and `ast.Attribute` (`obj.method()`)
    callees are recorded — other call shapes (e.g. calling a subscript or a
    call result) have no stable name to resolve against and are
    intentionally skipped, per the brief.
    """

    def __init__(self) -> None:
        self._stack: list[tuple[str, int]] = []
        self.calls: list[tuple[str, int | None, int, str, int, int]] = []

    def _enclosing(self) -> tuple[str, int | None]:
        return self._stack[-1] if self._stack else ("<module>", None)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_def(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_def(node)

    def _visit_def(self, node) -> None:
        self._stack.append((node.name, node.lineno))
        self.generic_visit(node)
        self._stack.pop()

    def visit_Call(self, node: ast.Call) -> None:
        callee = node.func
        if isinstance(callee, ast.Name):
            name, line, col = callee.id, callee.lineno, callee.col_offset
        elif isinstance(callee, ast.Attribute):
            # The attribute token (`.attr`) is always the last token of
            # `node.func`, so its start column is `end_col_offset -
            # len(attr)` on the attribute's own end line — this holds even
            # when the object expression before it spans multiple lines.
            name = callee.attr
            line = callee.end_lineno
            col = callee.end_col_offset - len(callee.attr)
        else:
            name = line = col = None

        if name is not None:
            caller_name, caller_lineno = self._enclosing()
            self.calls.append((caller_name, caller_lineno, node.lineno, name, line, col))

        self.generic_visit(node)


def _collect_calls(tree: ast.Module) -> list[tuple[str, int | None, int, str, int, int]]:
    collector = _CallCollector()
    collector.visit(tree)
    return collector.calls
