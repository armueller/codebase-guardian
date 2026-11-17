<!--
@what Design for four index-rebuild fixes: a `tsconfig` path field in guardian.config.json so the TypeScript call graph works when tsconfig.json is not at the git root, rebuild phases that fail independently and report what was skipped, an MCP server that re-reads project config instead of freezing it at startup, and one shared file list (with excludeDirectories applied) for the indexer and the call graph.
@domain code-index, call-graph, config, rebuild
@tags design, tsconfig, guardian-config, rebuild-index, exclude-directories, mcp-server, ts-morph
-->

# tsconfig path + rebuild resilience

**Date:** 2026-11-16
**Branch:** `fix/tsconfig-path-and-rebuild-resilience`
**Status:** Approved by Austin 2026-11-16. Plan: `docs/plans/2026-11-16-tsconfig-path-and-rebuild-resilience.md`

## Why

The project that reported this keeps its TypeScript app in `web/` and has no `tsconfig.json` at the git root. `rebuild_index` there returned `Error: File not found: <root>/tsconfig.json` and left an index with no Tier 2 rows, no call edges and no docs. Investigating that one report found four separate defects in guardian (0.8.2, `2e8bae7`):

1. **The call graph only looks for `<git root>/tsconfig.json`.** `loadProject()` in `src/mcp-server/call-graph.ts` hard-codes the path, and ts-morph throws when the file is missing. Four other indexed projects have no root tsconfig either, so they fail the same way.
2. **One failed phase aborts the rest.** The throw skips the Python call graph and the validation-cache clear, which run after the TypeScript call graph. The result is a bare error that does not say phase 1 succeeded or what was skipped. The pipeline is also written twice (`index.ts` `rebuild_index` and `build-index.ts`).
3. **The MCP server freezes its config at startup.** `resolveConfig()` caches per project root for the life of the process. That project's server started before `guardian.config.json` and `docs/` existed, so the rebuild used `sourceDirectories ["."]` and `docsDirectories []` and ignored the config file written one second earlier.
4. **The two phases index different files, and `excludeDirectories` does nothing.** The indexer's walker skips a hard-coded folder list. The call graph uses its own glob, which loads everything under a source directory, including `node_modules` and `build` (verified). `excludeDirectories` is read into the config and consumed by no code.

## Goals

- `rebuild_index` completes Tier 2 discovery and the call graph for a repo whose tsconfig is in a sub-folder, with that tsconfig's path aliases honoured, without a tsconfig at the git root.
- A repo with no tsconfig at all still gets a rebuild that finishes.
- A failure in one phase never prevents the others, and the result names each phase that failed or degraded and why.
- A change to `guardian.config.json`, or to the folders auto-detection looks at, takes effect on the next rebuild without restarting the server.
- The indexer and the call graph read the same set of files, and `excludeDirectories` controls that set.

## Non-goals

- More than one TypeScript root per repo (for example a repo that also has an `mcp-server/tsconfig.json`). The field is a single path. It can widen to a list later without breaking existing configs.
- Solution-style configs whose real settings live in a referenced file such as `tsconfig.app.json`. Pointing the field at that file directly already works.
- Changing the hook. It never reads a tsconfig.
- Applying `excludeDirectories` to the git-based staleness count.

## Anti-goals

- Guessing. An explicit `tsconfig` path that does not exist must not silently fall back to something else.
- A rebuild that looks complete when part of it did not run.

## Approaches

**A. Nearest tsconfig per file.** Each TypeScript file uses the closest `tsconfig.json` above it, one compiler project per tsconfig, compiler defaults for files with none. No config needed, and covers several TypeScript roots. Larger change; calls between roots resolve by name only.

**B. A `tsconfig` path in `guardian.config.json` (chosen).** One optional field, relative to the git root. Smaller, and the repo states which tsconfig is meant instead of guardian inferring it. Handles one root.

**C. A plus an override field.** Only useful for solution-style configs, which none of the indexed projects use.

