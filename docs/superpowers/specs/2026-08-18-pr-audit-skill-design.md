# PR Audit Skill — Plugin-Owned + Project Extensions (Design)

**Date:** 2026-08-18
**Status:** Approved (brainstorming), pending implementation
**Author:** Austin Mueller (with Claude)

## Goal

Move the `pr-audit` capability — a comprehensive, Guardian-driven pre-merge PR audit — out of a single project (RMWM) and into the **codebase-guardian plugin**, so every Guardian-enabled project gets it. Provide a clean, additive **extension mechanism** so each project supplies only its own semantics (baseline commands, doc layout, domain checklists) without forking the skill.

## Motivation

The audit leans almost entirely on Guardian's MCP tools (`search`, `callers`, `callees`, `impact`, `search_doc_sections`, `search_comments`, suggestion staging). It is fundamentally a Guardian capability that happens to live in RMWM today. Packaging it in the plugin makes it reusable (e.g. auditing codebase-guardian's own PRs, and — now that Guardian indexes Python — RMWM's Python PR #151). The current RMWM skill hardcodes RMWM specifics (TS/JSDoc tags, `app/` layout, DynamoDB/Redux/CDK checklists, `docs/{architecture,patterns,best-practices}`, the vault plan dir, the deferred-bug repo), so a naive copy would not generalize.

## Key constraint (drives the whole design)

A **project-local skill named `pr-audit` would shadow the plugin's** `pr-audit` (Claude Code resolves same-named skills most-specific-wins). Therefore the project extension **must be data, not a competing skill**. The plugin owns the single `pr-audit` skill; projects contribute config + checklist files the skill discovers and loads at runtime.

## Architecture

- **`skills/pr-audit/SKILL.md`** ships in the plugin (auto-discovered like `audit`/`hook-audit`; `build.sh` already syncs `skills/`). Available in every Guardian-enabled project.
- Each project drops **two committed files** under `.guardian/`:
  - **`.guardian/pr-audit.config.json`** — structured knobs the skill's control flow reads.
  - **`.guardian/pr-audit.checklists.md`** — free-form prose domain checks injected verbatim into the audit subagent's instructions.
- The skill runs **with no extension** too: generic phases only, with baked-in defaults. The extension is purely additive.
- **`.gitignore`** narrows from `.guardian/` (whole dir) to a whitelist so config is committed while runtime output stays ignored:
  ```gitignore
  .guardian/*
  !.guardian/pr-audit.config.json
  !.guardian/pr-audit.checklists.md
  ```
  (Must be `.guardian/*`, not `.guardian/`, for the `!` un-ignore to take effect.)

### Split: generic (plugin) vs extension (project)

| Piece | Generic skill | Config-driven | checklists.md |
|---|---|---|---|
| Subagent-dispatch execution model + ultrathink framing + critical principles | ✅ | | |
| Phase 0 setup, Guardian index rebuild on indexed-file changes, diff scope, empirical baseline | ✅ | baseline cmds, plan dir | |
| Phase 1 doc-alignment · 2 duplicate · 3 impact · 4 suggestion-staging triage | ✅ (Guardian tools) | docDirs, impact.depth, staging path | |
| Phase 5 doc **completeness/accuracy** — language-agnostic, via Guardian's normalized `domains`/`tags`/`systemlayers` | ✅ | | convention specifics |
| Phase 6.1–6.2 directory-README + domain/side-effect coherence | ✅ (Guardian) | | |
| Phase 6.x **domain checklists** (financial, admin, fail-open, …) | | | ✅ injected |
| Phase 7 staff synthesis · 8 plan cross-ref · 9 PR description · 10 compose/post marker | ✅ | thresholds, vault, marker | |

### Language-agnostic principle

The generic skill reasons about **documentation completeness/accuracy against the project's convention** — patterns, best-practices, procedures — never specific tag syntax. It *mentions* the shared metadata concept (domain, tags, layer, what/how/why) and that it appears as **JSDoc tags in TS** and **docstring lines (`Domain:`/`Tags:`/`Layer:`) in Python**, but queries Guardian's **normalized fields uniformly** regardless of language. Exact requirements (which tags are mandatory; when Python needs `Args:`/`Returns:`) live in the extension checklists or are inherited from Guardian's own per-edit validation. Result: one skill audits a TS PR and a Python PR without branching.

