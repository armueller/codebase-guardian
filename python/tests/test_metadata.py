from guardian_py.metadata import parse_doc_metadata


def test_parses_domain_and_tags_lowercased():
    doc = (
        "A contract's mark on a date.\n\n"
        "Domain: Options, Marking. Tags: Mark, Carry-Forward, staleness.\n"
    )
    meta = parse_doc_metadata(doc)
    assert meta["domains"] == ["options", "marking"]
    assert meta["tags"] == ["mark", "carry-forward", "staleness"]
    assert meta["layer"] is None


def test_layer_is_not_lowercased():
    doc = "Do a thing.\n\nDomain: pricing. Layer: Business Logic.\n"
    meta = parse_doc_metadata(doc)
    assert meta["domains"] == ["pricing"]
    assert meta["layer"] == "Business Logic"


def test_none_and_empty_are_safe():
    assert parse_doc_metadata(None) == {"domains": [], "tags": [], "layer": None}
    assert parse_doc_metadata("Just a summary, no metadata.") == {
        "domains": [],
        "tags": [],
        "layer": None,
    }


def test_prose_with_compound_word_is_not_metadata():
    # "DataLayer:" must not match — the \b anchor prevents prose false-positives.
    meta = parse_doc_metadata("Uses the DataLayer: storage tier for caching.")
    assert meta == {"domains": [], "tags": [], "layer": None}


def test_label_value_stops_at_newline():
    # A label line without a terminating period must not swallow following prose.
    doc = "Domain: options, marking\n\nThis is prose that follows the metadata.\n"
    meta = parse_doc_metadata(doc)
    assert meta["domains"] == ["options", "marking"]


def test_label_must_start_a_line_not_be_embedded_in_prose():
    doc = "See the Domain: model layer for details.\n"
    meta = parse_doc_metadata(doc)
    assert meta == {"domains": [], "tags": [], "layer": None}
