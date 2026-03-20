# Architecture

## System Components

The code index system has six core modules and two external integration points:

### Core Modules (MCP Server)

All live in `src/mcp-server/`:

| Module | File | Responsibility |
|--------|------|---------------|
| **Database** | `db.ts` | Schema definition, CRUD operations, FTS5 search, type definitions |
| **Indexer** | `indexer.ts` | JSDoc parsing, comment extraction, doc section parsing, file scanning |
| **Call Graph** | `call-graph.ts` | TypeScript AST analysis via ts-morph, export discovery, call edge extraction |
| **Embeddings** | `embeddings.ts` | HuggingFace `all-MiniLM-L6-v2` local inference, vector storage, cosine similarity |
| **MCP Server** | `index.ts` | MCP protocol implementation, tool handlers, hybrid search orchestration |
| **Build CLI** | `build-index.ts` | Command-line entry point for full/incremental rebuilds |

### Hook Integration (Validation System)

Lives in `src/hooks/`:

| Module | File | Responsibility |
|--------|------|---------------|
| **Hook Entry** | `pre-edit-validation-ai.ts` | Intercepts Edit/Write, orchestrates validation flow |
| **Code Index Client** | `helpers/code-index-client.ts` | Direct SQLite queries against `code-quality.db` for pattern context |
| **Headless Claude** | `helpers/claude-headless.ts` | Executes headless Claude CLI for AI-powered code review |
| **Validation Cache** | `helpers/validation-cache.ts` | 5-minute TTL cache to avoid re-validating identical edits |
| **Session Store** | `helpers/validation-sessions.ts` | Maps file paths to Claude session IDs for `--resume` |
| **Function Extractor** | `helpers/function-extractor.ts` | Extracts function/type declarations from edit diffs |
| **Code Analyzer** | `helpers/code-analyzer.ts` | Analyzes called functions, property accesses, type usage |
| **JSDoc Parser** | `helpers/jsdoc-parser.ts` | Local (non-AI) JSDoc completeness validation |
| **Types** | `helpers/types.ts` | Shared type definitions for hook system |

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
```

### 2. Edit Validation (Online, per-edit)

```
Claude Edit/Write ──► PreToolUse Hook fires
    │
    ▼
Skip check: Is this .md, .test.ts, .json, hooks/, etc.?
    │ (if not skipped)
    ▼
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
    ├── Allow → exit(0), cache result
    └── Deny → exit(2), return violations as feedback
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

```
codebase-guardian/
├── code-quality.db                    # SQLite database (generated, gitignored)
├── .claude/
│   ├── settings.json                # Hook configuration + env vars
│   ├── hooks/
│   │   ├── pre-edit-validation-ai.ts    # Hook entry point
│   │   ├── validation-debug.log         # Debug output (gitignored)
│   │   └── helpers/
│   │       ├── types.ts
│   │       ├── claude-headless.ts
│   │       ├── code-index-client.ts
│   │       ├── validation-cache.ts
│   │       ├── validation-sessions.ts
│   │       ├── function-extractor.ts
│   │       ├── code-analyzer.ts
│   │       └── jsdoc-parser.ts
│   └── mcp-servers/
│       └── code-index/
│           ├── package.json
│           ├── tsconfig.json
│           ├── src/                   # TypeScript source
│           │   ├── index.ts           # MCP server
│           │   ├── db.ts              # Database layer
│           │   ├── indexer.ts         # Indexing engine
│           │   ├── call-graph.ts      # Call graph builder
│           │   ├── embeddings.ts      # Vector embeddings
│           │   └── build-index.ts     # CLI build script
│           ├── dist/                  # Compiled JS (MCP server runs from here)
│           └── docs/                  # This documentation
└── .mcp.json                         # MCP server registration
```
