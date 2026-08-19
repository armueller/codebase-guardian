---
name: pr-audit
description: Comprehensive, language-agnostic PR audit driven by Codebase Guardian semantic search, impact analysis, suggestion-staging triage, and staff-level synthesis. Loads per-project config + checklists, dispatches a fresh subagent to run the phases, and posts a marker comment to the PR.
allowed-tools: Bash, Read, Glob, Grep, Agent, WebFetch, AskUserQuestion, mcp__codebase-guardian__search, mcp__codebase-guardian__callers, mcp__codebase-guardian__callees, mcp__codebase-guardian__impact, mcp__codebase-guardian__search_doc_sections, mcp__codebase-guardian__search_comments, mcp__codebase-guardian__rebuild_index, mcp__codebase-guardian__list_domains, mcp__codebase-guardian__list_tags, mcp__codebase-guardian__index_status
---

# /pr-audit — Pre-Merge Quality Gate

Run this audit at the end of a PR before merging. It catches bugs, gaps, pattern violations, and missed requirements that accumulate over a multi-phase implementation. Output is a marker comment posted to the PR.

This skill is **plugin-owned and project-agnostic**. It works in any Codebase Guardian project and in any language Guardian indexes (currently TypeScript and Python). Project-specific semantics — the commands that verify the build, the documentation layout, and the domain checklists — are supplied by two optional files the project commits:

- **`.guardian/pr-audit.config.json`** — structured knobs (baseline commands, doc dirs, thresholds, marker, plan location, deferred-bug repo).
- **`.guardian/pr-audit.checklists.md`** — free-form prose domain checks, injected into the audit (Phase 6).

Both are optional. With neither, the skill runs the generic Guardian-driven phases with sensible defaults and discloses what it skipped. **Read `.guardian/pr-audit.config.json` first** (if present) to load the project's settings; then read `.guardian/pr-audit.checklists.md` (if present) — its contents are project domain checks you MUST run in Phase 6.

## ⚠️ Execution model — dispatch a subagent (REQUIRED)

**The controller session MUST NOT execute the audit phases inline. Instead, dispatch a fresh `general-purpose` Agent to run Phases 0–10, and only handle composition + posting of the marker comment in the controller.**

### Why this is non-negotiable

The controller has implementation memory from the PR being audited. That memory creates a recurring corner-cut: "I know who calls this function — I just dispatched the implementer that updated it" / "I know the test count" / "I already verified that doc tag." Those statements conflate *knowing what the answer probably is* with *gathering the evidence the skill requires*. The skill exists because "I think I know" is wrong sometimes and you can't tell which times without running the check.

A fresh subagent has no implementation history. It cannot short-circuit. The tool calls become structurally mandatory because there is no "I already know" to fall back on.

### How to dispatch

Use the `Agent` tool with `subagent_type: 'general-purpose'`. The prompt MUST:

1. **Begin with the `ultrathink` keyword to maximize the subagent's reasoning budget.** The audit's primary failure mode is not running out of context; it's not thinking deeply enough about each phase's findings. Always use `ultrathink`.

2. **Include the framing clause verbatim** (or as close as you can get to it):

   > "ultrathink. You are a staff-level developer reviewing this PR. This audit IS the trust-building moment for the PR — once posted, the team treats its findings (and the absence of findings) as authoritative. Your job is to carefully and meticulously review as if your professional reputation depends on it. If anything slips through unflagged, it's on you.
   >
   > **The asymmetric cost matters.** Flagging something innocuous costs a reviewer 30 seconds to read and dismiss. Missing a real bug can cost hours-to-days of production debugging plus eroded trust. The math is overwhelming — when in doubt, SURFACE it. False positives are vastly preferable to false negatives. If you're 30% sure something is wrong, raise it as an Open Question. If you're 50% sure, raise it as a Risk. The instinct to suppress because 'this might be fine' is the failure mode.
   >
   > This is the only review the PR gets. Read the plugin skill file at `<path to this SKILL.md>` in full before you start, then read the project's `.guardian/pr-audit.config.json` and `.guardian/pr-audit.checklists.md` if they exist. Run every phase with concrete evidence from tool calls — never substitute 'I think I know' for an actual check. Show your evidence trail in every phase's summary."

