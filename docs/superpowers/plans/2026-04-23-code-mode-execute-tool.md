# Code Mode: Execute Tool + Semantic Search Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Code Mode `execute` MCP tool, upgrade `buildPatternContext` to use semantic search, give the headless validator query capability, and make denial messages educational.

**Architecture:** A new shared Index API (`src/shared/index-api.ts`) wraps all query capabilities from `db.ts` and `embeddings.ts` into a single typed interface. The MCP server exposes a new `execute` tool that runs user-written TypeScript against this API in a `vm` sandbox. The hook's `buildPatternContext` switches from FTS-only to semantic search for DRY detection. The headless Claude validator gets MCP server access via `--mcp-config` so it can query the index during validation. Denial messages are enhanced with suggested `api.*` queries.

**Tech Stack:** Node.js `vm` module for sandboxing, `better-sqlite3` (synchronous SQLite), `@huggingface/transformers` (local embedding model), `ts-morph`, existing MCP SDK.

**Spec:** `docs/superpowers/specs/2026-04-23-code-mode-execute-tool-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/shared/index-api.ts` | Create | Typed Index API — wraps db.ts + embeddings.ts into a unified query interface |
| `src/mcp-server/index.ts` | Modify | Add `execute` tool definition + handler, refactor existing handlers to use Index API |
| `src/hooks/helpers/code-index-client.ts` | Modify | Replace `searchFTS` with semantic search in `buildPatternContext`, delegate to Index API |
| `src/hooks/helpers/claude-headless.ts` | Modify | Add `--mcp-config` to headless invocations, update system prompt |
| `src/hooks/pre-edit-validation.ts` | Modify | Enhance denial messages with suggested queries |
| `templates/claude-md-snippet.md` | Modify | Add "research before editing" guidance |
| `tests/index-api.test.ts` | Create | Unit tests for Index API |
| `tests/execute-tool.test.ts` | Create | Unit tests for VM sandbox execution |
| `tests/denial-messages.test.ts` | Create | Unit tests for denial message enhancement |

---

## Task 1: Typed Index API — Synchronous Methods

The foundation layer. Wraps the synchronous query functions from `db.ts` into a clean API object. Semantic search (async) is added in Task 2.

**Files:**
- Create: `src/shared/index-api.ts`
- Create: `tests/index-api.test.ts`
- Reference: `src/mcp-server/db.ts` (functions being wrapped)

- [ ] **Step 1: Write the failing tests for synchronous Index API methods**

