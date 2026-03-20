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

### Prerequisites

- **Node.js >= 18** (for the MCP server and build tooling)
- **Claude Code CLI** (`claude` command available in PATH)
- **jq** (optional but recommended — used to merge hook config into `settings.json`)

### Install

```bash
git clone https://github.com/armueller/codebase-guardian.git
cd codebase-guardian
./install.sh
```

The install script does the following:

1. Creates `~/.codebase-guardian/` with subdirectories for indexes and logs
2. Copies the source to `~/.codebase-guardian/source/`
3. Runs `npm install` and `npm run build` (compiles TypeScript)
4. Registers a **user-level MCP server** (`codebase-guardian`) via `claude mcp add --scope user`
5. Registers a **user-level PreToolUse hook** for `Edit|Write` operations in `~/.claude/settings.json`
6. Installs skills (`/audit`, `/hook-audit`, `/review-suggestions`) to `~/.claude/skills/`
7. Records the version in `~/.codebase-guardian/.version`

After install, the guardian is active on **every project** you open in Claude Code. No per-project setup needed.

### Uninstall

```bash
cd /path/to/codebase-guardian
./install.sh --uninstall
```

This removes the MCP server registration, the PreToolUse hook from settings.json, and the installed skills. It will ask before deleting `~/.codebase-guardian/` (which contains per-project indexes).

## Getting Started

### 1. Build the Index

Open any TypeScript project in Claude Code and use the MCP tool:

```
Use the rebuild_index tool to build the code index
```

Or from the command line:

```bash
cd /your/project
node ~/.codebase-guardian/source/dist/mcp-server/build-index.js
```

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

```
~/.codebase-guardian/
├── source/                          # Installed source code + node_modules + dist
├── indexes/{project-hash}/          # Per-project SQLite databases
│   └── code-quality.db             #   FTS5 + vector embeddings + call graph
├── logs/{project-hash}/             # Per-project validation logs
│   └── validation-debug.log        #   Every hook invocation with timing
├── projects.json                    # Maps project hashes to names/paths
└── .version                         # Installed version

~/.claude/settings.json              # PreToolUse hook registration
~/.claude.json                       # MCP server registration
~/.claude/skills/                    # Installed skills (audit, hook-audit, review-suggestions)
```

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
  "fileExtensions": [".ts", ".tsx"],
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

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GUARDIAN_PROJECT_ROOT` | Override project root detection | Auto-detected from git |
| `GUARDIAN_HOME` | Override install directory | `~/.codebase-guardian/` |

## Multi-Project Support

Guardian automatically detects which project you're working in and uses a separate database for each. Project detection uses the git root of the file being edited, so it handles submodules and monorepos correctly.

```
~/.codebase-guardian/
├── indexes/
│   ├── a3f2b1c8d9e0/code-quality.db    # Project A
│   └── f7c4e2a1b3d5/code-quality.db    # Project B
├── logs/
│   ├── a3f2b1c8d9e0/validation-debug.log
│   └── f7c4e2a1b3d5/validation-debug.log
└── projects.json                        # Hash → name/path mapping
```

## Updating

```bash
cd /path/to/codebase-guardian
git pull
./update.sh
```

The update script:

1. Pulls latest changes (if in a git repo)
2. Syncs source files to `~/.codebase-guardian/source/`
3. Reinstalls dependencies and rebuilds TypeScript
4. Updates skills in `~/.claude/skills/`
5. Preserves all per-project indexes, logs, and data

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
