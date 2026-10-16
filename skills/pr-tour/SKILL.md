---
name: pr-tour
description: Guided PR review inside the reviewer's own Neovim. Runs the same analysis as pr-walkthrough (true before-state, churn quarantine, behavior slices, full per-slice analysis), then delivers each behavior as a tour — before/after side by side in real files with full LSP on both, short notes pinned to the lines they describe — while the reviewer navigates at their own pace and asks questions in the Claude pane. Requires Neovim with the pr-tour plugin; offers pr-walkthrough instead, never falls back silently.
allowed-tools: Bash, Read, Write, Glob, Grep, Agent, WebFetch, AskUserQuestion, mcp__codebase-guardian__search, mcp__codebase-guardian__callers, mcp__codebase-guardian__callees, mcp__codebase-guardian__impact, mcp__codebase-guardian__search_doc_sections, mcp__codebase-guardian__search_comments, mcp__codebase-guardian__list_domains, mcp__codebase-guardian__list_tags, mcp__codebase-guardian__index_status
---

# /pr-tour — Review a PR from inside Neovim

`/pr-walkthrough` builds understanding by writing it out. This skill builds the same understanding and hands it over **as code the reviewer navigates**: the real files, in their own editor, with go-to-definition and references on both the old and the new code. Your words shrink to short notes pinned to the lines they describe.

**The analysis is identical to `/pr-walkthrough`. Only the delivery changes.** A note is short because the analysis behind it was done — never instead of doing it.

## Load the shared core first

