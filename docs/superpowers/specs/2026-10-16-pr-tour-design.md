# /pr-tour — Neovim-guided PR review

**Date:** 2026-10-16
**Branch:** `feat/pr-tour`
**Status:** Design approved in conversation; awaiting spec review

## Problem

`/pr-walkthrough` does the right analysis but delivers it badly. Each behavior arrives as long generated prose with quoted code in a terminal pane. Two things go wrong:

1. **The code is shown out of context.** Quoted snippets can't be navigated — no go-to-definition, no find-references, no hover JSDoc. This is the same failure that makes GitHub's review UI painful.
2. **Long-form generated prose is fatiguing**, and it is particularly poor at conveying the thing review most needs: how it worked before, how it works now, and why.

## Goal

A new skill, `/pr-tour`, that runs the same groundwork as `/pr-walkthrough` but delivers each behavior as a **tour inside the reviewer's own Neovim**: before/after side by side in real files with full LSP, short notes pinned to the lines they describe, and Claude's pane quiet unless asked.

**Success:** the reviewer reviews a real PR mostly by navigating Neovim, reads Claude's pane only by choice, and finishes understanding the before → after → why of each behavior.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Relationship to `/pr-walkthrough` | New skill. Reuse Phases 0–2 groundwork in full; replace presentation. `/pr-walkthrough` behavior unchanged. |
| Chat pane | None inside Neovim. Claude runs in its own kitty pane. |
| Bridge | **A: a bash CLI over Neovim's RPC socket.** No MCP server in v1; subcommands map 1:1 to future MCP tools. |
| Before/after view | Side-by-side diff split. Single head-only pane for files the PR does not change. |
| Before-side language features | Real merge-base worktree with full LSP (not a scratch buffer). |
| Navigation | Reviewer drives (`]s` / `[s`); Claude listens and can `goto` when answering. |
| Findings | Anchored as distinct notes where possible; short numbered list in the pane after each tour. |
| claudecode.nvim | Not in v1; revisit later. |

## Out of scope (v1)

- claudecode.nvim integration
- An MCP server for the bridge
- Claude opening kitty panes / launching Neovim
- Any behavior change to `/pr-walkthrough`

## Components

```
skills/
├── _shared/pr-groundwork.md   # Phases 0–2 + blind-spot taxonomy + machine-authored failure modes (moved from pr-walkthrough)
├── pr-walkthrough/SKILL.md    # Loads _shared/pr-groundwork.md; presentation unchanged
└── pr-tour/SKILL.md           # Loads _shared/pr-groundwork.md; delivers behaviors as Neovim tours
scripts/pr-tour                # Bash CLI — the only thing Claude calls
nvim/lua/pr-tour/              # Neovim plugin — renders a tour file, reports state
tests/pr-tour.test.ts          # Integration tests (node --test via tsx)
```

Boundaries: the Lua plugin knows nothing about PRs, git hosts, or Claude — it renders a tour file and reports state. The CLI is a thin pipe. All review intelligence lives in the skill.

### 1. Shared groundwork — `skills/_shared/pr-groundwork.md`

Phases 0 (pin the ground), 1 (classify and quarantine, including the fan-out dispatch rules and the ratio report), and 2 (build the slice map) move verbatim out of `pr-walkthrough/SKILL.md`, along with the **Blind-spot taxonomy** and **Machine-authored PR failure modes** sections. Both skills instruct Claude to read this file before starting. Config loading (`pr-walkthrough.config.json`, `.local.json`, `.checklists.md`, search order `.guardian/` then `.claude/`) is also shared — `/pr-tour` reads the same files; there is no separate `pr-tour.config.json`.

`pr-walkthrough`'s user-visible behavior must not change. The move is a text relocation; its Phase 3–5 content stays in its own SKILL.md.

### 2. CLI — `scripts/pr-tour`

Bash. Every subcommand prints a single JSON object to stdout — `{"ok": true, ...}` or `{"ok": false, "error": "..."}` — and exits non-zero on failure.

