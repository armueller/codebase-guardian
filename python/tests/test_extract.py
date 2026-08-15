import os

from guardian_py.extract import extract_file

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _units_by_name(result):
    return {u["name"]: u for u in result["units"]}


def test_module_metadata():
    result = extract_file(os.path.join(FIX, "models_sample.py"))
    assert result["language"] == "py"
    assert result["module"]["domains"] == ["covered-calls", "labels"]


def test_dataclass_unit():
    units = _units_by_name(extract_file(os.path.join(FIX, "models_sample.py")))
    mark = units["Mark"]
    assert mark["kind"] == "dataclass"
    assert mark["is_exported"] is True
    assert mark["domains"] == ["options", "marking"]
    assert mark["tags"] == ["mark", "carry-forward", "staleness"]
    assert mark["signature"] is None
    assert "dataclass(frozen=True)" in mark["decorators"]


def test_function_signature():
    units = _units_by_name(extract_file(os.path.join(FIX, "models_sample.py")))
    fn = units["score_strike"]
    assert fn["kind"] == "function"
    assert fn["signature"]["returns"] == "float"
    params = {p["name"]: p for p in fn["signature"]["params"]}
    assert params["contract"]["annotation"] == "Contract"
    assert params["weights"]["default"] == "DEFAULT_WEIGHTS"


def test_export_via_all_and_underscore():
    units = _units_by_name(extract_file(os.path.join(FIX, "models_sample.py")))
    # __all__ lists Mark + score_strike; _private_helper is neither in __all__ nor public
    assert units["_private_helper"]["is_exported"] is False


def test_syntax_error_payload():
    result = extract_file(os.path.join(FIX, "broken.py"))
    assert result["error"] == "syntax"
    assert result["language"] == "py"
    assert "units" not in result