Austin chose B on 2026-11-16: it is the smaller change and it is explicit.

## Design

### 1. The `tsconfig` field

`guardian.config.json` gains an optional `"tsconfig"`: a path to a tsconfig file, relative to the git root (for example `"web/tsconfig.json"`). `GuardianConfig` carries the outcome as one of three cases: a file that exists (configured, or the root `tsconfig.json`), none, or invalid with a reason (configured but missing, or not a non-empty string).

Resolution, in order:

| Case | TypeScript call graph | Reported as |
|---|---|---|
| `tsconfig` set, file exists | built with that file | ok |
| `tsconfig` set, file missing | the rebuild does not start (changed 2026-11-17, see section 6; first built as a failed phase) | `tsconfig "<path>" from guardian.config.json does not exist` |
| not set, `<root>/tsconfig.json` exists | built with it (today's behaviour) | ok |
| not set, no root tsconfig, TypeScript files present | built with compiler defaults | degraded: no tsconfig found, path aliases are not resolved; set `"tsconfig"` |
| no TypeScript files in the source directories | nothing to build | ok, noted as "no TypeScript files" |

Compiler defaults still yield export discovery, and calls through relative imports still resolve to their file. Calls through a path alias do not, and they get no call edge. An unresolvable alias import comes back from the compiler as its own import specifier in the calling file, so the callee lookup is made against the calling file and finds nothing. Measured on the reporting project with the built CLI: 108 call edges with `"tsconfig": "web/tsconfig.json"`, 65 without, and none of the route-to-`lib` calls (all alias imports) keep an edge. That loss is why the case is reported as degraded and not ok. (Corrected twice on 2026-11-16: the first draft said these edges were lost, which was right; a later edit claimed they were matched by function name, which was an inference from reading the code and was disproved by the measurement above.)

Source-directory auto-detection (`detectSourceDirectories`) reads the same resolved tsconfig and treats its `include` entries as relative to that file's folder, so there is one notion of "the project's tsconfig". It only runs when `sourceDirectories` is not set.

Stored paths do not change: the call graph already records paths relative to the git root wherever the tsconfig sits.

### 2. One rebuild pipeline, phases isolated

A new module (`src/mcp-server/rebuild.ts`) owns the full rebuild and is the only caller of the phases. Both `rebuild_index` and the `build-index` CLI call it.

Phases, in order: clear data → index code and docs → TypeScript call graph → Python call graph → clear validation cache and sessions. Each runs in its own try/catch and returns a status: `ok`, `degraded` (ran, with a stated limitation), or `failed` (with the error message). A failure is recorded and the next phase runs.

One exception: if "index code and docs" fails, the two call-graph phases are marked `skipped: indexing failed`, because they resolve against its rows. The cache clear still runs.

The result lists every phase with its status. `rebuild_index` heads it "Index Rebuild Complete" only when every phase is `ok`; otherwise "Index Rebuild Finished With Problems", followed by the per-phase lines and then the usual counts. It sets `isError` only when indexing itself failed. The CLI prints the same lines and exits non-zero when any phase failed.

### 3. Fresh config in the server

`resolveConfig` gains a way to bypass the cache. The MCP server resolves the project root once at startup (it cannot change for a running server, and the database path derives from it) and re-reads everything else (`guardian.config.json` and the auto-detected folders) at the start of `rebuild_index`, `index_status` and auto-sync. The hook keeps the cache: it is a short-lived process and the cache exists to avoid repeated `git rev-parse` calls within one invocation.

### 4. One file list, `excludeDirectories` applied

The walker in `indexer.ts` becomes the single source of "which files are in the index". The call graph stops globbing and adds exactly the `.ts`/`.tsx` files the walker returns. Test files (`*.test.ts[x]`) are already dropped by the walker and already ignored by the call graph, so its output does not change for files that were in both sets.

`excludeDirectories` takes over from the hard-coded `WALK_EXCLUDE_DIRS`. The default list is that walker list (a superset of the old `DEFAULT_EXCLUDE`), so repos without the field behave as before. A value in `guardian.config.json` is **added to** the default list; the defaults always apply and cannot be removed (decided by Austin on 2026-11-17, replacing the earlier "replaces the default" call; see section 5). An entry with no slash matches a folder of that name at any depth (`node_modules`); an entry with a slash matches that path relative to the git root (`web/data`).

### 5. Added after the whole-branch review (2026-11-16)

The review found four ways the first implementation still broke the anti-goal or the documented rules. All are fixed:

- **Python that was never indexed read as complete.** With no Python interpreter, no Python rows are written, so "degraded when the index holds Python rows" could never fire. The index phase now counts Python files it could not extract and is `degraded` when the count is non-zero; the Python call graph is `degraded` when it could not run and the project has Python by either measure.
- **A configured source or docs directory that does not exist** was walked as empty. The index phase is now `degraded` and names the directory.
- **`./data` and `/data` matched at any depth.** The leading prefix was stripped before deciding whether the entry was a path. An entry is now a path if it contains a slash before the prefix is stripped, so `./data` means the top-level folder only.
- **The four list fields were not validated.** `"excludeDirectories": [5]` threw mid-rebuild after the old index was cleared. A list field with the wrong shape is now ignored, its default is used, and the rebuild reports it. A config file whose root is not a JSON object is reported the same way as one that is not JSON.

When the index phase has more than one limitation, the report lists all of them.

**Decided by Austin on 2026-11-17: `excludeDirectories` adds to the defaults.** The first implementation replaced the default list, as originally approved. The review pointed out that before 0.8.3 the field was ignored and the 15 defaults always applied, so every existing config that sets the field effectively had "add" behaviour, and under "replace" a config without `.claude`, `.venv` or `site-packages` would start indexing Claude worktrees and virtualenvs. With "add", upgrading can only skip more folders. The cost is that a folder named like a default (`build`, `dist`) can never be indexed from inside a source directory; Austin confirmed those should not be indexed anyway. The README example and the template now list only project-specific entries.

### 6. After the PR audit (2026-11-17)

`/pr-audit` ran on the PR and Austin's instruction was to fix everything it raised. The changes to the design:

- **A rebuild never starts from a configuration it knows is broken.** This replaces "a missing configured tsconfig fails that phase" (section 1) and "an unparseable config file gives a degraded rebuild with auto-detected settings" (sections 2 and 5). The audit showed that a typo in `tsconfig` wiped a good index and replaced it with one that had no TypeScript call graph. The same is true of every definite config error, so they are all checked before anything is cleared: an unusable `guardian.config.json`, a field with the wrong shape, an invalid tsconfig, a tsconfig that cannot be loaded. The result reads "Index Rebuild Not Started", lists the problems, and the existing index is untouched. Things that are not definitely errors still run and are reported as `degraded`: a configured directory that does not exist, Python that could not be extracted. The hook is unaffected and stays fail-open; it uses the default for a setting it could not read.
- **`tsconfig` must be a file inside the project root.** A folder, a path outside the root, and the root itself are `invalid`. `null` means not set, and the value is trimmed. Before this, `"tsconfig": "."` made source-directory detection return `..` and the rebuild indexed sibling folders.
- **Auto-detection keeps only folders.** A tsconfig `include` entry that names a file (`vite.config.ts`, `next-env.d.ts`) was returned as a source directory. Tsconfig files are read with a small comment-tolerant parser, because `tsc --init` writes comments and the plain JSON parser silently lost the `include` list. The parser is hand-written on purpose: config loading must not import the TypeScript compiler, since the search-hint hook resolves config on every grep.
- **More ways the call graph is reported as degraded.** A tsconfig that loads with errors (a missing `extends` target) and a solution-style tsconfig (`references`, no `paths` of its own) both built a graph with alias edges missing and read `ok`.
- **More ways indexing is reported as degraded.** Python that sits outside the source directories when no Python was indexed (this repo itself was the example; it now has a `guardian.config.json` listing `src` and `python`), folders that could not be read, a rebuild that found no code files, and the names of the first few Python files that could not be indexed.
- **The rebuild's outcome is stored** in the metadata table, and `index_status` shows it.
- **The file list is computed once per rebuild** and passed to both phases, and `repoRoot` must equal the config's project root. The incremental path asks `classifyIndexFile` for the verdict a full walk would give each file, so auto-sync can no longer index a file a full rebuild skips.
- **The Python call graph takes its exclude list from Node**, so `src/config.ts` is the one source for both languages.
- **Every field in `guardian.config.json` is validated**, including the `jsdoc` and `searchHint` groups the hook reads, each exclude entry (trimmed; a glob pattern is an error) and each file extension (must start with a dot).

Left as it was, with the reason:

- Export discovery keeps its old path filter (`node_modules`, `.test.`, `__`) for Tier 2 only. Removing it would add Tier 2 rows to existing indexes that have `__mocks__`-style folders.
- A call graph that fails while it runs (after the preflight passed) still drops Tier 2 discovery along with the edges: both come from one compiler project.
- The call graph reads the same extensions as the indexer, so a config listing only `.ts` gets no `.tsx` Tier 2 rows. That follows from the single file list.

Still out of scope: more than one TypeScript root per project; applying `excludeDirectories` to the git-based staleness count; the hook's function-extractor false positives (tracked in issue #25).

## Calls I made (not decisions Austin stated)

- No tsconfig and no field → compiler defaults reported as degraded, instead of skipping the TypeScript call graph.
- Field set but file missing → that phase fails; no fallback.
- ~~`excludeDirectories` replaces the default list instead of adding to it, matching the README, the template and the other fields.~~ Reversed on 2026-11-17: it adds to the defaults (section 5).
- Slash/no-slash matching for `excludeDirectories` entries.
- `isError` only when indexing failed; a degraded or failed call graph is a visible problem in a usable result.
- Auto-detection of source directories follows the configured tsconfig.
- The four fixes ship together on one branch, as separate commits.
- Added while planning, both from the "looks complete when it is not" anti-goal: a `guardian.config.json` that cannot be parsed is reported in the rebuild result (today it is silently ignored), and a Python call graph that produced nothing because the interpreter or helper failed is reported as degraded when the index holds Python rows.

## Testing

No test covers `call-graph.ts` today. New fixture repos under `tests/fixtures/`:

- root tsconfig (regression: output unchanged);
- sub-folder tsconfig with a path alias and the field set: Tier 2 rows exist and a call through the alias produces an edge to the right file;
- same repo without the field: degraded status, relative-import edge present, no edge for the alias call (to either same-named function);
- field pointing at a missing file: TypeScript phase failed, Python call graph and cache clear still ran;
- a source directory containing `node_modules`, `build` and a path-style exclude: none of them reach either phase.

Plus: config tests for `tsconfig` resolution and the cache bypass (write `guardian.config.json` after a first resolve, confirm the second resolve sees it), and a pipeline test that a throwing phase does not stop later ones and appears in the result.

Final check against the real case: rebuild the reporting project with `"tsconfig": "web/tsconfig.json"` and confirm Tier 2 > 0, call edges > 0, the two plan docs as Tier 3, and no `web/.react-router` or `web/*.config.ts` rows.

## Docs and release

README configuration section (new field, what `excludeDirectories` matches, what a degraded rebuild means), `templates/guardian.config.json`, `docs/indexing-pipeline.md`, and the project `CLAUDE.md` structure list for the new module. Version bump to 0.8.3 in `package.json` and `.claude-plugin/plugin.json`.

## Left to the builder

Names and signatures of the new functions, the exact wording of result lines, and how fixtures are laid out.
