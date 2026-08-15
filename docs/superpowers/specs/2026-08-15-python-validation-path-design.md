# Python Validation Path — Full Parity (Tier A + B)

**Date:** 2026-08-15
**Branch:** TBD (not yet created)
**Status:** Design approved, pending implementation plan

## Summary

Codebase Guardian is a TypeScript-only tool: the PreToolUse hook and the semantic
indexer both parse with ts-morph, and `shouldSkipValidation` was a deny-list that
validated anything it did not explicitly exclude. On the RMWM2 project — which has
a load-bearing, in-progress Python package at `ml/labelgen/` — this caused a cascade
of false denials: the TS parser emitted spurious "syntax errors" on Python, extracted
zero functions, and the index had no Python siblings, so the headless validator either
blocked on inapplicable JSDoc conventions or blocked because the (empty) extraction
produced a prompt with no code to review.

This design adds a **first-class Python validation path with full parity** to the
TypeScript path: edit-time validation in the hook (Tier A) **and** a Python semantic
index with cross-file DRY, callers/callees, impact analysis, and hybrid search
(Tier B). The strategy differs from the TS path in one important way — Python has
mature deterministic tooling (ruff, pydoclint, pyright), so the guardian **delegates
mechanical checks to those tools and reserves the headless LLM for the semantic
judgments they cannot make** (docstring truthfulness, meaning-level DRY, pattern fit).

An interim unblock has already shipped: `shouldSkipValidation` is now an allow-list
(`VALIDATABLE_EXTENSIONS = {.ts, .tsx}`), so Python files cleanly skip validation
until this path lands. Enabling Python means adding `.py` to that allow-list behind
a real extractor.

## Motivation

- RMWM2's `ml/labelgen/` is complicated, load-bearing Python under active development.
  The guardian must help there, not block. (A workaround note was even added to
  `ml/labelgen/README.md` telling tooling to ignore the empty index — that note becomes
  obsolete once we index `ml/`.)
- The guardian's five validation principles transfer to Python (see Research Findings),
  most cleanly, some with adaptation. The semantic index (embeddings, FTS5, hybrid
  search), validation cache, session store, and circuit breaker are already
  language-agnostic and need no change — only the parse/extract and convention/prompt
  layers are TypeScript-locked.

## Decisions (locked with user)

| Decision | Choice | Rationale |
|---|---|---|
| Scope | **Tier A + B (full parity)** | Python is load-bearing; cross-file DRY/callers/search are wanted. |
| Analysis engine | **Python-subprocess** (managed venv) | Maximum accuracy; user accepts the guardian provisioning a Python env. |
| Type-check oracle | **pyright** | Faster, stricter, analyzes unannotated code; runs `--outputjson`. |
| Docstring strictness | **Pragmatic** | Module + class docstrings + `Domain`/`Tags` always; function `Args/Returns/Raises` only when the signature is non-trivial. Anti-churn. |
| Convention & linters | **Ours to define** | `ml/labelgen` is ~5 small modules; user will bring it up to a clean standard and add tooling. |
| Deterministic-first | **Yes** | ruff/pydoclint/pyright own mechanical verdicts; LLM owns semantic judgment. |

## Research Findings — principle transfer verdicts

1. **Documentation completeness & accuracy — transfers with adaptation.** Accuracy
   checking is *better* supported in Python (pydoclint / ruff `DOC` verify params/
   returns/raises against the signature deterministically). Adaptations: do **not**
   require types-in-docstrings (types live in PEP 484/604 annotations; duplicating is
   an anti-pattern); no required-tag standard (default **Google** style); `@domain/
   @tags/@systemlayer` have no native equivalent → carry them as a structured docstring
   section. LLM handles semantic truthfulness only.
2. **DRY — transfers cleanly.** Prime the LLM on Python reuse vectors (decorators,
   mixins, `functools.singledispatch`/`cached_property`, context managers), not just
   literal duplication.