| Subcommand | Behavior |
|---|---|
| `attach <headRoot>` | Discover the Neovim instance whose `getcwd()` is inside `headRoot`. Writes state to `$TMPDIR/pr-tour/<hash-of-headRoot>.json` (`{socket, headRoot, pid}`). Zero matches → error naming the path to open Neovim in. Multiple → error listing them (pid + cwd). |
| `load <tour.json>` | Calls the plugin's loader with the file path (never inline JSON — avoids shell quoting). Returns the plugin's validation report: stop count, finding count, and any dropped notes/stops with reasons. |
| `where` | Returns current stop index + title, active side (`base`/`head`), file, cursor line, and last visual selection `{file, side, startLine, endLine, text, ageSeconds}` or null. |
| `goto <file> <line> [--before]` | Jump the tour tab to a location on the head side (or base side with `--before`). Does not change the current stop. |
| `clear` | Remove all notes, close the tour tab, unset tour keymaps. |

**Discovery:** Neovim opens a default server socket per instance (on this machine: `$TMPDIR/nvim.$USER/*/nvim.<pid>.0`; on Linux under `$XDG_RUNTIME_DIR`). The CLI globs both locations, queries each with `nvim --server <sock> --remote-expr 'getcwd()'`, and matches by path prefix after resolving symlinks. A dead socket (query fails) is skipped. An env override `PR_TOUR_NVIM_SOCKET` bypasses discovery.

**Re-attach:** if the saved socket fails on any subcommand, the CLI re-runs discovery once for the saved `headRoot` before reporting failure.

**Calling Lua:** `nvim --server <sock> --remote-expr "luaeval('require(\"pr-tour\").<fn>(_A)', '<arg>')"`, where the Lua function returns a JSON string that the CLI prints. The plugin is responsible for producing valid JSON (`vim.json.encode`).

### 3. Neovim plugin — `nvim/lua/pr-tour/`

Exposes `load(path)`, `where()`, `jump(args)`, `clear()` for the CLI (`jump`, not `goto` — `goto` is a reserved word in LuaJIT); each wraps its body in `pcall` and returns JSON `{ok, ...}` — errors never surface as Lua exceptions in the editor.

#### Tour file format (version 1)

```json
{
  "version": 1,
  "title": "Behavior 2: route by header sniffing",
  "headRoot": "/abs/path/repo-pr-123",
  "baseRoot": "/abs/path/repo-pr-123-base",
  "stops": [{
    "title": "Pivot: sniff() replaces extension check",
    "file": "src/convert/route.ts",
    "baseFile": "src/route.ts",
    "view": "split",
    "line": 41, "endLine": 44,
    "notes": [
      {"side": "base", "line": 41, "kind": "explain", "text": "ext only — wrong for renamed files"},
      {"side": "head", "line": 41, "kind": "explain", "text": "reads the magic bytes instead"},
      {"side": "head", "line": 88, "kind": "finding", "severity": "med", "text": "lock never released on throw"}
    ],
    "more": "Optional longer explanation shown in a float on demand."
  }]
}
```

Field rules:

- `file` — path relative to `headRoot`. Required unless `view` is `base`.
- `baseFile` — path relative to `baseRoot`. Defaults to `file`. `null` for files added by the PR.
- `view` — `split` (changed file: base left, head right, diff mode), `head` (file unchanged by the PR: single pane), `base` (file deleted by the PR: single base pane).
- `line` / `endLine` — the focus range on the head side (base side for `view: "base"`). `endLine` defaults to `line`.
- `notes[].side` — `base` or `head`; must be a side the stop's view shows.
- `notes[].kind` — `explain` or `finding`. `severity` (`low`/`med`/`high`) required for `finding`, ignored otherwise.
- `more` — optional.

#### Validation (`load`)

Dropped with a reason in the report, never silently: a note whose `line` is beyond EOF, a note on a side the view doesn't show, a `finding` without `severity`, a stop whose file doesn't exist on its side (whole stop dropped). Unknown `version` → `load` fails outright. If every stop is dropped, `load` fails.

