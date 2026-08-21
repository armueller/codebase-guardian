---
name: pr-walkthrough
description: Helps a human review a PR efficiently — it does not review in their place. Pins the true before-state, quarantines mechanical churn from real behavior change, slices the diff into vertical behaviors, and walks the reviewer through each one with real code and full control flow, then drafts and posts the review they approve. Companion to pr-audit, not a replacement.
allowed-tools: Bash, Read, Glob, Grep, Agent, WebFetch, AskUserQuestion, mcp__codebase-guardian__search, mcp__codebase-guardian__callers, mcp__codebase-guardian__callees, mcp__codebase-guardian__impact, mcp__codebase-guardian__search_doc_sections, mcp__codebase-guardian__search_comments, mcp__codebase-guardian__list_domains, mcp__codebase-guardian__list_tags, mcp__codebase-guardian__index_status
---

# /pr-walkthrough — Human Review Companion

`/pr-audit` produces findings. **This produces understanding, and the findings fall out of it.**

The problem this solves: PRs have become large and are increasingly machine-authored, which makes them hard for a human to hold in their head. An audit hands you a verdict you must either trust or re-derive. That is not review. Review is a person understanding the change well enough to have a defensible opinion about it. This skill builds that understanding, in vertical slices, with the actual code in front of the reviewer.

**The human is the reviewer. You are their instrument.** You do the legwork — reading the base revision, tracing call chains, enumerating call sites, verifying claims. They make the calls. Every finding is a proposal until they accept it.

This skill is **plugin-owned and project-agnostic**. Project specifics come from two optional files the project commits:

- **`pr-walkthrough.config.json`** — structured knobs (prior-artifact markers, doc dirs, issue tracker, review-record destination).
- **`pr-walkthrough.checklists.md`** — stack-specific blind-spot checks, injected into Phase 1 and Phase 3.

**Search order for both: `.guardian/`, then `.claude/`.** Take the first that exists. Many projects gitignore `.guardian/` wholesale (it is where the validation hook stages per-dev suggestions), which makes a config placed there uncommittable and therefore invisible to the rest of the team. If you find a config only in `.guardian/` and that path is gitignored, say so — the project probably intends it to be shared.

Both files are optional. With neither, run the generic phases and disclose what was skipped. **Read the config first**, then the checklists.

## ⚠️ Execution model — this runs INLINE (the inverse of pr-audit)

`pr-audit` dispatches a fresh subagent because implementation memory invites corner-cutting. **This skill is the opposite: the walkthrough MUST run in the main session, because the dialogue with the human is the deliverable.** A subagent cannot have the conversation, cannot be interrupted, cannot be argued with, and cannot absorb the human's domain knowledge mid-stream.

Subagents are used for exactly one thing: **the Phase 1 classification fan-out**, which is read-only inventory work that would otherwise consume the context the dialogue needs.

**Every claim a subagent returns is a hypothesis, not a finding.** Verify it yourself against the code before putting it in front of the human. In practice a meaningful fraction of subagent claims are overstated — a real observation with a wrong severity, a reachability assumption never checked. Presenting those unverified burns the reviewer's trust faster than missing them would.

## Phase 0 — Pin the ground

Nothing downstream is trustworthy if this is wrong.

