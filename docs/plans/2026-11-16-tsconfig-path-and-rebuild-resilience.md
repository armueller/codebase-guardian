<!--
@what Implementation plan for the tsconfig path field and rebuild resilience fixes: a `tsconfig` field in guardian.config.json, one shared file list with excludeDirectories applied, a single rebuild pipeline whose phases fail independently and report their status, and an MCP server that re-reads project config on every rebuild.
@domain code-index, call-graph, config, rebuild
@tags plan, tsconfig, guardian-config, rebuild-index, exclude-directories, mcp-server, ts-morph
-->

# tsconfig Path + Rebuild Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-11-16 · **Branch:** `fix/tsconfig-path-and-rebuild-resilience` · **Vault mirror:** `Project Plans/codebase-guardian/Fix - Tsconfig Path and Rebuild Resilience.md`

**Summary:** `rebuild_index` aborted on a repo whose tsconfig is in a sub-folder, and the investigation found three more defects behind it. This plan fixes all four.

**Goal:** A rebuild finishes and reports honestly on any repo layout: tsconfig at the root, in a sub-folder, or absent.

**Architecture:** `config.ts` resolves which tsconfig applies and can rebuild a config from disk on demand. A new `file-walk.ts` is the only place that decides which files are in the index. A new `rebuild.ts` owns the phase sequence and is called by both the MCP tool and the CLI.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), ts-morph, better-sqlite3, Node's `--test` runner via `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-16-tsconfig-path-and-rebuild-resilience-design.md`

## Execution Notes (2026-11-16)

All six tasks are done on `fix/tsconfig-path-and-rebuild-resilience`. Suite: 414 tests before, 459 after, all passing. Decisions made during execution that differ from the steps below:

- **Degraded mode loses alias edges; it does not match them by name.** The real-case run gave 108 call edges with `"tsconfig": "web/tsconfig.json"` and 65 without. An unresolvable alias import resolves to its own import specifier in the calling file, so the callee lookup finds nothing. The note, README, spec and the Task 3 test now say "not linked". Behaviour was left alone: name-matching unresolved imports would also link calls into npm packages to same-named local functions.
- **The `ts-subdir` fixture is built by `tests/helpers/ts-subdir-repo.ts`** in a temp dir, not committed under `tests/fixtures/`. Every test needs its own writable copy.
- **Files are added to the ts-morph project by exact path**, not by glob, so route files named `[id].ts` or `(group)/$slug.ts` load. A test covers it.
- **A tsconfig that exists but cannot be loaded** fails the phase as `could not load tsconfig "<path>": <reason>`; ts-morph's own message does not name the file.
- **When clearing the old index fails**, indexing is skipped with "clearing the old index failed" and the call graphs with "indexing did not run".
- **Real-case Tier 3 is 3, not 2**: the other repo gained a third plan doc after this plan was written.
- **Working with the edit hook in this repo:** a function's JSDoc, signature and body must change in one Edit. The hook compares the docs with the body after every individual edit and denies a half-finished change.

Not done here, by design: push, tag, publish. The installed plugin stays on 0.8.2 until Austin releases 0.8.3.

## Global Constraints

- Config field name is exactly `"tsconfig"`: one path, relative to the git root. Not a list.
- A configured tsconfig that is missing or unusable never falls back to another file.
- `excludeDirectories` in `guardian.config.json` replaces the default list. An entry with no `/` matches a folder of that name at any depth. An entry with a `/` matches that path relative to the git root.
- Default exclude list is today's walker list, verbatim: `node_modules, dist, .claude, cdk.out, build, __snapshots__, .next, .turbo, coverage, .venv, __pycache__, .pytest_cache, site-packages, .mypy_cache, .ruff_cache`.
- Stored `file_path` values stay relative to the git root.
- The hook is not changed and keeps the config cache.
- Every new or modified function needs the JSDoc tag set the guardian hook enforces in this repo (`@what @how @why @sideeffects @systemlayer @domain @tags`), or the edit is denied.
- Commits carry no Claude attribution. Never `--no-verify`.
- Run tests from the repo: `npx tsx --test tests/<file>.test.ts`; full suite `npm test`.
- Version after this work: `0.8.3` in `package.json` and `.claude-plugin/plugin.json`.

## Review Focus

