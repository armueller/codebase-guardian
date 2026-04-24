# Code Mode: Execute Tool + Semantic Search Upgrade

**Date:** 2026-04-23
**Branch:** TBD (not yet created)
**Status:** Design approved, pending implementation plan

## Summary

The codebase guardian's semantic index has valuable knowledge, but neither the primary Claude session nor the headless validator effectively taps into it. The primary session almost never reaches for the MCP tools proactively, and when it does, composing multi-step queries (search -> callers -> impact) across sequential tool calls is clunky. The headless validator receives a static context dump via `buildPatternContext` and cannot ask contextual follow-up questions. Additionally, `buildPatternContext` uses FTS-only search for DRY detection, missing the semantic/vector search infrastructure that already exists in `embeddings.ts`.

This design introduces a Code Mode `execute` tool (inspired by [Cloudflare's Code Mode](https://blog.cloudflare.com/code-mode/)), upgrades `buildPatternContext` to use semantic search, gives the headless validator query capability, and makes denial messages educational.

## Motivation

Two articles sparked this work:

- **Cloudflare Code Mode** — LLMs write more reliable code than tool-call tokens. Converting MCP tools into typed APIs that agents write code against produces better, more composable results.
- **Context Mode** — Compressing tool outputs and routing through sandboxed execution extends session lifetime. The knowledge base concept (SQLite FTS5, fetch-and-index) aligns with what codebase guardian already does.

The core insight: the index has the data, but the ergonomics prevent both Claude instances from using it effectively.

## Architecture

Five components, ordered by dependency:

```
1. Typed Index API (foundation)
       |
   +---+---+
   |       |
   v       v
2. Execute    3. buildPatternContext
   MCP Tool      Semantic Upgrade
       |
       v
4. Headless Validator    5. Denial Message
   Query Capability         Enhancement
```

### 1. Typed Index API

**File:** `src/shared/index-api.ts`

A clean, unified API interface wrapping all query capabilities. Used by the execute tool, the headless validator, and `buildPatternContext`. Single source of truth for querying the index.

**Interface:**

```typescript
interface IndexAPI {
  // Search
  search(query: string, filters?: SearchFilters): FunctionResult[]
  semanticSearch(query: string, limit?: number): Promise<SemanticResult[]>

  // Call graph
  callers(functionName: string): FunctionResult[]
  callees(functionName: string): FunctionResult[]
  impact(functionIds: number[], depth?: number): ImpactResult

  // Lookup
  lookup(name: string, filePath?: string): FunctionResult | null
  lookupByFile(filePath: string): FunctionResult[]
  functionsByDirectory(dirPath: string): FunctionResult[]

  // Content search
  searchComments(query: string, limit?: number): CommentSearchResult[]
  searchDocs(query: string, limit?: number): DocSectionResult[]

  // Taxonomy
  listDomains(): DomainCount[]
  listTags(domain?: string): TagCount[]

  // Metadata
  indexStatus(): IndexMetadata
}
```

**Design decisions:**
- Synchronous where possible (FTS, SQLite queries), async only for `semanticSearch` (embedding model)
- Returns plain objects (JSON-serializable), not database rows
- No side effects — read-only queries only
- The same API powers the execute tool, headless validator, AND `buildPatternContext`
- Uses `createRequire` for `better-sqlite3` (same pattern as `code-index-client.ts`) and dynamic `import()` for `@huggingface/transformers` to work across the CJS/ESM boundary

### 2. Execute MCP Tool

**File:** Changes to `src/mcp-server/index.ts`

A new `execute` tool added alongside the existing 11 MCP tools. Claude writes TypeScript against the Index API in a sandboxed VM context. One tool call, one round-trip, arbitrarily complex queries.

**How it works:**

1. Claude sends a TypeScript snippet to the `execute` tool
2. The MCP server creates a `vm.createContext` sandbox with the Index API bound as `api`
3. The snippet executes — no filesystem, no network, no `require`/`import`
4. The script's return value is JSON-serialized and sent back

**Tool definition:**

```typescript
{
  name: 'execute',
  description: 'Execute TypeScript code against the codebase index API. Write code using the `api` object to compose complex queries in a single call. Available methods: api.search(query, filters?), api.semanticSearch(query, limit?), api.callers(name), api.callees(name), api.impact(ids, depth?), api.lookup(name, filePath?), api.lookupByFile(filePath), api.functionsByDirectory(dirPath), api.searchComments(query, limit?), api.searchDocs(query, limit?), api.listDomains(), api.listTags(domain?), api.indexStatus(). All methods are synchronous except semanticSearch() which is async (use await). Return your result — it will be JSON-serialized.',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'TypeScript code to execute. Use the `api` object. Return your result.'
      }
    },
    required: ['code']
  }
}
```

**Example usage:**

```typescript
// "What would break if I change calculateProfit's signature?"
const fn = api.lookup("calculateProfit");
const callers = api.callers("calculateProfit");
const callees = api.callees("calculateProfit");
return {
  function: { name: fn.name, file: fn.file_path, params: fn.description },
  calledBy: callers.map(c => ({ name: c.name, file: c.file_path })),
  calls: callees.map(c => ({ name: c.name, file: c.file_path })),
  blastRadius: callers.length
};
```

**Sandbox constraints:**
- `vm.createContext` with only `api` and `JSON` exposed — no `process`, `require`, `fs`, `console`
- Execution timeout: 5 seconds
- Read-only DB connection (already the case)
- Script errors return the error message as the tool result (not swallowed)

**Async handling:** `semanticSearch` is the only async method. The VM execution wraps the script in an async IIFE so `await api.semanticSearch(...)` works naturally. The sandbox resolves the promise before returning.

**Existing tools:** All 11 existing MCP tools remain unchanged. `execute` is purely additive.

### 3. buildPatternContext Semantic Search Upgrade

**File:** Changes to `src/hooks/helpers/code-index-client.ts`

Replace the FTS-only similar function search with semantic search from the embeddings pipeline.

**Current state** (line 749 of `code-index-client.ts`):

```typescript
// Converts "calculateAverageProfitLoss" -> "calculate average profit loss"
const searchTerms = funcName.replace(/([a-z])([A-Z])/g, '$1 $2')...
const similar = searchFTS(searchTerms, 5);
```

This only finds functions with overlapping keywords. `computeNetGainLoss` won't match `calculateAverageProfitLoss` even though they're semantically close.

**Change:** Use the Index API's `semanticSearch` method instead of `searchFTS` for the similar-function DRY detection pass.

**Async implications:** `buildPatternContext` becomes `async` (returns `Promise<PatternContext>`). It already runs inside `async main()` in the hook, so this is a straightforward change. The call sites just add `await`.

**Latency:** First-time embedding model load adds ~2-3s. Subsequent query embeddings are ~50ms. The model stays warm for the hook's process lifetime.

**Fallback:** If the embedding model fails to load, fall back to FTS. Fail-open design preserved.

**Scope:** Only the similar-function search changes. All other context gathering (README, siblings, callers, directory patterns, comment search) remains unchanged.

### 4. Headless Validator Query Capability

**File:** Changes to `src/hooks/helpers/claude-headless.ts`

Attach the codebase-guardian MCP server to the headless Claude invocation so the validator can query the index during validation.

**Change to `execFileSync` call:**

```typescript
const result = execFileSync('claude', [
  '-p', prompt,
  '--system-prompt', SYSTEM_PROMPT,
  '--output-format', 'json',
  '--permission-mode', 'bypassPermissions',
  '--model', 'opus',
  '--mcp-config', mcpConfigPath  // NEW
], { ... });
```

The MCP config points to the codebase-guardian server, which includes the `execute` tool. The headless validator gets full query composability.

**System prompt addition:**

```
## Index Query Tools

You have access to the codebase index via MCP tools. Use the `execute` tool
to write TypeScript queries when the pre-loaded context is insufficient.

Examples of when to query:
- You see an unfamiliar invocation pattern and want to check sibling files
- You suspect a DRY violation but the pre-loaded similar functions aren't close enough
- You want to check callers of a function not in the pre-loaded blast radius
- You want to search documentation for a specific pattern or convention

Don't query for information already in the pre-loaded context. Query when you
need to go deeper.
```

**Why MCP:** The headless validator is a separate Claude process — it can't call TypeScript in-process. MCP is the natural interface, and the `execute` tool gives it full composability. The MCP server boots once per headless session; resumed sessions reuse it.

**Latency:** MCP server startup adds ~1-2s to the first headless invocation. The validator already takes ~10-15s, so this is a modest cost for dramatically better context.

**Fail-open:** If the MCP server fails to start, the headless validator works exactly as today — pre-loaded context only, no follow-up queries.

### 5. Denial Message Enhancement

**File:** Changes to `src/hooks/pre-edit-validation.ts`

Make validation denial messages educational by including the specific query that would have prevented the denial.

**Current denial format:**
> "Function 'calculateFees' duplicates existing 'computeFees' in utils/fees.ts:23"

**Enhanced denial format:**
> "Function 'calculateFees' duplicates existing 'computeFees' in utils/fees.ts:23. **Next time, run:** `api.semanticSearch('calculate fees')` before creating new functions in this domain."

**Implementation:** When constructing the denial response, map violation types to suggested queries:

- **DRY violation** -> suggest `api.semanticSearch('...')` with the function's name converted to search terms
- **Pattern mismatch** -> suggest `api.functionsByDirectory('...')` to check sibling conventions
- **Blast radius concern** -> suggest `api.callers('...')` to check impact before modifying
- **Missing documentation context** -> suggest `api.searchDocs('...')` to find relevant pattern guides

This trains the primary Claude in-context — every denial teaches it how to use the index proactively. The learning happens at exactly the moment Claude is paying attention (it just got blocked).

**CLAUDE.md complement:** The installed CLAUDE.md snippet still includes a brief "use the index before editing" instruction as an initial nudge for early-session behavior, before any denials have occurred.

## Invariants Preserved

- **Fail-open:** Every new code path (semantic search, MCP attachment, VM sandbox) has a fallback. No new path can permanently block work.
- **Existing tools untouched:** All 11 MCP tools continue to work exactly as before.
- **CJS/ESM boundary:** The Index API module lives in `src/shared/` and must be consumable from both the MCP server (ESM) and the hook (CJS via tsx). It uses `createRequire` for `better-sqlite3` (same pattern as `code-index-client.ts`) and dynamic `import()` for `@huggingface/transformers`. The hook's `code-index-client.ts` becomes a thin wrapper that delegates to the Index API, replacing its duplicated query logic.
- **Read-only hook access:** The hook and execute tool only read from the database. No writes.
- **Session resume:** Headless session resume continues to work. The MCP server attachment is part of the session.

## Open Questions

None — all design decisions have been resolved through discussion.
