# Database Schema

The code index uses a single SQLite database (`code-quality.db`) with WAL journaling and foreign keys enabled. The schema is defined in `db.ts` and created automatically on `openDatabase()`.

## Entity-Relationship Overview

```
functions (core entity)
    │
    ├── 1:N ── function_domains      (many-to-many via domain text)
    ├── 1:N ── function_tags          (many-to-many via tag text)
    ├── 1:N ── function_systemlayers  (many-to-many via systemlayer text)
    ├── 1:1 ── function_embeddings    (per-type: "signature" and "body")
    ├── 1:N ── function_comments      (inline comments from function body)
    ├── 1:N ── doc_sections           (heading-level chunks, Tier 3 only)
    └── N:N ── call_edges             (source → target function references)

functions_fts         (FTS5 virtual table, synced via triggers)
comments_fts          (FTS5 virtual table, synced via triggers)
doc_sections_fts      (FTS5 virtual table, synced via triggers)

file_hashes           (incremental rebuild tracking)
metadata              (key-value store for index state)
```

## Tables

### `functions`

The core entity. Stores both code functions (Tier 1, 2) and documentation entries (Tier 3).

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment ID |
| `name` | TEXT NOT NULL | Function name or document title |
| `description` | TEXT NOT NULL | Concatenated `@what + @how + @why` or doc body (truncated to 1000 chars for Tier 3) |
| `file_path` | TEXT NOT NULL | Relative path from repo root |
| `line_number` | INTEGER NOT NULL | Line number in source file |
| `is_exported` | INTEGER NOT NULL | 1 if exported, 0 if not (currently always 1 for Tier 1) |
| `declaration_type` | TEXT NOT NULL | `'function'`, `'const'`, `'class'`, `'interface'`, `'type'`, `'doc'` |
| `side_effects` | TEXT | Contents of `@sideeffects` tag, or NULL |
| `system_layer` | TEXT | First `@systemlayer` value, or NULL |
| `tier` | INTEGER NOT NULL | 1 = JSDoc-annotated, 2 = auto-discovered export, 3 = documentation |

**Indexes:** `idx_functions_name`, `idx_functions_file_path`, `idx_functions_tier`

### Tier Classification

| Tier | Source | How Identified | Has JSDoc | Has Embeddings |
|------|--------|---------------|-----------|----------------|
| 1 | `app/**/*.ts(x)` | JSDoc block containing `@domain` | Yes | Yes |
| 2 | `app/**/*.ts(x)` | Exported symbol found by ts-morph (not already Tier 1) | No | Yes |
| 3 | `docs/**/*.md` | Markdown files matching `*.md` pattern | N/A | Yes |

### `function_domains`

Many-to-many relationship between functions and business domains.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `function_id` | INTEGER FK | References `functions(id)` ON DELETE CASCADE |
| `domain` | TEXT NOT NULL | Lowercase domain name (e.g., `"options-trading"`, `"authentication"`) |

Domains are extracted from the `@domain` JSDoc tag, split by comma, trimmed, and lowercased.

### `function_tags`

Many-to-many relationship between functions and searchable tags.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `function_id` | INTEGER FK | References `functions(id)` ON DELETE CASCADE |
| `tag` | TEXT NOT NULL | Lowercase tag (e.g., `"validation"`, `"ticker"`, `"regex"`) |

Tags are extracted from the `@tags` JSDoc tag, split by comma, trimmed, and lowercased. Minimum 3 tags per function (enforced by convention, not schema).

### `function_systemlayers`

Many-to-many relationship between functions and architectural layers.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `function_id` | INTEGER FK | References `functions(id)` ON DELETE CASCADE |
| `systemlayer` | TEXT NOT NULL | Mixed-case layer name (e.g., `"Business Logic"`, `"UI Helper"`) |

System layers are NOT lowercased (unlike domains and tags). Common values: `Business Logic`, `UI Helper`, `Data Layer`, `API`, `Validation`, `Utility`, `Model`, `Controller`.

### `function_embeddings`

Vector embeddings for semantic search. Each function can have up to two embeddings.

| Column | Type | Description |
|--------|------|-------------|
| `function_id` | INTEGER FK | References `functions(id)` ON DELETE CASCADE |
| `embedding_type` | TEXT NOT NULL | `"signature"` or `"body"` |
| `embedding` | BLOB NOT NULL | Raw Float32Array bytes (384 dimensions × 4 bytes = 1,536 bytes) |
| `input_hash` | TEXT NOT NULL | SHA-256 hash (truncated to 16 hex chars) of the input text |

**Primary key:** `(function_id, embedding_type)`

