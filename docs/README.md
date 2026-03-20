# Codebase Guardian — Semantic Code Index

A Model Context Protocol (MCP) server that provides hybrid keyword + vector search over the the codebase. The index powers automated DRY enforcement, code discovery, and quality validation through Claude Code's hook system.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Claude Code Session                         │
│                                                                    │
│  Edit/Write ──► PreToolUse Hook ──► code-index-client.ts           │
│                  (pre-edit-validation-ai.ts)    │                  │
│                       │                         │ SQLite queries   │
│                       ▼                         ▼                  │
│                 claude-headless.ts         code-quality.db ◄────┐   │
│                 (AI validation)                               │   │
│                       │                                       │   │
│                       ▼                                       │   │
│                 Allow / Deny                                  │   │
│                                                               │   │
│  MCP Tools ──► index.ts (MCP Server) ────────────────────────►│   │
│                  search, callers,                              │   │
│                  search_comments, etc.                         │   │
│                                                               │   │
│  CLI ──────► build-index.ts ──► indexer.ts ──► call-graph.ts ─┘   │
│                                     │                              │
│                                     ▼                              │
│                               embeddings.ts                        │
│                            (HuggingFace local)                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](./architecture.md) | System components, data flow, and design decisions |
| [Schema](./schema.md) | SQLite database schema, tables, indexes, and FTS5 configuration |
| [Indexing Pipeline](./indexing-pipeline.md) | How code and documentation are scanned, parsed, and indexed |
| [Search](./search.md) | Hybrid search algorithm, FTS5 queries, vector similarity, and filtering |
| [MCP Tools](./mcp-tools.md) | Complete reference for all MCP tools exposed to Claude |
| [Hook Integration](./hook-integration.md) | How the PreToolUse hook uses the index for code quality enforcement |

## Quick Reference

```bash
# Full rebuild (with embeddings, ~16s)
npx tsx src/mcp-server/build-index.ts

# Fast rebuild (skip embeddings, ~7s)
npx tsx src/mcp-server/build-index.ts --skip-embeddings

# Compile TypeScript (required after source changes for MCP server)
cd .claude/mcp-servers/code-index && npm run build

# Check index health via MCP
# Use the index_status tool through Claude
```

## Key Numbers (as of last rebuild)

| Metric | Count |
|--------|-------|
| Total indexed entries | 781 |
| Tier 1 (JSDoc-annotated functions) | 394 |
| Tier 2 (auto-discovered exports) | 356 |
| Tier 3 (documentation files) | 31 |
| Inline comments indexed | 1,047 |
| Documentation sections | 346 |
| Vector embeddings | 425 |
| Call graph edges | 893 |
