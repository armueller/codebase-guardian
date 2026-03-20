# Hook Integration

The code index powers an automated code quality enforcement system via Claude Code's PreToolUse hook mechanism. Every Edit/Write operation is intercepted, analyzed against the code index, and validated by a headless Claude session before being applied.

## Hook Configuration

Defined in `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "tsx src/hooks/pre-edit-validation-ai.ts",
            "timeout": 60000
          }
        ]
      }
    ]
  }
}
```

Environment variables passed to the hook:
- `CODE_INDEX_DB`: Path to `code-quality.db`
- `CLAUDE_WORKING_DIR`: Repository root path

## Validation Flow

### 1. Skip Check

The hook immediately allows (exit 0) edits to files that don't need validation:

- `.md` files (documentation)
- `.test.ts` / `.test.tsx` files (tests)
- `.json` files (configuration)
- `.env*` files (environment)
- Files under `src/hooks/` (hook code itself)
- Files under `cdk/` (infrastructure)
- Files under `node_modules/`

### 2. Function Extraction

From the edit diff (`old_string` → `new_string`), the hook extracts:

- **Modified functions**: Functions present in both old and new, with changes
- **Created functions**: Functions in new code not present in old
- **Called functions**: Function names referenced in the new code
- **Types/interfaces**: Type declarations in the new code

### 3. Local JSDoc Validation

Before invoking the AI, a fast local check validates JSDoc completeness:

- All required tags present (`@what`, `@how`, `@why`, `@param`, `@returns`, `@sideeffects`, `@systemlayer`, `@domain`, `@tags`)
- Minimum 3 tags
- No empty tag values

Issues found here are passed to the AI validator as pre-identified problems, reducing AI analysis time.

### 4. Cache Check

A validation cache (`validation-cache.ts`) stores results keyed by a hash of:
- File path
- New content
- Functions extracted

If an identical edit was validated within the last 5 minutes, the cached result is returned immediately (no AI call).

### 5. Pattern Context Building

The code index client (`code-index-client.ts`) queries the SQLite database directly to build a `PatternContext`:

| Context Element | Source | Purpose |
|----------------|--------|---------|
| Directory README | File read | Check for directory-specific rules |
| Sibling functions | `functions` table filtered by directory | Pattern consistency |
| Called function details | `functions` table by name | Verify called functions exist and are used correctly |
| Callers of modified functions | `call_edges` table | Blast radius awareness |
| FTS similarity matches | `functions_fts` MATCH query | DRY enforcement (function-level) |
| Comment similarity matches | `comments_fts` MATCH query | DRY enforcement (sub-function-level) |
| Relevant documentation | `functions` + `doc_sections` tables | Best practice enforcement |

This step executes approximately 200 SQLite queries in under 100ms (all read-only against the WAL-mode database).

### 6. Headless Claude Execution

The assembled context is sent to a headless Claude session for AI-powered judgment.

#### First Attempt

A new Claude CLI session is spawned with:
- **System prompt**: Detailed rules for DRY, JSDoc, pattern consistency, inline comment quality, README compliance, and blast radius awareness
- **User prompt**: The full context (edit details, extracted functions, JSDoc issues, similar functions, caller info, documentation)
- **Model**: `opus`
- **Permissions**: `bypassPermissions`
- **Output format**: JSON

The session ID is stored in `validation-sessions.ts` keyed by file path.

#### Resume (Retry After Denial)

If the developer fixes issues and retries, the hook:
1. Looks up the session ID for the file path
2. Sends only the updated code via `--resume`
3. The resumed Claude session has full context from the first attempt

This significantly reduces latency on retries (~5s vs ~15s).

### 7. Decision Parsing

The AI response is parsed as JSON:

```json
{
  "decision": "allow" | "deny",
  "reasoning": "Brief explanation of the decision",
  "violations": [
    {
      "rule": "DRY" | "JSDoc" | "Pattern" | "InlineComment" | "README" | "BlastRadius",
      "severity": "error" | "warning",
      "message": "Description of the violation",
      "suggestion": "How to fix it"
    }
  ]
}
```

- **Allow**: Exit 0, cache the result
- **Deny**: Exit 2, return violations as user-facing feedback

## What Gets Enforced

### 1. DRY — Don't Repeat Yourself (Primary)

The system searches for existing functions that do the same thing:

- **Function-level**: FTS5 search using camelCase-split function names
- **Sub-function-level**: Inline comment similarity matching

If a new function duplicates existing functionality, the violation message references the existing function(s) that should be reused instead.

### 2. JSDoc Completeness

All functions must have complete JSDoc with every required tag. Missing tags are identified by local validation and confirmed by the AI.

### 3. JSDoc Accuracy

The AI checks that JSDoc descriptions match the actual implementation. Stale or misleading documentation is flagged.

### 4. Inline Comment Quality

Comments must be descriptive enough for the code index to use them for DRY detection:

- **Violations**: Vague section headers (`// Assets`), short useless comments (`// Update`)
- **Not violations**: Short end-of-line clarifications (`// in cents`), eslint directives

Minimum threshold: 20 characters for standalone comments.

### 5. Pattern Consistency

Code should follow naming, domain, and architectural conventions established in its directory. The AI compares against sibling functions in the same directory.

### 6. README Compliance

If the directory has a README.md, code should follow any rules documented there.

### 7. Blast Radius Awareness

When modifying a function with callers, the AI considers whether the change could break dependents.

## Session Management

### Session Store

File: `src/hooks/.validation-sessions.json`

Maps `filePath` → `{ sessionId, timestamp }` with a 1-hour TTL. Expired sessions are cleaned up on each validation run.

### Validation Cache

File: `src/hooks/.validation-cache.json`

Maps `cacheKey` (hash of file + content + functions) → `{ result, timestamp }` with a 5-minute TTL.

## Fail-Open Design

Every error path in the hook system allows the edit:

- Database missing → allow
- Database locked → allow
- SQLite query error → allow
- Headless Claude timeout → allow
- JSON parse error → allow
- Unexpected exception → allow

This ensures the hook never blocks development even when something goes wrong. Debug logs are written to `validation-debug.log` for post-hoc analysis.

## Performance Characteristics

| Phase | Typical Latency |
|-------|----------------|
| Skip check | < 1ms |
| Function extraction | 5-20ms |
| Local JSDoc validation | 1-5ms |
| Cache lookup | 1-2ms |
| Pattern context building | 50-100ms (200 SQLite queries) |
| Headless Claude (first attempt) | 10-20s |
| Headless Claude (resume) | 3-8s |
| **Total (first attempt)** | **10-20s** |
| **Total (cache hit)** | **< 10ms** |
| **Total (resume)** | **3-8s** |

## Debugging

Debug logs are written to `src/hooks/validation-debug.log`. Each entry includes:

- Timestamp
- Hook input summary
- Skip decision reasoning
- Functions extracted
- JSDoc issues found
- Pattern context summary
- Headless Claude raw output
- Final decision with reasoning

To analyze validation behavior:

```bash
# Recent validations
tail -100 src/hooks/validation-debug.log

# Find denials
grep "DENY" src/hooks/validation-debug.log

# Find specific file validations
grep "dashboard.options-search" src/hooks/validation-debug.log
```