#### Rendering

- **Tour tab:** the tour opens in a dedicated tabpage. Reloading a tour reuses it. `clear` closes it. The reviewer's other tabs and windows are never touched.
- **Split view:** left window `<baseRoot>/<baseFile>`, right window `<headRoot>/<file>`, both `:diffthis`. Moving to another stop in the same file pair keeps the windows and only scrolls.
- **Base side is locked:** every buffer whose path is under `baseRoot` — including buffers opened by `gd` from the base pane — gets `readonly` and `nomodifiable` via a `BufReadPost` autocmd scoped to `baseRoot`, registered on `load` and removed on `clear`.
- **Focus range:** a subtle background highlight (`PrTourFocus`) on `line`..`endLine`.
- **Notes:** extmarks with end-of-line `virt_text`. A note wider than the space left in the window is rendered as `virt_lines` below its line, wrapped to window width. `explain` notes use `PrTourNote` (muted); `finding` notes use `PrTourFinding` plus a `◆` sign and a `[sev]` prefix. All highlight groups are `default` links so colorschemes can override.
- **Keymaps (global normal-mode maps, installed only while a tour is loaded):** `]s` / `[s` next/previous stop; outside the tour tab they fall through to the built-in spell navigation. `]n` / `[n` step through the current stop's notes by line (base before head at the same line), moving between panes and echoing `note i/n: <note>`; at either end they say so and the cursor stays. The stop arrival message includes the note count (`pr-tour 2/9 · 3 notes: <title>`). `gL` shows the cursor line's notes in full, then the stop's `more`, in a float (a message if there is neither; it does nothing outside the tour tab). `gK` was the first choice but LazyVim binds it buffer-locally to signature help on LSP attach, which shadows a global map. Any mapping the reviewer had on these keys is saved on load and restored by `clear`. Keys configurable via `require("pr-tour").setup({ keys = {...} })`.
- **Selection capture:** a `ModeChanged` autocmd on leaving visual mode records `{file, side, startLine, endLine, text, time}` for `where`.

### 4. Skill — `skills/pr-tour/SKILL.md`

Runs **inline** in the main session (same rationale as `/pr-walkthrough`: the dialogue is the deliverable). Subagents only for the Phase 1 fan-out.

**Setup**

1. Read `skills/_shared/pr-groundwork.md` and project config. Resolve PR, head SHA, merge-base (Phase 0).
2. **Workspace — head side:** use the main checkout if its working tree is clean and it can switch to the PR head; otherwise `git worktree add ../<repo>-pr-<N> <headSha>`.
3. **Workspace — base side:** always `git worktree add --detach ../<repo>-pr-<N>-base <mergeBase>`.
4. **Dependencies** for each worktree: if the PR changes dependency manifests or lockfiles (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `pyproject.toml`, `requirements*.txt`, `uv.lock`, `poetry.lock`), run a real install on the head side; otherwise symlink `node_modules` / the venv from the main checkout. Base side always symlinks from the main checkout. Report which strategy was used for each side.
5. Ask the reviewer to open Neovim in the head worktree in a kitty pane, then run `pr-tour attach <headRoot>`. Do not proceed until attach succeeds. If it can't succeed, say so and offer `/pr-walkthrough` instead — never silently fall back to prose.

**Groundwork:** shared Phases 0–2 unchanged. The behavior map is presented in Claude's pane as a short table for the reviewer to order and prune.

**Per behavior** (replaces `/pr-walkthrough` Phase 3):