3. **Pattern consistency — transfers cleanly** (stronger fit — PEP 20 "one obvious way").
   Make "siblings" package-aware (`__init__.py`/`__all__`); do not re-check formatting
   (ruff owns it).
4. **Runtime correctness — transfers with weakened guarantees.** Dynamism (`getattr`,
   `**kwargs`, monkeypatching) makes attribute-access claims unreliable → **delegate to
   pyright, bias warn-not-deny**.
5. **API validity — transfers with adaptation.** Signature resolution works (Jedi/
   griffe/pyright), but variadic/decorated/overloaded signatures reduce certainty →
   **warn-not-deny** when the callee is decorated, variadic, or dynamically dispatched.

## Architecture

The core move is a **language-adapter seam** at the extraction boundary. Everything
downstream of extraction is already language-agnostic and is reused verbatim: the
validation cache (`validation-cache.ts`), session store (`validation-sessions.ts`),
circuit breaker (`circuit-breaker.ts`), embeddings (`embeddings.ts`), FTS5 + hybrid
search, headless-Claude orchestration (`claude-headless.ts`), and the hook output
protocol (`hook-output.ts`).

### 1. Language-adapter boundary

A `LanguageAdapter` interface, dispatched on file extension, exposes what today is
hardcoded to ts-morph:

```
interface LanguageAdapter {
  language: 'ts' | 'py';
  getSyntaxErrors(content): SyntaxError[] | { fatal: true };   // fatal → hook allows (intermediate state)
  extract(content, filePath): ExtractedUnit[];                 // functions, methods, classes, dataclasses, modules
  parseDocMetadata(unit): { domains, tags, layer? };
}
```

- **TS adapter** wraps the existing `function-extractor.ts` / `code-analyzer.ts` /
  `jsdoc-parser.ts` (no rewrite — the current functions become the adapter body).
- **PY adapter** shells to the Python helper (component 2) and maps its JSON onto the
  common `ExtractedUnit` shape. `ExtractedClass` is added to `types.ts` (classes and
  dataclasses); functions and methods reuse `ExtractedFunction`.

The hook's `validateEdit` and the indexer select the adapter by extension. Prompts are
parameterized by `language`.

### 2. Python extraction helper (`guardian_py`)

A small Python package bundled with the guardian and run from the guardian's managed
venv (component 6). Two modes:

- `python -m guardian_py extract <file>` — parse one file with **`ast` + griffe**; emit
  JSON: modules/classes/functions/methods with docstrings, signatures (params +
  annotations + defaults, `*args`/`**kwargs`, keyword-only), decorators, imports,
  `__all__`, line numbers, and parsed `Domain:`/`Tags:`/`Layer:` metadata. On
  `SyntaxError` (mid-edit buffer) emit `{"error":"syntax","detail":...}`.
- `python -m guardian_py callgraph <package-root>` — use **Jedi** to resolve cross-file
  call edges (`caller → callee`) across the package for index builds.

The helper is stdlib-first (`ast`, `griffe`) so extraction has minimal dependency
surface; Jedi is only needed for the offline call graph.

### 3. Hook path (Tier A) for `.py`

