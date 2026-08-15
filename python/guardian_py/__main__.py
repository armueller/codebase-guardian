"""CLI for the guardian Python helper.

Domain: code-index, python-support. Tags: cli, extraction, entrypoint.
"""
from __future__ import annotations

import argparse
import json
import sys

from guardian_py.extract import extract_file


def main(argv: list[str] | None = None) -> int:
    """Dispatch a guardian_py subcommand; always return 0 (fail-open contract)."""
    parser = argparse.ArgumentParser(prog="guardian_py")
    sub = parser.add_subparsers(dest="command", required=True)
    p_extract = sub.add_parser("extract", help="Extract units from one file")
    p_extract.add_argument("file")
    args = parser.parse_args(argv)

    if args.command == "extract":
        try:
            payload = extract_file(args.file)
        except FileNotFoundError:
            payload = {"language": "py", "file": args.file, "error": "not_found"}
        except Exception as exc:  # never crash the caller; report and exit 0
            payload = {"language": "py", "file": args.file, "error": "internal", "detail": str(exc)}
        sys.stdout.write(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
