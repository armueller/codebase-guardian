# Architecture

## System Components

The code index system has eight core modules (six TypeScript, two Python-bridge) and two external integration points:

### Core Modules (MCP Server)

All live in `src/mcp-server/`:

| Module | File | Responsibility |
|--------|------|---------------|
| **Database** | `db.ts` | Schema definition, CRUD operations, FTS5 search, type definitions (`functions.language` tags TS/Python rows) |
| **Indexer** | `indexer.ts` | JSDoc parsing, comment extraction, doc section parsing, file scanning; dispatches `.py` files to the Python indexing branch |
| **Call Graph** | `call-graph.ts` | TypeScript AST analysis via ts-morph, export discovery, call edge extraction |
| **Python Index Bridge** | `py-index.ts` | Runs `guardian_py extract` for an on-disk `.py` file, returns raw module+unit JSON for the indexer |
| **Python Call Graph** | `py-call-graph.ts` | Runs `guardian_py callgraph` (Jedi), resolves edges by `(file, def-line)` into `call_edges` |
| **Embeddings** | `embeddings.ts` | HuggingFace `all-MiniLM-L6-v2` local inference, vector storage, cosine similarity |
| **MCP Server** | `index.ts` | MCP protocol implementation, tool handlers, hybrid search orchestration |
| **Build CLI** | `build-index.ts` | Command-line entry point for full/incremental rebuilds |

### Hook Integration (Validation System)

Lives in `src/hooks/`:

| Module | File | Responsibility |
|--------|------|---------------|
| **Hook Entry** | `pre-edit-validation.ts` | Intercepts Edit/Write, resolves the skip-list/language dispatch, orchestrates the TS validation flow |
| **Skip/Language Gate** | `helpers/skip-validation.ts` | `VALIDATABLE_EXTENSIONS` allow-list + `isPythonFile`/`requiresCodeIndex` language dispatch |
| **Code Index Client** | `helpers/code-index-client.ts` | Direct SQLite queries against `code-quality.db` for pattern context (language-scoped via an optional `language` arg) |
| **Headless Claude** | `helpers/claude-headless.ts` | Executes headless Claude CLI for AI-powered code review (TS + Python prompt builders, TS/Python system prompts) |
| **Validation Cache** | `helpers/validation-cache.ts` | 5-minute TTL cache to avoid re-validating identical edits |
| **Session Store** | `helpers/validation-sessions.ts` | Maps file paths to Claude session IDs for `--resume` |
| **Validation Flow (shared)** | `helpers/validation-flow.ts` | Session/circuit-breaker/identical-resubmission resolution + outcome recording, shared by the TS and Python paths |
| **Function Extractor** | `helpers/function-extractor.ts` | Extracts function/type declarations from edit diffs (TS, ts-morph) |
| **Code Analyzer** | `helpers/code-analyzer.ts` | Analyzes called functions, property accesses, type usage (TS) |
| **JSDoc Parser** | `helpers/jsdoc-parser.ts` | Local (non-AI) JSDoc completeness validation (TS) |
| **Python Validator** | `helpers/py-validate.ts` | Validates `.py` edits: guardian_py extraction, doc-completeness, deterministic tools, pattern context, headless Claude |
| **Python Adapter** | `helpers/adapters/py-adapter.ts` | Bridges the `guardian_py extract` subprocess into `ExtractedFunction`/`ExtractedClass` |
| **Python Tools** | `helpers/py-tools.ts` | Runs `ruff` + `pydoclint` (fail-open, timeout-bounded) for deterministic findings |
| **Python Doc Check** | `helpers/py-doc-check.ts` | Pragmatic docstring-completeness convention check + novelty (new/modified) marking |
| **Types** | `helpers/types.ts` | Shared type definitions for hook system (TS + Python) |

## Data Flow

### 1. Index Build (Offline)