### Marker + CI gate

The generic skill **always composes + posts** the marker comment (`<!-- pr-audit:v1 -->`) and verifies visibility — that is the audit's output. Whether a **CI job enforces** the marker's presence is a per-project opt-in wired up by the project itself (RMWM keeps its `audit-marker` job; codebase-guardian may add one later). Config carries `marker.commentMarker` and an optional `marker.ciCheckJob`.

## Config schema (v1)

`.guardian/pr-audit.config.json` — all fields optional, skill supplies defaults:
```jsonc
{
  "version": 1,
  "baseline": { "typecheck": "<cmd>", "lint": "<cmd|null>", "test": "<cmd>" },
  "docDirs": ["docs/..."],
  "staffReview": { "minDiffLinesForFullPass": 100 },
  "impact": { "depth": 2 },
  "suggestionStaging": { "filePath": ".guardian/suggestions.md", "clearAfterAudit": true },
  "marker": { "commentMarker": "<!-- pr-audit:v1 -->", "ciCheckJob": null },
  "deferredBugProtocol": { "requireGitHubIssue": true, "repo": "<owner/repo>" },
  "plan": { "vaultDir": "~/Dropbox/Obsidian/Project Plans/<project>" },
  "checklistsFile": ".guardian/pr-audit.checklists.md"
}
```
Defaults when absent: baseline auto-skip with a disclosure (don't guess commands); `docDirs` = `["docs"]`; thresholds as shown; marker enabled with the v1 marker; `checklistsFile` defaults to `.guardian/pr-audit.checklists.md` if present, else no domain checks (disclosed).

## codebase-guardian's own extension (built now, as the reference example)

- **`.guardian/pr-audit.config.json`**: `baseline{typecheck:"npx tsc --noEmit", test:"npm test", lint:null}`, `docDirs:["docs"]`, `plan.vaultDir:"~/Dropbox/Obsidian/Project Plans/codebase-guardian"`, `deferredBugProtocol.repo:"armueller/codebase-guardian"`, marker v1, `ciCheckJob:null`.
- **`.guardian/pr-audit.checklists.md`**: Guardian's own invariants as its "domain checklists" (analogous to RMWM's financial/admin checks), sourced from `CLAUDE.md`:
  - **Fail-open**: every hook error path allows the edit; extractors/tools never throw.
  - **Hook output & exit discipline**: deny via `hookSpecificOutput` on stdout (exit 0), never `exit(2)`+stderr; never `process.exit()` — set `process.exitCode`.
  - **CJS/ESM boundary**: hook (CJS via tsx) vs MCP server (ESM); type-only imports across; duplicated runtime utils are intentional.
  - **Validation cache vs session store**: two-hash semantics (disk-content hash for staleness, proposed-content hash for identical-resubmission).
  - **Circuit breaker**: stands down after `MAX_CONSECUTIVE_DENIALS`.
  - **Three-tier index + normalization** (domains/tags lowercased; system layers not).
  - **Language adapter seam**: TS ts-morph adapter untouched; Python via `guardian_py`; no `language` filter added to shared queries.

## Packaging / versioning

- Add `skills/pr-audit/SKILL.md` — auto-discovered, no `plugin.json` change; `build.sh` already syncs `skills/`.
- Bump `.claude-plugin/plugin.json` + `package.json` (0.4.0 → 0.5.0) so the skill deploys on next `/plugin update` + rebuild.

## Scope

**Now:** generic plugin skill + codebase-guardian's `.guardian/` extension + `.gitignore` change + version bump.

**Follow-up (separate change):** migrate RMWM — delete `.claude/skills/pr-audit/SKILL.md`, move its config to `.guardian/pr-audit.config.json`, lift its 6.3–6.6 domain checklists into `.guardian/pr-audit.checklists.md`, keep its `audit-marker` CI job. Verify `/pr-audit` still runs against PR #151 using the plugin skill.

## Out of scope
- Changing the audit's phase taxonomy or severity markers (kept identical to RMWM's proven format).
- Adding a CI `audit-marker` job to codebase-guardian (optional, later).
- Auto-detecting Python source roots (tracked separately with the Python-validation follow-ups).