1. Do the full Phase 3 analysis (before + why, the change, call chain down, back up, untouched callers, reviewer's bench, prior-artifact adjudication) — same rigor, same verification rules.
2. Encode it as a tour: before-state and pivot stops as `split`; call-chain hops in unchanged files as `head`; deleted code as `base`. Findings become `finding` notes on their lines. "Checked and fine" items become `explain` notes where they have an anchor. Surprising or load-bearing hops get their own stop.
3. **Note discipline:** each note ≤ ~80 characters, one claim, plain words (the plain-over-dense rule applies with more force). Anything longer goes in the stop's `more`, or waits until asked.
4. Write the tour to the scratchpad, `pr-tour load`. If the report lists dropped items, fix and reload. Then say **one line** in the pane: `Behavior N loaded: K stops, F findings.`
5. While the reviewer walks: on any question, run `pr-tour where` first and answer short, against the stop/line/selection they're on. Use `goto` when showing beats telling.
6. When the reviewer says they're done with the behavior, post a short numbered list: findings (severity, one line, stop + line) and checked-and-fine items. The reviewer replies by number. Accepted findings carry their file/line forward into the review draft.

**After all behaviors:** Phase 4 (cross-slice synthesis), Phase 4.5 (plain-language recap — kept short), and Phase 5 (draft, approve, post — including all posting mechanics) run in the pane exactly as `/pr-walkthrough` specifies. Phase 5 content is referenced, not duplicated: `/pr-tour` instructs Claude to follow `/pr-walkthrough`'s Phase 4–5 sections.

**Teardown:** `pr-tour clear`. Offer to remove both worktrees (`git worktree remove`); remove only on confirmation. Running notes and review record follow `/pr-walkthrough`'s rules (`notesPath`, `recordDestination`).

## Error handling summary

| Failure | Behavior |
|---|---|
| No Neovim in head worktree | `attach` errors with the path to open; skill waits / offers `/pr-walkthrough`. |
| Several Neovims in head worktree | `attach` lists them; reviewer closes one or sets `PR_TOUR_NVIM_SOCKET`. |
| Neovim closed/restarted mid-review | CLI re-discovers once; else errors with re-attach instruction. Tour reload restores state. |
| Bad tour content | `load` drops and reports; Claude fixes and reloads. |
| Lua error | Caught by `pcall`, returned as `{ok:false}`; editor unaffected. |
| PR head moves mid-review | Worktrees are pinned to SHAs, so the tour stays coherent; Phase 5's head-SHA re-check before posting governs the review. |

## Testing

- **Integration tests** in `tests/pr-tour.test.ts`, run by `npm test` (node `--test` via tsx — no new framework). Each test starts a headless Neovim (`nvim --headless --clean --listen <sock>`, plugin added via `runtimepath`), runs the real `scripts/pr-tour`, and asserts through `--remote-expr`:
  - notes land on the correct lines and sides; findings carry the sign and severity
  - `split` builds two diff windows; `head`/`base` build one
  - `]s` / `[s` move between stops (driven via `nvim_feedkeys` / `nvim_input`)
  - `where` reports stop, side, cursor, and a captured selection
  - base-side buffers are `nomodifiable`
  - `clear` removes extmarks, the tab, and keymaps
- **Fixture:** a git repo created in a temp dir by the test, with a modified, renamed, added, deleted, and unchanged file across two commits, plus head and base worktrees. A second tour with deliberately invalid notes asserts the validation report.
- **Discovery:** two headless instances in different dirs (correct match), two in the same dir (ambiguity error), none (clear error), a dead socket (skipped).
- Tests skip with a message if `nvim` is not on PATH.
- **End-to-end acceptance:** one real `/pr-tour` run on an actual PR in the reviewer's LazyVim, including confirming per-worktree LSP roots (base files get their own client; `gd`/`gr`/`K` work on both sides). Not done until this passes.

## Packaging

- Add `nvim` to the non-rsync fallback copy list in `scripts/build.sh` (rsync already copies the whole tree).
- README: a `/pr-tour` section with the LazyVim spec and the kitty two-pane setup:
  ```lua
  { dir = "~/.claude/plugins/data/codebase-guardian-codebase-guardian/app/nvim", name = "pr-tour", opts = {} }
  ```
- Add `pr-tour` to the skills list in the README and CLAUDE.md project structure.
- Bump `package.json` (and `.claude-plugin/plugin.json` for publishing) so the bootstrap rebuilds and `app/nvim` appears.