```
Source Files (app/**/*.ts, app/**/*.tsx)
    │
    ▼
Phase 1: Code Scanning (indexer.ts)
    ├── Scan all .ts/.tsx files in app/
    ├── Match JSDoc blocks containing @domain (Tier 1)
    ├── Parse @what, @how, @why, @param, @returns, @sideeffects, @domain, @tags, @systemlayer
    ├── Extract function name + body from code following JSDoc
    ├── Extract inline comments from function bodies
    ├── Scan docs/ for .md files (Tier 3)
    ├── Parse doc sections at heading boundaries
    ├── Generate vector embeddings (HuggingFace local)
    └── Store everything in code-quality.db
    │
    ▼
Phase 2: Call Graph (call-graph.ts)
    ├── Load TypeScript project via ts-morph
    ├── Discover all exported functions/variables/classes (Tier 2)
    ├── Walk AST to find function call expressions
    ├── Resolve callee to source file using TypeScript's type checker
    ├── Insert call edges (source → target)
    └── Generate embeddings for Tier 2 functions
    │
    ▼
Phase 1b + 2b: Python (py-index.ts, py-call-graph.ts) — same tables, no parallel schema
    ├── Scan all .py files (excluding .venv/__pycache__/site-packages/build/dist/caches)
    ├── Run `guardian_py extract` per file — module row + function/method/class/dataclass units
    ├── Parse Domain:/Tags:/Layer: docstring lines (Tier 1 if Domain: present, else Tier 2/3)
    ├── Denormalize: a unit without its own Domain inherits the module's
    ├── Run `guardian_py callgraph` (Jedi) — cross-file call edges, resolved by (file, def-line)
    └── Generate embeddings from docstrings (same pipeline as TypeScript)
```

### 2. Edit Validation (Online, per-edit)

```
Claude Edit/Write ──► PreToolUse Hook fires
    │
    ▼
Skip gate (helpers/skip-validation.ts): infrastructure/secret path patterns
(CLAUDE.local, .env, .claude/hooks/) skip unconditionally; otherwise the file's
extension must be in VALIDATABLE_EXTENSIONS ({.ts, .tsx, .py}) — an ALLOW-LIST,
not a deny-list, so an unsupported language is cleanly skipped rather than run
through a pipeline that can't parse it
    │ (if not skipped)
    ▼
Language dispatch: is this a .py file (isPythonFile)?
    │
    ├── YES → Python path (validatePythonEdit, see below) — TS code-index
    │         availability is NOT required (requiresCodeIndex is false for Python)
    │
    └── NO  → TS code index must be available (fail-open if not), then:
              Extract functions from edit diff
              ├── Modified functions (old_string → new_string)
              ├── Created functions (new, not in old)
              └── Called functions (referenced in new code)
              │
              ▼
              Local JSDoc validation (no AI, fast)
              ├── Check all required tags present
              └── Collect issues list
              │
              ▼
              Cache check: Have we validated this exact edit before?
              │ (if cache miss)
              ▼
              Build pattern context from code index (~200 SQLite queries, <100ms)
              ├── Directory README content
              ├── Sibling functions in same directory
              ├── Called function details (from index)
              ├── Callers of modified functions (blast radius)
              ├── FTS similarity search for DRY enforcement
              ├── Inline comment similarity (sub-function DRY)
              └── Relevant documentation sections
              │
              ▼
              Session check: Do we have a previous session for this file?
              │
              ├── First attempt: Execute headless Claude with full system prompt + context
              │
              └── Resume: Execute headless Claude with --resume, sending only updated code
              │
              ▼
              Parse AI response: { decision: "allow" | "deny", violations: [...] }
              │
              ├── Allow → cache result
              └── Deny → return violations as feedback
    │
    ▼
Emit decision as PreToolUse hookSpecificOutput JSON on stdout, process.exitCode = 0
(never exit(2)/stderr, never process.exit() — see CLAUDE.md's "Hook Output
Protocol & Exit Discipline")
    │
    ▼
Record the decision to metrics.db (durable cross-project store; fail-safe, never breaks the hook)
```

