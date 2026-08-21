# Codebase Guardian

Semantic code index + automated validation hooks for TypeScript codebases. Install once, works on any project you open in Claude Code.

Guardian indexes your codebase's functions, types, documentation, and call graph into a searchable SQLite database backed by FTS5 keyword search and vector embeddings. A PreToolUse hook validates every edit for code quality — DRY enforcement, JSDoc completeness, pattern consistency, and README compliance — using headless Claude with the full semantic index as context.

## Why

Claude Code is exceptionally good at writing code — but it has no memory of what already exists in your codebase. Without enforcement, this leads to predictable problems:

- **Duplicate code everywhere.** Claude writes a new `formatCurrency()` function because it doesn't know you already have one in `utils/formatting.ts`. Multiply this across hundreds of edits and your codebase fills with redundant implementations that diverge over time.
- **Documentation rot.** Claude modifies a function's behavior but doesn't update the JSDoc. Or it creates new functions with no documentation at all. The codebase becomes progressively harder to understand — for both humans and AI.
- **Pattern drift.** Your `controllers/` directory follows a specific pattern, documented in its README. Claude doesn't read the README before writing a new controller, so it invents its own approach. Now you have two patterns where you should have one.
- **Invisible blast radius.** Claude changes a utility function's signature without knowing that 15 other functions depend on it. The change compiles but breaks assumptions downstream.

These aren't hypothetical — they're the actual failure modes observed during months of daily Claude Code usage on a production codebase. Traditional code review catches them, but only after the code is already written and committed. By then, the duplicate has callers, the undocumented function has dependents, and cleaning up is 10x harder than preventing the problem.

