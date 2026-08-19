import os

from guardian_py.extract import extract_file

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _units_by_name(result):
    return {u["name"]: u for u in result["units"]}


def test_all_does_not_suppress_public_method_export():
    # __all__ governs MODULE-level exports only; a public method not in __all__ must
    # still report is_exported=True (else its docstring requirement silently vanishes
    # for every module disciplined enough to declare __all__). Regression for Q2.
    units = _units_by_name(extract_file(os.path.join(FIX, "all_with_method.py")))
    assert units["Widget"]["is_exported"] is True  # in __all__
    assert units["to_dict"]["is_exported"] is True  # public method, NOT in __all__
    assert units["_private"]["is_exported"] is False  # underscore-private method


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


def test_nested_class_recursive_walk():
    units = _units_by_name(extract_file(os.path.join(FIX, "nested_class_sample.py")))
    assert units["Outer"]["kind"] == "class"
    assert units["Outer"]["parent"] is None
    assert units["Meta"]["kind"] == "class"
    assert units["Meta"]["parent"] == "Outer"
    assert units["describe"]["kind"] == "method"
    assert units["describe"]["parent"] == "Meta"
    assert units["outer_method"]["kind"] == "method"
    assert units["outer_method"]["parent"] == "Outer"


def test_qualified_dataclass_decorator_detected():
    units = _units_by_name(extract_file(os.path.join(FIX, "qualified_dataclass.py")))
    assert units["QualifiedBare"]["kind"] == "dataclass"
    assert units["QualifiedCalled"]["kind"] == "dataclass"


def test_dataclass_fields():
    units = _units_by_name(extract_file(os.path.join(FIX, "models_sample.py")))
    mark = units["Mark"]
    fields = {f["name"]: f for f in mark["fields"]}
    assert fields["price"] == {
        "name": "price",
        "annotation": "float",
        "default": None,
        "comment": "dollars per share",
    }
    assert fields["stale_sessions"] == {
        "name": "stale_sessions",
        "annotation": "int",
        "default": "0",
        "comment": None,
    }
    # Methods must not appear as fields.
    assert "is_stale" not in fields


def test_method_and_function_parent_linkage():
    units = _units_by_name(extract_file(os.path.join(FIX, "models_sample.py")))
    assert units["is_stale"]["kind"] == "method"
    assert units["is_stale"]["parent"] == "Mark"
    assert units["score_strike"]["kind"] == "function"
    assert units["score_strike"]["parent"] is None


def test_annotated_all_restricts_exports():
    # __all__: list[str] = [...] is an ast.AnnAssign, not ast.Assign. A name not
    # in it must report is_exported=False even though it has no leading
    # underscore (otherwise the underscore-convention fallback over-exports it).
    units = _units_by_name(extract_file(os.path.join(FIX, "annotated_all.py")))
    assert units["public_fn"]["is_exported"] is True
    assert units["looks_public_but_not_exported"]["is_exported"] is False


def test_syntax_error_payload():
    result = extract_file(os.path.join(FIX, "broken.py"))
    assert result["error"] == "syntax"
    assert result["language"] == "py"
    assert "units" not in result