### 2b. Python Edit Path (`validatePythonEdit`, `py-validate.ts`)

Reached from the language dispatch above. Independent of ts-morph/JSDoc; mirrors
the shape of the TS flow but with Python-specific extraction and convention:

```
guardian_py extract (via py-adapter.ts, guardian pyenv subprocess)
    ├── syntax error / tooling unavailable / extractor error → allow (fail-open)
    ▼
Mark novelty (new vs. modified) by diffing unit names against the pre-edit file
    ▼
Pragmatic doc-completeness check (py-doc-check.ts) — module/class docstring +
Domain: line required; public function docstring required; Args/Returns/Raises
depth left to pydoclint + the LLM (skipped entirely for test files)
    ▼
Deterministic tool findings: ruff + pydoclint (py-tools.ts, fail-open, timeout-bounded)
    ▼
Cache check (shared cache, same as TS) → session/circuit-breaker/identical-
resubmission resolution (validation-flow.ts, shared with the TS path)
    ▼
First attempt only: pull pre-injected pattern context from the code index —
buildPatternContext(filePath, modified, created, [], comments, 'py') — the 'py'
language scope keeps TS functions from surfacing as "similar" to a Python edit;
defensive (falls back to an empty context on any error)
    ▼
Execute headless Claude with the neutral PY_SYSTEM_PROMPT, bounded to the
read-only code-index MCP tools via --permission-mode dontAsk + --disallowedTools
(no filesystem tools) — biased warn-not-deny on runtime/API concerns
    ▼
Parse AI response → allow/deny, same outcome recording as the TS path
(validation-flow.ts's recordValidationOutcome)
```

### 3. MCP Tool Query (Online, on-demand)

```
Claude invokes MCP tool (e.g., search, callers, impact)
    │
    ▼
Auto-sync: Check .dirty-files for recently modified files
    ├── If dirty files exist, incrementally rebuild those files
    └── Invalidate embedding cache
    │
    ▼
Execute query against code-quality.db
    ├── search: Hybrid FTS5 (40%) + semantic (60%)
    ├── callers/callees: Walk call_edges table
    ├── impact: BFS traversal up caller graph
    ├── search_comments: FTS5 on function_comments
    └── search_doc_sections: FTS5 on doc_sections
    │
    ▼
Format results and return to Claude
```

## Design Decisions

### Why SQLite?

- **Single-file database**: No server process, no connection management
- **FTS5**: Built-in full-text search with BM25 ranking
- **WAL mode**: Concurrent reads from hook while MCP server writes
- **better-sqlite3**: Synchronous API, ideal for hook performance (async overhead matters at per-edit scale)

### Why Local Embeddings (HuggingFace)?

- **No API calls**: Rebuild runs fully offline, no rate limits, no costs
- **Deterministic**: Same model always produces same embeddings
- **Small model**: `all-MiniLM-L6-v2` produces 384-dim vectors, fast on CPU (~7s for 425 functions)
- **Brute-force search**: At 781 functions, exact dot-product scan is faster than building an approximate index

### Why Two Search Backends (Hybrid)?

- **FTS5 (keyword)**: Exact term matching, handles function names and specific terminology
- **Semantic (vector)**: Conceptual similarity, handles paraphrasing and cross-domain matches
- **40/60 weighting**: Keywords get 40% to ensure exact matches surface, but semantic gets 60% because DRY detection needs conceptual matching more than exact keyword overlap

### Why Hook + MCP Dual Architecture?

The hook validation system queries the database **directly** (via `code-index-client.ts`) rather than going through the MCP server. This is intentional:

- **Independence**: Hook works even if the MCP server is down
- **Performance**: Direct SQLite queries avoid MCP JSON-RPC overhead
- **Different consumers**: Hook needs very specific pattern context; MCP tools serve general-purpose queries