- [ ] **Resolve the merge-base explicitly.** `git merge-base <base> <head>`. Record it. This is "before" for the entire review.
- [ ] **Use three-dot diffs, always.** `git diff <merge-base>...<head>`. A two-dot diff on a branch that has merged from base reports an enormous fictional changeset — on the PR this skill was built from, three-dot was 116 files / +4295 / −896 and two-dot was 270 files / −19,743. If a number looks implausible, this is why.
- [ ] **Check whether the branch is actually checked out.** `git branch --show-current`. If it is not, **plain `grep -rn ... app/` searches the wrong revision and returns plausible wrong answers**, because most symbols exist on both branches. Either check the branch out / create a worktree, or use `git grep -n <pattern> <ref> -- <path>` and `git show "<ref>:<path>"` for every read. State which ref every search ran against.
- [ ] **Read before-state from the base revision, never from diff hunks.** `git show "<merge-base>:<path>"`. Reconstructing "before" by reading `-` lines gives a false picture — you see what changed, not what was there.
- [ ] **Ingest prior review artifacts** listed in `config.priorArtifacts` (marker comments from audits, QA verification, previous reviews) plus inline review comments and bot comments. These are **input to adjudicate, not findings to repeat.**
- [ ] **Establish the coverage boundary.** For each prior artifact, determine which commit it covers, and compare against the current head. Commits landing after the newest artifact are unreviewed by anything. Say so explicitly and weight attention accordingly. Also check whether the artifact's vocabulary still matches the code — after a rename, an audit's "re-verified unchanged" findings may reference symbols that no longer exist.
- [ ] **Diff the PR description's claims about the before-state against the merge-base.** See "Machine-authored PR failure modes" below.
- [ ] Gather commits with dates (`git log --reverse --format='%h %ad %s'`), file status counts, and churn ranking.

## Phase 1 — Classify and quarantine

The point of this phase is to make a large diff tractable by proving which parts do not need reading.

Every changed file goes into exactly one bucket:

| bucket | meaning |
|---|---|
| **MECHANICAL** | a repeated substitution following a stated rule; no behavior change |
| **SEMANTIC** | behavior changes: new logic, changed conditions, changed defaults, added/removed branches |
| **STRUCTURAL** | added/deleted/renamed/split; content mostly moved |
| **TEST** | classify separately — see below |

**The mechanical bucket is where the value is, and it is not "files we skip."** For each mechanical group:

1. **State the substitution rule precisely** — the old form and the new form, e.g. `viewMode === 'print'` → `isFinalOutput(lens)`.
2. **Verify every file conforms.** Read them.
3. **Promote every non-conforming file to SEMANTIC**, with file:line and both snippets.

A wide refactor's bugs live in the call sites that do not match the rule. On the PR this skill was built from, 39 substitutions were faithful and two were not — one a latent inversion, one an undocumented permission change in a file whose diff otherwise looked like an import shuffle.

**Classify tests separately**: NEW COVERAGE / ADAPTED / CHANGED ASSERTIONS / REMOVED COVERAGE. For ADAPTED files, verify the assertion is genuinely equivalent — hunt for loosened matchers, deleted table rows, renamed `it` blocks that now claim less, and **literals that survived a rename and are no longer valid values of their type**.

### Dispatching the fan-out

Split by directory area, roughly balanced, one read-only agent each. Each prompt MUST carry: the merge-base SHA and head ref; the `git show "<ref>:<path>"` rule with the explicit warning not to reconstruct before-state from hunks; the bucket definitions; the substitution-rule + conformance-verification + promotion instruction; and a demand for terse structured output (a table, not prose).

Tell them plainly: **you are building an inventory, not reviewing for bugs.** Then verify what comes back.

### Report the ratio

Tell the reviewer what fraction of the diff needs a rule check rather than a read. That number is the reason this approach works, and it reframes the PR from "116 files" to "the 40 that matter."

## Phase 2 — Build the slice map

**Slices are behaviors, not files.** Derive them from what a user or caller can observe, then map files onto them.

- If the PR introduces new vocabulary (a new enum, concept, or abstraction that other slices depend on), make **slice 0 a primer**: what existed before, what gap forced the change, the new shape, and one table showing where the new states differ. Five minutes here makes every later slice readable.
- Present the map with per-slice file counts and a one-line reason each. **Let the reviewer order and prune it.** Offer a recommendation and say why — narrative order usually beats risk order, because unfamiliar vocabulary makes risky code unreadable.

## Phase 3 — Walk each slice

**One slice per message. Never batch.** The reviewer needs to ask questions before the next slice lands.

Each slice follows the same arc:

