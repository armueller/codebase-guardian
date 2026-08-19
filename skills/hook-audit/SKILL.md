---
name: hook-audit
description: Audit validation hook performance — analyze allow/deny decisions, timing, and false positives
trigger: /hook-audit, "audit hook performance", "check validation logs", "hook stats"
---

# Validation Hook Performance Audit

You are analyzing the Codebase Guardian validation hook's performance for this project.

## Step 1: Locate the Log File

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | shasum -a 256 | cut -c1-12)
# Guardian's data now lives in the plugin's data dir. Prefer an explicit override,
# then ${CLAUDE_PLUGIN_DATA} (substituted here when installed as a plugin, or read
# from the environment), then the deterministic plugin data path as a guaranteed fallback.
GUARDIAN_HOME="${GUARDIAN_HOME:-${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/codebase-guardian-codebase-guardian}}"
LOG_PATH="$GUARDIAN_HOME/logs/$PROJECT_HASH/validation-debug.log"
```

If the log file doesn't exist, inform the user:
```
No validation logs found for this project. The hook hasn't run yet, or logs have been cleared.
```

If there's also a `.old` rotated log, read both (current + rotated) for a fuller picture.

## Step 2: Parse Log Entries

Each hook invocation starts with `=== {timestamp} ===` and contains structured entries:

**Key patterns to extract:**
- `ALLOW: {reason}` — Edit was allowed
- `DENY: {reason}` — Edit was blocked
- `ERROR: {message}` — Hook encountered an error
- `[TIMING] TOTAL VALIDATION TIME: {N}ms` — Total time per validation
- `[TIMING] Headless Claude execution: {N}ms` — AI validation time
- `[TIMING] Build pattern context: {N}ms` — Code index query time
- `[TIMING] Cache hit` / `[TIMING] Cache miss` — Cache effectiveness
- `[SESSION] Retry attempt` — Developer is retrying after denial
- `[SESSION] Identical resubmission` — Developer resubmitted without changes
- `[SESSION] File content changed since last denial` — Stale session cleared
- `Decision: allow` / `Decision: deny` — Headless Claude's decision
- `Violations:` — What violations were found

## Step 3: Generate Report

```
## Codebase Guardian — Hook Performance Audit

**Project:** {project name}
**Log period:** {first timestamp} to {last timestamp}
**Total validations:** {N}

### Decision Summary

| Decision | Count | Percentage |
|----------|-------|------------|
| Allow | X | XX% |
| Deny | X | XX% |
| Error (fail-open) | X | XX% |
| Cache hit (skipped) | X | XX% |
| Timeout (fail-open) | X | XX% |

### Timing Distribution

| Metric | p50 | p90 | p99 | Max |
|--------|-----|-----|-----|-----|
| Total validation | Xms | Xms | Xms | Xms |
| Headless Claude | Xms | Xms | Xms | Xms |
| Pattern context | Xms | Xms | Xms | Xms |

### Session Analysis

- Retry attempts: {N} (developer revised and resubmitted)
- Identical resubmissions: {N} (developer resubmitted without changes — wasted time)
- Stale sessions cleared: {N} (file changed between retries)
- Average attempts before allow: {N}

### Denial Analysis

**Most common violation types:**
1. Missing JSDoc — {N} occurrences
2. DRY violation — {N} occurrences
3. Pattern mismatch — {N} occurrences
4. Inline comment quality — {N} occurrences

**Files most frequently denied:**
1. `path/to/file.ts` — {N} denials
2. ...

### Potential False Positives

Look for patterns that suggest the hook is being too aggressive:
- Functions denied multiple times for the same file in the same session (developer struggling to satisfy the hook)
- Denials followed immediately by identical resubmissions (developer may not understand the violation)
- Denials where the violation text is vague or unhelpful

List any suspicious patterns found.

### Improvement Recommendations

Based on the analysis, suggest:
- If too many timeouts: consider increasing timeout or reducing context size
- If too many false positives: identify which rules are triggering incorrectly
- If cache hit rate is low: check if edits are highly varied or cache TTL is too short
- If retry rate is high: check if violation messages are actionable enough
```

## Step 4: Offer Actions

1. **Clear old logs** — Offer to remove the rotated `.old` log if it's stale
2. **Adjust hook configuration** — If patterns suggest config changes (timeout, enforcement mode)
3. **Report false positives** — Help the user file specific false positive examples for future tuning

## Important Notes

- Parse the ENTIRE log file, not just a sample
- Timing percentiles should be calculated from actual data, not estimated
- Be specific about false positive candidates — include the actual violation text and the code that was denied
- If the log is very large (>10MB), focus on the most recent 1000 validations and note the sampling