```typescript
// tests/index-api.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createIndexAPI } from '../src/shared/index-api.js';
import { openDatabase, clearAllData, insertFunction, insertDomains, insertTags, insertSystemLayers, insertCallEdge, insertComments, insertDocSections } from '../src/mcp-server/db.js';

describe('IndexAPI — synchronous methods', () => {
  let api: ReturnType<typeof createIndexAPI>;
  let db: ReturnType<typeof openDatabase>;

  before(() => {
    db = openDatabase(':memory:');

    // Seed test data
    const id1 = insertFunction(db, {
      name: 'calculateProfit',
      description: 'Calculates net profit after fees',
      file_path: 'src/utils/finance.ts',
      line_number: 10,
      is_exported: 1,
      declaration_type: 'function',
      side_effects: 'None',
      system_layer: 'Business Logic',
      tier: 1,
    });
    insertDomains(db, id1, ['finance', 'calculations']);
    insertTags(db, id1, ['profit', 'fees', 'calculation']);
    insertSystemLayers(db, id1, ['Business Logic']);

    const id2 = insertFunction(db, {
      name: 'formatCurrency',
      description: 'Formats a number as USD currency string',
      file_path: 'src/utils/finance.ts',
      line_number: 30,
      is_exported: 1,
      declaration_type: 'function',
      side_effects: 'None',
      system_layer: 'UI Helper',
      tier: 1,
    });
    insertDomains(db, id2, ['finance', 'formatting']);
    insertTags(db, id2, ['currency', 'formatting', 'usd']);
    insertSystemLayers(db, id2, ['UI Helper']);

    const id3 = insertFunction(db, {
      name: 'fetchPrices',
      description: 'Fetches current market prices from API',
      file_path: 'src/api/market.ts',
      line_number: 5,
      is_exported: 1,
      declaration_type: 'function',
      side_effects: 'API call to market data provider',
      system_layer: 'API',
      tier: 1,
    });
    insertDomains(db, id3, ['finance', 'market-data']);
    insertTags(db, id3, ['api', 'prices', 'market']);
    insertSystemLayers(db, id3, ['API']);

    // Call edge: calculateProfit calls fetchPrices
    insertCallEdge(db, id1, id3, 'call');

    // Comments
    insertComments(db, id1, [
      { comment_text: 'Subtract broker commission from gross profit', comment_type: 'line', line_offset: 3 },
    ]);

    // Doc section
    const docId = insertFunction(db, {
      name: 'Financial Patterns README',
      description: 'Documents financial calculation patterns and fee structures',
      file_path: 'docs/financial-patterns.md',
      line_number: 1,
      is_exported: 0,
      declaration_type: 'doc',
      side_effects: null,
      system_layer: null,
      tier: 3,
    });
    insertDocSections(db, docId, [
      { heading: 'Fee Calculation', heading_level: 2, body: 'All fee calculations must use the standard fee schedule.', section_type: 'prose', section_order: 1 },
    ]);

    api = createIndexAPI(db);
  });

  it('lookup finds a function by name', () => {
    const result = api.lookup('calculateProfit');
    assert.ok(result, 'Should find calculateProfit');
    assert.equal(result!.name, 'calculateProfit');
    assert.equal(result!.file_path, 'src/utils/finance.ts');
    assert.deepEqual(result!.domains, ['finance', 'calculations']);
  });

  it('lookup returns null for unknown function', () => {
    const result = api.lookup('nonexistent');
    assert.equal(result, null);
  });

  it('lookup filters by file path', () => {
    const result = api.lookup('calculateProfit', 'src/utils/finance.ts');
    assert.ok(result);
    const noResult = api.lookup('calculateProfit', 'src/other/file.ts');
    assert.equal(noResult, null);
  });

  it('lookupByFile returns all functions in a file', () => {
    const results = api.lookupByFile('src/utils/finance.ts');
    assert.equal(results.length, 2);
    const names = results.map(r => r.name);
    assert.ok(names.includes('calculateProfit'));
    assert.ok(names.includes('formatCurrency'));
  });

  it('functionsByDirectory returns functions in a directory', () => {
    const results = api.functionsByDirectory('src/utils');
    assert.equal(results.length, 2);
  });

  it('callers returns functions that call the target', () => {
    const results = api.callers('fetchPrices');
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'calculateProfit');
  });

  it('callees returns functions called by the target', () => {
    const results = api.callees('calculateProfit');
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'fetchPrices');
  });

  it('search finds functions via FTS', () => {
    const results = api.search('profit calculation');
    assert.ok(results.length > 0, 'Should find at least one result');
    const names = results.map(r => r.name);
    assert.ok(names.includes('calculateProfit'));
  });

  it('search filters by domain', () => {
    const results = api.search('profit', { domain: 'formatting' });
    const names = results.map(r => r.name);
    assert.ok(!names.includes('calculateProfit'), 'calculateProfit is not in formatting domain');
  });

  it('searchComments finds matching inline comments', () => {
    const results = api.searchComments('broker commission');
    assert.ok(results.length > 0);
    assert.ok(results[0].comment.comment_text.includes('broker commission'));
  });

  it('searchDocs finds matching documentation sections', () => {
    const results = api.searchDocs('fee calculation');
    assert.ok(results.length > 0);
    assert.equal(results[0].section.heading, 'Fee Calculation');
  });

  it('listDomains returns all domains with counts', () => {
    const results = api.listDomains();
    assert.ok(results.length > 0);
    const finance = results.find(d => d.domain === 'finance');
    assert.ok(finance, 'Should have finance domain');
    assert.equal(finance!.count, 3);
  });

  it('listTags returns tags, optionally filtered by domain', () => {
    const all = api.listTags();
    assert.ok(all.length > 0);
    const filtered = api.listTags('formatting');
    assert.ok(filtered.length > 0);
    const tagNames = filtered.map(t => t.tag);
    assert.ok(tagNames.includes('currency') || tagNames.includes('formatting'));
  });

  it('impact returns transitive callers with depth', () => {
    const results = api.impact('fetchPrices');
    assert.ok(results.length > 0);
    assert.equal(results[0].function.name, 'calculateProfit');
    assert.equal(results[0].depth, 1);
  });

  it('indexStatus returns metadata', () => {
    const status = api.indexStatus();
    assert.ok(status.functions_indexed >= 3);
    assert.ok(status.domains_count >= 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/index-api.test.ts`
Expected: FAIL — `createIndexAPI` does not exist yet.

- [ ] **Step 3: Implement the Index API module**