1. **Before** — real code from the base revision, plus *why it was that way*. Quote enough to be self-contained.
2. **The change** — the actual diff, annotated. Lead with the smallest thing that is the whole point (often one line).
3. **Call chain down** — entry point → each hop with `file:line` → the pivot where behavior actually changes.
4. **Back up** — what returns, what re-renders, what the user sees. Cover the branches, not just the happy path.
5. **What did not change but touches this** — callers outside the diff, sibling call sites, tests that should have moved.
6. **The reviewer's bench** — positions, with confidence labels, on correctness, performance, architecture, and pattern consistency. Include **what you checked and found fine**, so an absence of findings is defensible rather than an absence of looking.
7. **Adjudicate the prior artifacts that touch this slice** — corroborate, refute, or reclassify. Distinguish *real but inherited from the base branch* from *introduced here*; that distinction usually decides whether something blocks the merge.

### Rules for this phase

- **State positions flatly, with a confidence label.** "Neutral questions are how reviews get vague." Give the reviewer something to disagree with.
- **Concede quickly and without ceremony when they push back correctly.** Their domain knowledge routinely settles things the code cannot — whether an operation touches content, whether a UI state is reachable, whether a product direction is real. Fold it in and move on.
- **Number your paragraphs** so the reviewer can reply with "27 yes, 29 no."
- **Keep formatting simple.** Terminals mangle nested structures. Plain fenced code blocks, short tables, no deep nesting.
- **Verify before presenting.** If a subagent claimed it, check it. If you claimed it three messages ago and it now matters, check it again.
- **Distinguish mechanism from confirmed defect.** If reachability depends on something you have not exercised, say exactly that and name what would settle it. Overclaiming once costs more than under-claiming ten times.

## Phase 4 — Cross-slice synthesis

Once every slice is understood, ask what only the whole picture reveals: does the new abstraction earn its keep, is the migration complete, do the pieces agree with each other, what is on a hot path, and which decisions are load-bearing but undocumented.

## Phase 5 — Draft, approve, post

**Draft everything. Show the reviewer. Post nothing without approval.**

### Composing the review

Order the summary comment as:

1. **How this was reviewed** — the method, briefly. This is not throat-clearing: it tells the author what was and was not covered, and it makes the review's conclusions auditable. Include the coverage-boundary finding from Phase 0.
2. **What's working** — specific, evidence-backed praise. **Placed BEFORE the findings.** Praise placed after findings reads as consolation. Good signal in both directions is the point; a decision that would have been easy to get wrong and was gotten right deserves to be recorded as clearly as a defect.
3. **Would fix before merge** — ranked, each with a one-line mechanism and a pointer to the inline comment.
4. **Fast-follow** — same, shorter.
5. **Design questions that need an answer, not a change** — surface these in the summary even when the evidence lives inline, or they get buried in a file thread nobody opens.
6. **Adjudication of prior artifacts** — what you closed, what you reclassified, what you are pushing back on.

Inline comments carry the evidence. The summary carries the ranking.

### Voice

Write as the reviewer, with their judgment and your legwork. Precise, plain, direct, concise. Short sentences. No hedging where the claim is verified; explicit uncertainty where it is not. It does not need to pass as fully human-authored, but it must read as though the reviewer had a hand in authoring it — because they did.

### Posting mechanics — the parts that bite

- [ ] **Re-resolve the head SHA immediately before posting.** `gh pr view <N> --json headRefOid`. A long review outlives its own baseline. If the head moved: check whether any anchor file was touched, whether the merge-base changed, and **whether the new commits invalidate any finding**. Re-verify before firing.
- [ ] **Verify every anchor line falls inside a diff hunk** in the new file, or the API rejects it. Parse hunk headers *anchored*, not greedily — `sed -nE 's/^@@ -[0-9]+(,[0-9]+)? \+([0-9]+)(,([0-9]+))? @@.*/\2 \4/p'`. A greedy `.*+` matches the last `+` in the context text and silently reports every anchor as out-of-hunk.
- [ ] **Never hand-escape markdown into JSON.** Write the bodies as markdown separated by a delimiter, then let `jq -Rs 'split("...")'` do the escaping. Validate the assembled payload — part count, comment count, no short/empty bodies — before posting.
- [ ] Post one review (`POST /pulls/:n/reviews`, `event: "COMMENT"`) carrying the summary as `body` and all inline comments in `comments`. Reply to existing bot/reviewer threads separately via `POST /pulls/:n/comments/:id/replies`.
- [ ] Verify after posting.

