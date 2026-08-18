import json
import os
import subprocess
import sys

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
ROOT = os.path.dirname(os.path.dirname(__file__))  # the python/ dir
PKG = os.path.join(FIX, "pkg")


def _run(*args):
    return subprocess.run(
        [sys.executable, "-m", "guardian_py", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def _edges():
    proc = _run("callgraph", PKG)
    assert proc.returncode == 0
    payload = json.loads(proc.stdout)
    return payload


def test_callgraph_emits_json_exit_zero_no_error():
    payload = _edges()
    assert payload["language"] == "py"
    assert payload["root"] == PKG
    assert "error" not in payload
    assert isinstance(payload["edges"], list)


def test_callgraph_resolves_cross_file_call():
    payload = _edges()
    matches = [
        e
        for e in payload["edges"]
        if e["caller_name"] == "use" and e["callee_name"] == "helper"
    ]
    assert len(matches) == 1
    edge = matches[0]
    assert edge["callee_file"] is not None
    assert edge["callee_file"].endswith("a.py")
    assert edge["caller_file"].endswith("b.py")
    assert edge["edge_type"] == "calls"
    assert isinstance(edge["line"], int)
    # `callee_def_line` must be `helper`'s own `def` line in a.py (line 5 —
    # see fixtures/pkg/a.py), which is exactly what the indexer stores as
    # that unit's `functions.line_number`. `caller_line` must be `use`'s own
    # `def` line in b.py (line 7 — see fixtures/pkg/b.py), NOT the call-site
    # line (`line`, which is the `return helper()` line inside `use`).
    assert edge["callee_def_line"] == 5
    assert edge["caller_line"] == 7
    assert edge["caller_line"] != edge["line"]


def test_callgraph_external_call_has_null_callee_file():
    payload = _edges()
    matches = [
        e
        for e in payload["edges"]
        if e["caller_name"] == "use_external" and e["callee_name"] == "len"
    ]
    assert len(matches) == 1
    assert matches[0]["callee_file"] is None
    assert matches[0]["callee_def_line"] is None
    # `use_external`'s own def line (line 11 — see fixtures/pkg/b.py).
    assert matches[0]["caller_line"] == 11


def test_callgraph_unresolvable_call_has_null_callee_file():
    payload = _edges()
    matches = [
        e
        for e in payload["edges"]
        if e["caller_name"] == "use_undefined"
        and e["callee_name"] == "totally_undefined_function"
    ]
    assert len(matches) == 1
    assert matches[0]["callee_file"] is None
    assert matches[0]["callee_def_line"] is None


def test_callgraph_skips_broken_file_without_crash():
    payload = _edges()
    # broken.py has a syntax error and must be skipped silently — no top-level
    # error, and edges from the other (valid) files in the package must still
    # come through.
    assert "error" not in payload
    names = {e["callee_name"] for e in payload["edges"]}
    assert "helper" in names


def test_callgraph_nonexistent_root_still_exit_zero():
    proc = _run("callgraph", os.path.join(FIX, "does_not_exist_pkg"))
    assert proc.returncode == 0
    payload = json.loads(proc.stdout)
    assert payload["edges"] == []


class _RaisingModulePathDefinition:
    """Stands in for a Jedi `Definition` whose `.module_path` raises.

    Jedi's `Definition.module_path` does further lazy inference internally
    and can raise on its own, independent of `Script.goto()` itself
    succeeding — this reproduces exactly that failure mode.
    """

    @property
    def module_path(self):
        raise RuntimeError("simulated Jedi internal failure")


class _StubScriptRaisesOnModulePathAccess:
    def goto(self, line, col, follow_imports=True):  # noqa: ARG002 - stub signature
        return [_RaisingModulePathDefinition()]


def test_resolve_callee_swallows_exception_from_module_path_access():
    # Regression test: `_resolve_callee` must wrap the ENTIRE resolution body
    # (goto + `.module_path` access + str() + containment check) in one
    # try/except, not just `goto()`. A `.module_path` raise here previously
    # escaped `_resolve_callee`, aborted the whole file loop in
    # `build_callgraph`, and got caught only by __main__.py's last-resort
    # handler — discarding every edge collected so far, not just this call.
    # `.line` access (task-p3.4) is subject to the same risk and must stay
    # inside the same guard, so the stub never even reaches it here.
    from guardian_py.callgraph import _resolve_callee

    result = _resolve_callee(_StubScriptRaisesOnModulePathAccess(), 1, 0, PKG)
    assert result == (None, None)


class _RaisingLineDefinition:
    """Stands in for a Jedi `Definition` whose `.module_path` resolves fine
    but whose `.line` raises — a distinct lazy-inference failure mode from
    `.module_path` raising, introduced by the task-p3.4 `callee_def_line`
    capture. Must be swallowed by the same try/except, not a new one.
    """

    module_path = os.path.join(PKG, "a.py")

    @property
    def line(self):
        raise RuntimeError("simulated Jedi internal failure on .line access")


class _StubScriptRaisesOnLineAccess:
    def goto(self, line, col, follow_imports=True):  # noqa: ARG002 - stub signature
        return [_RaisingLineDefinition()]


def test_resolve_callee_swallows_exception_from_line_access():
    # Regression test (task-p3.4): `defs[0].line` (captured for
    # `callee_def_line`) must be inside the same try/except as
    # `.module_path` — a raise here must not escape `_resolve_callee` either.
    from guardian_py.callgraph import _resolve_callee

    result = _resolve_callee(_StubScriptRaisesOnLineAccess(), 1, 0, PKG)
    assert result == (None, None)