1. `"tsconfig"` is present but not a non-empty string (a number, a list, `""`): the TypeScript call graph fails with a message naming the bad value; nothing else is affected. → Task 1.
2. `guardian.config.json` exists but is not valid JSON: today it is silently ignored. The rebuild must say so. → Tasks 1 and 4.
3. The configured tsconfig exists but is malformed: the rebuild still finishes and every other phase runs. → Task 4.
4. Overlapping `sourceDirectories` (`[".", "web/app"]`): each file is indexed once. → Task 2.
5. Exclude entries written `"web/data/"` or `"./web/data"`: they still match `web/data`. → Task 2.

## File Structure

| File | Responsibility |
|---|---|
| `src/config.ts` (modify) | `tsconfig` resolution, `reloadConfig`, config-file error, default excludes, source-directory detection relative to the resolved tsconfig |
| `src/mcp-server/file-walk.ts` (create) | The one answer to "which files are in the index"; walker and exclude matching move here from `indexer.ts` |
| `src/mcp-server/indexer.ts` (modify) | Uses `file-walk.ts`; accepts an explicit config |
| `src/mcp-server/call-graph.ts` (modify) | Builds the ts-morph project from the resolved tsconfig and the shared file list; returns a status |
| `src/mcp-server/py-call-graph.ts` (modify) | Returns why it produced nothing, when it did |
| `src/mcp-server/rebuild.ts` (create) | Phase sequence, isolation, result, report lines |
| `src/mcp-server/build-index.ts`, `src/mcp-server/index.ts` (modify) | Call `rebuild.ts`; the server reloads config |

---