## Blind-spot taxonomy by change kind

The highest-value findings come from asking **"what class of correctness is nobody checking here?"** Automated passes and mechanical-conformance checks both verify *logical* equivalence. Anything that is not logical equivalence is a systematic blind spot.

| change kind | the blind spot | what to check |
|---|---|---|
| **Rename / mechanical substitution** | **referential** behavior, not logical | identity of values passed into caches, memo boundaries, dependency arrays. A rename that merges two things into one object changes *when consumers invalidate*, which no logical-equivalence check catches. |
| **Extraction of inline code into a shared unit** | **widened preconditions** | the inline version had implicit invariants from its single call site. Enumerate the new callers and ask what each can pass that the original never could. Guards belong in the extracted unit, not the callers. |
| **New member added to an enum / new axis** | **the default when the axis is absent**, and predicates that were 1:1 with members and stop being | find every optional parameter with a default and ask whether the default is right for *every* call site that omits it, or merely for today's. |
| **Permission bypass / capability flag** | **what else the flag turns off**, compounded | trace every consumer of the flag, not just the intended one. Two independently-reasonable bypasses can compose into something nobody designed. The safe default for a bypass is deny, so hand-maintained allow/exclude lists should be derived from a canonical source. |
| **Data healing / normalization** | **cardinality**, not just per-item validity | dropping invalid entries changes collection emptiness, and emptiness is often load-bearing somewhere else. Also ask whether the producer of the bad data was fixed, or only the symptom. |
| **Test adaptation following a rename** | **literals that are no longer valid values** | a renamed identifier with an un-renamed value, kept compiling by a loose type or a mock that bypasses validation. Also: assertions that got looser, and tests that would pass if the feature were deleted. |
| **Context / provider consolidation** | **subscription scope** | which consumers previously read a narrow, rarely-changing source and now read a broad, frequently-changing one. |

Project-specific instantiations of these belong in `.guardian/pr-walkthrough.checklists.md`.

## Machine-authored PR failure modes

Check these on every PR whose description or code was largely model-generated:

- **Branch-internal history described as the baseline.** Over a long authoring session the model's "previously" means *earlier in my session*, not *on the base branch*. It will describe scaffolding it built and tore down as though the reader had seen it. **Diff the description's before-state claims against the merge-base.** On the PR this skill was built from, the description described collapsing two concepts into one; only one of them had ever existed on the base branch.
- **Naming and documentation asserting invariants the code does not hold.** Model-authored code documents intent thoroughly and confidently. When the implementation drifts from the intent, the prose does not — and a type named `StableContextValue` with a paragraph explaining its memoization discipline is *more* dangerous than an undocumented one, because future authors trust it. **Read the JSDoc as a claim to verify, not as a description to accept.**
- **Prior artifacts one revision stale.** Audits and QA runs pin to a commit. Renames invalidate their vocabulary wholesale while leaving them looking authoritative.
- **Design reversals mid-branch.** Check whether commits later in the branch reverse decisions that earlier artifacts (design docs, audits) still describe. A finding closed "as invalid" may have been dissolved by a reversal, which is worth recording — the reasoning is otherwise lost.
- **Over-elaborate rationale for a decision that was never made.** Length of justification does not correlate with correctness.

## Review record

Maintain a running notes file (`config.notesPath`, default a session scratchpad) with the pinned baseline, the classification, per-slice findings, and the reviewer's confirmed reactions. Long reviews outlive a single context window; the notes file is what survives. Offer to file a final record wherever `config.recordDestination` points.
