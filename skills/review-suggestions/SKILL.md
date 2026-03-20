---
name: review-suggestions
description: Review and apply accumulated non-blocking suggestions from the validation hook
trigger: /review-suggestions, "check suggestions", "apply suggestions", "review hook suggestions"
---

# Review Accumulated Suggestions

You are reviewing non-blocking suggestions that the Codebase Guardian validation hook has accumulated for this project. These are improvements the hook noticed but didn't block for — soft recommendations rather than hard violations.

## Step 1: Locate the Suggestions File

The suggestions file lives in the project repo at `.guardian/suggestions.md`:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SUGGESTIONS_PATH="$PROJECT_ROOT/.guardian/suggestions.md"
```

If the file doesn't exist or is empty, inform the user:
```
No pending suggestions for this project. The validation hook hasn't logged any non-blocking recommendations yet.
```

## Step 2: Read and Parse Suggestions

The suggestions file is markdown with this structure:

```markdown
## Session: {session-id} — {date}

- **File:** `path/to/file.ts` | **Function:** `functionName`
  **Suggestion:** Consider extracting the date formatting logic into a shared helper — similar logic exists in `formatTimestamp()` at `utils/dates.ts:45`

- **File:** `path/to/other.ts` | **Function:** `processOrder`
  **Suggestion:** The @tags list could include "order-processing" for better discoverability — sibling functions use this tag
```

## Step 3: Present Suggestions

Group suggestions by file and present them:

```
## Pending Suggestions ({N} total)

### `src/controllers/orders.ts` (3 suggestions)

1. **`processOrder`** — Consider extracting the date formatting logic into a shared helper — similar logic exists in `formatTimestamp()` at `utils/dates.ts:45`

2. **`validateOrder`** — The @tags list could include "order-validation" for better discoverability

3. **`submitOrder`** — Inline comment "// submit" is too short to be useful for search — consider "// Submit order to exchange API with retry logic"

### `src/helpers/calc.ts` (1 suggestion)

1. **`calculateFees`** — @sideeffects says "None" but the function reads from a config cache that could be stale
```

## Step 4: Offer Actions

For each suggestion (or in batch), offer:

1. **Apply** — Make the suggested change. Read the actual file first to verify the suggestion is still relevant (the code may have changed since the suggestion was logged).

2. **Dismiss** — Mark the suggestion as reviewed and remove it from the file.

3. **Apply all** — Apply all suggestions that are still relevant. Check each file first.

4. **Clear all** — Dismiss all suggestions without applying.

After processing, update the suggestions file to remove handled items.

## Important Notes

- Always read the current file before applying a suggestion — the code may have changed
- If a suggestion references a function that no longer exists, dismiss it automatically
- Group "apply" operations by file to minimize edits
- Ask for user confirmation before applying, showing the proposed change
- After applying suggestions, offer to rebuild the index if JSDoc was updated