### Why Session Resume?

When the headless Claude denies an edit, the developer fixes the issue and retries. The `--resume` flag continues the same Claude session, so:

- The AI remembers its previous analysis and reasoning
- It only needs to evaluate the delta, not re-analyze all context
- Validation is faster on retries (~5s vs ~15s for first attempt)

### CJS/ESM Boundary

The hook scripts run via `tsx` (CommonJS) while the MCP server is ESM (`"type": "module"`). This means:

- Hook scripts can import **types** from the MCP server modules (type-only imports are erased at runtime)
- Hook scripts **cannot** import runtime functions from ESM modules
- Utility functions like `sanitizeFTSQuery()` must be duplicated across the boundary with comments explaining why

## File System Layout

Codebase Guardian ships as a **Claude Code plugin**, not a per-project install — the
`.claude/hooks/` + `.claude/mcp-servers/code-index/` layout below is historical
(pre-plugin-conversion) and no longer exists. There are two layouts that matter:
this repo's **source tree**, and the **built copy** the plugin actually runs from.

### This repo (source)

```
codebase-guardian/
├── .claude-plugin/
│   ├── plugin.json                   # Plugin manifest (name, version)
│   └── marketplace.json              # Marketplace entry for /plugin marketplace add
├── hooks/
│   └── hooks.json                    # PreToolUse hook registration (points at the built copy)
├── scripts/
│   ├── bootstrap.sh                  # SessionStart hook — triggers build.sh in the background
│   ├── build.sh                      # Syncs source into $CLAUDE_PLUGIN_DATA/app, npm install/build, provisions the Python pyenv venv
│   ├── run-hook.sh / run-mcp.sh      # Thin wrappers the plugin invokes (resolve node, exec the built dist/)
│   └── copy-assets.mjs               # Copies .cjs boundary files into dist/ after tsc
├── src/                              # TypeScript source — see CLAUDE.md's "Project Structure" for the full tree
│   ├── mcp-server/                   # MCP server (index.ts, db.ts, indexer.ts, call-graph.ts, py-index.ts, py-call-graph.ts, embeddings.ts, build-index.ts)
│   └── hooks/                        # PreToolUse hook (pre-edit-validation.ts + helpers/, including the py-*.ts Python path)
├── python/guardian_py/               # Python extraction helper (ast-based), bundled alongside the compiled TS
├── requirements-python.txt           # Pinned Python toolchain versions (ruff, pydoclint, pyright, griffe, jedi)
├── skills/                           # Slash commands (installed to ~/.claude/skills/)
├── templates/                        # guardian.config.json template + CLAUDE.md snippet
├── tests/                            # Unit tests (tsx --test)
└── .mcp.json                         # MCP server registration
```

### Runtime (built copy — where the hook and MCP server actually execute)

```
${CLAUDE_PLUGIN_DATA}/                 # or ~/.codebase-guardian/ at the dev/fallback root
├── app/                               # Synced + built by scripts/build.sh; NOT committed
│   ├── dist/                          # Compiled JS (hook + MCP server run from here)
│   ├── node_modules/
│   ├── python/                        # guardian_py, copied verbatim (interpreted, not compiled)
│   └── pyenv/                         # Managed Python venv: ruff, pydoclint, pyright, griffe, jedi
├── indexes/{project-hash}/
│   ├── code-quality.db                # SQLite database (per project)
│   ├── .validation-cache.json
│   └── .validation-sessions.json
├── logs/{project-hash}/
│   └── validation-debug.log
├── metrics.db                         # Durable cross-project decision metrics store (queried by the `metrics` tool / `npm run metrics`)
├── .build-stamp                       # Hash of package.json; rebuild trigger
└── projects.json                      # Hash → name/path manifest
```

See CLAUDE.md's "Deploying / Testing Changes" and "User-Level File Locations" for how the sync/build/rebuild cycle works.
