# Codebase Guardian

Semantic code index + automated validation hooks for TypeScript codebases. Installs as a user-level Claude Code hook and MCP server — active on every project.

## Local Development

Install dependencies locally first:

```bash
npm install --ignore-scripts && npm rebuild better-sqlite3
```

`--ignore-scripts` is required because `sharp` (transitive dep from `@huggingface/transformers`) fails to build natively. `better-sqlite3` needs its native addon rebuilt separately. Both `install.sh` and `update.sh` use this same approach — if you change one, change both.

## Running Tests

```bash
npm test                    # All tests (via tsx)
npm run test:mcp            # Database + indexer tests only
npm run test:hooks          # Hook helper tests only
```

Tests use Node's built-in `--test` runner via `tsx`. No jest, no mocha. Always run tests from the repo, not from the installed directory.

## Deploying Changes

After code changes are tested, deploy to the installed location:

```bash
./update.sh
```

This syncs source to `~/.codebase-guardian/source/`, installs deps, builds TypeScript, and updates skills. The hook and MCP server run from the installed copy, not this repo directly. **Code changes are not live until update.sh runs.**

Do NOT try to manually rsync files, find tsc, or compile individually. `update.sh` handles everything.

Note: CLAUDE.md changes do NOT require `update.sh` — Claude Code reads CLAUDE.md from the repo directly.

## Project Structure

```
src/
├── mcp-server/             # MCP server (ESM, runs via node)
│   ├── index.ts            # Tool handlers + server setup
│   ├── db.ts               # SQLite schema + CRUD (better-sqlite3)
│   ├── indexer.ts           # Phase 1: JSDoc & doc parsing
│   ├── call-graph.ts        # Phase 2: Call graph + export discovery (ts-morph)
│   ├── embeddings.ts        # HuggingFace vector embeddings (local, no API)
│   └── build-index.ts       # CLI entry point for index rebuilds
├── hooks/                   # PreToolUse hook (CJS via tsx, reads stdin)
│   ├── pre-edit-validation.ts  # Hook orchestrator
│   └── helpers/
│       ├── types.ts            # Shared type definitions
│       ├── function-extractor.ts # Extract functions + JSDoc from edit diff
│       ├── code-analyzer.ts     # Analyze called functions, types, properties
│       ├── jsdoc-parser.ts      # Parse and validate JSDoc tags (local, no AI)
│       ├── claude-headless.ts   # Execute headless Claude for AI validation
│       ├── code-index-client.ts # Direct SQLite queries (readonly)
│       ├── validation-cache.ts  # 5-minute TTL result cache
│       └── validation-sessions.ts # Session store for --resume support
├── config.ts               # Config resolution (git root, paths, auto-detection)
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

### Function Extractor (`function-extractor.ts`)

Uses ts-morph AST parsing to find function declarations and their JSDoc. This handles all declaration patterns: `function foo()`, `const foo = () =>`, `const foo = function foo()`, `React.memo(function foo())`, class methods, object property methods, etc.

The JSDoc lookup (`findJSDocBefore`) still uses a regex to find the nearest `/** */` block before the declaration node and a heuristic to check what text appears between them. If new declaration patterns cause JSDoc detection failures, this heuristic is the first place to look.

### Three Index Tiers

- **Tier 1 (JSDoc)**: Functions with `@domain` tag in JSDoc. Full metadata.
- **Tier 2 (Exports)**: Exported functions discovered by ts-morph, lacking JSDoc. Minimal metadata.
- **Tier 3 (Docs)**: Markdown files parsed into heading-level sections.

Tier detection: presence of `@domain` in JSDoc block → Tier 1. Otherwise if exported → Tier 2.

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

## User-Level File Locations

```
~/.codebase-guardian/
├── source/                          # Installed source (synced by update.sh)
├── indexes/{project-hash}/          # Per-project SQLite databases
│   ├── code-quality.db
│   ├── .validation-cache.json       # Result cache
│   └── .validation-sessions.json    # Session store
├── logs/{project-hash}/
│   └── validation-debug.log         # Every hook invocation with timing
└── projects.json                    # Hash → name/path manifest

~/.claude/settings.json              # Hook registration
~/.claude/skills/                    # Installed skills
```

## Debugging Validation Logs

Per-project validation logs are at `~/.codebase-guardian/logs/{project-hash}/validation-debug.log`. To find which hash corresponds to which project:

```bash
cat ~/.codebase-guardian/projects.json
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
cat ~/.codebase-guardian/projects.json

# Clear cache and sessions for a specific project
rm ~/.codebase-guardian/indexes/{project-hash}/.validation-cache.json ~/.codebase-guardian/indexes/{project-hash}/.validation-sessions.json
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