Codebase Guardian solves this by **validating every edit at write-time**, before it lands. A semantic index gives the validator full context about what already exists, and headless Claude applies judgment about whether the edit is a legitimate new capability or a quality violation. Bad edits get blocked with specific, actionable feedback — and Claude sees that feedback and fixes the issues automatically.

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Code Session                                        │
│                                                             │
│  Developer asks Claude to edit code                         │
│       │                                                     │
│       ▼                                                     │
│  Edit/Write tool call                                       │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────────────────────────────────────┐                │
│  │  PreToolUse Hook (pre-edit-validation)  │                │
│  │                                         │                │
│  │  1. Extract functions from edit         │                │
│  │  2. Check JSDoc locally (fast)          │                │
│  │  3. Query code index for context:       │                │
│  │     - Similar existing functions (DRY)  │                │
│  │     - Directory patterns & README       │                │
│  │     - Callers (blast radius)            │                │
│  │     - Relevant project documentation    │                │
│  │     - Similar inline comments           │                │
│  │  4. Validate via headless Claude        │                │
│  │  5. Allow, deny, or allow with          │                │
│  │     non-blocking suggestions            │                │
│  └─────────────────────────────────────────┘                │
│       │                                                     │
│       ▼                                                     │
│  ┌──────────┐     ┌──────────────────────┐                  │
│  │ MCP Tools │────▶│  code-quality.db     │                  │
│  │ (search,  │     │  (SQLite + FTS5 +    │                  │
│  │  callers, │     │   vector embeddings) │                  │
│  │  impact)  │     └──────────────────────┘                  │
│  └──────────┘                                               │
└─────────────────────────────────────────────────────────────┘
```

## Installation

Codebase Guardian is a **Claude Code plugin**, installed from its self-hosted marketplace.

### Prerequisites

- **Node.js >= 18** on your `PATH` (the plugin builds its native engine on first use)
- **A C/C++ build toolchain** to compile `better-sqlite3`: Xcode Command Line Tools on macOS (`xcode-select --install`), or `build-essential` + `python3` on Linux
- **macOS or Linux** — the first-run bootstrap is a bash script; on Windows, run under WSL
- **Claude Code**

### Install

In Claude Code:

```
/plugin marketplace add armueller/codebase-guardian
/plugin install codebase-guardian@codebase-guardian
```

On the **first session after install**, the plugin builds its engine in the background: it installs ~550MB of native dependencies (`onnxruntime`, `better-sqlite3`) and compiles TypeScript into the plugin's data directory. This takes a few minutes and happens only once (and again after an update that changes dependencies). **Until it finishes, edits are allowed through unvalidated** — validation and the MCP tools activate automatically once the build completes.

After that, the guardian is active on **every project** you open in Claude Code. No per-project setup needed. Skills are available as `/codebase-guardian:audit`, `/codebase-guardian:hook-audit`, and `/codebase-guardian:review-suggestions`.

### Update

```
/plugin update codebase-guardian@codebase-guardian
```

### Uninstall

```
/plugin uninstall codebase-guardian@codebase-guardian
```

This removes the plugin, its hook, and its MCP server, along with the plugin's data directory (indexes, logs, built engine). Pass `--keep-data` to preserve it.

### Migrating from the old shell install

Earlier versions installed via `install.sh` — a user-level hook in `~/.claude/settings.json`, an MCP server registered with `claude mcp add`, skills copied into `~/.claude/skills/`, and data under `~/.codebase-guardian/`. If you're coming from that, do this once:

1. **Remove the shell install** so it doesn't double-register with the plugin (two hooks validating every edit, two MCP servers):
   ```bash
   # remove the guardian PreToolUse hook from ~/.claude/settings.json (back it up first)
   jq 'if .hooks.PreToolUse then .hooks.PreToolUse |= map(select(.hooks | all(.command | contains("codebase-guardian") | not))) else . end' \
     ~/.claude/settings.json > /tmp/s.json && mv /tmp/s.json ~/.claude/settings.json
   claude mcp remove codebase-guardian --scope user
   rm -rf ~/.claude/skills/audit ~/.claude/skills/hook-audit ~/.claude/skills/review-suggestions
   ```
2. **Install the plugin** (see [Install](#install) above).
3. **Re-index each project.** The plugin keeps its data in the plugin data directory (`${CLAUDE_PLUGIN_DATA}`), **not** `~/.codebase-guardian/`, so your old indexes are orphaned. Until a project is re-indexed there, the hook finds no index and **fails open (no validation)**. In each project you want guarded, ask Claude to run the **`rebuild_index`** MCP tool (or `npm run build-index`). Once you're satisfied, `~/.codebase-guardian/` can be deleted.

## Getting Started

### 1. Build the Index

Open any TypeScript project in Claude Code and use the MCP tool:

```
Use the rebuild_index tool to build the code index
```

The index also rebuilds automatically as you edit, and can be rebuilt any time by asking Claude to run the `rebuild_index` MCP tool (useful after a git merge or branch switch, which can leave the index stale).

The index scans your source files and documentation in two phases:

- **Phase 1:** Scans TypeScript files for JSDoc-annotated functions (Tier 1), and documentation files for structured docs (Tier 3). Generates vector embeddings for semantic search.
- **Phase 2:** Uses the TypeScript compiler API to discover exported functions not covered by JSDoc (Tier 2) and extracts the call graph (who calls what).

### 2. Make Edits

Once the index is built, every `Edit` and `Write` operation is automatically validated by the hook. The hook:

- **Allows** edits that pass all quality checks
- **Denies** edits with specific, actionable violation messages (Claude will see the feedback and fix the issues)
- **Allows with suggestions** when there are non-blocking improvement opportunities (logged to `.guardian/suggestions.md` in your project for later review)
- **Fails open** if the hook encounters an error or times out — your edits are never permanently blocked

### 3. Review Suggestions

Non-blocking suggestions accumulate in your project at `.guardian/suggestions.md`. Review them with:

```
/review-suggestions
```

## File Locations

### User-Level (shared across all projects)

Guardian stores its data in the plugin's persistent data dir, `${CLAUDE_PLUGIN_DATA}` — on disk, `~/.claude/plugins/data/codebase-guardian-codebase-guardian/`:

```
~/.claude/plugins/data/codebase-guardian-codebase-guardian/
├── app/                             # Built engine (dist/ + node_modules), rebuilt by the SessionStart bootstrap
├── indexes/{project-hash}/          # Per-project SQLite databases
│   └── code-quality.db             #   FTS5 + vector embeddings + call graph
├── logs/{project-hash}/             # Per-project validation logs
│   └── validation-debug.log        #   Every hook invocation with timing
├── metrics.db                       # Durable cross-project decision metrics
├── .build-stamp                     # Marks a successful engine build
└── projects.json                    # Maps project hashes to names/paths
```

The plugin's own files (manifest, `hooks/`, `skills/`, `scripts/`) install read-only under `~/.claude/plugins/cache/{marketplace}/codebase-guardian/{version}/`. Hooks and the MCP server are registered by the plugin itself (`hooks/hooks.json`, `.mcp.json`) — not in `~/.claude/settings.json` or `~/.claude.json`.

### Per-Project (in your repo)

```
your-project/
├── .guardian/
│   └── suggestions.md               # Non-blocking suggestions from the validation hook
└── guardian.config.json              # Optional per-project configuration overrides
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `search` | Hybrid keyword (40%) + semantic (60%) search across functions, types, and documentation |
| `callers` | Find all direct callers of a function (reverse call graph) |
| `callees` | Find all direct dependencies of a function (forward call graph) |
| `impact` | Analyze blast radius — BFS traversal up the caller graph to find all affected functions |
| `index_status` | Index health: function counts by tier, domain/tag/layer counts, stale file count |
| `rebuild_index` | Full re-scan of source files, documentation, call graph, and embeddings |
| `list_domains` | List all business domains with function counts |
| `list_tags` | List tags with usage counts, optionally filtered by domain |
| `list_systemlayers` | List architectural layers (Business Logic, UI Helper, Data Layer, etc.) |
| `search_comments` | FTS5 search over inline comments within function bodies |
| `search_doc_sections` | FTS5 search over documentation sections by heading |
| `metrics` | Report the guardian's durable allow/deny metrics (rates, outcomes, deny categories, per-project, timing) over an optional window/project |

