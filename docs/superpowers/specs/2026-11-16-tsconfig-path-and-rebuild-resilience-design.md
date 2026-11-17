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

`the reporting project` keeps its TypeScript app in `web/` and has no `tsconfig.json` at the git root. `rebuild_index` there returned `Error: File not found: <root>/tsconfig.json` and left an index with no Tier 2 rows, no call edges and no docs. Investigating that one report found four separate defects in guardian (0.8.2, `2e8bae7`):

1. **The call graph only looks for `<git root>/tsconfig.json`.** `loadProject()` in `src/mcp-server/call-graph.ts` hard-codes the path, and ts-morph throws when the file is missing. `project B`, `project C`, `project D` and `project E` have no root tsconfig either, so they fail the same way.
2. **One failed phase aborts the rest.** The throw skips the Python call graph and the validation-cache clear, which run after the TypeScript call graph. The result is a bare error that does not say phase 1 succeeded or what was skipped. The pipeline is also written twice (`index.ts` `rebuild_index` and `build-index.ts`).
3. **The MCP server freezes its config at startup.** `resolveConfig()` caches per project root for the life of the process. The the reporting project server started before `guardian.config.json` and `docs/` existed, so the rebuild used `sourceDirectories ["."]` and `docsDirectories []` and ignored the config file written one second earlier.
4. **The two phases index different files, and `excludeDirectories` does nothing.** The indexer's walker skips a hard-coded folder list. The call graph uses its own glob, which loads everything under a source directory, including `node_modules` and `build` (verified). `excludeDirectories` is read into the config and consumed by no code.

## Goals

- `rebuild_index` completes Tier 2 discovery and the call graph for a repo whose tsconfig is in a sub-folder, with that tsconfig's path aliases honoured, without a tsconfig at the git root.
- A repo with no tsconfig at all still gets a rebuild that finishes.
- A failure in one phase never prevents the others, and the result names each phase that failed or degraded and why.
- A change to `guardian.config.json`, or to the folders auto-detection looks at, takes effect on the next rebuild without restarting the server.
- The indexer and the call graph read the same set of files, and `excludeDirectories` controls that set.

## Non-goals

- More than one TypeScript root per repo (for example `project F`'s `mcp-server/tsconfig.json`). The field is a single path. It can widen to a list later without breaking existing configs.
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
| `tsconfig` set, file missing | not built | failed: `tsconfig "<path>" from guardian.config.json does not exist` |
| not set, `<root>/tsconfig.json` exists | built with it (today's behaviour) | ok |
| not set, no root tsconfig, TypeScript files present | built with compiler defaults | degraded: no tsconfig found, path aliases are not resolved; set `"tsconfig"` |
| no TypeScript files in the source directories | nothing to build | ok, noted as "no TypeScript files" |

Compiler defaults still yield export discovery, and calls through relative imports still resolve to their file. Calls through a path alias do not: on the reporting project 635 of 877 calls resolve to a file, and none of the 267 calls through the `~/` alias do. Those calls are not dropped. The existing fallback matches them by function name alone (`getFunctionByName` with no file), which is right when the name is unique in the index and picks an arbitrary row when two functions share it. That ambiguity is why the case is reported as degraded and not ok. (Corrected 2026-11-16: an earlier draft said the alias edges were lost.)

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

`excludeDirectories` replaces the hard-coded `WALK_EXCLUDE_DIRS`. The default becomes today's walker list (which is a superset of the current `DEFAULT_EXCLUDE`), so repos without the field behave as now. Like every other field, a value in `guardian.config.json` replaces the default. An entry with no slash matches a folder of that name at any depth (`node_modules`); an entry with a slash matches that path relative to the git root (`web/data`).

## Calls I made (not decisions Austin stated)

- No tsconfig and no field → compiler defaults reported as degraded, instead of skipping the TypeScript call graph.
- Field set but file missing → that phase fails; no fallback.
- `excludeDirectories` replaces the default list instead of adding to it, matching the README, the template and the other fields.
- Slash/no-slash matching for `excludeDirectories` entries.
- `isError` only when indexing failed; a degraded or failed call graph is a visible problem in a usable result.
- Auto-detection of source directories follows the configured tsconfig.
- The four fixes ship together on one branch, as separate commits.
- Added while planning, both from the "looks complete when it is not" anti-goal: a `guardian.config.json` that cannot be parsed is reported in the rebuild result (today it is silently ignored), and a Python call graph that produced nothing because the interpreter or helper failed is reported as degraded when the index holds Python rows.

## Testing

No test covers `call-graph.ts` today. New fixture repos under `tests/fixtures/`:

- root tsconfig (regression: output unchanged);
- sub-folder tsconfig with a path alias and the field set: Tier 2 rows exist and a call through the alias produces an edge to the right file;
- same repo without the field: degraded status, relative-import edge present (the alias call is matched by name only, so its target is not asserted);
- field pointing at a missing file: TypeScript phase failed, Python call graph and cache clear still ran;
- a source directory containing `node_modules`, `build` and a path-style exclude: none of them reach either phase.

Plus: config tests for `tsconfig` resolution and the cache bypass (write `guardian.config.json` after a first resolve, confirm the second resolve sees it), and a pipeline test that a throwing phase does not stop later ones and appears in the result.

Final check against the real case: rebuild the reporting project with `"tsconfig": "web/tsconfig.json"` and confirm Tier 2 > 0, call edges > 0, the two plan docs as Tier 3, and no `web/.react-router` or `web/*.config.ts` rows.

## Docs and release

README configuration section (new field, what `excludeDirectories` matches, what a degraded rebuild means), `templates/guardian.config.json`, `docs/indexing-pipeline.md`, and the project `CLAUDE.md` structure list for the new module. Version bump to 0.8.3 in `package.json` and `.claude-plugin/plugin.json`.

## Left to the builder

Names and signatures of the new functions, the exact wording of result lines, and how fixtures are laid out.