```typescript
// src/shared/index-api.ts

import type Database from 'better-sqlite3';
import {
  getFunctionByName,
  getFunctionById,
  getFunctionsByIds,
  searchByFTS,
  searchFunctions,
  searchCommentsByFTS,
  searchDocSectionsByFTS,
  listDomains,
  listTags,
  listSystemLayers,
  getCallers,
  getCallees,
  getImpact,
  getIndexMetadata,
  hydrateFunctions,
  type FunctionResult,
  type FunctionRecord,
  type SearchFilters,
  type DomainCount,
  type TagCount,
  type SystemLayerCount,
  type CommentRecord,
  type DocSectionRecord,
  type IndexMetadata,
} from '../mcp-server/db.js';

// ─── Result Types ───────────────────────────────────────────────────────────

export interface CommentSearchResult {
  comment: CommentRecord;
  function: FunctionResult;
}

export interface DocSearchResult {
  section: DocSectionRecord;
  function: FunctionResult;
}

export interface ImpactResult {
  function: FunctionResult;
  depth: number;
}

export interface SemanticResult {
  functionId: number;
  similarity: number;
}

// ─── API Interface ──────────────────────────────────────────────────────────

export interface IndexAPI {
  // Search
  search(query: string, filters?: SearchFilters): FunctionResult[];
  semanticSearch(query: string, limit?: number): Promise<FunctionResult[]>;

  // Call graph
  callers(functionName: string): FunctionResult[];
  callees(functionName: string): FunctionResult[];
  impact(functionName: string, depth?: number): ImpactResult[];

  // Lookup
  lookup(name: string, filePath?: string): FunctionResult | null;
  lookupByFile(filePath: string): FunctionResult[];
  functionsByDirectory(dirPath: string): FunctionResult[];

  // Content search
  searchComments(query: string, limit?: number): CommentSearchResult[];
  searchDocs(query: string, limit?: number): DocSearchResult[];

  // Taxonomy
  listDomains(): DomainCount[];
  listTags(domain?: string): TagCount[];
  listSystemLayers(): SystemLayerCount[];

  // Metadata
  indexStatus(): IndexMetadata;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createIndexAPI(db: Database.Database): IndexAPI {
  return {
    search(query: string, filters?: SearchFilters): FunctionResult[] {
      if (filters && Object.keys(filters).length > 0) {
        return searchFunctions(db, { ...filters, query } as any);
      }
      const ftsResults = searchByFTS(db, query, filters?.limit ?? 15);
      const ids = ftsResults.map(r => r.id);
      if (ids.length === 0) return [];
      const funcMap = getFunctionsByIds(db, ids);
      return ids.map(id => funcMap.get(id)).filter((f): f is FunctionResult => f !== undefined);
    },

    async semanticSearch(_query: string, _limit?: number): Promise<FunctionResult[]> {
      // Implemented in Task 2 — requires async embedding model
      return [];
    },

    callers(functionName: string): FunctionResult[] {
      return getCallers(db, functionName);
    },

    callees(functionName: string): FunctionResult[] {
      return getCallees(db, functionName);
    },

    impact(functionName: string, depth?: number): ImpactResult[] {
      const results = getImpact(db, functionName, undefined, depth);
      return results.map(r => ({ function: r.function, depth: r.depth }));
    },

    lookup(name: string, filePath?: string): FunctionResult | null {
      return getFunctionByName(db, name, filePath);
    },

    lookupByFile(filePath: string): FunctionResult[] {
      const rows = db.prepare('SELECT * FROM functions WHERE file_path = ? ORDER BY line_number')
        .all(filePath) as FunctionRecord[];
      return hydrateFunctions(db, rows);
    },

    functionsByDirectory(dirPath: string): FunctionResult[] {
      const rows = db.prepare('SELECT * FROM functions WHERE file_path LIKE ? AND tier != 3 ORDER BY name')
        .all(`${dirPath}/%`) as FunctionRecord[];
      return hydrateFunctions(db, rows);
    },

    searchComments(query: string, limit?: number): CommentSearchResult[] {
      return searchCommentsByFTS(db, query, limit);
    },

    searchDocs(query: string, limit?: number): DocSearchResult[] {
      const results = searchDocSectionsByFTS(db, query, limit);
      return results.map(r => ({ section: r.section, function: r.function }));
    },

    listDomains(): DomainCount[] {
      return listDomains(db);
    },

    listTags(domain?: string): TagCount[] {
      return listTags(db, domain);
    },

    listSystemLayers(): SystemLayerCount[] {
      return listSystemLayers(db);
    },

    indexStatus(): IndexMetadata {
      return getIndexMetadata(db);
    },
  };
}
```

Note: The `search` method here uses FTS-only for now. The MCP server's `search` tool handler already has its own hybrid search (FTS + semantic, lines 187-292 of `index.ts`). The `search` method on the API is for the `execute` tool — it provides FTS results. Claude can call `api.semanticSearch()` separately when needed. This avoids duplicating the hybrid search logic.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/index-api.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/index-api.ts tests/index-api.test.ts
git commit -m "feat: add typed Index API wrapping db.ts query functions"
```

---

## Task 2: Index API — Semantic Search Method

Add the async `semanticSearch` method to the Index API. This wraps the existing `semanticSearch` from `embeddings.ts` and hydrates the results into `FunctionResult` objects.

**Files:**
- Modify: `src/shared/index-api.ts`
- Modify: `tests/index-api.test.ts`
- Reference: `src/mcp-server/embeddings.ts` (semantic search + embedding pipeline)

- [ ] **Step 1: Write the failing test for semanticSearch**

Add to `tests/index-api.test.ts`:

```typescript
import { generateEmbeddings } from '../src/mcp-server/embeddings.js';

