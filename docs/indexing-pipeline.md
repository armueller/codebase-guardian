# Indexing Pipeline

The indexing pipeline scans the the codebase and documentation, extracts structured metadata, and stores it in the SQLite database. It runs in two phases: code scanning (Phase 1) and call graph extraction (Phase 2).

## Running a Build

```bash
# Full rebuild with embeddings (~16s)
npx tsx src/mcp-server/build-index.ts

# Fast rebuild without embeddings (~7s)
npx tsx src/mcp-server/build-index.ts --skip-embeddings

# Set custom repo root
GUARDIAN_PROJECT_ROOT=/path/to/repo npx tsx src/mcp-server/build-index.ts
```

The build script (`build-index.ts`) resolves the repo root from `GUARDIAN_PROJECT_ROOT` env var or by walking up from `__dirname`. The database is created at `{REPO_ROOT}/code-quality.db`.

## Phase 1: Code Scanning

### Tier 1 — JSDoc-Annotated Functions

**Source:** All `.ts` and `.tsx` files under `app/` (excluding `node_modules`, `dist`, `.claude`, `cdk.out`, `build`, `__snapshots__`)

**Detection:** Regex matches JSDoc blocks containing `@domain`:

```
/\/\*\*[\s\S]*?@domain[\s\S]*?\*\//g
```

**Extraction per function:**

1. **JSDoc tags**: `@what`, `@how`, `@why`, `@param`, `@returns`, `@sideeffects`, `@systemlayer`, `@domain`, `@tags`
2. **Function name**: Parsed from code immediately following the JSDoc block using pattern matching for `function`, `const`, `class`, `interface`, `type`, and `export` declarations
3. **Line number**: Computed from newlines before the JSDoc block
4. **Function body**: Extracted by counting braces `{` and `}` from the end of the JSDoc block
5. **Inline comments**: Extracted from the function body (see Comment Extraction below)
6. **Description**: Concatenation of `what`, `how`, and `why` tag values
7. **Embeddings**: Vector embedding of signature text (name + description + domains + tags + system layers)

**Normalization:**
- Domains: split by comma, trimmed, lowercased → `function_domains`
- Tags: split by comma, trimmed, lowercased → `function_tags`
- System layers: split by comma, trimmed (NOT lowercased) → `function_systemlayers`

### Tier 3 — Documentation Files

**Source:** All `.md` files under `docs/` subdirectories (`architecture/`, `best-practices/`, `patterns/`)

**Detection:** Files ending in `.md` found by `findReadmeFiles()`

**Extraction per document:**

1. **Name**: Extracted from first `#` heading, or filename
2. **Description**: File content truncated to 1000 characters
3. **JSDoc metadata**: If the doc contains `@domain` and `@tags` in its frontmatter/body, those are extracted
4. **Sections**: Parsed at `##` through `#####` heading boundaries (see Doc Section Parsing below)
5. **Embeddings**: Vector embedding of title + description

### Comment Extraction (`extractCommentsFromBody`)

Extracts inline comments from function bodies for sub-function-level DRY detection.

**Algorithm:**

1. Split body by newlines
2. Iterate lines, tracking state:
   - `//` comment lines: accumulate consecutive ones into a single merged entry
   - End-of-line comments (`code // comment`): capture the comment portion
   - When a blank line or code-only line breaks a `//` sequence, flush the accumulated comment
3. Detect section headers (`// --- Something ---` or `// ═══ Something ═══`) with type `section-header`
4. Filter by minimum length: standalone ≥ 5 chars, end-of-line ≥ 10 chars
5. Skip eslint directives, TODO comments, and similar non-semantic comments

**Example:**

```typescript
// Map asset fields from Polygon API (current + non-current assets)
// This includes both tangible and intangible asset categories
const assets = mapFields(raw);
// Calculate derived ratios from mapped values
const ratios = computeRatios(assets);
```

Produces two comment records:
1. `"Map asset fields from Polygon API (current + non-current assets) This includes both tangible and intangible asset categories"` (merged consecutive lines)
2. `"Calculate derived ratios from mapped values"`

### Doc Section Parsing (`parseDocSections`)

