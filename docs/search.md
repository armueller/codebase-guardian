# Search

The code index provides three search mechanisms: hybrid search (FTS5 + semantic), FTS5-only comment search, and FTS5-only doc section search.

## Hybrid Search (`search` tool)

The primary search combines keyword matching (FTS5) with vector similarity (embeddings) for best results.

### Algorithm

```
Input: query string + optional filters (domain, tags, system_layer, tier, etc.)

1. FTS5 Keyword Search
   ├── Sanitize query via sanitizeFTSQuery()
   ├── Query functions_fts with MATCH
   ├── Retrieve top limit*3 results with BM25 rank
   └── Normalize ranks to 0.0-1.0 via min-max scaling

2. Semantic Vector Search
   ├── Embed query using all-MiniLM-L6-v2
   ├── Compute dot product against all cached signature embeddings
   ├── Sort by cosine similarity (vectors are L2-normalized)
   └── Take top limit*3 results

3. Score Fusion
   ├── For each candidate function from either backend:
   │   ├── ftsScore = normalized FTS rank * 0.4  (40% weight)
   │   ├── semanticScore = similarity * 0.6      (60% weight)
   │   └── hybridScore = ftsScore + semanticScore
   ├── Sort by hybridScore descending
   └── Apply post-filters (domain, tags, system_layer, tier, etc.)

4. Hydrate Results
   ├── For each result, load domains, tags, systemlayers from junction tables
   └── Format as structured output

Output: Top N results with name, file path, description, domains, tags, etc.
```

### FTS5 Query Sanitization

All FTS5 queries pass through `sanitizeFTSQuery()` before reaching the database:

| Input | Output | Reason |
|-------|--------|--------|
| `"calculate profit"` | `"calculate" OR "profit"` | Multi-word → OR-joined tokens |
| `calculate` | `"calculate"` | Single word → quoted |
| `"exact phrase"` | `"exact phrase"` | Already has quotes → passthrough |
| `calc OR profit` | `calc OR profit` | Has FTS5 operator → passthrough |
| `UI` | `UI` | Token too short (< 3 chars) → fallback to raw |
| `options-trading` | `"options-trading"` | Hyphens preserved in token |

**Token processing:**
1. Check for existing FTS5 operators (`OR`, `AND`, `NOT`, `"`) → pass through
2. Split on whitespace
3. Strip non-alphanumeric characters (keep hyphens and underscores)
4. Filter tokens shorter than 3 characters
5. Wrap each in quotes and join with `OR`

### Score Normalization

FTS5 BM25 ranks are negative numbers (more negative = better match). They're normalized to 0.0-1.0 via:

```
normalizedScore = 1 - (rank - minRank) / (maxRank - minRank)
```

Where `minRank` is the best match (most negative) and `maxRank` is the worst. If all ranks are equal, all get 1.0.

Semantic similarity scores are already 0.0-1.0 (cosine similarity of L2-normalized vectors).

### Post-Filtering

After scoring, results are filtered by optional parameters:

| Filter | Matching Logic |
|--------|---------------|
| `domain` | Lowercased, checked against `func.domains` array |
| `tags` | Lowercased, ALL must be present in `func.tags` |
| `system_layer` | Exact match against `func.systemlayers` array (case-sensitive) |
| `file_path_pattern` | SQL LIKE pattern converted to regex (`%` → `.*`, `_` → `.`) |
| `tier` | Exact match on `func.tier` |
| `has_side_effects` | `true` = side_effects is non-null and non-empty; `false` = null/empty/None |

Filtering happens **after** scoring, so narrow filters may return fewer results than `limit` if the top candidates don't match.

## Comment Search (`search_comments` tool)

FTS5-only search over inline comments extracted from function bodies.

### Algorithm

```
1. Sanitize query via sanitizeFTSQuery()
2. Query comments_fts with MATCH
3. Join through function_comments → functions to get parent function
4. Hydrate each parent function with domains, tags, systemlayers
5. Return: comment text + parent function details
```

### Use Cases

- **Sub-function DRY detection**: Find functions with similar step-level logic
- **Implementation pattern search**: Find how specific operations are performed inside functions
- **Logic discovery**: Find functions that do a particular step (even if their JSDoc doesn't mention it)

### Example

Query: `"group options by ticker"`

Result:
```
Comment: "Group option contracts by underlying ticker symbol"
Function: createOptionTypeGroup
File: app/helpers/positions/createOptionTypeGroup.ts:15
Domains: options-trading, positions
```

## Doc Section Search (`search_doc_sections` tool)

FTS5-only search over heading-level sections from documentation files.

### Algorithm

```
1. Sanitize query via sanitizeFTSQuery()
2. Query doc_sections_fts with MATCH on heading and body
3. Join through doc_sections → functions to get parent document
4. Return: heading + body + parent document details
```

### Use Cases

- **Best practice lookup**: Find specific guidance from architecture/pattern docs
- **Pattern discovery**: Find documented patterns for a specific domain
- **Antipattern awareness**: Find documented antipatterns to avoid

### Example

Query: `"error handling retry"`

Result:
```
Section: "## Retry with Exponential Backoff"
Type: prose
From: Exponential Backoff Polling (docs/patterns/exponential-backoff-polling.md)
Body: "When making API calls that may fail transiently, use exponential backoff..."
```

## Auto-Sync

The `search` and `search_comments` tools call `autoSync()` before querying, which:

1. Reads `.dirty-files` for recently modified file paths
2. If dirty files exist, incrementally rebuilds only those files
3. Clears the dirty files list
4. Invalidates the in-memory embedding cache

This ensures search results reflect recent code changes without requiring a manual rebuild. The auto-sync skips embedding generation for speed.

## Embedding Model

| Property | Value |
|----------|-------|
| Model | `Xenova/all-MiniLM-L6-v2` |
| Provider | HuggingFace Transformers (local, no API) |
| Dimensions | 384 |
| Pooling | Mean |
| Normalization | L2 |
| Similarity | Dot product (equivalent to cosine for L2-normalized vectors) |

The embedding cache loads all signature embeddings into memory on first search (~1.2 MB for 425 vectors). Subsequent searches reuse the cache until `invalidateCache()` is called.