describe('IndexAPI — semantic search', () => {
  let api: ReturnType<typeof createIndexAPI>;
  let db: ReturnType<typeof openDatabase>;

  before(async () => {
    db = openDatabase(':memory:');

    const id1 = insertFunction(db, {
      name: 'calculateProfit',
      description: 'Calculates net profit after fees and commissions',
      file_path: 'src/utils/finance.ts',
      line_number: 10,
      is_exported: 1,
      declaration_type: 'function',
      side_effects: 'None',
      system_layer: 'Business Logic',
      tier: 1,
    });
    insertDomains(db, id1, ['finance']);
    insertTags(db, id1, ['profit', 'fees']);

    const id2 = insertFunction(db, {
      name: 'renderButton',
      description: 'Renders a styled button component',
      file_path: 'src/components/Button.tsx',
      line_number: 5,
      is_exported: 1,
      declaration_type: 'function',
      side_effects: 'None',
      system_layer: 'UI Helper',
      tier: 1,
    });
    insertDomains(db, id2, ['ui']);
    insertTags(db, id2, ['button', 'component']);

    // Generate embeddings for both functions
    await generateEmbeddings(db, {
      functionId: id1,
      name: 'calculateProfit',
      description: 'Calculates net profit after fees and commissions',
      domains: ['finance'],
      systemlayers: ['Business Logic'],
      tags: ['profit', 'fees'],
      body: 'return grossProfit - fees - commissions;',
    });

    await generateEmbeddings(db, {
      functionId: id2,
      name: 'renderButton',
      description: 'Renders a styled button component',
      domains: ['ui'],
      systemlayers: ['UI Helper'],
      tags: ['button', 'component'],
      body: 'return <button className={styles.btn}>{children}</button>;',
    });

    api = createIndexAPI(db);
  });

  it('semanticSearch returns functions ranked by similarity', async () => {
    const results = await api.semanticSearch('compute financial gains and losses');
    assert.ok(results.length > 0, 'Should find at least one result');
    // calculateProfit should rank higher than renderButton for a finance query
    assert.equal(results[0].name, 'calculateProfit');
  });

  it('semanticSearch respects limit', async () => {
    const results = await api.semanticSearch('function', 1);
    assert.equal(results.length, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/index-api.test.ts`
Expected: FAIL — `semanticSearch` returns empty array (stub from Task 1).

Note: This test requires the HuggingFace embedding model to download on first run (~30MB). It may take 30-60 seconds the first time. If the model fails to load in CI, the test should be skipped (not the implementation — the implementation has a fallback).

- [ ] **Step 3: Implement semanticSearch on the Index API**

In `src/shared/index-api.ts`, replace the stub `semanticSearch` method:

```typescript
// At the top, add import:
import { semanticSearch as runSemanticSearch, invalidateCache } from '../mcp-server/embeddings.js';

// Replace the stub in createIndexAPI:
async semanticSearch(query: string, limit?: number): Promise<FunctionResult[]> {
  const effectiveLimit = limit ?? 10;
  const results = await runSemanticSearch(db, query, effectiveLimit);
  if (results.length === 0) return [];
  const ids = results.map(r => r.functionId);
  const funcMap = getFunctionsByIds(db, ids);
  // Preserve similarity ranking order
  return ids.map(id => funcMap.get(id)).filter((f): f is FunctionResult => f !== undefined);
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/index-api.test.ts`
Expected: All tests PASS (including the new semantic search tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/index-api.ts tests/index-api.test.ts
git commit -m "feat: add semantic search to Index API via embeddings pipeline"
```

---

## Task 3: Execute MCP Tool — VM Sandbox

Add the `execute` tool to the MCP server. Claude writes TypeScript that runs in a `vm.createContext` sandbox with the Index API bound as `api`.

**Files:**
- Modify: `src/mcp-server/index.ts:43-168` (tool definitions), `src/mcp-server/index.ts:355-601` (tool handlers)
- Create: `tests/execute-tool.test.ts`
- Reference: `src/shared/index-api.ts` (the API object bound into the sandbox)

- [ ] **Step 1: Write the failing tests for the execute tool**

```typescript
// tests/execute-tool.test.ts
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { executeInSandbox } from '../src/mcp-server/execute-sandbox.js';
import { createIndexAPI } from '../src/shared/index-api.js';
import { openDatabase, insertFunction, insertDomains, insertTags, insertCallEdge } from '../src/mcp-server/db.js';

describe('executeInSandbox', () => {
  let api: ReturnType<typeof createIndexAPI>;
  let db: ReturnType<typeof openDatabase>;

  before(() => {
    db = openDatabase(':memory:');

    const id1 = insertFunction(db, {
      name: 'calculateProfit',
      description: 'Calculates net profit',
      file_path: 'src/utils/finance.ts',
      line_number: 10,
      is_exported: 1,
      declaration_type: 'function',
      side_effects: 'None',
      system_layer: 'Business Logic',
      tier: 1,
    });
    insertDomains(db, id1, ['finance']);
    insertTags(db, id1, ['profit']);

    const id2 = insertFunction(db, {
      name: 'fetchPrices',
      description: 'Fetches market prices',
      file_path: 'src/api/market.ts',
      line_number: 5,
      is_exported: 1,
      declaration_type: 'function',
      side_effects: 'API call',
      system_layer: 'API',
      tier: 1,
    });
    insertDomains(db, id2, ['finance']);
    insertTags(db, id2, ['api', 'prices']);

    insertCallEdge(db, id1, id2, 'call');

    api = createIndexAPI(db);
  });

  it('executes simple return statement', async () => {
    const result = await executeInSandbox(api, 'return 42;');
    assert.equal(result, 42);
  });

  it('accesses api.lookup', async () => {
    const result = await executeInSandbox(api, `
      const fn = api.lookup("calculateProfit");
      return fn ? fn.name : null;
    `);
    assert.equal(result, 'calculateProfit');
  });

  it('composes multi-step queries', async () => {
    const result = await executeInSandbox(api, `
      const fn = api.lookup("calculateProfit");
      const callees = api.callees("calculateProfit");
      return {
        name: fn.name,
        calls: callees.map(c => c.name),
      };
    `);
    assert.deepEqual(result, {
      name: 'calculateProfit',
      calls: ['fetchPrices'],
    });
  });

  it('supports await for async methods', async () => {
    const result = await executeInSandbox(api, `
      const results = await api.semanticSearch("profit");
      return results.length;
    `);
    assert.equal(typeof result, 'number');
  });

  it('cannot access process, require, or fs', async () => {
    await assert.rejects(
      () => executeInSandbox(api, 'return typeof process;'),
      /process is not defined/
    );
  });

  it('cannot access require', async () => {
    await assert.rejects(
      () => executeInSandbox(api, 'return require("fs");'),
      /require is not defined/
    );
  });

  it('times out on infinite loops', async () => {
    await assert.rejects(
      () => executeInSandbox(api, 'while(true) {}', 100),
      /timed out|timeout/i
    );
  });

  it('returns script errors as thrown exceptions', async () => {
    await assert.rejects(
      () => executeInSandbox(api, 'throw new Error("test error");'),
      /test error/
    );
  });

  it('provides JSON in sandbox', async () => {
    const result = await executeInSandbox(api, `
      return JSON.parse('{"a": 1}');
    `);
    assert.deepEqual(result, { a: 1 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/execute-tool.test.ts`
Expected: FAIL — `executeInSandbox` module does not exist yet.

- [ ] **Step 3: Implement the VM sandbox module**

```typescript
// src/mcp-server/execute-sandbox.ts
import vm from 'node:vm';
import type { IndexAPI } from '../shared/index-api.js';

const DEFAULT_TIMEOUT_MS = 5000;

export async function executeInSandbox(
  api: IndexAPI,
  code: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<unknown> {
  // Create a restricted context with only the API and JSON
  const sandbox = {
    api,
    JSON,
  };

  const context = vm.createContext(sandbox);

  // Wrap in async IIFE so user code can use await (for semanticSearch)
  const wrappedCode = `(async () => { ${code} })()`;

  const script = new vm.Script(wrappedCode, {
    timeout: timeoutMs,
    filename: 'execute-sandbox.js',
  });

  const result = script.runInContext(context, {
    timeout: timeoutMs,
  });

  // If the result is a promise (from async IIFE), await it
  return await result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/execute-tool.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/execute-sandbox.ts tests/execute-tool.test.ts
git commit -m "feat: add VM sandbox for executing code against Index API"
```

---

## Task 4: Wire Execute Tool into MCP Server

Add the `execute` tool definition and handler to the MCP server's existing tool infrastructure.

**Files:**
- Modify: `src/mcp-server/index.ts:43-168` (add tool definition to TOOL_DEFINITIONS array)
- Modify: `src/mcp-server/index.ts:355-601` (add case to tool handler switch)

- [ ] **Step 1: Add the execute tool definition**

In `src/mcp-server/index.ts`, add to the end of the `TOOL_DEFINITIONS` array (before the closing `]` around line 168):

```typescript
  {
    name: 'execute',
    description: 'Execute TypeScript code against the codebase index API. Write code using the `api` object to compose complex queries in a single call. Available methods: api.search(query, filters?), api.semanticSearch(query, limit?) [async — use await], api.callers(name), api.callees(name), api.impact(name, depth?), api.lookup(name, filePath?), api.lookupByFile(filePath), api.functionsByDirectory(dirPath), api.searchComments(query, limit?), api.searchDocs(query, limit?), api.listDomains(), api.listTags(domain?), api.listSystemLayers(), api.indexStatus(). Return your result — it will be JSON-serialized.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'TypeScript code to execute. Use the `api` object. Return your result.' },
      },
      required: ['code'],
    },
  },
```

- [ ] **Step 2: Add the imports**

At the top of `src/mcp-server/index.ts`, add:

```typescript
import { createIndexAPI } from '../shared/index-api.js';
import { executeInSandbox } from './execute-sandbox.js';
```

- [ ] **Step 3: Create the Index API instance**

After the `DB_PATH` constant (around line 39), add:

```typescript
const db = openDatabase(DB_PATH);
const indexApi = createIndexAPI(db);
```

Note: The existing handlers already call `openDatabase(DB_PATH)` inline. This creates a shared instance. The existing `db` variable usage in handlers should still work since they use their own `openDatabase` call — we're adding a parallel instance for the execute tool. Refactoring existing handlers to use the shared instance is a separate future cleanup.

- [ ] **Step 4: Add the execute handler to the switch block**

In the `CallToolRequestSchema` handler (around line 355), add a new case before the default:

```typescript
      case 'execute': {
        const code = args.code;
        if (!code || typeof code !== 'string') {
          return { content: [{ type: 'text', text: 'Error: code parameter is required and must be a string' }] };
        }
        try {
          const result = await executeInSandbox(indexApi, code);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Execution error: ${error instanceof Error ? error.message : String(error)}`,
            }],
          };
        }
      }
```

- [ ] **Step 5: Run the full test suite to verify nothing broke**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/index.ts
git commit -m "feat: wire execute tool into MCP server with VM sandbox"
```

---

## Task 5: buildPatternContext Semantic Search Upgrade

Replace the FTS-only similar function search in `buildPatternContext` with semantic search. This is the highest-impact change for DRY detection quality.

**Files:**
- Modify: `src/hooks/helpers/code-index-client.ts:706-805` (`buildPatternContext` function)
- Modify: `src/hooks/pre-edit-validation.ts:382` (add `await` to `buildPatternContext` call)
- Reference: `src/shared/index-api.ts` (semantic search method)

- [ ] **Step 1: Make buildPatternContext async and add semantic search**

In `src/hooks/helpers/code-index-client.ts`, change the `buildPatternContext` function signature from:

```typescript
export function buildPatternContext(
```

to:

```typescript
export async function buildPatternContext(
```

Then replace the FTS-based similar function search block (lines 748-765) from:

```typescript
  for (const funcName of functionsToSearch) {
    // Convert camelCase/PascalCase to space-separated words for better FTS matching
    // e.g., "calculateAverageProfitLoss" -> "calculate Average Profit Loss"
    const searchTerms = funcName
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
      .toLowerCase();

    const similar = searchFTS(searchTerms, 5);

    // Filter out the function itself (don't flag a function as similar to itself)
    const filtered = similar.filter(f => f.name !== funcName);

    if (filtered.length > 0) {
      similarExistingFunctions.set(funcName, filtered);
    }
  }
```

to:

```typescript
  for (const funcName of functionsToSearch) {
    // Convert camelCase/PascalCase to space-separated words for search
    const searchTerms = funcName
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
      .toLowerCase();

    // Try semantic search first for better conceptual matching,
    // fall back to FTS if embeddings are unavailable
    let similar: FunctionResult[] = [];
    try {
      similar = await semanticSearchFromHook(db, searchTerms, 5);
    } catch {
      // Embedding model unavailable — fall back to FTS
    }
    if (similar.length === 0) {
      similar = searchFTS(searchTerms, 5);
    }

    // Filter out the function itself (don't flag a function as similar to itself)
    const filtered = similar.filter(f => f.name !== funcName);

    if (filtered.length > 0) {
      similarExistingFunctions.set(funcName, filtered);
    }
  }
```

- [ ] **Step 2: Add the semantic search helper function**

Add this function to `code-index-client.ts` (above `buildPatternContext`):

```typescript
/**
 * Runs semantic search from the hook context.
 * Wraps the embeddings pipeline with the hook's readonly DB connection.
 * Returns hydrated FunctionResult[] in similarity order.
 */
async function semanticSearchFromHook(db: any, query: string, limit: number): Promise<FunctionResult[]> {
  // Dynamic import — embeddings.ts is ESM with heavy dependencies
  const { semanticSearch } = await import('../../mcp-server/embeddings.js');
  const results = await semanticSearch(db, query, limit);
  if (results.length === 0) return [];

  const funcResults: FunctionResult[] = [];
  for (const r of results) {
    const row = db.prepare('SELECT * FROM functions WHERE id = ?').get(r.functionId) as FunctionRow | undefined;
    if (row) {
      funcResults.push(hydrateFunction(db, row));
    }
  }
  return funcResults;
}
```

Note: We use `dynamic import()` rather than a top-level import because `embeddings.ts` pulls in `@huggingface/transformers` which is heavy and ESM-only. The dynamic import ensures it only loads when semantic search is actually attempted, and the `try/catch` in `buildPatternContext` handles the case where it fails.

- [ ] **Step 3: Update the caller in pre-edit-validation.ts**

In `src/hooks/pre-edit-validation.ts`, change line 382 from:

```typescript
  const patternContext = buildPatternContext(
```

to:

```typescript
  const patternContext = await buildPatternContext(
```

The function is already called inside `async function validateEdit()`, so adding `await` is all that's needed.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: All tests PASS. The existing `code-index-client.test.ts` tests should still pass since they test other functions, not `buildPatternContext` directly.

- [ ] **Step 5: Deploy and verify manually**

```bash
./update.sh
```

Then check the validation logs on the next edit to confirm semantic search is being used:

```bash
cat ~/.codebase-guardian/projects.json  # find your project hash
tail -50 ~/.codebase-guardian/logs/{project-hash}/validation-debug.log
```

You should see semantic search results in the "SIMILAR EXISTING FUNCTIONS" section of the headless Claude prompt (the log captures the full prompt).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/helpers/code-index-client.ts src/hooks/pre-edit-validation.ts
git commit -m "feat: upgrade buildPatternContext to use semantic search for DRY detection"
```

---

## Task 6: Headless Validator MCP Access

Attach the codebase-guardian MCP server to headless Claude invocations so the validator can query the index during validation.

**Files:**
- Modify: `src/hooks/helpers/claude-headless.ts:36-238` (system prompt), `src/hooks/helpers/claude-headless.ts:302-344` (first attempt execution), `src/hooks/helpers/claude-headless.ts:364-413` (resume execution)

- [ ] **Step 1: Add MCP config generation**

In `src/hooks/helpers/claude-headless.ts`, add a function after the imports (around line 25):

```typescript
import { writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import os from 'os';

/**
 * Generates a temporary MCP config file pointing to the codebase-guardian server.
 * Returns the path to the config file, or null if the server source isn't available.
 */
function getMcpConfigPath(): string | null {
  const guardianHome = path.join(os.homedir(), '.codebase-guardian');
  const serverEntry = path.join(guardianHome, 'source', 'dist', 'mcp-server', 'index.js');

  if (!require('fs').existsSync(serverEntry)) return null;

  const configPath = path.join(guardianHome, '.headless-mcp-config.json');
  const config = {
    mcpServers: {
      'codebase-guardian': {
        command: 'node',
        args: [serverEntry],
      },
    },
  };

  try {
    writeFileSync(configPath, JSON.stringify(config));
    return configPath;
  } catch {
    return null;
  }
}
```

Note: We use `require('fs').existsSync` instead of the already-imported `existsSync` from the top of the file because the import is `import { appendFileSync } from 'fs'` — we'd need to add `existsSync` to that import. Either approach works; the implementer should pick whichever is cleaner. The key requirement is checking that the compiled server entry point exists before generating the config.

- [ ] **Step 2: Update the system prompt**

In `src/hooks/helpers/claude-headless.ts`, add the following section to the end of `SYSTEM_PROMPT` (before the closing backtick at line 238):

```typescript
## Index Query Tools

You have access to the codebase index via MCP tools. Use the \`execute\` tool to write TypeScript queries when the pre-loaded context above is insufficient to make a confident judgment.

Examples of when to query:
- You see an unfamiliar invocation pattern and want to check if sibling files use the same pattern: \`return api.functionsByDirectory("src/utils").map(f => ({ name: f.name, desc: f.description }))\`
- You suspect a DRY violation but none of the pre-loaded similar functions are close enough: \`return await api.semanticSearch("validate user input and sanitize")\`
- You want to check callers of a function that wasn't in the pre-loaded blast radius: \`return api.callers("helperFunction").map(c => ({ name: c.name, file: c.file_path }))\`
- You want to search documentation for a specific pattern or convention: \`return api.searchDocs("error handling pattern")\`

Do NOT query for information already present in the pre-loaded context above. Only query when you need to go deeper. Each query adds latency, so be targeted.

Your response must still be ONLY a JSON object — any tool calls happen before your final response.
```

- [ ] **Step 3: Add --mcp-config to first attempt execution**

In `executeFirstAttempt` (around line 311), modify the `execFileSync` call. After `'--model', 'opus'`, add:

```typescript
    // Get MCP config for index query access
    const mcpConfig = getMcpConfigPath();

    const cliArgs = [
      '-p', prompt,
      '--system-prompt', SYSTEM_PROMPT,
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
      '--model', 'opus',
    ];
    if (mcpConfig) {
      cliArgs.push('--mcp-config', mcpConfig);
    }

    const result = execFileSync('claude', cliArgs, {
```

Replace the existing `execFileSync('claude', [...], {...})` call with this version.

- [ ] **Step 4: Add --mcp-config to resume execution**

Apply the same change in `executeWithResume` (around line 375). The `--resume` call also needs MCP access:

```typescript
    const mcpConfig = getMcpConfigPath();

    const cliArgs = [
      '--resume', headlessSessionId,
      '-p', prompt,
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
      '--model', 'opus',
    ];
    if (mcpConfig) {
      cliArgs.push('--mcp-config', mcpConfig);
    }

    const result = execFileSync('claude', cliArgs, {
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: All tests PASS. The `claude-headless.test.ts` tests only test `parseClaudeOutput`, not the execution functions, so they should be unaffected.

- [ ] **Step 6: Deploy and verify**

```bash
./update.sh
```

Clear cache for your test project, then trigger an edit and check the validation log:

```bash
cat ~/.codebase-guardian/projects.json
rm ~/.codebase-guardian/indexes/{hash}/.validation-cache.json ~/.codebase-guardian/indexes/{hash}/.validation-sessions.json
tail -100 ~/.codebase-guardian/logs/{hash}/validation-debug.log
```

Look for MCP-related entries in the log. If the headless validator used the execute tool, you'll see tool calls in the Claude output.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/helpers/claude-headless.ts
git commit -m "feat: give headless validator MCP access for index queries"
```

---

## Task 7: Denial Message Enhancement

Make denial messages educational by appending suggested `api.*` queries that would have prevented the violation.

**Files:**
- Modify: `src/hooks/pre-edit-validation.ts:463-469` (return formatting), `src/hooks/pre-edit-validation.ts:612-622` (deny exit)
- Create: `tests/denial-messages.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/denial-messages.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enhanceViolationWithQueryHint } from '../src/hooks/helpers/denial-hints.js';

describe('enhanceViolationWithQueryHint', () => {
  it('adds semanticSearch hint for DRY violations', () => {
    const violation = "Function 'calculateFees' duplicates existing 'computeFees' in utils/fees.ts:23";
    const enhanced = enhanceViolationWithQueryHint(violation);
    assert.ok(enhanced.includes(violation), 'Should preserve original violation');
    assert.ok(enhanced.includes('api.semanticSearch'), 'Should suggest semanticSearch');
  });

  it('adds functionsByDirectory hint for pattern violations', () => {
    const violation = "Function 'snake_case_name' does not follow camelCase naming convention used by sibling functions";
    const enhanced = enhanceViolationWithQueryHint(violation);
    assert.ok(enhanced.includes('api.functionsByDirectory'), 'Should suggest functionsByDirectory');
  });

  it('adds callers hint for blast radius violations', () => {
    const violation = "Function 'processOrder' signature changed — 3 callers may break";
    const enhanced = enhanceViolationWithQueryHint(violation);
    assert.ok(enhanced.includes('api.callers'), 'Should suggest callers');
  });

  it('adds searchDocs hint for documentation violations', () => {
    const violation = "Function violates documented error handling pattern in docs/error-patterns.md";
    const enhanced = enhanceViolationWithQueryHint(violation);
    assert.ok(enhanced.includes('api.searchDocs'), 'Should suggest searchDocs');
  });

  it('adds generic search hint for JSDoc violations', () => {
    const violation = "Function 'formatDate' missing @returns tag";
    const enhanced = enhanceViolationWithQueryHint(violation);
    // JSDoc violations don't need index hints — they're local fixes
    assert.equal(enhanced, violation, 'JSDoc violations should not get hints');
  });

  it('does not double-hint if violation already contains api reference', () => {
    const violation = "Use api.lookup('existingHelper') — duplicate detected";
    const enhanced = enhanceViolationWithQueryHint(violation);
    assert.equal(enhanced, violation, 'Should not add hint if api reference already present');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/denial-messages.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the denial hints module**

```typescript
// src/hooks/helpers/denial-hints.ts

/**
 * Enhances a violation string with a suggested api.* query that would have
 * prevented the violation. Teaches the primary Claude session how to use
 * the index proactively.
 */
export function enhanceViolationWithQueryHint(violation: string): string {
  // Don't double-hint
  if (violation.includes('api.')) return violation;

  const lower = violation.toLowerCase();

  // DRY violations — suggest semantic search
  if (lower.includes('duplicat') || lower.includes('similar') || lower.includes('existing') || lower.includes('reuse')) {
    // Extract function name from common violation formats like "Function 'name' duplicates..."
    const nameMatch = violation.match(/[Ff]unction\s+'(\w+)'/);
    const searchTerm = nameMatch
      ? nameMatch[1].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
      : 'your function description';
    return `${violation}\n  Hint: Before creating new functions, run: api.semanticSearch('${searchTerm}')`;
  }

  // Pattern violations — suggest directory inspection
  if (lower.includes('naming') || lower.includes('convention') || lower.includes('pattern') || lower.includes('sibling')) {
    return `${violation}\n  Hint: Check directory conventions first: api.functionsByDirectory('path/to/dir')`;
  }

  // Blast radius — suggest callers check
  if (lower.includes('caller') || lower.includes('break') || lower.includes('signature') || lower.includes('blast')) {
    const nameMatch = violation.match(/[Ff]unction\s+'(\w+)'/);
    const funcName = nameMatch ? nameMatch[1] : 'functionName';
    return `${violation}\n  Hint: Check impact before modifying: api.callers('${funcName}')`;
  }

  // Documentation compliance — suggest doc search
  if (lower.includes('document') || lower.includes('readme') || lower.includes('pattern guide') || lower.includes('best practice')) {
    return `${violation}\n  Hint: Check project documentation: api.searchDocs('relevant topic')`;
  }

  // JSDoc violations and other local issues — no hint needed
  return violation;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/denial-messages.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Wire into the hook orchestrator**

In `src/hooks/pre-edit-validation.ts`, import the new module:

```typescript
import { enhanceViolationWithQueryHint } from './helpers/denial-hints.js';
```

Then modify the return block (around line 463-469). Change:

```typescript
    return {
      action: validationResult.decision === 'allow' ? 'allow' : 'deny',
      message: validationResult.decision === 'allow'
        ? `Code Quality Passed: ${validationResult.reasoning}`
        : `BLOCKED: ${validationResult.reasoning}`,
      violations: validationResult.violations
    };
```

to:

```typescript
    const enhancedViolations = validationResult.violations.map(enhanceViolationWithQueryHint);

    return {
      action: validationResult.decision === 'allow' ? 'allow' : 'deny',
      message: validationResult.decision === 'allow'
        ? `Code Quality Passed: ${validationResult.reasoning}`
        : `BLOCKED: ${validationResult.reasoning}`,
      violations: enhancedViolations
    };
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/helpers/denial-hints.ts tests/denial-messages.test.ts src/hooks/pre-edit-validation.ts
git commit -m "feat: enhance denial messages with suggested index queries"
```

---

## Task 8: CLAUDE.md Template Update

Add "research before editing" guidance to the CLAUDE.md snippet installed into target projects.

**Files:**
- Modify: `templates/claude-md-snippet.md`

- [ ] **Step 1: Read the current template**

Read `templates/claude-md-snippet.md` to understand the existing content and where to add the new section.

- [ ] **Step 2: Add the research guidance section**

Append the following section to the end of `templates/claude-md-snippet.md`:

```markdown

## Using the Codebase Index

Before creating new functions or modifying existing ones, use the codebase-guardian MCP tools to research the codebase:

- **`execute`** — Write TypeScript against the index API for composed queries. Example: `const callers = api.callers("myFunc"); return callers.map(c => c.file_path);`
- **`search`** — Find functions by keyword. Use before writing new code to check for existing utilities.
- **`callers` / `callees` / `impact`** — Understand blast radius before changing function signatures.

A 30-second query saves a 15-second validation denial and retry cycle.
```

- [ ] **Step 3: Commit**

```bash
git add templates/claude-md-snippet.md
git commit -m "docs: add research-before-editing guidance to CLAUDE.md template"
```

---

## Task 9: Integration Test — End to End

Verify all pieces work together: Index API -> execute tool -> semantic search -> headless MCP access.

**Files:**
- No new files — verification only

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 2: Build and deploy**

```bash
./update.sh
```

Expected: Clean build, no TypeScript errors, successful deploy.

- [ ] **Step 3: Clear caches for your test project**

```bash
cat ~/.codebase-guardian/projects.json
rm ~/.codebase-guardian/indexes/{hash}/.validation-cache.json ~/.codebase-guardian/indexes/{hash}/.validation-sessions.json
```

- [ ] **Step 4: Test the execute tool via MCP**

In a Claude Code session on any indexed project, run:

```
Use the codebase-guardian execute tool to find all functions in the finance domain:
api.search("finance", { domain: "finance" })
```

Verify it returns results from the index.

- [ ] **Step 5: Test headless validator with MCP access**

Make a deliberate edit that creates a function duplicating existing functionality. Verify:
1. The validation denial includes enhanced hints
2. The validation log shows semantic search was used in `buildPatternContext`
3. The headless validator had MCP access (check logs for any tool calls)

- [ ] **Step 6: Test the semantic search upgrade**

Create a function with a name semantically similar to (but lexically different from) an existing function. For example, if `calculateProfit` exists, create `computeNetGains`. Verify that `buildPatternContext` finds the similarity via semantic search where FTS would have missed it.

- [ ] **Step 7: Final commit with updated spec status**

Update `docs/superpowers/specs/2026-04-23-code-mode-execute-tool-design.md`:
- Change `Status: Design approved, pending implementation plan` to `Status: Implemented`
- Change `Branch: TBD` to the actual branch name

```bash
git add docs/superpowers/specs/2026-04-23-code-mode-execute-tool-design.md
git commit -m "docs: mark code-mode design as implemented"
```
