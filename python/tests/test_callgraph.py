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


def test_callgraph_external_call_has_null_callee_file():
    payload = _edges()
    matches = [
        e
        for e in payload["edges"]
        if e["caller_name"] == "use_external" and e["callee_name"] == "len"
    ]
    assert len(matches) == 1
    assert matches[0]["callee_file"] is None


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