### Task 1: Config resolves the tsconfig and can be reloaded

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export type TsconfigResolution =
    | { kind: 'file'; path: string }      // absolute; exists; configured or <root>/tsconfig.json
    | { kind: 'none' }                    // not configured and no <root>/tsconfig.json
    | { kind: 'invalid'; reason: string } // configured but unusable
  // added to GuardianConfig:
  tsconfig: TsconfigResolution;
  configFileError: string | null;         // guardian.config.json present but unparseable
  export const DEFAULT_EXCLUDE: string[]; // the 15 entries in Global Constraints
  export function reloadConfig(projectRoot: string): GuardianConfig;
  ```
  `reloadConfig` rebuilds the config for a known root from disk, without re-detecting the root, and replaces the cache entry. `resolveConfig` keeps its signature and its cache.

Each test builds a temp dir with `mkdtempSync` and calls `reloadConfig(dir)`.

- [x] **Step 1: Write the failing tests** in `tests/config.test.ts`:

  | Test | Setup | Assertion |
  |---|---|---|
  | configured tsconfig | `guardian.config.json` `{"tsconfig":"web/tsconfig.json"}`, file exists | `tsconfig` deep-equals `{kind:'file', path: <dir>/web/tsconfig.json}` |
  | configured but missing | same config, no file | `kind === 'invalid'`, `reason === 'tsconfig "web/tsconfig.json" from guardian.config.json does not exist'` |
  | root tsconfig | no field, `<dir>/tsconfig.json` exists | `{kind:'file', path: <dir>/tsconfig.json}` |
  | none | no field, no root tsconfig | `{kind:'none'}` |
  | not a string | `{"tsconfig": 5}`, then `[]`, then `""` | `kind === 'invalid'` and `reason` contains `must be a non-empty string` |
  | config file unparseable | `guardian.config.json` containing `{ not json` | `configFileError` is a non-empty string; `sourceDirectories` is the auto-detected value |
  | reload sees a later file | `reloadConfig(dir)` → `sourceDirectories` is `['.']`; write `{"sourceDirectories":["lib"]}`; `reloadConfig(dir)` again | second result is `['lib']`, and `resolveConfig(dir)` now returns `['lib']` too (set `GUARDIAN_PROJECT_ROOT=dir` for that call, restore after) |
  | default excludes | no config file | `excludeDirectories` deep-equals `DEFAULT_EXCLUDE`, length 15 |
  | detection follows sub-folder tsconfig | `{"tsconfig":"web/tsconfig.json"}`, `web/tsconfig.json` `{"include":["src/**/*"]}`, `web/src/` exists | `sourceDirectories` deep-equals `['web/src']` |
  | detection falls back under the tsconfig folder | same, `include` is `["**/*"]`, `web/app/` exists | `['web/app']` |
  | root detection unchanged | root `tsconfig.json` `{"include":["src/**/*","app/**/*"]}`, both exist | `['src','app']` |

- [x] **Step 2: Run** `npx tsx --test tests/config.test.ts`. Expected: FAIL (`reloadConfig` is not exported).

- [x] **Step 3: Implement** in `src/config.ts`.
  - Split `resolveConfig` into root detection plus a private builder that takes a root; `reloadConfig` calls the builder and overwrites `configCache`.
  - `loadConfigFile` returns both the parsed object and the parse error message.
  - Add `tsconfig?: unknown` to `GuardianConfigFile` and resolve it per the table above; resolve relative values with `path.resolve(projectRoot, value)`.
  - `DEFAULT_EXCLUDE` becomes the 15-entry list and is exported.
  - `detectSourceDirectories(projectRoot, tsconfigFile: string | null)`: read `include` from `tsconfigFile`; `base` is that file's folder relative to the root (`''` at the root). Include-derived folders are joined under `base`. If none exist, try `src, app, lib, packages` under `base`. If none of those exist either, return `[base]` when `base` is non-empty and `['.']` otherwise. With no tsconfig, behave as today.

- [x] **Step 4: Run** `npx tsx --test tests/config.test.ts`. Expected: PASS. Then `npm test`: no regressions.

- [x] **Step 5: Commit** `feat(config): tsconfig path field, reloadConfig, config-file error`

---

### Task 2: One file list, with `excludeDirectories` applied

**Files:**
- Create: `src/mcp-server/file-walk.ts`
- Modify: `src/mcp-server/indexer.ts` (remove `WALK_EXCLUDE_DIRS`, `walkDirectory`, `findReadmeFiles` at lines 656–724; file collection at 887–906; the diagnostic at 1120–1123)
- Test: `tests/file-walk.test.ts` (create)

**Interfaces:**
- Consumes: `GuardianConfig`, `DEFAULT_EXCLUDE` (Task 1).
- Produces:
  ```ts
  export interface IndexFileSet { codeFiles: string[]; docFiles: string[] } // absolute, de-duplicated, sorted
  export function listIndexFiles(config: GuardianConfig): IndexFileSet;
  /** relDir: folder path relative to the project root, '/'-separated */
  export function isExcludedDir(relDir: string, exclude: string[]): boolean;
  export function walkDirectory(dir: string, extensions: string[], scope: { projectRoot: string; exclude: string[] }): string[];
  ```
  `buildIndex` gains `options.config?: GuardianConfig` (falls back to `resolveConfig(repoRoot)`).

`listIndexFiles` keeps today's rules: code files are `fileExtensions` under `sourceDirectories`, minus `*.test.ts[x]` and Python test files; doc files are `.md` under `docsDirectories` plus every `README.md` under `sourceDirectories`. A source directory is always walked, even if its own name is on the exclude list.

- [x] **Step 1: Write the failing tests** in `tests/file-walk.test.ts`. Build this tree in a temp dir (not a committed fixture: `.gitignore` drops `node_modules/`):

  ```
  web/app/a.ts            web/app/a.test.ts        web/app/README.md
  web/app/node_modules/p/x.ts     web/app/build/y.ts     web/app/data/z.ts
  web/app/nested/data/keep.ts     docs/guide.md
  ```
  With `sourceDirectories ['web/app']`, `docsDirectories ['docs']`:

  | Test | `excludeDirectories` | `codeFiles` (relative to the temp dir) |
  |---|---|---|
  | defaults | `DEFAULT_EXCLUDE` | `web/app/a.ts`, `web/app/data/z.ts`, `web/app/nested/data/keep.ts` |
  | bare name, any depth | `['data']` | `web/app/a.ts`, `web/app/build/y.ts`, `web/app/node_modules/p/x.ts` |
  | path entry, that path only | `[...DEFAULT_EXCLUDE, 'web/app/data']` | `web/app/a.ts`, `web/app/nested/data/keep.ts` |
  | trailing slash and `./` | `[...DEFAULT_EXCLUDE, './web/app/data/']` | same as the row above |
  | overlapping source dirs | defaults, `sourceDirectories ['.', 'web/app']` | each file once |

  Also assert `docFiles` is `docs/guide.md` and `web/app/README.md` in the defaults row, and `isExcludedDir('web/app/data', ['web/app/data']) === true`, `isExcludedDir('other/data', ['web/app/data']) === false`, `isExcludedDir('x/y/node_modules', ['node_modules']) === true`.

- [x] **Step 2: Run** `npx tsx --test tests/file-walk.test.ts`. Expected: FAIL (module not found).

- [x] **Step 3: Implement** `file-walk.ts` by moving the two walkers out of `indexer.ts` and replacing the hard-coded list check with `isExcludedDir`. Point `buildIndex`'s full-rebuild branch at `listIndexFiles(config)` and the Python diagnostic at the new `walkDirectory`.

- [x] **Step 4: Run** `npx tsx --test tests/file-walk.test.ts tests/indexer.test.ts tests/py-index.test.ts tests/ts-comments-index.test.ts`. Expected: PASS.

- [x] **Step 5: Commit** `refactor(index): one file list for the index, excludeDirectories applied`

---

### Task 3: Call graph uses the resolved tsconfig and the shared file list

**Files:**
- Modify: `src/mcp-server/call-graph.ts` (`loadProject` lines 32–52; `buildCallGraph` lines 250–314)
- Create: `tests/fixtures/ts-subdir/` (below)
- Test: `tests/call-graph.test.ts` (create)

**Interfaces:**
- Consumes: `config.tsconfig` (Task 1), `listIndexFiles` and `buildIndex`'s `options.config` (Task 2).
- Produces:
  ```ts
  export interface CallGraphResult {
    exportsDiscovered: number;
    edgesCreated: number;
    status: 'ok' | 'degraded';
    note: string | null;
  }
  export async function buildCallGraph(db: Database.Database, repoRoot: string, opts?: { config?: GuardianConfig }): Promise<CallGraphResult>;
  ```
  It throws `new Error(config.tsconfig.reason)` when `kind === 'invalid'`.

  Exact notes:
  - no TypeScript files: status `ok`, note `no TypeScript files in the source directories`
  - `kind === 'none'` with TypeScript files: status `degraded`, note `no tsconfig found at <root>/tsconfig.json and none configured; built with compiler defaults, so calls through path aliases are not linked (those call edges are missing). Set "tsconfig" in guardian.config.json.`

Fixture `tests/fixtures/ts-subdir/` (no JSDoc, so every function is Tier 2):

```
web/tsconfig.json          {"compilerOptions":{"module":"ES2022","moduleResolution":"bundler","strict":true,"paths":{"~/*":["./app/*"]}}}
web/app/a-other/greet.ts   export function greet(n: string): string { return 'other ' + n; }
web/app/lib/greet.ts       export function greet(n: string): string { return 'hi ' + n; }
web/app/lib/shout.ts       export function shout(s: string): string { return s.toUpperCase(); }
web/app/main.ts            import { greet } from '~/lib/greet'; import { shout } from './lib/shout';
                           export function run(): string { return shout(greet('x')); }
```
The two `greet` functions are the point: `a-other/greet.ts` sorts first, so a name-only match picks the wrong one.

Each test opens `openDatabase(':memory:')`, builds a config with `reloadConfig` on a temp copy of the fixture (`cpSync`) plus a written `guardian.config.json`, then runs `buildIndex(db, root, { config })` and `buildCallGraph(db, root, { config })`.

- [x] **Step 1: Write the failing tests:**

  | Test | Config | Assertions |
  |---|---|---|
  | sub-folder tsconfig | `{"sourceDirectories":["web/app"],"tsconfig":"web/tsconfig.json"}` | `status === 'ok'`; `exportsDiscovered === 4`; an edge exists from `run` (`web/app/main.ts`) to the `greet` row whose `file_path` is `web/app/lib/greet.ts`; no edge from `run` to the `greet` in `web/app/a-other/greet.ts`; an edge from `run` to `shout` |
  | no tsconfig | `{"sourceDirectories":["web/app"]}` | resolves without throwing; `status === 'degraded'`; `note` contains `calls through path aliases are not linked`; `exportsDiscovered === 4`; edge from `run` to `shout` exists; no edge from `run` to either `greet` |
  | configured but missing | `{"sourceDirectories":["web/app"],"tsconfig":"nope/tsconfig.json"}` | rejects with message `tsconfig "nope/tsconfig.json" from guardian.config.json does not exist` |
  | root tsconfig regression | copy `web/tsconfig.json` to the root with `"paths":{"~/*":["./web/app/*"]}`, no field | same edge assertions as the first row |
  | excluded folder is not loaded | first row's config plus a file `web/app/node_modules/p/x.ts` exporting `leaked()` | no `functions` row named `leaked` |
  | no TypeScript files | `sourceDirectories` pointing at an empty folder | `status === 'ok'`, `note === 'no TypeScript files in the source directories'`, both counts `0` |

- [x] **Step 2: Run** `npx tsx --test tests/call-graph.test.ts`. Expected: FAIL (throws `File not found: …/tsconfig.json` on the first row).

- [x] **Step 3: Implement.** `loadProject(config)` picks the ts-morph options from `config.tsconfig` (`tsConfigFilePath` for `file`, none for `none`), keeps `skipAddingFilesFromTsConfig` and `skipFileDependencyResolution`, and adds exactly the `.ts`/`.tsx` entries of `listIndexFiles(config).codeFiles`. `discoverExports` and `extractCallEdges` are unchanged.

- [x] **Step 4: Run** `npx tsx --test tests/call-graph.test.ts`. Expected: PASS.

- [x] **Step 5: Commit** `fix(call-graph): honour the tsconfig field, fall back to compiler defaults`

---

### Task 4: One rebuild pipeline with isolated phases

**Files:**
- Create: `src/mcp-server/rebuild.ts`
- Modify: `src/mcp-server/py-call-graph.ts` (the four early returns at lines 79–108), `src/mcp-server/build-index.ts` (the body of `main`)
- Test: `tests/rebuild.test.ts` (create); `tests/py-call-graph.test.ts` (one added assertion)

**Interfaces:**
- Consumes: `buildIndex` (Task 2), `buildCallGraph` / `CallGraphResult` (Task 3), `GuardianConfig.configFileError` (Task 1).
- Produces:
  ```ts
  // py-call-graph.ts: note is the reason nothing was built, else null
  Promise<{ edgesCreated: number; note: string | null }>

  export type PhaseStatus = 'ok' | 'degraded' | 'failed' | 'skipped';
  export type PhaseName = 'clear' | 'index' | 'ts-call-graph' | 'py-call-graph' | 'validation-cache';
  export interface PhaseResult { name: PhaseName; label: string; status: PhaseStatus; detail: string | null }
  export interface RebuildResult {
    phases: PhaseResult[];                 // always all five, in order
    indexStats: IndexStats | null;
    graphStats: CallGraphResult | null;
    pyGraphStats: { edgesCreated: number; note: string | null } | null;
    clearedArtifacts: string[];
    allOk: boolean;                        // every phase 'ok'
    indexingFailed: boolean;               // 'clear' or 'index' failed
  }
  export interface RebuildDeps {
    clearAllData: typeof clearAllData; buildIndex: typeof buildIndex; buildCallGraph: typeof buildCallGraph;
    buildPythonCallGraph: typeof buildPythonCallGraph; clearValidationArtifacts: typeof clearValidationArtifacts;
    invalidateCache: typeof invalidateCache;
  }
  export async function runRebuild(db: Database.Database, config: GuardianConfig, deps?: Partial<RebuildDeps>): Promise<RebuildResult>;
  export function formatRebuildReport(result: RebuildResult): string[];
  ```

Rules for `runRebuild`:
- Labels: `Clear old index`, `Index code and docs`, `TypeScript call graph`, `Python call graph`, `Validation cache`.
- Each phase runs in its own try/catch. A throw becomes `failed` with the error message as `detail`.
- If `clear` or `index` fails, `index` (when not yet run) and both call graphs are `skipped` with detail `indexing failed`. `validation-cache` always runs.
- `index` is `degraded` with detail `guardian.config.json could not be parsed (<error>); auto-detected settings were used` when `config.configFileError` is set.
- `ts-call-graph` takes `status` and `note` from `CallGraphResult`.
- `py-call-graph` is `degraded` with the returned `note` when `note` is set and the index holds at least one row with `language = 'py'`. With a note and no Python rows it is `ok` with detail `no Python files indexed`.
- `invalidateCache()` runs once after the call graphs, whatever their outcome.

`formatRebuildReport` returns: the heading (`## Index Rebuild Complete` when `allOk`, else `## Index Rebuild Finished With Problems`), a blank line, one line per phase as `- **<label>:** <status>` plus ` (<detail>)` when there is one, a blank line, then today's count lines from `index.ts:483–493` with `not run` in place of a number whose phase did not produce stats.

- [x] **Step 1: Write the failing tests** in `tests/rebuild.test.ts`, using stub `deps` and `openDatabase(':memory:')`:

  | Test | Stubs | Assertions |
  |---|---|---|
  | all ok | every dep succeeds | five phases, all `ok`; `allOk`; heading line is `## Index Rebuild Complete` |
  | TypeScript phase throws | `buildCallGraph` throws `Error('boom')` | `ts-call-graph` is `failed` with detail `boom`; `py-call-graph` and `validation-cache` stubs were called; `allOk === false`; `indexingFailed === false`; heading is `## Index Rebuild Finished With Problems`; a report line equals `- **TypeScript call graph:** failed (boom)` |
  | indexing throws | `buildIndex` throws | both call graphs `skipped` with detail `indexing failed` and their stubs not called; `validation-cache` ran; `indexingFailed === true` |
  | degraded call graph | `buildCallGraph` returns `status:'degraded', note:'n'` | phase `degraded`, detail `n`, `allOk === false` |
  | Python note, Python rows present | insert one `language='py'` row via `insertFunction`; py stub returns `{edgesCreated:0, note:'Python interpreter not found'}` | phase `degraded` with that detail |
  | Python note, no Python rows | same stub, no rows | phase `ok`, detail `no Python files indexed` |
  | unparseable config file | `config.configFileError = 'Unexpected token'` | `index` phase `degraded`, detail starts `guardian.config.json could not be parsed (Unexpected token)` |
  | malformed tsconfig, real deps | temp copy of `tests/fixtures/ts-subdir` with `web/tsconfig.json` overwritten by `{ not json`, config pointing at it, no stubs | `runRebuild` resolves; `index` and `validation-cache` are `ok`; `ts-call-graph` is `ok`, `degraded` or `failed`, never an unhandled rejection |

  In `tests/py-call-graph.test.ts` add: with `GUARDIAN_HOME` set to an empty temp dir, `buildPythonCallGraph` returns `edgesCreated: 0` and `note === 'Python interpreter not found'`.

- [x] **Step 2: Run** `npx tsx --test tests/rebuild.test.ts tests/py-call-graph.test.ts`. Expected: FAIL (module not found; `note` undefined).

- [x] **Step 3: Implement** `rebuild.ts` and the `note` returns in `py-call-graph.ts` (`Python interpreter not found`; `Python call graph subprocess failed: <message>`; `Python call graph produced non-JSON output`; `Python call graph reported an error: <error>`). The existing `console.error` lines stay.

- [x] **Step 4: Rewrite `build-index.ts`'s `main`** to call `runRebuild(db, config)`, print `formatRebuildReport(result)` and the timing, keep `clearDirtyFiles`, and set `process.exitCode = 1` when any phase is `failed`. Replace the `process.exit(1)` in the catch with `process.exitCode = 1`.

- [x] **Step 5: Run** `npx tsx --test tests/rebuild.test.ts tests/py-call-graph.test.ts`, then `npm test`. Expected: PASS.

- [x] **Step 6: Commit** `fix(rebuild): isolate rebuild phases and report each one's status`

---

### Task 5: The server reloads config and uses the pipeline

**Files:**
- Modify: `src/mcp-server/index.ts` (config at lines 46–52, `autoSync` at 212–225, `rebuild_index` at 459–497, `index_status` at 555–561)
- Test: `tests/mcp-server-rebuild.test.ts` (create)

**Interfaces:**
- Consumes: `reloadConfig` (Task 1), `runRebuild`, `formatRebuildReport` (Task 4).

- [x] **Step 1: Write the failing test.** It drives the real server over stdio with the SDK's `Client` and `StdioClientTransport`, spawning `npx tsx src/mcp-server/index.ts` with `cwd` set to a temp git repo (`git init`) and `GUARDIAN_HOME` set to a temp dir. Give the test a 180 s timeout.

  The repo starts as a copy of `tests/fixtures/ts-subdir` plus `docs/notes.md` (a heading and an `@domain demo` line), with **no** `guardian.config.json`.

  1. Call `rebuild_index`. Assert the text contains `## Index Rebuild Finished With Problems` and `TypeScript call graph:** degraded`, and that `isError` is not true.
  2. Without restarting the server, write `guardian.config.json`: `{"sourceDirectories":["web/app"],"docsDirectories":["docs"],"tsconfig":"web/tsconfig.json"}`.
  3. Call `rebuild_index` again. Assert the text contains `## Index Rebuild Complete`, `**Tier 2 (exports):** 4` and `**Tier 3 (docs):** 1`.
  4. Call `callers` with `function_name: "shout"`. Assert the text contains `run`.

- [x] **Step 2: Run** `npx tsx --test tests/mcp-server-rebuild.test.ts`. Expected: FAIL at step 1 (the current server returns `Error: File not found`).

- [x] **Step 3: Implement.** Keep `REPO_ROOT`, `DB_PATH` and `DIRTY_FILES_PATH` as startup constants. Replace reads of the startup `config` in `rebuild_index`, `index_status` and `autoSync` with `reloadConfig(REPO_ROOT)`, and pass that config to `runRebuild` / `buildIndex`. `rebuild_index` returns `formatRebuildReport(result).join('\n')` with `isError: result.indexingFailed`.

- [x] **Step 4: Run** `npx tsx --test tests/mcp-server-rebuild.test.ts`, then `npm test`. Expected: PASS.

- [x] **Step 5: Commit** `fix(mcp): reload project config on rebuild instead of freezing it at startup`

---

### Task 6: Docs, version, and the real case

**Files:**
- Modify: `README.md` (Configuration section, lines 361–386), `templates/guardian.config.json`, `docs/indexing-pipeline.md` (Phase 2, lines 105–110), `CLAUDE.md` (Project Structure list), `package.json`, `.claude-plugin/plugin.json`

- [x] **Step 1: Update the docs.**
  - README: add `"tsconfig": "web/tsconfig.json"` to the example with one sentence (when to set it; what happens when it is not set and there is no root tsconfig). State the two matching rules for `excludeDirectories` and that the value replaces the default. Add a short "Reading the rebuild result" note covering `ok / degraded / failed / skipped`. Correct the auto-detection bullet to say detection follows the configured tsconfig.
  - Template: add `"tsconfig"` to the `_comment` as an optional field; do not add a live value.
  - `docs/indexing-pipeline.md`: step 1 of Phase 2 becomes "Load the resolved tsconfig and add the indexed `.ts`/`.tsx` files".
  - `CLAUDE.md`: add `file-walk.ts` and `rebuild.ts` to the structure list.

- [x] **Step 2: Bump** both version fields to `0.8.3`.

- [x] **Step 3: Build and run the full suite.** `npm run build && npm test`. Expected: build clean, all tests pass.

- [x] **Step 4: Check the real case on a copy** (the other repo is not ours to edit). Copy `<the reporting project checkout>` to the scratchpad without `node_modules`, `build` and `.git`, add `"tsconfig": "web/tsconfig.json"` to the copy's `guardian.config.json`, then run the built CLI with `GUARDIAN_PROJECT_ROOT=<copy>` and `GUARDIAN_HOME=<temp dir>`.

  Expected: heading `## Index Rebuild Complete`; Tier 2 > 0; call edges > 0; Tier 3 = 2. Then query the temp database: no `file_path` starting `web/.react-router` and none matching `web/%.config.ts`.

  Run it once more with the field removed. Expected: `TypeScript call graph:** degraded`, exit code 0.

- [x] **Step 5: Commit** `docs: tsconfig field, excludeDirectories matching, rebuild statuses; bump to 0.8.3`

- [x] **Step 6: Tell the other session** (`the reporting session`) what to add to its `guardian.config.json` once 0.8.3 is installed, and what a rebuild without the field looks like (degraded: alias call edges are missing).

Publishing (push, tag, `/plugin update`) is Austin's step after review and is not part of this plan.
