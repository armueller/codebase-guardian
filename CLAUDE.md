# Codebase Guardian

Semantic code index + automated validation hooks for TypeScript codebases. Installs as a user-level Claude Code hook and MCP server — active on every project.

## Local Development

Install dependencies locally first:

```bash
npm install --ignore-scripts && npm rebuild better-sqlite3
```

`--ignore-scripts` is required because `sharp` (transitive dep from `@huggingface/transformers`) fails to build natively. `better-sqlite3` needs its native addon rebuilt separately. The plugin bootstrap (`scripts/build.sh`) uses this same approach — keep them consistent.

## Running Tests

```bash
npm test                    # All tests (via tsx)
npm run test:mcp            # Database + indexer tests only
npm run test:hooks          # Hook helper tests only
```

Tests use Node's built-in `--test` runner via `tsx`. No jest, no mocha. Always run tests from the repo, not from the installed directory.

## Deploying / Testing Changes

Codebase Guardian ships as a **Claude Code plugin** (see `.claude-plugin/`, `hooks/`, `.mcp.json`, `scripts/`). The hook and MCP server run from the plugin's **built copy** under `${CLAUDE_PLUGIN_DATA}/app` — NOT from this repo, and no longer from `~/.codebase-guardian/source`.

**How the engine gets built:** the `SessionStart` hook (`scripts/bootstrap.sh` → `scripts/build.sh`) copies the plugin source into `${CLAUDE_PLUGIN_DATA}/app`, runs `npm install` + `npm rebuild better-sqlite3` + `npm run build`, and stamps success. It runs once on first use (in the background) and re-runs only when `package.json` changes. `dist/` and `node_modules/` are NOT committed.

**Local dev loop** (test the plugin without publishing):

```
/plugin marketplace add /absolute/path/to/codebase-guardian
/plugin install codebase-guardian@codebase-guardian
```

To force a rebuild after source changes: bump `package.json` (or delete `${CLAUDE_PLUGIN_DATA}/.build-stamp`) and start a new session. To iterate on the compiled hook directly, `npm run build` in the repo (which now also runs `scripts/copy-assets.mjs` to copy `.cjs` boundary files into `dist/` — the compiled hook needs them).

**Publishing:** bump `version` in `.claude-plugin/plugin.json`, commit, push, tag. Users get it via `/plugin update`.

Note: CLAUDE.md changes are read from the repo directly and don't require a rebuild.

## Project Structure

```
src/
├── mcp-server/             # MCP server (ESM, runs via node)
│   ├── index.ts            # Tool handlers + server setup
│   ├── db.ts               # SQLite schema + CRUD (better-sqlite3)
│   ├── indexer.ts           # Phase 1: JSDoc & doc parsing + Python module/unit indexing
│   ├── call-graph.ts        # Phase 2: TS call graph + export discovery (ts-morph)
│   ├── py-index.ts          # Python extraction bridge: guardian_py `extract` → raw JSON for the indexer
│   ├── py-call-graph.ts     # Python call graph: guardian_py `callgraph` (Jedi) → call_edges rows
│   ├── embeddings.ts        # HuggingFace vector embeddings (local, no API)
│   └── build-index.ts       # CLI entry point for index rebuilds
├── hooks/                   # PreToolUse hook (CJS via tsx, reads stdin)
│   ├── pre-edit-validation.ts  # Hook orchestrator — dispatches .py to the Python path, else the TS path
│   └── helpers/
│       ├── types.ts            # Shared type definitions (ExtractedFunction/ExtractedClass, TS + Python)
│       ├── function-extractor.ts # Extract functions + JSDoc from edit diff (TS)
│       ├── code-analyzer.ts     # Analyze called functions, types, properties (TS)
│       ├── jsdoc-parser.ts      # Parse and validate JSDoc tags (TS, local, no AI)
│       ├── skip-validation.ts   # VALIDATABLE_EXTENSIONS allow-list + isPythonFile/requiresCodeIndex
│       ├── validation-flow.ts   # Session/circuit-breaker/outcome logic shared by the TS and Python paths
│       ├── py-validate.ts       # Python validation orchestrator (mirrors validateEdit for .py)
│       ├── py-tools.ts          # Deterministic ruff + pydoclint runners
│       ├── py-doc-check.ts      # Pragmatic Python docstring-completeness convention + novelty marking
│       ├── adapters/py-adapter.ts # guardian_py `extract` bridge → ExtractedFunction/ExtractedClass
│       ├── claude-headless.ts   # Execute headless Claude for AI validation (TS + Python prompt builders)
│       ├── code-index-client.ts # Direct SQLite queries (readonly); buildPatternContext is language-scoped
│       ├── validation-cache.ts  # 5-minute TTL result cache
│       └── validation-sessions.ts # Session store for --resume support
├── config.ts               # Config resolution (git root, paths, auto-detection, getGuardianHome/pyenv)
python/
└── guardian_py/             # Python extraction helper (stdlib `ast`), run from the guardian's managed pyenv venv
    ├── extract.py            # `python -m guardian_py extract <file>` — module/class/function/method JSON
    ├── callgraph.py          # `python -m guardian_py callgraph <root>` — Jedi cross-file call edges
    └── metadata.py           # Parses `Domain:`/`Tags:`/`Layer:` docstring lines
skills/                      # Slash commands (installed to ~/.claude/skills/)
templates/                   # guardian.config.json template + CLAUDE.md snippet
tests/                       # Unit tests (tsx --test)
```