### The Three Index Tiers

1. **Tier 1 (JSDoc)** — Functions with complete JSDoc annotations. Highest quality: name, description, domains, tags, system layers, side effects, call signatures. This is what the validation hook enforces.
2. **Tier 2 (Exports)** — Exported functions discovered by the TypeScript compiler but lacking JSDoc. Minimal metadata (name + file path). The `/audit` skill identifies these as coverage gaps.
3. **Tier 3 (Documentation)** — Markdown files (READMEs, architecture docs, pattern guides) parsed into heading-level sections for granular search.

## Skills (Slash Commands)

| Command | Description |
|---------|-------------|
| `/audit` | Scan the codebase for JSDoc coverage — reports coverage %, per-directory breakdown, top gaps. Offers to generate JSDoc stubs. |
| `/hook-audit` | Analyze validation hook performance — allow/deny/error rates, timing distributions, false positive detection. |
| `/review-suggestions` | Review and apply accumulated non-blocking suggestions from `.guardian/suggestions.md`. |
| `/pr-audit <PR#>` | Comprehensive pre-merge PR audit — Guardian-driven duplicate/impact/doc/pattern analysis plus your project's own checklists, run by a fresh subagent and posted as a marker comment. Tailor it per project — see [PR Audit Setup](#pr-audit-setup). |

## Validation Hook

The PreToolUse hook fires on every `Edit` and `Write` operation. It skips non-source files (markdown, JSON, config, test files, etc.) and validates TypeScript source changes.

### What It Checks (in priority order)

#### 1. DRY — Don't Repeat Yourself (PRIMARY)

The most important check. The semantic code index exists specifically to prevent duplicate code.

- Searches FTS5 for functions with similar names/descriptions
- Compares inline comments against the comment index for step-level duplication
- If an existing function does the same thing → **hard deny** with a specific recommendation ("Use `existingFunc()` from `path/to/file.ts` instead")

#### 2. JSDoc Completeness (CRITICAL)