3. **Hand off the minimum necessary context** — PR number, base branch, branch name, one-sentence summary of what the PR does, and the absolute paths to this skill file + the project's config/checklists. The subagent reads the skill itself; do NOT paraphrase phases in the prompt, and do NOT summarize the implementation (that pollutes the fresh context).

4. **Direct the subagent to draft the marker comment to `/tmp/pr-audit-comment-<PR>.md`.** The subagent does NOT post; the controller does.

5. **Require the subagent to report back** with: a per-phase summary (one paragraph each, citing the tool calls run — not just "Phase 5 ✅"); the counts for the Status line; and **explicit completeness disclosures** — anything it did NOT do (e.g., "did not run the test command — config specified none"). Surface every gap so the controller can decide whether to fill it before posting.

### Controller responsibilities (LIMITED)

1. Read the draft comment.
2. **Spot-check 1–2 high-severity findings against the actual code** before posting. If a finding looks wrong, ask the subagent to revisit (don't silently delete).
3. Post via `gh api repos/<owner>/<repo>/issues/<pr>/comments -X POST -F body=@<path>`.
4. Verify the marker is visible.
5. Update the Resolution Log as findings get fixed.

### What NOT to do
- ❌ Do not run Phases 0–10 inline in the controller. The fresh-context mechanism is the whole point.
- ❌ Do not skip the framing clause "to save tokens."
- ❌ Do not accept the subagent's draft without a tool-call evidence trail. If the report arrives without tool calls referenced, the audit was shallow — send it back.
- ❌ Do not let the controller's implementation memory enter the audit.

### What the rest of this file is for

Everything below (Phases 0–10) is the **instruction set the SUBAGENT executes**, not the controller. The controller dispatches + verifies + posts.

---

## Critical principles

1. **Optimize for thoroughness, not speed.** Audit slowness is acceptable; audit blindness is not. If a finding is plausibly correct, gather the evidence even if it takes many Guardian queries.

2. **Evidence-required for findings.** Every finding in 🔴 Bugs, 🟠 Risks, 🟡 Pattern Violations, 🔵 Design Concerns, 🟣 Missing Pieces must cite concrete evidence — a Guardian search hit, an impact result, a doc reference with section, or a related `file:line`. Findings without evidence go to 🟢 Open Questions — but that is for genuine epistemic uncertainty, NOT to save time on evidence-gathering.

3. **Open Questions is first-class output.** If something looks weird, off, or out of place — ask it. A question with a simple answer is still worth asking if it catches 1/50 bad assumptions.

4. **The plan is the source of truth for intent; the code is what was built.** Compare the two systematically in Phase 8.

5. **"I think I know" is not evidence.** This phrase, or any structural equivalent ("I verified during implementation," "the test passed earlier so I assume it still does"), is the corner-cut that necessitated the subagent execution model. Replace it with the actual tool call.

6. **Asymmetric cost — surface, don't suppress.** 30% confident something is wrong → 🟢 Open Question. 50% → 🟠 Risk (with evidence). 70%+ → the appropriate severity with evidence. The correct internal question is "if this turns out to be wrong, did I flag it?" not "am I sure enough to flag it?"

7. **You are building trust, not optimizing for empty findings.** "0 findings" is welcome ONLY when defensible with evidence of having looked. "5 findings, 3 later dismissed" beats "0 findings" without rigor.

## Documentation metadata is language-shaped — reason about the concept, not the syntax

Guardian indexes both TypeScript and Python. Both carry the same **conceptual metadata** — a domain, tags, a system layer, and a what/how/why — but express it differently:

- **TypeScript**: JSDoc tags (`@domain`, `@tags`, `@systemlayer`, `@what`, `@how`, `@why`, `@param`, `@returns`, `@sideeffects`).
- **Python**: docstring lines (`Domain:`, `Tags:`, `Layer:`) plus the summary/args/returns prose.

Guardian's index **normalizes both into the same fields** (`domains`, `tags`, `systemlayers`). So throughout this audit, reason about *"does each changed unit carry its required documentation metadata, and does that metadata match the code?"* and query it **uniformly via Guardian**, regardless of language. Do NOT hardcode a specific tag set here — the exact requirement (which tags are mandatory, when a Python function needs `Args:`/`Returns:`) is either stated in the project's `.guardian/pr-audit.checklists.md` or already enforced by Guardian's per-edit validation hook. Defer to those.

## Phase 0 — Setup

- [ ] **Load config.** Read `.guardian/pr-audit.config.json` if it exists: `baseline{typecheck,lint,test}`, `docDirs`, `staffReview.minDiffLinesForFullPass` (default 100), `impact.depth` (default 2), `suggestionStaging.filePath` (default `.guardian/suggestions.md`), `marker.commentMarker` (default `<!-- pr-audit:v1 -->`) + `marker.ciCheckJob`, `deferredBugProtocol{requireGitHubIssue,repo}`, `plan.vaultDir`, `checklistsFile` (default `.guardian/pr-audit.checklists.md`). If the file is absent, use the defaults and note "No pr-audit.config.json — using defaults" in the comment preamble.
- [ ] **Rebuild the index if indexed files changed.** Run `git diff <base>...HEAD --name-only` and check for changes to files Guardian indexes (source in the configured `docDirs`/source tree, `.md` docs, and — depending on language — `.ts`/`.tsx`/`.py`). If any changed, rebuild via `mcp__codebase-guardian__rebuild_index` and wait for completion (accept 30s–2min latency). A stale index produces false negatives. If NOTHING indexable changed, skip the rebuild and note it explicitly. When in doubt, rebuild.
- [ ] **Locate the plan.** If `plan.vaultDir` is set, list it and match a plan to the current branch/feature. If multiple match, ask the dev. If none, flag as a Missing Piece and proceed. If `plan.vaultDir` is unset, skip Phase 8 later.
- [ ] **Gather diff scope:** `git log <base>..HEAD --oneline --no-merges`, `git diff <base>...HEAD --stat`, `git diff <base>...HEAD --name-only`. Identify the base branch (`main` unless the plan or branch name says otherwise).
- [ ] **Identify new vs modified vs deleted public units** by parsing the diff (exported functions/types/classes in TS; module-level and exported defs in Python). New = added export/public def; modified = signature or behavior changed.
- [ ] **Calculate total diff line count** (added + deleted) — decides whether Phase 7 runs.
- [ ] **Empirically verify the baseline.** Do NOT trust the PR description's claims. For each command in `config.baseline` that is set, run it and record the actual result in the comment preamble (pass/fail + first error line; test pass/skip/fail counts). Also run `gh pr checks <N>` for CI status. If a `baseline` command is null/absent, note "baseline.<name> not configured — not run." If anything is red that the PR description claimed green, that is itself a 🔴 Bug or 🟠 Risk.

## Phase 1 — Documentation alignment

For each unique domain touched by changed files (from Guardian's `domains` field on changed units):

- [ ] Call `mcp__codebase-guardian__search_doc_sections` with the domain name.
- [ ] Read the top 2–3 doc sections returned.
- [ ] For each changed unit in that domain: does the code's behavior match what the doc prescribes?

Findings: behavior contradicts doc → 🔴 BUG (`file:line` + doc section). Ambiguous → 🟢 Open Question. If a domain touched by the diff has no doc under the configured `docDirs` → 🟣 Missing Piece.

## Phase 2 — Duplicate detection (new units + sub-step similarity)

For each **new** public unit from Phase 0:

- [ ] Call `mcp__codebase-guardian__search` with its name + 2–3 keywords from its doc summary + 1–2 from its body.
- [ ] Inspect the top 5 hits. If a hit does roughly the same job → 🟡 Pattern Violation: `PV-N <new-file>:<line> <new-unit> duplicates <existing-file>:<line> <existing-unit> (search rank N)`.
- [ ] Call `mcp__codebase-guardian__search_comments` with 1–2 representative inline-comment phrases from the new unit. If a hit describes a similar sub-step already implemented elsewhere → ⚪ Suggestion: `SUG-N <new-file>:<line> + <existing-file>:<line> share sub-step "<phrase>" — consider shared helper`.

If the new unit is genuinely novel, no finding.

## Phase 3 — Impact / blast radius (modified units)

For each **modified** public unit where the signature, return type, or side-effects changed:

- [ ] Call `mcp__codebase-guardian__callers` with the unit name.
- [ ] Call `mcp__codebase-guardian__impact` with the unit name and `depth` from config (default 2).
- [ ] For each caller: is its file in the PR diff?
  - Not in diff + signature changed → 🔴 BUG: "Caller `<file>:<line>` not updated; will break at runtime".
  - Not in diff + side-effects added (e.g. was pure, now does I/O) → 🟠 RISK.
  - Not in diff + return shape changed but compatible → 🟢 Open Question.

If a unit has >20 callers, summarize ("`foo` has 47 callers; 3 not in diff: …"). Don't list all.

## Phase 4 — Suggestion staging triage

- [ ] Read the suggestion-staging file (`suggestionStaging.filePath`, default `.guardian/suggestions.md`) in full. If empty after its header, skip the rest of this phase.
- [ ] Group entries by file path. For each entry categorize: **PR-scoped** (file in diff), **Opportunistic** (adjacent + small), **Out-of-scope** (unrelated), **Stale** (file/unit gone). Severity-assess each.
- [ ] Drop Stale and noise entries silently. Surface meaningful ones: PR-scoped high → 🟡/🔵; PR-scoped low → ⚪ Suggestion (PR-scoped); Opportunistic → ⚪ Suggestion (opportunistic); Out-of-scope substantial → 🟣 Missing Piece ("consider a GitHub issue").
- [ ] If `suggestionStaging.clearAfterAudit` is true, **clear the file atomically** — truncate to its single header comment (preserve the auto-managed header line so the hook keeps appending correctly).

## Phase 5 — Documentation completeness + accuracy

Per the language-agnostic principle above, work from Guardian's normalized metadata, not a fixed tag list.

For each **new** public unit:
- [ ] Confirm it carries the documentation metadata the project requires (domain, tags, a clear what/why; per-parameter and return docs where the project's convention calls for them). Missing required metadata → 🟡 Pattern Violation: `PV-N <file>:<line> <unit> missing doc metadata: <list>`. Exported/public with NO doc at all → 🟡 Pattern Violation.

For each **modified** public unit:
- [ ] Compare the current doc against the new body. Do parameter names/types, the return description, and the stated side-effects still match? Stale doc → 🟡 Pattern Violation with the specific mismatch.

For each significant behavior change:
- [ ] Check whether a doc under `docDirs` that describes the prior behavior was updated. Not updated → 🟣 Missing Piece.

## Phase 6 — Pattern compliance + project domain checklists

Phase 6 aggregates across the diff and runs the project's own checklists.

### 6.1 Directory README / convention compliance
For each new file: identify its directory, call `mcp__codebase-guardian__search_doc_sections` with the directory name to find its README/conventions. If found, does the new file follow the documented pattern (naming, exports, structure)? Deviation → 🟡 Pattern Violation referencing the README.

### 6.2 Cross-file domain + side-effect coherence
For each new public unit: cross-check its domain against siblings in the same directory (`mcp__codebase-guardian__list_tags`, sibling search). A unit whose domain is incoherent with its neighbors → 🟢 Open Question. Cross-check declared side-effects against the directory's role (pure-helper directories should not contain I/O; controller/data-layer directories declaring no side-effects are suspicious) → 🟡 Pattern Violation or 🟢 Open Question.

### 6.3 Project domain checklists (injected)
- [ ] Read `.guardian/pr-audit.checklists.md` (the `checklistsFile` from config). **Run every check it lists** against the diff, using Guardian queries + file reads for evidence. Each failure lands under the marker taxonomy (🔴/🟠/🟡/🔵/🟣) per the evidence rule, citing `file:line` + the checklist item.
- [ ] If the checklists file is absent, note "No project checklists — Phase 6.3 skipped" and rely on 6.1/6.2 plus the generic phases. Do not invent project-specific rules.

## Phase 7 — Staff-level synthesis

If the total diff line count is below `staffReview.minDiffLinesForFullPass` (default 100), skip and note ("Phase 7 skipped — diff is N lines, threshold M").

Phase 7 is a synthesis of the evidence already gathered, read with a staff-engineer lens. For each significant change reason about: **Should this exist at all?** (Phase 2 evidence) · **Right module/owner?** (search for where similar responsibilities live) · **Right approach vs the plan?** · **Right decomposition?** (file >500 lines, function >50 lines, module with >5 mixed-responsibility exports) · **Performance/UX?** (sync work on hot paths, N+1, blocking I/O). Every Phase 7 finding goes to 🔵 Design Concerns ONLY with concrete evidence; otherwise 🟢 Open Question. No speculative Design Concerns.

## Phase 8 — Plan cross-reference

If no plan was found in Phase 0 (or `plan.vaultDir` unset), skip and note it.

For each section of the plan: **Design decisions** reflected in code? (unimplemented → 🟣 Missing Piece) · **Phase checklists** — every "complete" phase actually matches the code? (mismatch → 🟣 Missing Piece or 🔴 BUG) · **Key files** exist and do what the plan says? · **Research insights** correctly applied? (misapplied → 🔴 BUG) · **Open questions** resolved in code without updating the plan? → 🟢 Open Question. Also flag code changes NOT in the plan (scope creep) — notes, not necessarily blocking.

## Phase 9 — PR description quality

Runs only when a PR exists (skip + note if pre-flight, no PR yet).

- [ ] Fetch the description: `gh pr view <N> --json body --jq .body`.
- [ ] Assess whether the description **opens with a high-level summary** (1–3 plain-language sentences of what + why) before diving into file/function detail. If it jumps straight into implementation detail with no opening abstract → 🟡 Pattern Violation ("add a 1–3 sentence high-level summary at the top"). If a project PR template exists and prescribes a stricter structure, check against it. This is a warn, never a merge blocker on its own.

## Phase 10 — Compose and post the marker comment

Compose using this exact structure (drop any section with zero findings):

````markdown
<!-- pr-audit:v1 -->
## PR Audit — claude /pr-audit
_Run at: <ISO timestamp> · branch: <branch-name>_

**Status:** N fixed · N deferred · N open · N questions
<!-- Counts cover Bugs + Risks + Pattern Violations + Design Concerns + Missing Pieces. Suggestions and Open Questions are tracked separately. -->

**Baseline:** <typecheck result> · <test result> · <lint result or "not configured"> · CI: <gh pr checks summary>

### 🔴 Bugs (N)
- [ ] BUG-1 `file:line` — what's broken, what fails at runtime, fix

### 🟠 Risks (N)
- [ ] RISK-1 `file:line` — scenario where this breaks

### 🟡 Pattern Violations (N)
- [ ] PV-1 `file:line` — violation, reference to convention

### 🔵 Design Concerns (N) — evidence-backed
- [ ] DC-1 `file:line` — concern + concrete evidence

### 🟣 Missing Pieces (N)
- [ ] MP-1 — plan said X, code lacks it / no doc for domain Y

### ⚪ Suggestions surfaced from staging (N)
- [ ] SUG-1 `file:line` — PR-scoped DRY/cleanup

### 🟢 Open Questions for Reviewer (N)
- Q1 `file:line` — the question + why it might matter

### Resolution Log
- (dev appends as items are fixed or deferred)
````

Use the `commentMarker` from config (default `<!-- pr-audit:v1 -->`) as the FIRST line so the comment is idempotently locatable and any opt-in CI `ciCheckJob` can verify it.

### Posting
- [ ] PR number: `gh pr view --json number --jq .number`. If no PR exists (pre-flight), write the body to `/tmp/pr-audit-comment.md` and return — the caller posts later.
- [ ] Repo: `gh repo view --json nameWithOwner --jq .nameWithOwner`.
- [ ] Write the body to `/tmp/pr-audit-comment-<N>.md`, then post: `gh api repos/<owner-repo>/issues/<N>/comments -X POST -F body=@<path>`.
- [ ] Confirm visible: `gh pr view <N> --comments | grep "<commentMarker>"`. If not found, surface the error.

Leave the Resolution Log empty after posting; the dev appends over time.

## Deferred-bug protocol

If `deferredBugProtocol.requireGitHubIssue` is true, a deferred 🔴 BUG's link MUST be a GitHub issue URL (not a bare reference or TODO). To defer: `gh issue create -R <deferredBugProtocol.repo> --title "<bug>" --body "Deferred from PR #<N>: <BUG-K>"`, check the BUG's box, and append `→ deferred, tracked in <issue url>`. Before completing, remind the dev: "If any 🔴 BUGS remain unresolved, either fix them or follow the deferred-bug protocol."

## Open Questions — philosophy

The 🟢 Open Questions bar is **low — surface anything that looks weird**; the findings bar is **high — evidence required**. If you think "this might be wrong but I can't prove it," that is a question worth asking. Frame each with the reasoning that made you wonder: not "Is this right?" but "I notice X; in similar code at `file:line` we do Y; should this too?"
