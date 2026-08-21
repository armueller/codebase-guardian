# MCP Tools Reference

The code index MCP server exposes 10 tools to Claude. These tools are available in any Claude Code session where the `codebase-guardian` server is enabled.

## Search Tools

### `search`

Hybrid keyword + semantic search across the entire index.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Natural language or keywords |
| `domain` | string | No | Filter by domain (e.g., `"options-trading"`) |
| `tags` | string[] | No | Filter by tags (ALL must match) |
| `system_layer` | string | No | Filter by layer (e.g., `"Business Logic"`) — case-sensitive |
| `file_path_pattern` | string | No | SQL LIKE pattern (e.g., `"app/store/%"`) |
| `tier` | number | No | Filter by tier: 1, 2, or 3 |
| `has_side_effects` | boolean | No | Filter by presence of side effects |
| `limit` | number | No | Max results (default 15, max 50) |

**Output:** Ranked list of functions with name, file path, line number, description, domains, tags, system layers, side effects, tier, and hybrid score.

**When to use:** Primary discovery tool. Use for finding existing implementations before writing new code. The 40% keyword + 60% semantic weighting handles both exact term matches and conceptual similarity.

### `search_comments`

FTS5 search over inline comments within function bodies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search terms |
| `limit` | number | No | Max results (default 10, max 30) |

**Output:** Matching comments with their parent function name, file path, and metadata.

**When to use:** Finding sub-function-level logic patterns. If `search` finds a function with a similar name but you need to know if the *internal steps* overlap, search comments for specific step descriptions.

### `search_doc_sections`

FTS5 search over documentation sections at heading level.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search terms |
| `limit` | number | No | Max results (default 10, max 30) |

**Output:** Matching sections with heading, body text, section type (prose/code), and parent document.

**When to use:** Finding best practices, patterns, and architectural guidance. More granular than `search` which only indexes document titles and descriptions.

## Call Graph Tools

### `callers`

Find all functions that call a given function (reverse call graph).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `function_name` | string | Yes | Function name to look up |
| `file_path` | string | No | Disambiguate when multiple functions share the name |
| `edge_type` | string | No | Filter: `"calls"` or `"imports"` |

**Output:** List of calling functions with name, file path, and edge type.

**When to use:** Understanding who depends on a function before modifying it.

### `callees`

Find all functions that a given function calls (forward call graph).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `function_name` | string | Yes | Function name to look up |
| `file_path` | string | No | Disambiguate |
| `edge_type` | string | No | Filter: `"calls"` or `"imports"` |

**Output:** List of called functions with name, file path, and edge type.

**When to use:** Understanding a function's dependencies and what it relies on.

### `impact`

Analyze the blast radius of modifying a function using BFS traversal up the caller graph.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `function_name` | string | Yes | Function to analyze |
| `file_path` | string | No | Disambiguate |
| `depth` | number | No | Max traversal depth (default 3, max 10) |

**Output:** Tree of affected functions organized by depth from the target function.

**When to use:** Before modifying a widely-used function, understand how far the change propagates.

## Taxonomy Tools

### `list_domains`

List all business domains with function counts.

No parameters.

**Output:** Table of domain names and how many functions belong to each.

**When to use:** Discovering what business areas exist in the codebase.

### `list_tags`

List tags with usage counts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `domain` | string | No | Filter tags to a specific domain |
| `limit` | number | No | Max results (default 50, max 200) |

**Output:** Table of tag names and usage counts.

**When to use:** Finding common keywords for more targeted searches.

### `list_systemlayers`

List all architectural layers with function counts.

No parameters.

**Output:** Table of system layer names and function counts.

**When to use:** Understanding the architectural distribution of the codebase.

## Administrative Tools

### `rebuild_index`

Full or incremental rebuild of the code index.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `skip_embeddings` | boolean | No | Skip HuggingFace embedding generation (default false) |

**Output:** Build statistics including counts for each tier, comments, doc sections, embeddings, and call edges.

**When to use:** After significant codebase changes, or when search results seem stale. Note: this clears all existing data before rebuilding.

### `index_status`

Get current index health metrics.

No parameters.

**Output:** Counts by tier, domain/tag/systemlayer counts, embedding count, call edge count, comment count, doc section count, last rebuild time, and number of stale files.

**When to use:** Checking if the index is up to date before relying on search results.

### `metrics`

Report the guardian's durable decision metrics from the cross-project decisions store (`metrics.db`) — a measure of how useful the guardian is over time. Read-only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `since_days` | number | No | Only include decisions from the last N days (default: all time) |
| `project` | string | No | Filter to a project by name/root substring (default: all projects) |

**Output:** Allow/deny rates (overall and on genuine headless-validated judgments), outcome buckets (`quality_pass`, `deny_blocked`, `fail_open_timeout`, `circuit_breaker`, …), deny-reason categories, per-project rates, and headless-validation timing percentiles.

**When to use:** To measure whether the guardian is catching real issues and where it spends time — all-time, or scoped with `since_days` / `project`. The same report is available from the CLI via `npm run metrics`.

## Configuration

### MCP Server Registration (`.mcp.json`)

```json
{
  "mcpServers": {
    "codebase-guardian": {
      "command": "node",
      "args": [".claude/mcp-servers/code-index/dist/index.js"],
      "env": {
        "GUARDIAN_PROJECT_ROOT": "{PROJECT_ROOT}"
      }
    }
  }
}
```

### Auto-Allow Permissions (`.claude/settings.local.json`)

All tools should be in the `allow` list so Claude can use them without prompting:

```json
{
  "permissions": {
    "allow": [
      "mcp__codebase-guardian__search",
      "mcp__codebase-guardian__search_comments",
      "mcp__codebase-guardian__search_doc_sections",
      "mcp__codebase-guardian__list_domains",
      "mcp__codebase-guardian__list_tags",
      "mcp__codebase-guardian__list_systemlayers",
      "mcp__codebase-guardian__callers",
      "mcp__codebase-guardian__callees",
      "mcp__codebase-guardian__impact",
      "mcp__codebase-guardian__index_status",
      "mcp__codebase-guardian__rebuild_index"
    ]
  }
}
```

## After Source Changes

The MCP server runs from compiled JavaScript in `dist/`. After modifying any source file in `src/`:

```bash
cd .claude/mcp-servers/code-index && npm run build
```

Then reconnect the MCP server in Claude Code (e.g., `/mcp` command) to pick up the changes.
