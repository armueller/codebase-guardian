import json
import os
import subprocess
import sys

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
ROOT = os.path.dirname(os.path.dirname(__file__))  # the python/ dir


def _run(*args):
    return subprocess.run(
        [sys.executable, "-m", "guardian_py", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def test_extract_emits_json_exit_zero():
    proc = _run("extract", os.path.join(FIX, "models_sample.py"))
    assert proc.returncode == 0
    payload = json.loads(proc.stdout)
    assert payload["language"] == "py"
    assert any(u["name"] == "Mark" for u in payload["units"])


def test_syntax_error_still_exit_zero():
    proc = _run("extract", os.path.join(FIX, "broken.py"))
    assert proc.returncode == 0
    payload = json.loads(proc.stdout)
    assert payload["error"] == "syntax"


def test_nonexistent_path_still_exit_zero():
    proc = _run("extract", os.path.join(FIX, "does_not_exist.py"))
    assert proc.returncode == 0
    payload = json.loads(proc.stdout)
    assert payload["error"] == "not_found"


def test_broad_except_path_still_exit_zero():
    # A directory path raises IsADirectoryError (an OSError, not
    # FileNotFoundError) from open() — this exercises the generic
    # `except Exception` branch rather than the not_found branch.
    proc = _run("extract", FIX)
    assert proc.returncode == 0
    payload = json.loads(proc.stdout)
    assert "error" in payload
