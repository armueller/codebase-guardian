<!--
  Project domain checklists for /pr-audit (codebase-guardian).
  Loaded and run by the plugin's pr-audit skill in Phase 6.3.
  These encode this repo's load-bearing invariants (see CLAUDE.md). Each item
  names the severity to assign on failure; every finding still needs concrete
  evidence (a file:line, a Guardian hit, a test result).
-->

# Codebase Guardian — PR Audit Domain Checklists

The subject of this project is a PreToolUse validation hook + semantic code index shipped as a Claude Code plugin. Its invariants are unusually load-bearing: a regression here silently corrupts other people's edit-validation. Audit the diff against the following. Cite `file:line` evidence for every finding.

## 1. Fail-open (the top invariant — a violation is almost always 🔴)

The hook MUST NEVER permanently block work. Every error path must allow the edit and log.

- [ ] Every new or modified hook error path allows the edit: missing/locked DB, SQLite error, extractor failure, `SyntaxError`, headless-Claude timeout or crash, JSON-parse failure, ruff/pydoclint/subprocess failure, `buildPatternContext` failure. A path that returns `deny` on an *error* (as opposed to a real validation decision), or that throws uncaught out of the hook, → 🔴 BUG.
- [ ] Extractors and subprocess runners never throw — they catch internally and return a sentinel (`null`/empty/`unavailable`). Check any new/edited: `function-extractor.ts`, `adapters/py-adapter.ts` (`extractPython`), `py-tools.ts` (`runPyTools`), `py-doc-check.ts`, `mcp-server/py-index.ts` (`extractPythonFile`), `mcp-server/py-call-graph.ts` (`buildPythonCallGraph`). New extraction/subprocess code without a fail-open guard → 🔴 BUG. A test proving "returns/allows, does not throw" should exist → else 🟡 PV.

## 2. Hook output & exit discipline (see CLAUDE.md "Hook Output Protocol & Exit Discipline")

- [ ] Any new deny decision is emitted via `buildPreToolUseDecision(...)` → `hookSpecificOutput` on **stdout**, process exiting 0. A deny emitted via `exit(2)` + stderr JSON → 🔴 BUG (Claude Code classifies it as a non-blocking error and the edit proceeds — the deny is silently discarded).
- [ ] No new `process.exit(...)` call on the hook path. Exit paths set `process.exitCode` and return. A `process.exit()` → 🔴 BUG (forces onnxruntime thread teardown → SIGABRT/exit 134, and a non-zero exit discards the deny).

## 3. Circuit breaker (see CLAUDE.md "Circuit breaker")

- [ ] Any change touching the deny/retry loop preserves the stand-down after `MAX_CONSECUTIVE_DENIALS` consecutive denials of the same file (allow + surface concerns as a loud warning), and the check still sits before the identical-resubmission short-circuit. Removing or weakening it → 🔴 BUG (violates never-permanently-block).

## 4. Validation cache vs session store (see CLAUDE.md — the two-hash rules)

- [ ] Session staleness is checked against the hash of the file **on disk** (`lastDeniedContentHash`), NOT the proposed post-edit content. Staleness checked against proposed content → 🟠 RISK (every slightly-different retry clears the session and pays full headless cost).
- [ ] Identical-resubmission detection uses `lastDeniedProposedHash` (hash of the proposed content). Confusing the two hashes → 🟠 RISK.
- [ ] Validation-cache entries store `filePath` for per-file invalidation, and the cache is busted on index rebuild. Missing either → 🟡 PV.

## 5. CJS/ESM boundary (see CLAUDE.md "CJS/ESM Boundary")

- [ ] Hook code (`src/hooks/**`, runs via `tsx` as CJS) does not add a **runtime** import of an ESM-only `src/mcp-server/**` module. Type-only imports across the boundary are fine. A new cross-boundary runtime import → 🔴 BUG (runtime load failure). 
- [ ] Runtime utilities intentionally duplicated across the boundary (with explanatory comments) must NOT be "unified." Do not flag such duplication as a DRY violation — if the diff *removes* a duplication and unifies across the boundary, that is the finding → 🟠 RISK.
- [ ] New `.cjs` boundary files that the compiled hook needs are copied into `dist/` by `scripts/copy-assets.mjs`. A new `.cjs` not wired into copy-assets → 🔴 BUG (missing-module at runtime).

## 6. Index correctness — tiers, normalization, no cross-language regression

- [ ] Normalization unchanged: domains and tags are split/trim/**lowercased**; system layers are split/trim and **NOT lowercased**. New normalization code that deviates → 🟡 PV.
- [ ] Tier detection unchanged: Tier 1 = doc metadata present (`@domain` / `Domain:`); Tier 2 = exported/public without doc; Tier 3 = markdown section. Misclassification → 🟠 RISK.
- [ ] The TypeScript path is unchanged by Python/other-language work unless explicitly intended. Shared code refactors (e.g. `buildPatternContext`, prompt builders) must keep TS output byte-identical — the existing TS tests must pass unchanged. Unintended TS drift → 🟠 RISK.
- [ ] No `language` filter is added to a shared index query (`getCallers`/`getCallees`/`search`/`buildPatternContext` sibling/similar lookups) unless the change is *intentionally* language-scoping the caller (and the TS caller path is left unfiltered). An unintended filter → 🟠 RISK.

## 7. Plugin build / packaging

- [ ] `dist/` and `node_modules/` are NOT committed. New committed build output → 🟡 PV.
- [ ] User-facing changes bump the version in **both** `.claude-plugin/plugin.json` and `package.json` (the `package.json` hash is what triggers the plugin rebuild). Only one bumped, or neither → 🟡 PV.
- [ ] New plugin assets live under a synced path (`build.sh` syncs `src scripts skills hooks templates python … .claude-plugin .mcp.json`). A new runtime asset outside those paths → 🟠 RISK (absent in the built `app/`).

## 8. Tests & docs

- [ ] New hook or index behavior has a `tsx --test` test (`npm test`). A behavior change with no test → 🟡 PV.
- [ ] Architecture-affecting changes (a new invariant, subsystem, or seam) are reflected in `CLAUDE.md` (the living architecture doc). Not reflected → 🟣 Missing Piece.
- [ ] Python helper changes (`python/guardian_py/**`) have matching `pytest` coverage under `python/tests/`. New Python behavior without a test → 🟡 PV.