## Architecture Notes

### CJS/ESM Boundary

The project is `"type": "module"` (ESM), but the hook runs via `tsx` which executes as CJS for stdin/stdout handling. Type-only imports work across the boundary. Runtime utilities that need to work in both contexts are duplicated with comments explaining why — do not try to unify them.

### Hook vs MCP Server

The hook and MCP server are independent consumers of the same SQLite database:
- **Hook**: Direct `better-sqlite3` queries (fast, synchronous, fail-open). Runs on every Edit/Write.
- **MCP Server**: General-purpose tools for human queries. Runs as a long-lived process.

The hook cannot depend on the MCP server being running.

### Fail-Open Design

The hook MUST never permanently block work. Every error path (missing DB, SQLite error, headless Claude timeout, JSON parse failure) must allow the edit and log the error. This is a strict invariant.

**Circuit breaker (`helpers/circuit-breaker.ts`).** Now that denials actually block the tool call (see "Hook Output Protocol & Exit Discipline"), an imperfect/strict validator — or a legitimate multi-step refactor that passes through messy intermediate states — could otherwise trap the agent in an endless deny→revise→deny loop. That would violate the "never permanently block" invariant. So after `MAX_CONSECUTIVE_DENIALS` (3) consecutive denials of the same file in a session, the hook stands down: it allows the edit and surfaces the still-unresolved concerns as a loud warning + suggestion. This relies on the session-store invariant that denied edits never land on disk (so `attemptCount` accumulates across retries of the same denied edit); once released, the session is cleared. The check sits before the identical-resubmission short-circuit so the agent is freed even if it resubmits the same code.

### Hook Output Protocol & Exit Discipline

Two non-obvious constraints govern how the PreToolUse hook emits its decision. Both were the cause of denials being **silently discarded** — the hook computed a correct `deny` but the edit was still presented to the user for approval. Do not "simplify" either of these away.

1. **Deny must use `hookSpecificOutput` on stdout, exit 0 — NOT exit code 2 + stderr.** Claude Code 2.1.x classifies an `exit(2)` + stderr-JSON hook as a `hook_non_blocking_error` ("Failed with non-blocking status code") and lets the tool proceed. A blocking deny MUST be printed to **stdout** as:
   ```json
   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
   ```
   `permissionDecision` is `"allow" | "deny" | "ask"`. See `helpers/hook-output.ts` (`buildPreToolUseDecision`) and its regression test `tests/hook-output.test.ts`.