1. Construct post-edit content (existing logic in `validateEdit`).
2. Run `guardian_py extract` (bounded timeout, **fail-open** on any error; `SyntaxError`
   → allow-with-note "intermediate state", matching the TS path's behavior).
3. Run deterministic tools on the edited file and capture structured findings:
   **ruff** (lint), **pydoclint** (docstring↔signature), **pyright** (`--outputjson`,
   types). Each is timeout-bounded and fail-open.
4. Local **pragmatic doc-completeness** check (see Convention): module/class docstrings
   + `Domain`/`Tags` required; function `Args/Returns/Raises` required only for
   non-trivial signatures.
5. Build a **Python-flavored prompt**: extracted units + docstrings + deterministic-tool
   findings + index pattern-context (siblings/similar/callers from Tier B) + the
   convention text. LLM makes the **semantic** verdict (truthfulness, meaning-DRY,
   pattern fit) and is told to **warn-not-deny** on dynamic/unresolvable
   runtime/API concerns.
6. Cache / session / circuit-breaker: reused verbatim.

### 4. Indexer path (Tier B)

- Walk `.py`, **excluding** `.venv/`, `__pycache__/`, `.pytest_cache/`, `site-packages/`,
  `build/`, `dist/`, `.mypy_cache/`, `.ruff_cache/`. (RMWM2's `ml/` has 467 `.py` files
  but only ~5 real source modules; the rest are the vendored `.venv`.)
- Extract via `guardian_py extract`; resolve call edges via `guardian_py callgraph`.
- Populate the **same** tables (see Data Model). Embeddings are generated from Python
  docstrings by the existing pipeline (language-agnostic).
- `guardian.config.json` gains an optional `extensions` override already; the walk and
  the call-graph glob must both honor Python (today the call-graph glob is hardcoded to
  `**/*.ts{,x}` — it becomes language-aware).

## Data Model

Reuse the existing schema (`db.ts`) with minimal additions:

- **`functions.language`** — new column, `'ts' | 'py'`; existing rows default `'ts'`.
- **`functions.declaration_type`** — extend the value set to include `module`, `class`,
  `dataclass`, `method` (already stores `function`, arrow, etc. for TS). Python classes
  and dataclasses are stored as `functions` rows; methods as rows linked by file/line.
- **`function_domains` / `function_tags`** — reused for parsed `Domain:`/`Tags:`.
  Module docstrings are indexed as their **own `declaration_type='module'` rows**
  (aiding doc-section-style discovery) **and** their module-level `Domain` is
  **denormalized onto the module's members**, so a class/function without its own
  `Domain` still inherits the module's for search. (Both, resolved during review.)
- **`call_edges`** — unchanged shape; Jedi supplies `(caller, callee)` edges.
- **`function_systemlayers`** — reused for the optional Python `Layer:`; may be empty.

This is a schema bump. Indexes are per-project and rebuildable, so the migration is a
single `rebuild_index`, which already busts the validation cache (per CLAUDE.md).

**Tier detection (Python):** `Domain:` present in a docstring → **Tier 1**; public
(in `__all__` or non-`_`-prefixed) → **Tier 2**; markdown → **Tier 3** (unchanged).

## Convention (the standard the guardian enforces)

Google-style docstrings; **types in annotations, never in prose**. Normalization rules
follow the TS path: domains and tags are split/trim/**lowercased**; layer is
split/trim/**not lowercased**.

- **Module docstring** (required): one-line what + `Domain: <a, b, c>` line.
- **Class / dataclass docstring** (required): one-line what + invariants paragraph +
  `Domain: … Tags: …`. Field units/invariants stay as inline `# comments`
  (`strike: float  # dollars per share`).
- **Public function/method docstring** (required): one-line imperative summary;
  `Args:`/`Returns:`/`Raises:` **only when the signature is non-trivial**. `_private`
  helpers: summary only.
- **Type annotations** required on every public param + return (PEP 604 `X | Y`).
- **Metadata grammar:** `Domain:` and `Tags:` are comma-separated lists on their own
  line inside module/class docstrings; optional `Layer:` line for system layer.

The guardian does **not** re-check formatting (ruff owns it) and biases **warn-not-deny**
on runtime/API concerns that depend on dynamic resolution.

## Provisioning (install.sh + update.sh — change both)

- Create a managed venv at `~/.codebase-guardian/pyenv/` with:
  `pip install griffe jedi pydoclint ruff pyright` (pyright's pip package bundles its
  Node binary; ruff ships a wheel). Pinned versions recorded in a
  `requirements-python.txt` in the repo.
- Requires `python3` (≥3.12) on PATH. If provisioning fails, **Python validation
  degrades to skip** — `.py` is only added to `VALIDATABLE_EXTENSIONS` when the pyenv
  and helper import-check succeed (fail-open, never a hard error).
- `install.sh` and `update.sh` currently use `npm install --ignore-scripts && npm rebuild
  better-sqlite3`; the venv step is added to both (CLAUDE.md invariant: change both).

## RMWM2 rollout (separate from the guardian build; sequence after)

1. Add `[tool.ruff]`, `[tool.pyright]`, `[tool.pydoclint]` to `ml/pyproject.toml`.
2. Bring `ml/labelgen/*.py` docstrings up to the convention (small; ~5 modules).
3. Remove the workaround note in `ml/labelgen/README.md`.
4. Run `rebuild_index` for RMWM2 so `ml/` is indexed; verify hook behavior on a real
   `.py` edit.

## Testing

- **Python helper JSON contract** — fixtures: valid module, mid-edit invalid buffer
  (→ `error: syntax`), frozen dataclass with `Domain:/Tags:`, function with and without
  `Args:`, `_private` helper, `*args/**kwargs` signature.
- **Language dispatch** — extension → adapter selection; `.py` routes to PY adapter.
- **Deterministic-tool parsing** — ruff/pydoclint/pyright JSON → structured findings;
  tool-missing and tool-timeout both fail-open.
- **Indexer** — walk excludes `.venv/`/caches; a fixture Python package indexes into the
  shared tables with correct tiers; Jedi call edges populate `call_edges`.
- **Pragmatic doc check** — trivial signature needs only a summary; non-trivial requires
  `Args/Returns`.
- **End-to-end hook** — feed a `.py` HookInput to the installed hook (as done for the
  allow-list) and assert allow/deny + fail-open on a killed subprocess.

## Invariants Preserved

- **Fail-open, never permanently block.** Every new subprocess (extract, ruff, pydoclint,
  pyright, Jedi) is timeout-bounded and fail-open. `SyntaxError` on a mid-edit buffer →
  allow-with-note.
- **Hook must not call `process.exit()`** — set `process.exitCode` (unchanged; Exit
  Discipline block).
- **Deny via `hookSpecificOutput` on stdout, exit 0** (unchanged).
- **Denied edits never land on disk** — session staleness still checked against the file
  on disk (unchanged).
- **Circuit breaker** — reused unchanged (releases after 3 consecutive denials of the
  same file in a session).
- **Embeddings always generated** — Python docstrings feed the same pipeline; no
  skipping.

## Risks & Mitigations

- **Hook latency** (extract + ruff + pydoclint + pyright per edit). Mitigate: run tools
  only on the single edited file; short per-tool timeouts; consider pyright/dmypy-style
  warm process later. All fail-open, so a slow/absent tool never blocks.
- **`ast` cannot parse mid-edit buffers.** Accepted: on `SyntaxError` the hook allows
  with a note (we do not want to block on incomplete code anyway).
- **Jedi resolution imperfect** on dynamic Python. Accepted: call graph is best-effort;
  runtime/API verdicts bias warn-not-deny.
- **python3 / venv absence.** Degrades to skip (`.py` not enabled) — same clean state as
  today's allow-list.

## Out of Scope (v1)

- JavaScript/JSX as a first-class language (the allow-list also skips it today; add later
  via the same seam).
- A live/daemonized pyright for sub-second type checks (optimization, not correctness).
- Auto-fixing Python (guardian validates; it does not rewrite).

## Resolved Questions

- **Pin exact Python tool versions** in `requirements-python.txt` (reproducible builds,
  stable behavior) rather than floating to latest. Resolved during review.
- **Index module docstrings both ways** — as their own `declaration_type='module'` rows
  *and* by denormalizing module `Domain` onto members. Resolved during review (see
  Data Model).