Every function must have complete JSDoc. See [JSDoc Standards](#jsdoc-standards) below for the full tag specification.

- Functions missing JSDoc entirely → **hard deny**
- Functions with incomplete JSDoc (missing required tags) → **hard deny**
- Types/interfaces/enums missing at least `@what` → **hard deny**

#### 3. JSDoc Accuracy (CRITICAL for modified functions)

Stale documentation is worse than no documentation. When a function is modified:

- `@what` must describe what the code does now, not what it used to do
- `@param` tags must match current parameter names and types
- `@returns` must match the current return type
- `@sideeffects` must reflect current side effects

#### 4. Inline Comment Quality (IMPORTANT)

Inline comments are indexed for sub-function-level DRY detection. They must be descriptive enough for search:

- Comments under 20 characters describing nothing useful → **deny** (e.g., `// Parse JSON`, `// Update`)
- Good: `// Parse decompressed string as typed JSON object`
- Section headers and end-of-line clarifications are more lenient

#### 5. Pattern Consistency (IMPORTANT)

New code should follow conventions established in its directory:

- Naming conventions (camelCase functions in a camelCase directory)
- Domain coherence (a trading helper shouldn't have `@domain "authentication"`)
- System layer alignment (a UI helper in a data layer directory)
- Side effect profile (introducing side effects in a pure-function directory)

#### 6. README Compliance (IMPORTANT)

If the directory has a README indexed in Tier 3, edits must follow its documented rules. Additionally, project-wide documentation (best practices, pattern guides) matched by domain/tag overlap is surfaced to the validator.

#### 7. Blast Radius Awareness (INFORMATIONAL)

For modified functions, the hook surfaces callers from the call graph. This is informational — it only denies if the change clearly breaks callers (signature changes, removed exports).

### Session Continuity

When the hook denies an edit, it stores the headless Claude session ID. On the next attempt for the same file, it resumes the session with `--resume` — the validator already has full context from the previous attempt and only needs the updated code. This makes retries faster and more accurate.

### Fail-Open Design

The hook is designed to never permanently block work:

- If the code index database doesn't exist → **allow** (fail-open)
- If headless Claude times out (120s) → **allow** (fail-open)
- If any error occurs during validation → **allow** (fail-open)
- If the edit is a duplicate resubmission after denial → **deny** instantly (cached, no AI call)

## JSDoc Standards

Every exported function must have complete JSDoc with ALL of these tags:

```typescript
/**
 * @what Brief description of what the function does
 * @how Technical details of how it accomplishes the task
 * @why Business/architectural reason why this function exists
 *
 * @param {type} name Description of each parameter
 * @returns {type} Description of return value (required even for void)
 *
 * @sideeffects "None" if pure, or list side effects (API calls, state mutations, DB writes, file I/O)
 * @systemlayer One of: UI Helper, Business Logic, Data Layer, API, Validation, Utility, Controller, Model, etc.
 * @domain Business domain(s), comma-separated (e.g., "options-trading, calculations")
 * @tags Minimum 3 comma-separated searchable keywords (5 preferred for discoverability)
 */
```

### Example

```typescript
/**
 * @what Calculates the weighted average cost basis across all tax lots
 * @how Divides total invested capital by total shares, applying wash sale adjustments
 *   for lots flagged by the wash sale detection algorithm
 * @why Required for accurate P&L reporting and tax lot accounting — the cost basis
 *   determines realized gain/loss when positions are closed
 *
 * @param {TaxLot[]} lots Array of tax lots to average
 * @param {boolean} includeWashSales Whether to include wash sale adjustments
 * @returns {number} Weighted average cost basis per share
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain portfolio, cost-basis, tax-lots
 * @tags cost-basis, weighted-average, wash-sale, tax-lots, portfolio-calculation
 */
export function calculateWeightedCostBasis(
  lots: TaxLot[],
  includeWashSales: boolean
): number {
  // ...
}
```

### Types, Interfaces, and Enums

Types have relaxed requirements compared to functions:

- `@what` — **Required.** Brief description of what the type represents.
- `@domain` — Recommended for discoverability.
- `@tags` — Minimum 2 searchable keywords recommended.
- `@how`, `@why`, `@param`, `@returns`, `@sideeffects` — Not required for types.

### Inline Comments Best Practices

Inline comments within function bodies are indexed for step-level DRY detection. Write them so someone searching the comment index for a concept would find relevant matches:

- **Good:** `// Calculate fee-adjusted net proceeds by subtracting platform and exchange fees from gross`
- **Good:** `// Group options contracts by underlying ticker for consolidated P&L display`
- **Bad:** `// Calculate` (too short, not searchable)
- **Bad:** `// Loop through items` (describes syntax, not intent)
- **OK:** `// --- Revenue Calculations ---` (section headers are organizational, treated leniently)
- **OK:** `const rate = 0.005; // 0.5% per transaction` (end-of-line clarifications are fine)

## Configuration

### Per-Project Config (optional)

Create `guardian.config.json` at your project root to override auto-detection:

```json
{
  "sourceDirectories": ["src", "lib"],
  "docsDirectories": ["docs"],
  "excludeDirectories": ["node_modules", "dist", "build", ".next", "coverage"],
  "fileExtensions": [".ts", ".tsx", ".py"],
  "jsdoc": {
    "requiredTags": ["what", "how", "why", "sideeffects", "systemlayer", "domain", "tags"],
    "minTags": 3,
    "minCommentLength": 5
  }
}
```

All fields are optional. Without a config file, Guardian auto-detects:

- **Source directories** from `tsconfig.json` `include` patterns, falling back to `src/`, `app/`, `lib/`
- **Docs directories** by checking for `docs/`, `doc/`, `documentation/`
- **Project root** via `git rev-parse --show-toplevel`
- **Project name** from `package.json`

> **Mixed TypeScript + Python repos:** source-directory auto-detection is driven by `tsconfig.json`, so Python packages living **outside** the TypeScript roots (e.g. an `ml/` directory) are not scanned automatically. Add them explicitly: `"sourceDirectories": ["app", "ml"]`. `.py` is enabled by default in `fileExtensions`; `.venv/`, `__pycache__/`, and Python test files are excluded/skipped for you.

### PR Audit Setup

The `/pr-audit` skill runs a comprehensive, language-agnostic pre-merge audit of a PR — duplicate detection, blast-radius/impact analysis, documentation alignment, pattern compliance, and staff-level synthesis, all driven by the Guardian index — and dispatches a **fresh subagent** to do it (no implementation memory to short-circuit the checks). It works out of the box with defaults; two optional **committed** files under `.guardian/` tailor it to your project.

**`.guardian/pr-audit.config.json`** — structured knobs the audit reads:

```json
{
  "version": 1,
  "baseline": { "typecheck": "npx tsc --noEmit", "lint": null, "test": "npm test" },
  "docDirs": ["docs"],
  "staffReview": { "minDiffLinesForFullPass": 100 },
  "impact": { "depth": 2 },
  "suggestionStaging": { "filePath": ".guardian/suggestions.md", "clearAfterAudit": true },
  "marker": { "commentMarker": "<!-- pr-audit:v1 -->", "ciCheckJob": null },
  "deferredBugProtocol": { "require": true, "tracker": { "type": "github", "repo": "owner/repo" } },
  "plan": { "vaultDir": "~/path/to/implementation/plans" },
  "checklistsFile": ".guardian/pr-audit.checklists.md"
}
```

- **`baseline`** — commands the audit runs to *empirically* verify the PR (it never trusts the PR description's claims about type-check/lint/tests). Set any to `null` to skip it.
- **`docDirs`** — where your architecture/pattern/best-practice docs live (used for documentation-alignment checks against changed code).
- **`marker.ciCheckJob`** — name of an optional CI job that enforces the marker comment's presence; leave `null` if you don't have one. The comment is always posted regardless.
- **`deferredBugProtocol.tracker`** — where a deferred 🔴 BUG gets filed. `{ "type": "github", "repo": "owner/repo" }` files via `gh issue create`; `{ "type": "jira", "projectPrefix": "ABC", "urlTemplate": "https://you.atlassian.net/browse/{key}" }` files via `acli`. Omit the whole `deferredBugProtocol` block to skip tracker enforcement. The legacy `{ "requireGitHubIssue": true, "repo": "..." }` shape is still honored.
- **`plan.vaultDir`** — where implementation plans live (for plan-vs-code cross-reference); omit to skip that phase. Use a repo-relative path if plans are committed (`docs/plans`). If your plans live in a personal notes vault, that is a *per-developer* setting — put it in `pr-audit.local.json` instead, or you will point the whole team at your home directory.

All fields are optional — omit the file entirely to run with defaults.

**`.guardian/pr-audit.checklists.md`** — free-form prose domain checks the audit runs against your diff (project invariants, business rules, per-area checklists). Each item states the severity to assign on failure; findings still require concrete evidence. See this repo's own [`.guardian/pr-audit.checklists.md`](.guardian/pr-audit.checklists.md) for a worked example — it encodes Guardian's own fail-open / hook-output / boundary invariants as auditable items.

**Commit both files.** Guardian ignores runtime output under `.guardian/` but whitelists the committed config — mirror this in your `.gitignore`:

```gitignore
.guardian/*
!.guardian/pr-audit.config.json
!.guardian/pr-audit.checklists.md
!.guardian/pr-walkthrough.config.json
!.guardian/pr-walkthrough.checklists.md
```

> **The trailing `/*` matters.** Ignoring `.guardian` (no slash) excludes the *directory*, and git will not descend into an excluded directory — so the `!` negations below it can never take effect and your shared config silently stays untracked. If your project already has a bare `.guardian` rule, this is the fix.

**Run it:** `/pr-audit <PR#>` (or `/pr-audit` for the current branch's PR). The skill rebuilds the index if indexed files changed, dispatches the audit subagent through all phases, and posts (and later updates) a marker comment on the PR. It is language-agnostic — the same skill audits TypeScript and Python PRs, reasoning about documentation via Guardian's normalized metadata rather than language-specific tags.

### PR Walkthrough Setup

`/pr-audit` produces findings. `/pr-walkthrough` produces **understanding** — it is a companion for the human reviewer, not a second audit.

It exists because PRs have grown large and increasingly machine-authored, which makes them hard to hold in your head. An audit hands you a verdict to trust or re-derive; that is not review. The walkthrough pins the true before-state, proves which files are mechanical churn and which carry behavior, slices the diff into vertical behaviors, and walks you through each one — real code, full control flow, one slice at a time — then drafts and posts your review.

Unlike `/pr-audit`, it runs **inline** rather than in a subagent: the dialogue with you is the deliverable, and a subagent cannot be interrupted or argued with. Subagents are used only for the read-only classification fan-out.

Two optional committed files tailor it, same pattern as the audit:

- **`.guardian/pr-walkthrough.config.json`** — prior-artifact markers to ingest and adjudicate (so it does not re-derive your audit's findings), doc dirs, issue tracker, checklists path. See [`templates/pr-walkthrough.config.json`](templates/pr-walkthrough.config.json).
- **`.guardian/pr-walkthrough.checklists.md`** — stack-specific blind-spot checks. The skill ships a generic taxonomy of what each *kind* of change tends to hide (renames hide referential problems, extractions hide widened preconditions, permission bypasses hide compound effects); this file holds your stack's concrete instantiations.

### Committed config vs per-developer overrides

Both skills read an optional **`*.local.json`** beside the committed config, shallow-merged over it and never committed — it falls under the project's normal `.guardian/*` ignore rule.

**The committed file describes the project. The local file describes the developer.** Where you keep your review notes, or your implementation plans, is not a project decision: a committed value silently points the whole team at one person's home directory. See [`templates/pr-walkthrough.local.example.json`](templates/pr-walkthrough.local.example.json).

| Setting | Belongs in |
| --- | --- |
| `priorArtifacts`, `docDirs`, `checklistsFile`, `issueTracker`, `baseline`, `marker` | committed config |
| `recordDestination`, `notesPath` | `pr-walkthrough.local.json` |
| `plan.vaultDir` | committed if plans are in-repo; `pr-audit.local.json` if they live in a personal vault |

Both skills flag a personal-looking path found in a committed config, and neither guesses a destination when none is set.

**Run it:** `/pr-walkthrough <PR#>`.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GUARDIAN_PROJECT_ROOT` | Override project root detection | Auto-detected from git |
| `GUARDIAN_HOME` | Override the data directory (indexes/logs) | Plugin data dir (`${CLAUDE_PLUGIN_DATA}`) when installed as a plugin, else `~/.codebase-guardian/` |

## Multi-Project Support

Guardian automatically detects which project you're working in and uses a separate database for each. Project detection uses the git root of the file being edited, so it handles submodules and monorepos correctly.

```
~/.claude/plugins/data/codebase-guardian-codebase-guardian/
├── indexes/
│   ├── a3f2b1c8d9e0/code-quality.db    # Project A
│   └── f7c4e2a1b3d5/code-quality.db    # Project B
├── logs/
│   ├── a3f2b1c8d9e0/validation-debug.log
│   └── f7c4e2a1b3d5/validation-debug.log
└── projects.json                        # Hash → name/path mapping
```

## Updating

```
/plugin update codebase-guardian@codebase-guardian
```

Claude Code pulls the latest version. If the update changes dependencies (`package.json`), the plugin's `SessionStart` bootstrap rebuilds the engine automatically on the next session. Per-project indexes and logs are preserved.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full system design.

### Key Components

| Component | Location | Description |
|-----------|----------|-------------|
| MCP Server | `src/mcp-server/` | Semantic index with hybrid FTS5 + vector search, call graph analysis |
| Validation Hook | `src/hooks/` | PreToolUse hook — extracts functions, queries index, validates via headless Claude |
| Config System | `src/config.ts` | Auto-detection of project root, source dirs, paths. Cached per project root. |
| Shared Utilities | `src/shared/` | CJS modules for cross-ESM/CJS boundary imports |
| Skills | `skills/` | Claude Code slash commands for auditing and review |
| Templates | `templates/` | Per-project config template and CLAUDE.md JSDoc standards snippet |
