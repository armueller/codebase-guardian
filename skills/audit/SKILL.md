---
name: audit
description: Audit JSDoc coverage and inline comment quality across the codebase
trigger: /audit, "audit documentation", "check JSDoc coverage", "audit code quality"
---

# JSDoc & Comment Coverage Audit

You are running a documentation coverage audit for this project using Codebase Guardian.

## Step 1: Resolve Project Paths

Determine the Guardian database path for this project:

```bash
# Get the project root
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Compute the project hash (first 12 chars of SHA-256 of project root)
PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | shasum -a 256 | cut -c1-12)

# Guardian paths
GUARDIAN_HOME="${GUARDIAN_HOME:-$HOME/.codebase-guardian}"
DB_PATH="$GUARDIAN_HOME/indexes/$PROJECT_HASH/code-quality.db"
```

Check if the database exists. If not, inform the user they need to build the index first:
```
The code index has not been built for this project yet.
Run the MCP tool `rebuild_index` (with skip_embeddings=true for speed) to build it first, then run /audit again.
```

## Step 2: Scan Source Files

Find all TypeScript source files in the project (excluding test files, node_modules, dist, build):

```bash
find "$PROJECT_ROOT" -name "*.ts" -o -name "*.tsx" | grep -v node_modules | grep -v dist | grep -v build | grep -v '.test.' | grep -v '.spec.' | grep -v '__'
```

For each source file, count:
1. **Total exported functions** — `export function`, `export const ... = (...) =>`, `export async function`
2. **Functions with complete JSDoc** — Has `@what`, `@how`, `@why`, `@domain`, `@tags` (min 3), `@sideeffects`, `@systemlayer`, `@param` for each param, `@returns`
3. **Functions with partial JSDoc** — Has JSDoc comment (`/** ... */`) but missing required tags
4. **Functions with no JSDoc** — No JSDoc comment at all
5. **Exported interfaces/types/enums** — Count total and those with at minimum `@what`
6. **Inline comments** — Count of `//` and `/* */` comments inside function bodies (excluding JSDoc)

## Step 3: Generate Report

Present the results as a structured report:

```
## Codebase Guardian — Documentation Audit

**Project:** {project name}
**Scanned:** {N} files, {N} functions, {N} types

### Coverage Summary

| Category | Count | Percentage |
|----------|-------|------------|
| Functions with complete JSDoc | X | XX% |
| Functions with partial JSDoc | X | XX% |
| Functions with no JSDoc | X | XX% |
| Types/interfaces with JSDoc | X | XX% |
| Types/interfaces without JSDoc | X | XX% |

### Per-Directory Breakdown

| Directory | Functions | Complete | Partial | Missing | Coverage |
|-----------|-----------|----------|---------|---------|----------|
| src/controllers/ | 12 | 10 | 1 | 1 | 83% |
| ... | ... | ... | ... | ... | ... |

### Top Gaps (functions missing JSDoc)

1. `functionName` in `path/to/file.ts:42`
2. `anotherFunction` in `path/to/other.ts:88`
3. ...

### Inline Comment Quality

- Total inline comments: {N}
- Average comments per function: {N}
- Functions with zero inline comments: {N} ({X}%)
```

## Step 4: Offer Actions

After presenting the report, offer these actions:

1. **Generate JSDoc stubs** — For each function missing JSDoc, generate a stub with AI-inferred tags:
   - `@what` — Inferred from function name and body
   - `@how` — Inferred from implementation
   - `@why` — Inferred from directory context and callers
   - `@param` — Extracted from function signature
   - `@returns` — Extracted from return type
   - `@domain` — Inferred from directory and sibling functions
   - `@sideeffects` — Detected from function body (API calls, state mutations, file I/O)
   - `@systemlayer` — Inferred from directory patterns
   - `@tags` — AI-generated searchable keywords (minimum 5)

2. **Add JSDoc standards to CLAUDE.md** — Check if the project's CLAUDE.md contains the `<!-- codebase-guardian -->` marker. If not, offer to append the JSDoc standards snippet from `~/.codebase-guardian/source/templates/claude-md-snippet.md`.

3. **Rebuild index** — If many functions were updated, offer to trigger a full index rebuild.

## Important Notes

- Be thorough — scan ALL source files, not just a sample
- When generating stubs, read the actual function body to produce accurate tags, don't guess from names alone
- Group stub generation by file to minimize edit operations
- Ask the user before applying stubs — show them first for approval