Splits Tier 3 documentation into heading-level sections for granular FTS5 search.

**Algorithm:**

1. Split content at heading boundaries: `/^(#{2,5})\s+(.+)$/m`
2. Skip `## @` metadata headings (already captured in function description)
3. For each section:
   - Extract fenced code blocks as separate entries with type `code`
   - Remaining text becomes type `prose`
4. Filter: body must be ≥ 20 characters
5. Assign sequential `section_order` values

## Phase 2: Call Graph

### Export Discovery (Tier 2)

Uses `ts-morph` to load the TypeScript project and discover all exported symbols not already captured as Tier 1:

1. Load the resolved tsconfig (the `tsconfig` path from `guardian.config.json`, else `<root>/tsconfig.json`, else compiler defaults) and add the `.ts`/`.tsx` files the indexer walked — the same file list, with `excludeDirectories` applied
2. For each source file, find exported declarations:
   - Functions (`export function`)
   - Variables (`export const`)
   - Classes (`export class`)
   - Interfaces and types (skipped — only runtime symbols)
3. For each export not already in the index (by name + file path), insert as Tier 2
4. Generate signature embedding from name + file path

### Call Edge Extraction

Walks the AST of every source file to find function call expressions:

1. Find all `CallExpression` nodes in the AST
2. Resolve the callee using TypeScript's type checker to get the source file
3. Match the callee name to an indexed function (Tier 1 or Tier 2)
4. Insert a `calls` edge from the caller function to the callee function
5. Also track `imports` edges from import declarations

**Deduplication:** Edges have a `UNIQUE(source_function_id, target_function_id, edge_type)` constraint, so duplicate references are silently ignored.

## Embedding Generation

Uses HuggingFace `@huggingface/transformers` to run `Xenova/all-MiniLM-L6-v2` locally (no API calls):

- **Model**: `all-MiniLM-L6-v2` (384-dimensional embeddings)
- **Pooling**: Mean pooling with L2 normalization
- **Lazy loading**: Pipeline initialized on first embed call, reused afterward
- **Incremental**: Each embedding has an `input_hash`; if the hash hasn't changed, embedding is skipped

**Signature text format:**
```
functionName: What it does. How it works. Why it exists. Domains: domain1, domain2. System layers: UI Helper. Tags: tag1, tag2, tag3
```

**Body text:** First 1000 characters of the function body.

## Incremental Rebuild

The system supports incremental rebuilds via two mechanisms:

### File Hash Tracking

Each indexed file has a content hash stored in `file_hashes`. On rebuild:
1. Compute current file hash
2. Compare with stored hash
3. If unchanged, skip the file
4. If changed, delete all functions for that file and re-index

### Dirty File Tracking

The MCP server maintains a `.dirty-files` file listing files modified since the last sync. On search queries, `autoSync()` checks this file and incrementally rebuilds only the dirty files before returning results.

## Output

A typical full rebuild produces:

```
=== Codebase Guardian Index Builder ({PROJECT_NAME}) ===
Repository: {PROJECT_ROOT}
Database: {GUARDIAN_HOME}/indexes/{project-hash}/code-quality.db

## Index Rebuild Complete

- **Clear old index:** ok
- **Index code and docs:** ok
- **TypeScript call graph:** ok
- **Python call graph:** ok (no Python files indexed)
- **Validation cache:** ok

**Files scanned:** 41
**Files skipped (unchanged):** 0
**Tier 1 (JSDoc):** 126
**Tier 2 (exports):** 21
**Tier 3 (docs):** 3
**Embeddings generated:** 129
**Call edges:** 108
**Python call edges:** 0
**Inline comments:** 19
**Doc sections:** 50
**Validation cache:** already clear

=== Finished in 2.2s ===
```

The `rebuild_index` MCP tool returns the same report (from the heading down). The phases are run by `src/mcp-server/rebuild.ts`. Each one ends `ok`, `degraded`, `failed` or `skipped`, with the reason in brackets; a failed phase does not stop the ones after it, and the heading reads "Index Rebuild Finished With Problems" unless every phase is `ok`. The CLI exits non-zero when any phase failed. See "Reading the Rebuild Result" in the README.