2. **The hook MUST NOT call `process.exit()` — set `process.exitCode` and let it exit naturally.** Building pattern context loads onnxruntime-node (via the embeddings pipeline) on every function edit. Its native thread pool aborts the process with `mutex lock failed: Invalid argument` (SIGABRT / exit 134) if `process.exit()` forces synchronous teardown while those threads are alive. A non-zero exit is treated as a non-blocking error (see constraint 1's failure mode), so the deny is discarded. Natural exit lets node drain stdout and tear the thread pool down cleanly (onnxruntime threads do not hold the event loop, so there is no hang). Every exit path in `pre-edit-validation.ts` sets `process.exitCode` and returns — see the "Exit Discipline" comment block there.

### Search Hint Hook (`search-hint.ts`)

A **second, independent PreToolUse hook** (matcher `Grep|Glob|Bash|mcp__codebase-guardian__search*`, via `scripts/run-search-hint.sh`) that nudges Claude toward the semantic `search` MCP tool when it greps. It is separate from the `Edit|Write` validation hook and deliberately lightweight — the **common path is string parsing + small JSON state only** (no `better-sqlite3`/onnx load), so it stays sub-10ms and can't affect validation. Only the rare nudge additionally runs one short, **timeout-bounded (500ms) `git log`** for the staleness hint, which blocks the tool briefly and degrades to "no hint" if git is slow. It emits a non-blocking reminder via `hookSpecificOutput.additionalContext` (`permissionDecision: "allow"`) — the verified mechanism for injecting model-visible context without blocking or re-prompting a tool.

- **`helpers/search-detection.ts`** (pure): classifies a call as `semantic` / `grep-search` / `none`. The Bash branch parses pipeline stages to fire on real codebase searches (`rg`, `grep -r`, `git grep`, `find -name`, `fd`) but skip pipe filters (`ps | grep`), single-file greps, and non-search `find`.
- **`helpers/search-hint-state.ts`**: per-session throttle in `${guardianHome}/.search-hint-state.json` (global, so the frequent path needs no git resolution). Nudge once, re-arm after `rearmAfter` (default 10) grep searches **without** a semantic search; a semantic search resets the counter. Keyed by session id → survives context compaction.
- **`helpers/index-staleness.ts`**: on a nudge, uses the index db's mtime + `git log --since` over pathspecs **derived from the project's indexing config** (source dirs × configured `fileExtensions`, plus doc dirs × `.md`) to append a `rebuild_index` suggestion when ≥ `stalenessThreshold` (default 15) files have landed since the last build. `.dirty-files` is unused (nothing populates it), which is why staleness is computed from git, not that.
- Gated: no nudge unless the cwd project has an index. Fail-open: any error → no output. Config knobs live under `searchHint` in `guardian.config.json`.

### Function Extractor (`function-extractor.ts`)

Uses ts-morph AST parsing to find function declarations and their JSDoc. This handles all declaration patterns: `function foo()`, `const foo = () =>`, `const foo = function foo()`, `React.memo(function foo())`, class methods, object property methods, etc.

The JSDoc lookup (`findJSDocBefore`) still uses a regex to find the nearest `/** */` block before the declaration node and a heuristic to check what text appears between them. If new declaration patterns cause JSDoc detection failures, this heuristic is the first place to look.

### Three Index Tiers

- **Tier 1 (JSDoc / docstring)**: Functions with `@domain` tag in JSDoc (TS), or a unit whose docstring has its own `Domain:` line (Python). Full metadata.
- **Tier 2 (Exports)**: Exported functions discovered by ts-morph, lacking JSDoc (TS); or a Python function/method/class/dataclass unit with no `Domain:` line (units are never Tier 3). Minimal metadata.
- **Tier 3 (Docs)**: Markdown files parsed into heading-level sections; also a Python **module** row whose docstring has no `Domain:` line (a module is never Tier 2).

Tier detection (TS): presence of `@domain` in JSDoc block → Tier 1. Otherwise if exported → Tier 2.

Tier detection (Python): the module row is Tier 1 if its docstring has a `Domain:` line, else Tier 3. Every function/method/class/dataclass unit row is Tier 1 if it has its own `Domain:` line, else Tier 2.

**Python index coverage.** `functions.language` (`'ts' | 'py'`) tags every row. Python module/class/function/method definitions are indexed by `indexPythonFile` (`indexer.ts`, via `py-index.ts`'s `extractPythonFile`) into the *same* `functions` / `function_domains` / `function_tags` / `function_systemlayers` / `function_embeddings` tables TypeScript uses — no parallel schema. A unit without its own `Domain:` line inherits the module's domains for search/embeddings (denormalization) while keeping its own tier. Cross-file Python call edges come from `py-call-graph.ts`'s `buildPythonCallGraph` (Jedi, via `guardian_py callgraph`) into the same `call_edges` table, resolved by `(file, def-line)` first — required because Python method names collide across classes in one file — falling back to name lookup. `Domain:`/`Tags:`/`Layer:` docstring lines are parsed by `guardian_py/metadata.py` and normalized exactly like JSDoc's `@domain`/`@tags`/`@systemlayer` (domains/tags lowercased, layer preserved case) into the identical columns, so hybrid search, callers/callees, and impact analysis work the same way across both languages.

### Normalization Rules

- Domains: split, trim, **lowercase**
- Tags: split, trim, **lowercase**
- System layers: split, trim, **NOT lowercased** (preserve "Business Logic", "UI Helper", etc.)

### Validation Cache vs Session Store

Two separate caching mechanisms with **different hash semantics** — getting these wrong causes stale denials or wasted headless Claude calls:

- **Validation cache** (`validation-cache.ts`): 5-minute TTL keyed on edit content hash. Avoids re-running headless Claude for the same edit. Each entry stores `filePath` so the cache can be invalidated per-file when an edit is allowed.
- **Session store** (`validation-sessions.ts`): 1-hour TTL keyed on `{outerSessionId}:{filePath}`. Enables `--resume` for faster retries after denial. Has two hashes:
  - `lastDeniedContentHash` — hash of the **file on disk** at denial time. Used for staleness detection: if the file on disk changes (because a different edit was allowed), the session is stale and must be cleared.
  - `lastDeniedProposedHash` — hash of the **proposed post-edit content** at denial time. Used for identical resubmission detection: if the exact same edit is retried, return the cached denial instantly.

**Critical invariant:** Denied edits never land on disk. So the file on disk doesn't change between retries of a denied edit. Session staleness must be checked against the file on disk, NOT the proposed content — otherwise every retry with a slightly different edit clears the session and pays the full ~15s headless Claude cost instead of the ~5s resume cost.

### Hybrid Search

40% FTS5 keyword + 60% semantic (cosine similarity on local embeddings). FTS5 ranks normalized via sigmoid. Semantic scores are already 0-1 cosine similarity.

### Python Validation Path

Python (`.py`) is a fully supported second language, not TypeScript-with-a-different-extension — it never touches ts-morph, JSDoc, or the `@domain`/`@what`/`@how` tag convention. Dispatch happens by extension at two independent seams: the hook's `VALIDATABLE_EXTENSIONS` allow-list (`skip-validation.ts`) and the indexer's Python branch (`indexer.ts`).

- **Extraction**: `guardian_py` (`python/guardian_py/`), a stdlib-`ast` helper run from the guardian's managed pyenv venv (`${GUARDIAN_HOME}/pyenv`, provisioned by `scripts/build.sh`, optional and fail-open — a missing `python3`/venv/pip only disables Python validation, it never fails the build). `python -m guardian_py extract <file>` always exits 0 (errors ride in the JSON payload, e.g. `{"error":"syntax"}` on a mid-edit buffer) and emits module/class/function/method units with docstrings, signatures, and parsed `Domain:`/`Tags:`/`Layer:` metadata. `python -m guardian_py callgraph <root>` uses Jedi for cross-file call edges (index builds only).
- **Deterministic-first, in-hook**: `py-tools.ts` runs `ruff` (lint) and `pydoclint` (docstring↔signature) — both fail-open, timeout-bounded, invoked from the guardian pyenv. `py-doc-check.ts` layers a **pragmatic** doc-completeness check on top (module + class docstrings need a `Domain:` line; public function docstrings just need to exist — `Args:`/`Returns:`/`Raises:` depth is left to pydoclint and the LLM, not locally enforced, to avoid churn on trivial signatures). **`pyright` is a CI/type gate, not run in-hook** — see the amendment in `docs/superpowers/specs/2026-08-15-python-validation-path-design.md`; in-hook latency was the reason.
- **Pattern context**: the Python index now has coverage (definitions + call edges, per "Python index coverage" above), so `py-validate.ts` pulls the same sibling/similar/caller/doc context TypeScript gets, via `buildPatternContext(filePath, ..., 'py')` — the `'py'` argument language-scopes DRY/sibling lookups so a TS function never surfaces as "similar" to a Python edit. The call is defensive (`.catch(() => EMPTY_PATTERN_CONTEXT)`) so a missing/empty/corrupt Python index can never block an edit. Session/cache/circuit-breaker logic is shared with the TS path via `validation-flow.ts` (`resolveSessionState` / `recordValidationOutcome`) rather than duplicated.
- **Prompt & bounded agent**: a neutral `PY_SYSTEM_PROMPT` (`claude-headless.ts`) carries no JSDoc/TS assumptions. The headless agent is bounded to the read-only code-index MCP tools (`PY_INDEX_TOOLS` — search/callers/callees/impact/etc.; excludes `execute` and `rebuild_index`) via `--permission-mode dontAsk` + `--disallowedTools` (Bash/Read/Write/Edit/MultiEdit/NotebookEdit/Glob/Grep/WebFetch/WebSearch/Task) — **not** `bypassPermissions`, under which `--allowedTools` is a no-op and read-only Bash would still be auto-allowed. This replaced an earlier design where the agent explored the filesystem ad-hoc for cross-file context, which caused multi-minute timeouts; bounding it to index-only tools plus pre-injected pattern context brought the timeout back to 120s, matching the TS path.
- **Stance**: Python is dynamically typed and its runtime/API guarantees are weaker than TypeScript's, so the prompt biases **warn-not-deny** on concerns the LLM can't resolve statically (attribute access, decorated/variadic signatures, monkeypatching). It denies only for a clear in-code contradiction: a docstring that plainly lies about the body, visible DRY duplication, or a missing required docstring/`Domain:` line.
- **Convention**: Google-style docstrings; types live in PEP 604 annotations, never duplicated in prose. `Domain:`/`Tags:`/`Layer:` are comma-separated lines inside module/class docstrings.

## User-Level File Locations

Guardian's runtime data lives in the plugin's persistent data dir, `${CLAUDE_PLUGIN_DATA}` — what `getGuardianHome()` resolves to under the installed plugin — which on disk is `~/.claude/plugins/data/codebase-guardian-codebase-guardian/`:

```
~/.claude/plugins/data/codebase-guardian-codebase-guardian/
├── app/                             # Built engine — dist + node_modules + python + pyenv, rebuilt by the SessionStart bootstrap (scripts/build.sh)
├── indexes/{project-hash}/          # Per-project SQLite databases
│   ├── code-quality.db
│   ├── .validation-cache.json       # Result cache
│   └── .validation-sessions.json    # Session store
├── logs/{project-hash}/
│   └── validation-debug.log         # Every hook invocation with timing
├── metrics.db                       # Durable cross-project decision metrics
├── .build-stamp                     # Marks a successful engine build (delete to force a rebuild)
└── projects.json                    # Hash → name/path manifest
```

The plugin's own files (manifest, `hooks/`, `skills/`, `scripts/`) are installed read-only under `~/.claude/plugins/cache/{marketplace}/codebase-guardian/{version}/` (i.e. `${CLAUDE_PLUGIN_ROOT}`). `GUARDIAN_HOME` overrides the data dir; without the plugin it falls back to `~/.codebase-guardian/`.

## Debugging Validation Logs

Per-project validation logs are at `~/.claude/plugins/data/codebase-guardian-codebase-guardian/logs/{project-hash}/validation-debug.log`. To find which hash corresponds to which project:

```bash
cat ~/.claude/plugins/data/codebase-guardian-codebase-guardian/projects.json
```

### Log Format

Each hook invocation starts with `=== {ISO timestamp} ===` and includes:

- `[TIMING]` — Performance metrics for each phase (read file, analyze usage, extract functions, build pattern context, headless Claude execution, total)
- `Functions - Called: N, Modified: N, Created: N` — What the code analyzer detected
- `JSDoc violations: functionName: N` or `none` — Local (pre-AI) JSDoc check results
- `[CACHE]` — Cache hit/miss
- `[SESSION]` — Session continuity (first attempt, retry, identical resubmission, stale session cleared)
- `[CONTEXT]` — What pattern context was built (README, siblings, similar functions, callers, docs, comments)
- `Decision: allow|deny` — Headless Claude's decision
- `Reasoning:` — Why
- `Violations:` / `Suggestions:` — Specific issues
- `ALLOW:` or `DENY:` — Final hook outcome

### Key Patterns to Look For

- **`DENY:` lines** — All denials with reasons. Grep for these first.
- **`[SESSION] File content changed since last denial`** — Session was cleared because the file on disk changed (an allowed edit landed between retries). If this fires when no allowed edit happened, it's a bug.
- **`[SESSION] Identical resubmission detected`** — Exact same proposed edit retried without changes.
- **`[CACHE] Returning cached result: deny`** — A cached denial was served. If the function's JSDoc was fixed by a prior allowed edit, this is a stale cache bug.
- **`No functions or types modified/created`** — Hook skipped validation (no function/type declarations changed).
- **`Body-only edit detected inside: FunctionName`** — Edit was inside a function body, treated as modification of that function.

### Busting the Cache

After deploying bug fixes to validation logic, cached denials from before the fix may still be served. Clear them:

```bash
# Find the project hash
cat ~/.claude/plugins/data/codebase-guardian-codebase-guardian/projects.json

# Clear cache and sessions for a specific project
GUARDIAN_DATA=~/.claude/plugins/data/codebase-guardian-codebase-guardian
rm "$GUARDIAN_DATA/indexes/{project-hash}/.validation-cache.json" "$GUARDIAN_DATA/indexes/{project-hash}/.validation-sessions.json"
```

Always do this after deploying fixes that change allow/deny behavior.

### Logs Are Large

These logs grow fast. Use `wc -l`, `grep`, and `tail` to navigate — don't try to read the whole file.

## Key Dependencies

- `better-sqlite3`: Synchronous SQLite (WAL mode for concurrent reads)
- `ts-morph`: TypeScript compiler API wrapper (call graph, export discovery)
- `@huggingface/transformers`: Local embedding model (`Xenova/all-MiniLM-L6-v2`, 384-dim)
- `@modelcontextprotocol/sdk`: MCP server framework
- `zod`: Schema validation