Read `../_shared/pr-review-core.md` (relative to this skill's base directory) before anything else. It holds configuration loading, Phases 0–5, the blind-spot taxonomy, the machine-authored failure modes, and the review record. Follow it in full. This file adds workspace setup and replaces **how Phase 3 is presented**.

The CLI is `../../scripts/pr-tour` relative to this skill's base directory. Resolve it to an absolute path once and call it `$PRT` below. Every subcommand prints one JSON object. `"ok": false` always carries an `error` — read it and act on it; never ignore a failed call.

## Execution model — inline

Same as `/pr-walkthrough`: this runs in the main session, because the dialogue is the deliverable. Subagents are used only for the core's Phase 1 fan-out, and every claim they return is a hypothesis until you verify it.

## Setup — workspace and attach

Do the core's Phase 0 ref work first (PR number, head SHA, merge-base). Then:

1. **Head side (`headRoot`).** If the main checkout's working tree is clean (`git status --porcelain` prints nothing) **and** the reviewer agrees to switch it, run `gh pr checkout <N>` there and use the main checkout. Otherwise `git worktree add --detach ../<repo>-pr-<N> <headSha>`.
2. **Base side (`baseRoot`).** Always `git worktree add --detach ../<repo>-pr-<N>-base <mergeBase>`.
   If a worktree path already exists from an earlier run, compare `git -C <path> rev-parse HEAD` to the wanted SHA: reuse it if it matches, otherwise ask before removing it.
3. **Dependencies, per worktree** (skip for the main checkout). Dependency files: `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `pyproject.toml`, `requirements*.txt`, `uv.lock`, `poetry.lock`.
   - Head: if `git diff --name-only <mergeBase>...<headSha>` lists any of them, run the project's real install inside `headRoot`. Otherwise symlink from the main checkout.
   - Base: always symlink from the main checkout.
   - Symlinking means: every `node_modules` directory in the main checkout (`find . -name node_modules -type d -prune`) linked at the same relative path in the worktree when its parent exists there, plus `.venv` / `venv` if present.
   - Tell the reviewer which strategy each side got, in one line.
4. **Attach.** Ask the reviewer to open Neovim in `headRoot` in another terminal pane (`cd <headRoot> && nvim`). Then run `$PRT attach <headRoot>`. Do not present anything until it returns `"ok": true`.
   - `no Neovim is open` → wait for the reviewer, retry.
   - several instances → show the `candidates`; ask which to close.
   - `does not have the pr-tour plugin` → point them to the README's PR Tour setup.
   - If attach cannot work (no Neovim available, or the reviewer would rather not), say so and offer `/pr-walkthrough`. **Never fall back to prose silently.**

## Phases 0–2 — unchanged

Run them from the core. The behavior map (Phase 2) goes in this pane as a short table; the reviewer orders and prunes it here.

## Phase 3 — Tour each slice (replaces the core's presentation)

### 3a. Analyze — the full arc, silently

Do every step of the core's Phase 3 arc for the slice, with all of its rules: before and why, the change, call chain down, back up, what did not change but touches this, the reviewer's bench, prior-artifact adjudication. Put the results in the running notes file. That is where the depth lives — not in this pane.

### 3b. Encode the analysis as a tour

Wherever the core says "show" or "quote" code, here it means **give it a stop**. Map the arc onto stops in narrative order:

| arc step | becomes |
|---|---|
| Before + why | a `split` stop on the old code; `base` notes say what it did and why |
| The change (the pivot) | a `split` stop on the pivot; `head` notes say what is different |
| Pass-through call-chain hops | no stop — a note on the call line naming where it goes |
| A surprising or load-bearing hop | its own stop: `head` view if the file is unchanged, `split` if changed |
| Back up / branches | a stop on any branch whose result is not obvious from its name |
| Untouched callers and siblings | `head` stops on the call sites that matter |
| Deleted code | a `base` stop |
| Bench findings | `finding` notes on the exact line, with severity |
| Checked and fine | `explain` notes where there is an anchor ("✓ all 4 callers handle null"); otherwise kept for the list in 3e |

Write the tour to the scratchpad as `tour-<slice-number>.json`:

```json
{
  "version": 1,
  "title": "Behavior 2: route by header sniffing",
  "headRoot": "/abs/path/to/head",
  "baseRoot": "/abs/path/to/base",
  "stops": [
    {
      "title": "Pivot: sniff() replaces the extension check",
      "file": "src/convert/route.ts",
      "baseFile": "src/route.ts",
      "view": "split",
      "line": 41,
      "endLine": 44,
      "notes": [
        { "side": "base", "line": 41, "kind": "explain", "text": "ext only — wrong for renamed files" },
        { "side": "head", "line": 41, "kind": "explain", "text": "reads the magic bytes instead" },
        { "side": "head", "line": 88, "kind": "finding", "severity": "med", "text": "lock never released on throw" }
      ],
      "more": "Optional longer explanation, shown only when the reviewer presses gK."
    }
  ]
}
```

- `view` is required: `split` (changed file), `head` (file the PR does not change, or adds), `base` (file the PR deletes).
- `file` is relative to `headRoot`; `baseFile` is relative to `baseRoot`, defaults to `file`, and is `null` for added files (use `view: "head"` for those).
- `line` / `endLine` are the focus range (`line` is required; it must exist in the file) on the head side (base side for `view: "base"`).
- A `split` stop needs both files to exist; a stop whose file is missing is dropped.
- Notes: `side` must be a side the view shows. `kind` is `explain` or `finding`; findings need `severity` `low` / `med` / `high`.

**Note discipline — the reason this skill exists.**
- At most ~80 characters. One claim. Plain words — the core's plain-over-dense rule, applied harder.
- Say what the line *does or means*, not what it *is*. The reviewer can read the code.
- Never restate the code ("calls sniff()"). A note that adds nothing the code doesn't show gets deleted.
- One to three notes per stop. More means it is two stops.
- Use `more` only when something truly cannot be split: plain markdown, at most ~8 lines.

### 3c. Load and hand over

Run `$PRT load <tour.json>`. If `dropped` is non-empty, fix the tour and reload — never present a tour with dropped items. Then say exactly one line and stop:

> Behavior 2 loaded: 6 stops, 1 finding.

On the first tour only, add the keys: `]s` / `[s` move between stops, `gK` opens a stop's detail.

### 3d. While the reviewer walks

- On any question, run `$PRT where` **first**, and answer against their stop, side, file, line, and selection. If `selection` is non-null and its `ageSeconds` is small, "this" means the selection.
- Answer short — a few sentences, same discipline as notes. Offer depth instead of delivering it unasked.
- When pointing beats describing, run `$PRT goto <file> <line>` (add `--before` for the old code) and tell them `]s` or `[s` returns them to the stop they were on.
- If a question exposes a gap in the tour, add the stop or note and reload, instead of writing the answer out at length.
- Concede quickly when they push back correctly (core rules).

### 3e. When they say they are done with the slice

Post a short numbered list, then wait:

```
1. [med] lock never released on throw — stop 3, route.ts:88
2. [low] sniff() re-reads the header on every call — stop 2, sniff.ts:12
3. ✓ checked: all 4 callers handle the new stream return
```

They reply by number ("1 yes, 2 no"). Record accepted findings with their file and line in the notes file — they become inline review comments. Then move to the next slice.

## Phases 4–5 — in the pane, as the core says

Cross-slice synthesis, the plain-language recap, and draft / approve / post all run in this pane exactly as the core describes. Keep the recap short. Inline comments come from the accepted findings.

## Teardown

1. `$PRT clear`.
2. Offer to remove each worktree you created (`git worktree remove <path>`); remove only on confirmation. Never remove the main checkout. If the head side was the main checkout, offer to switch it back to the branch it was on.
3. Notes and the review record follow the core's Review record section.

## When the CLI reports a problem

| CLI error | Do |
|---|---|
| `not attached` / Neovim gone and re-discovery failed | Ask the reviewer to reopen Neovim in `headRoot`, `$PRT attach`, then reload the current tour file — all tour state is in the file. |
| `did not respond within Ns` | Neovim is probably waiting at a prompt. Ask them to press Esc in Neovim, then retry. |
| `dropped` items on load | Fix the tour and reload. |