The `input_hash` enables incremental updates: if the hash hasn't changed since last embed, skip re-embedding.

**Embedding types:**
- `signature`: Concatenation of `name: description. Domains: ... System layers: ... Tags: ...`
- `body`: First 1000 characters of the function body

### `function_comments`

Inline comments extracted from function bodies for sub-function-level DRY detection.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `function_id` | INTEGER FK | References `functions(id)` ON DELETE CASCADE |
| `comment_text` | TEXT NOT NULL | The comment content (consecutive `//` lines merged) |
| `comment_type` | TEXT NOT NULL | `"block"`, `"line"`, or `"section-header"` |
| `line_offset` | INTEGER NOT NULL | Offset from function start |

**Extraction rules:**
- Consecutive `//` lines with no code between them are merged into one entry
- Minimum 5 characters for standalone comments, 10 for end-of-line comments
- `eslint-disable`, `TODO`, and similar directives are filtered out
- Section headers like `// --- Something ---` get type `"section-header"`

### `doc_sections`

Heading-level chunks from Tier 3 documentation files.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `doc_function_id` | INTEGER FK | References `functions(id)` ON DELETE CASCADE |
| `heading` | TEXT NOT NULL | Section heading text (e.g., `"Error Handling Pattern"`) |
| `heading_level` | INTEGER NOT NULL | 2-5 (matching `##` through `#####`) |
| `body` | TEXT NOT NULL | Section content (minimum 20 characters) |
| `section_type` | TEXT NOT NULL | `"prose"` or `"code"` |
| `section_order` | INTEGER NOT NULL | Sequential order within document |

**Parsing rules:**
- Split at `##` through `#####` headings
- Skip `## @` metadata headings (already captured in function description)
- Code blocks (triple backtick) extracted as separate entries with type `"code"`
- Body must be at least 20 characters

### `call_edges`

Directed graph of function call relationships, built by ts-morph AST analysis.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `source_function_id` | INTEGER FK | The calling function |
| `target_function_id` | INTEGER FK | The called function |
| `edge_type` | TEXT NOT NULL | `"calls"` or `"imports"` |

**Unique constraint:** `(source_function_id, target_function_id, edge_type)`

### `file_hashes`

Tracks file content hashes for incremental rebuild.

| Column | Type | Description |
|--------|------|-------------|
| `file_path` | TEXT PK | Relative path from repo root |
| `content_hash` | TEXT NOT NULL | SHA-256 truncated to 16 hex chars |
| `last_indexed` | TEXT NOT NULL | ISO timestamp |

### `metadata`

Key-value store for index-level metadata.

| Column | Type | Description |
|--------|------|-------------|
| `key` | TEXT PK | Metadata key (e.g., `"last_rebuilt"`, `"files_scanned"`) |
| `value` | TEXT NOT NULL | Metadata value |

## FTS5 Virtual Tables

Three FTS5 content-sync tables provide full-text search:

### `functions_fts`

Searches function names, descriptions, and system layers.

```sql
CREATE VIRTUAL TABLE functions_fts USING fts5(
  name, description, system_layer,
  content=functions, content_rowid=id
);
```

Synced via `AFTER INSERT/DELETE/UPDATE` triggers on `functions`.

### `comments_fts`

Searches inline comment text.

```sql
CREATE VIRTUAL TABLE comments_fts USING fts5(
  comment_text,
  content=function_comments, content_rowid=id
);
```

Synced via triggers on `function_comments`.

### `doc_sections_fts`

Searches documentation section headings and bodies.

```sql
CREATE VIRTUAL TABLE doc_sections_fts USING fts5(
  heading, body,
  content=doc_sections, content_rowid=id
);
```

Synced via triggers on `doc_sections`.

## FTS5 Query Handling

All FTS5 queries pass through `sanitizeFTSQuery()` which:

1. **Detects existing operators**: If query contains `OR`, `AND`, `NOT`, or double quotes, passes through as-is
2. **Tokenizes**: Splits on whitespace, strips non-alphanumeric characters (preserving hyphens and underscores)
3. **Filters short tokens**: Removes tokens under 3 characters
4. **Joins with OR**: Multi-word queries become `"word1" OR "word2" OR "word3"`

This prevents FTS5's default AND behavior from producing zero results for natural language queries like "group options by ticker".

## Database Configuration

```sql
PRAGMA journal_mode = WAL;     -- Write-Ahead Logging for concurrent reads
PRAGMA foreign_keys = ON;      -- Enforce CASCADE deletes
```

WAL mode allows the hook validation system to read the database while the MCP server or build script writes to it.
