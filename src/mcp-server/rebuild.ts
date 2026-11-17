/**
 * The full index rebuild, as one sequence of isolated phases.
 *
 * Both entry points call this: the `rebuild_index` MCP tool and the `build-index` CLI. They used
 * to hold their own copies of the sequence, and one throwing phase aborted everything after it
 * with a bare error. Here:
 *
 * - A configuration that is known to be broken stops the rebuild before anything is cleared.
 * - Each phase reports its own status, so the result says what ran, what ran with a limitation,
 *   what failed and what was skipped.
 * - The outcome is stored in the index, so `index_status` can repeat it later.
 */
import path from 'path';
import type Database from 'better-sqlite3';
import { configProblems, type GuardianConfig } from '../config.js';
import { clearAllData, countPythonFunctions, getMetadata, setMetadata } from './db.js';
import { buildIndex, clearDirtyFiles, type IndexStats } from './indexer.js';
import { buildCallGraph, checkTsconfigLoads, type CallGraphResult } from './call-graph.js';
import { buildPythonCallGraph } from './py-call-graph.js';
import { invalidateCache } from './embeddings.js';
import { clearValidationArtifacts } from './validation-artifacts.js';
import { configuredDirectoryProblems, listIndexFiles, type IndexFileSet } from './file-walk.js';
import { errorMessage } from '../shared/util.js';

/**
 * @what How one rebuild phase ended
 *
 * - `ok`: ran and did everything
 * - `degraded`: ran, with a stated limitation
 * - `failed`: threw; the error message is the detail
 * - `skipped`: not run, because a phase it depends on failed or the rebuild did not start
 *
 * @domain index-rebuild, code-index
 * @tags index-rebuild, phase-status, reporting
 */
export type PhaseStatus = 'ok' | 'degraded' | 'failed' | 'skipped';

/**
 * @what Identifier of a rebuild phase, in run order: clear, index, ts-call-graph, py-call-graph, validation-cache
 * @domain index-rebuild, code-index
 * @tags index-rebuild, phase-name, pipeline
 */
export type PhaseName = 'clear' | 'index' | 'ts-call-graph' | 'py-call-graph' | 'validation-cache';

/**
 * @what The outcome of one rebuild phase, as shown in the rebuild report
 * @domain index-rebuild, code-index
 * @tags index-rebuild, phase-result, reporting
 */
export interface PhaseResult {
  name: PhaseName;
  /** Human-readable phase name used in the report */
  label: string;
  status: PhaseStatus;
  /** Why the phase is degraded, failed or skipped; an optional remark when ok; else null */
  detail: string | null;
}

/**
 * @what The Python call graph's counts and, when it built nothing, the reason
 * @domain index-rebuild, python-support
 * @tags index-rebuild, python, call-graph, stats
 */
type PyGraphStats = { edgesCreated: number; note: string | null };

/**
 * @what Everything a full rebuild produced: one result per phase plus the counts from the phases that ran
 * @domain index-rebuild, code-index
 * @tags index-rebuild, result, phase-status, stats
 */
export interface RebuildResult {
  /** Always all five phases, in run order */
  phases: PhaseResult[];
  /** null when indexing failed or was skipped */
  indexStats: IndexStats | null;
  /** null when the TypeScript call graph failed or was skipped */
  graphStats: CallGraphResult | null;
  /** null when the Python call graph failed or was skipped */
  pyGraphStats: PyGraphStats | null;
  /** Validation cache and session files removed */
  clearedArtifacts: string[];
  /** True only when every phase is `ok` */
  allOk: boolean;
  /** True when clearing or indexing failed: the index itself is not trustworthy */
  indexingFailed: boolean;
  /** The configuration errors that stopped the rebuild before it touched anything; null when it ran */
  notStarted: string[] | null;
}

/**
 * @what The steps runRebuild calls, replaceable in tests
 * @domain index-rebuild, testing
 * @tags index-rebuild, dependency-injection, phases
 */
export interface RebuildDeps {
  checkTsconfigLoads: typeof checkTsconfigLoads;
  listIndexFiles: typeof listIndexFiles;
  clearAllData: typeof clearAllData;
  buildIndex: typeof buildIndex;
  buildCallGraph: typeof buildCallGraph;
  buildPythonCallGraph: typeof buildPythonCallGraph;
  clearValidationArtifacts: typeof clearValidationArtifacts;
  invalidateCache: typeof invalidateCache;
  clearDirtyFiles: typeof clearDirtyFiles;
}

const DEFAULT_DEPS: RebuildDeps = {
  checkTsconfigLoads,
  listIndexFiles,
  clearAllData,
  buildIndex,
  buildCallGraph,
  buildPythonCallGraph,
  clearValidationArtifacts,
  invalidateCache,
  clearDirtyFiles,
};

const PHASE_ORDER: PhaseName[] = ['clear', 'index', 'ts-call-graph', 'py-call-graph', 'validation-cache'];

const LABELS: Record<PhaseName, string> = {
  'clear': 'Clear old index',
  'index': 'Index code and docs',
  'ts-call-graph': 'TypeScript call graph',
  'py-call-graph': 'Python call graph',
  'validation-cache': 'Validation cache',
};

/** Metadata key under which the last rebuild's per-phase outcome is stored. */
const STATUS_KEY = 'last_rebuild_status';

/**
 * @what The result of running one phase body: its value, or the message of what it threw
 * @domain index-rebuild
 * @tags index-rebuild, error-isolation, result-type
 */
type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * @what Runs one phase body and turns a throw into a value
 * @how Awaits the body inside try/catch; returns `{ ok: true, value }` or `{ ok: false, error }` with the error's message
 * @why Phase isolation: one phase throwing must not stop the phases after it
 *
 * @param {() => T | Promise<T>} body The phase's work
 * @returns {Promise<Attempt<T>>} The body's value, or the message of what it threw
 *
 * @sideeffects Whatever the body does
 * @systemlayer Utility
 * @domain index-rebuild
 * @tags index-rebuild, error-isolation, try-catch, fail-open
 */
async function attempt<T>(body: () => T | Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await body() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * @what Builds a PhaseResult with its report label filled in
 * @how Looks the label up by phase name
 * @why Keeps the five labels in one table so the report wording cannot drift between phases
 *
 * @param {PhaseName} name Which phase
 * @param {PhaseStatus} status How it ended
 * @param {string | null} [detail] Reason or remark, if any
 * @returns {PhaseResult} The phase result
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain index-rebuild
 * @tags index-rebuild, phase-result, labels, pure
 */
function phase(name: PhaseName, status: PhaseStatus, detail: string | null = null): PhaseResult {
  return { name, label: LABELS[name], status, detail };
}

/**
 * @what Formats "N thing(s)" with the right singular or plural noun
 * @how Returns `1 <singular>` for one and `<n> <plural>` otherwise
 * @why Several report sentences count files or folders; "1 Python files were" reads as a bug
 *
 * @param {number} n The count
 * @param {string} singular Noun phrase for one
 * @param {string} plural Noun phrase for any other count
 * @returns {string} The count with its noun
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain index-rebuild
 * @tags reporting, plural, formatting, pure
 */
function counted(n: number, singular: string, plural: string): string {
  return n === 1 ? `1 ${singular}` : `${n} ${plural}`;
}

/**
 * @what Lists the configuration errors that must stop a rebuild before it starts
 * @how The definite errors recorded on the config (configProblems: an unusable guardian.config.json, ignored fields, an invalid tsconfig), plus, when the tsconfig is a file, the reason it cannot be loaded (checked by actually loading it)
 * @why A rebuild clears the old index first. Starting one from a configuration that is known to be broken would replace a good index with one built from defaults nobody asked for, or one with no TypeScript call graph. These problems are all knowable up front, so they are checked before anything is touched.
 *
 * @param {GuardianConfig} config Freshly resolved project config
 * @param {RebuildDeps} d The rebuild's steps (checkTsconfigLoads is used)
 * @returns {string[]} One sentence per problem; empty when the rebuild may start
 *
 * @sideeffects Reads the tsconfig from disk
 * @systemlayer Business Logic
 * @domain index-rebuild, config
 * @tags index-rebuild, preflight, config-problems, tsconfig, validation
 */
function preflightProblems(config: GuardianConfig, d: RebuildDeps): string[] {
  const problems = configProblems(config);
  if (config.tsconfig.kind === 'file') {
    const loadError = d.checkTsconfigLoads(config);
    if (loadError) problems.push(loadError);
  }
  return problems;
}

/**
 * @what Builds the result of a rebuild that was stopped before it started
 * @how Every phase is `skipped` with the detail "rebuild not started"; no stats; the problems are carried in notStarted
 * @why Callers always get the same result shape, and the report and the exit code can tell "did not start" from "ran with problems"
 *
 * @param {string[]} problems The configuration errors found by preflightProblems
 * @returns {RebuildResult} A result with nothing run
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain index-rebuild
 * @tags index-rebuild, preflight, result, pure
 */
function notStartedResult(problems: string[]): RebuildResult {
  return {
    phases: PHASE_ORDER.map(name => phase(name, 'skipped', 'rebuild not started')),
    indexStats: null,
    graphStats: null,
    pyGraphStats: null,
    clearedArtifacts: [],
    allOk: false,
    indexingFailed: false,
    notStarted: problems,
  };
}

/**
 * @what Lists the reasons the index phase ran with a limitation, in report order
 * @how Collects, in this order: configured source or docs directories that cannot be used, folders the walk could not read, a rebuild that found no code files at all, Python files that could not be extracted (naming the first few), and Python files that sit outside the source directories when no Python was indexed. An empty list means the phase is ok.
 * @why Each of these leaves part of the project out of the index while indexing itself "succeeds". The report must say so, and say all of them, not just the first.
 *
 * @param {GuardianConfig} config The config the index phase ran with
 * @param {IndexStats} stats What the index phase reported
 * @returns {string[]} One reason per limitation; empty when there are none
 *
 * @sideeffects Reads the filesystem (stat of the configured directories)
 * @systemlayer Business Logic
 * @domain index-rebuild, code-index
 * @tags index-rebuild, degraded, missing-directory, python, unreadable, reporting
 */
function indexLimitations(config: GuardianConfig, stats: IndexStats): string[] {
  const reasons = configuredDirectoryProblems(config);
  const sources = config.sourceDirectories.join(', ');

  const unreadable = stats.unreadableDirectories;
  if (unreadable.length > 0) {
    reasons.push(`${counted(unreadable.length, 'folder', 'folders')} could not be read: ${unreadable.join(', ')}`);
  }

  if (stats.codeFilesScanned === 0) {
    reasons.push(
      `no code files were found in the source directories (${sources}) ` +
      `with the configured extensions (${config.fileExtensions.join(', ')})`,
    );
  }

  const skipped = stats.pythonFilesSkipped;
  if (skipped > 0) {
    const sample = stats.pythonFilesSkippedSample;
    const more = skipped > sample.length && sample.length > 0 ? ` and ${skipped - sample.length} more` : '';
    const named = sample.length > 0 ? `: ${sample.join(', ')}${more}` : '';
    reasons.push(
      `${counted(skipped, 'Python file was', 'Python files were')} not indexed ` +
      `(extraction failed, or the Python interpreter is missing)${named}`,
    );
  }

  const outside = stats.pythonFilesOutsideSources;
  if (outside > 0) {
    const one = outside === 1;
    reasons.push(
      `${counted(outside, 'Python file', 'Python files')} under the project ${one ? 'is' : 'are'} outside the source ` +
      `directories (${sources}) and ${one ? 'was' : 'were'} not indexed; ` +
      `add ${one ? 'its' : 'their'} folder to "sourceDirectories" in guardian.config.json`,
    );
  }

  return reasons;
}

/**
 * @what Decides the Python call-graph phase's status from what buildPythonCallGraph returned
 * @how No note means it ran normally: ok. With a note (a fail-open path was taken), it is degraded when the project has Python, because edges that should exist are missing. "Has Python" means the index holds a Python row OR the index phase had to skip Python files: a missing interpreter both prevents the rows from being written and makes the call graph fail open, so rows alone cannot be the test. With a note and no Python at all there was nothing to build, so it is ok with a remark.
 * @why buildPythonCallGraph fails open and returns zero edges both when a repo has no Python and when the interpreter is missing; only the second is a problem worth reporting
 *
 * @param {Database.Database} db Open index database, already populated by the index phase
 * @param {string | null} note The reason buildPythonCallGraph built nothing, or null
 * @param {number} pythonFilesSkipped Python files the index phase could not extract
 * @returns {PhaseResult} The py-call-graph phase result
 *
 * @sideeffects Reads the functions table
 * @systemlayer Business Logic
 * @domain index-rebuild, python-support
 * @tags index-rebuild, python, call-graph, degraded, phase-status
 */
function pythonPhase(db: Database.Database, note: string | null, pythonFilesSkipped: number): PhaseResult {
  if (note === null) return phase('py-call-graph', 'ok');
  if (countPythonFunctions(db) > 0 || pythonFilesSkipped > 0) return phase('py-call-graph', 'degraded', note);
  return phase('py-call-graph', 'ok', 'no Python files indexed');
}

/**
 * @what What the index phase produced: its result, and the stats and file list the later phases need
 * @domain index-rebuild, code-index
 * @tags index-rebuild, index-phase, file-list, stats
 */
interface IndexOutcome {
  result: PhaseResult;
  /** null when indexing failed or did not run */
  stats: IndexStats | null;
  /** The one file list of this rebuild; null when indexing failed or did not run */
  files: IndexFileSet | null;
}

/**
 * @what Runs the index phase: lists the project's files once, indexes them, and clears the dirty-file list
 * @how Computes the file list (listIndexFiles) and passes it to buildIndex; a throw from either makes the phase `failed`. On success the dirty-file list is cleared, because a full rebuild supersedes it, and the phase is `degraded` when indexLimitations finds anything, with every reason listed.
 * @why The file list is computed here, once, and returned so the call graph reads exactly the files the index read. The dirty-file list is cleared only after indexing succeeded, by this pipeline and not by its callers, so the MCP tool and the CLI behave the same.
 *
 * @param {Database.Database} db Open index database, already cleared
 * @param {GuardianConfig} config Freshly resolved project config
 * @param {RebuildDeps} d The rebuild's steps
 * @returns {Promise<IndexOutcome>} The phase result plus the stats and file list
 *
 * @sideeffects Reads source and doc files; writes index rows and embeddings; empties the dirty-file list; logs to stderr
 * @systemlayer Business Logic
 * @domain index-rebuild, code-index
 * @tags index-rebuild, index-phase, file-list, dirty-files, degraded
 */
async function runIndexPhase(db: Database.Database, config: GuardianConfig, d: RebuildDeps): Promise<IndexOutcome> {
  console.error('Indexing code and docs...');
  const indexed = await attempt(async () => {
    const files = d.listIndexFiles(config);
    const stats = await d.buildIndex(db, config.projectRoot, { config, files });
    return { files, stats };
  });
  if (!indexed.ok) {
    return { result: phase('index', 'failed', indexed.error), stats: null, files: null };
  }

  const dirtyFilesPath = path.join(path.dirname(config.databasePath), '.dirty-files');
  const cleared = await attempt(() => d.clearDirtyFiles(dirtyFilesPath));
  if (!cleared.ok) console.error(`Could not clear the dirty-file list: ${cleared.error}`);

  const { files, stats } = indexed.value;
  const limitations = indexLimitations(config, stats);
  const result = limitations.length > 0
    ? phase('index', 'degraded', limitations.join('; '))
    : phase('index', 'ok');
  return { result, stats, files };
}

/**
 * @what What the two call-graph phases produced
 * @domain index-rebuild, call-graph
 * @tags index-rebuild, call-graph, phase-result, stats
 */
interface CallGraphOutcome {
  /** The ts-call-graph result, then the py-call-graph result */
  results: [PhaseResult, PhaseResult];
  graphStats: CallGraphResult | null;
  pyGraphStats: PyGraphStats | null;
}

/**
 * @what Runs the TypeScript and Python call-graph phases, or skips both when there is no index to resolve against
 * @how When the index phase produced no stats, both are `skipped` with the given reason. Otherwise each runs through attempt(): the TypeScript phase takes its status and note from buildCallGraph (given the same file list the index phase used), and the Python phase's status is decided by pythonPhase. A throw in one is recorded as `failed` and the other still runs.
 * @why Both graphs resolve callers and callees against the rows the index phase wrote, which is the only dependency between phases
 *
 * @param {Database.Database} db Open index database
 * @param {GuardianConfig} config Freshly resolved project config
 * @param {RebuildDeps} d The rebuild's steps
 * @param {IndexOutcome} index What the index phase produced
 * @param {string} skipReason The detail to use when the phases are skipped
 * @returns {Promise<CallGraphOutcome>} Both phase results and their stats
 *
 * @sideeffects Reads source files; inserts Tier 2 rows, embeddings and call edges; may spawn a Python subprocess; logs to stderr
 * @systemlayer Business Logic
 * @domain index-rebuild, call-graph
 * @tags index-rebuild, call-graph, typescript, python, phase-isolation
 */
async function runCallGraphPhases(
  db: Database.Database,
  config: GuardianConfig,
  d: RebuildDeps,
  index: IndexOutcome,
  skipReason: string,
): Promise<CallGraphOutcome> {
  const { stats, files } = index;
  if (stats === null || files === null) {
    return {
      results: [phase('ts-call-graph', 'skipped', skipReason), phase('py-call-graph', 'skipped', skipReason)],
      graphStats: null,
      pyGraphStats: null,
    };
  }

  console.error('Building call graph...');
  const graph = await attempt(() => d.buildCallGraph(db, config.projectRoot, { config, files }));
  const tsResult = graph.ok
    ? phase('ts-call-graph', graph.value.status, graph.value.note)
    : phase('ts-call-graph', 'failed', graph.error);

  console.error('Building Python call graph...');
  const pyGraph = await attempt(async () => {
    const pyStats = await d.buildPythonCallGraph(db, config.projectRoot, { config });
    return { pyStats, result: pythonPhase(db, pyStats.note, stats.pythonFilesSkipped) };
  });
  const pyResult = pyGraph.ok ? pyGraph.value.result : phase('py-call-graph', 'failed', pyGraph.error);

  return {
    results: [tsResult, pyResult],
    graphStats: graph.ok ? graph.value : null,
    pyGraphStats: pyGraph.ok ? pyGraph.value.pyStats : null,
  };
}

/**
 * @what Runs a full index rebuild as five isolated phases and reports each one's outcome
 * @how First the preflight: if the configuration has definite errors (preflightProblems), nothing is touched and the result says the rebuild did not start. Otherwise, in order: clear the old data, index code and docs (runIndexPhase), build the TypeScript and Python call graphs (runCallGraphPhases), clear the hook's validation cache and sessions. Each phase runs through attempt(), so a throw is recorded as `failed` and the next phase still runs. The two call graphs are `skipped` when clearing or indexing failed; the validation cache is always cleared. The embedding cache is invalidated once after the call graphs, and the per-phase outcome is stored in the index (saveRebuildStatus).
 * @why One sequence for the MCP tool and the CLI, and a rebuild that never looks complete when part of it did not run. Before this, a missing tsconfig aborted the Python call graph and the cache clear and returned a bare error.
 *
 * @param {Database.Database} db Open index database
 * @param {GuardianConfig} config Freshly resolved project config, passed to every phase
 * @param {Partial<RebuildDeps>} [deps] Steps to substitute (tests)
 * @returns {Promise<RebuildResult>} Per-phase results plus the stats of the phases that ran; notStarted lists the configuration errors when the rebuild did not start
 *
 * @sideeffects Deletes and rewrites the index database contents; reads source files; loads the embedding model; may spawn a Python subprocess; empties the dirty-file list; deletes the validation cache and session files; writes the rebuild status to the metadata table; logs to stderr. None of these when the rebuild does not start.
 * @systemlayer Business Logic
 * @domain index-rebuild, code-index
 * @tags index-rebuild, pipeline, phase-isolation, preflight, call-graph, indexing, validation-cache, reporting
 */
export async function runRebuild(
  db: Database.Database,
  config: GuardianConfig,
  deps: Partial<RebuildDeps> = {},
): Promise<RebuildResult> {
  const d: RebuildDeps = { ...DEFAULT_DEPS, ...deps };

  const problems = preflightProblems(config, d);
  if (problems.length > 0) return notStartedResult(problems);

  // Phase 1: clear old data, so stale Tier 2 rows and call edges cannot survive the rebuild.
  const cleared = await attempt(() => d.clearAllData(db));
  const clearResult = cleared.ok ? phase('clear', 'ok') : phase('clear', 'failed', cleared.error);

  // Phase 2: index code and docs. Phases 3 and 4 resolve against the rows it wrote.
  const index: IndexOutcome = cleared.ok
    ? await runIndexPhase(db, config, d)
    : { result: phase('index', 'skipped', 'clearing the old index failed'), stats: null, files: null };
  const graphs = await runCallGraphPhases(db, config, d, index, cleared.ok ? 'indexing failed' : 'indexing did not run');

  // Not a phase of its own: an in-memory cache reset. A failure here must not hide the results above.
  const invalidated = await attempt(() => d.invalidateCache());
  if (!invalidated.ok) console.error(`Embedding cache invalidation failed: ${invalidated.error}`);

  // Phase 5: the hook's cached verdicts were computed against the old index. Always clear them.
  const artifacts = await attempt(() => d.clearValidationArtifacts(config.databasePath));
  const cacheResult = artifacts.ok ? phase('validation-cache', 'ok') : phase('validation-cache', 'failed', artifacts.error);

  const phases = [clearResult, index.result, ...graphs.results, cacheResult];
  const result: RebuildResult = {
    phases,
    indexStats: index.stats,
    graphStats: graphs.graphStats,
    pyGraphStats: graphs.pyGraphStats,
    clearedArtifacts: artifacts.ok ? artifacts.value : [],
    allOk: phases.every(p => p.status === 'ok'),
    indexingFailed: clearResult.status === 'failed' || index.result.status === 'failed',
    notStarted: null,
  };

  const saved = await attempt(() => saveRebuildStatus(db, result));
  if (!saved.ok) console.error(`Could not store the rebuild status: ${saved.error}`);
  return result;
}

/**
 * @what Gives the process exit code a command-line rebuild should end with
 * @how 1 when the rebuild did not start or any phase failed; 0 otherwise, including when a phase is degraded
 * @why A script that runs the CLI must be able to tell "no usable rebuild happened" from "the index is usable, with stated limitations"
 *
 * @param {RebuildResult} result The rebuild result
 * @returns {number} 0 or 1
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain index-rebuild
 * @tags index-rebuild, exit-code, cli, pure
 */
export function rebuildExitCode(result: RebuildResult): number {
  const failed = result.notStarted !== null || result.phases.some(p => p.status === 'failed');
  return failed ? 1 : 0;
}

/**
 * @what Renders one phase as a report line
 * @how `- **<label>:** <status>`, followed by the detail in brackets when there is one
 * @why The rebuild report and index_status show phases the same way
 *
 * @param {Pick<PhaseResult, 'label' | 'status' | 'detail'>} p The phase
 * @returns {string} A markdown list line
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain index-rebuild
 * @tags index-rebuild, reporting, markdown, pure
 */
function phaseLine(p: Pick<PhaseResult, 'label' | 'status' | 'detail'>): string {
  return `- **${p.label}:** ${p.status}${p.detail ? ` (${p.detail})` : ''}`;
}

/**
 * @what Stores the per-phase outcome of a rebuild in the index's metadata table
 * @how Writes one JSON value (whether every phase was ok, and each phase's label, status and detail) under a fixed key
 * @why The rebuild result is returned once. Without a stored copy, index_status after a degraded or failed rebuild shows a fresh "last rebuilt" time and plain counts, and anyone who did not read that one response sees a healthy index.
 *
 * @param {Database.Database} db Open index database
 * @param {RebuildResult} result The rebuild that just ran
 * @returns {void}
 *
 * @sideeffects Writes one row to the metadata table
 * @systemlayer Data Layer
 * @domain index-rebuild, code-index
 * @tags index-rebuild, metadata, index-status, persistence
 */
function saveRebuildStatus(db: Database.Database, result: RebuildResult): void {
  const stored = {
    allOk: result.allOk,
    phases: result.phases.map(({ label, status, detail }) => ({ label, status, detail })),
  };
  setMetadata(db, STATUS_KEY, JSON.stringify(stored));
}

/**
 * @what Reads back the per-phase outcome of the last rebuild that ran, as report lines
 * @how Loads the JSON stored by saveRebuildStatus and renders a heading line ("complete" or "finished with problems") followed by one line per phase. Returns null when nothing is stored (an index built before this was recorded) or the stored value cannot be read.
 * @why Lets index_status repeat what the last rebuild reported, so a degraded index is visible after the fact
 *
 * @param {Database.Database} db Open index database
 * @returns {string[] | null} Markdown lines, or null when there is no stored status
 *
 * @sideeffects Reads the metadata table
 * @systemlayer Data Layer
 * @domain index-rebuild, code-index
 * @tags index-rebuild, metadata, index-status, reporting
 */
export function readLastRebuildStatus(db: Database.Database): string[] | null {
  const raw = getMetadata(db, STATUS_KEY);
  if (raw === null) return null;
  try {
    const stored = JSON.parse(raw) as { allOk: boolean; phases: Pick<PhaseResult, 'label' | 'status' | 'detail'>[] };
    return [
      `**Last rebuild:** ${stored.allOk ? 'complete' : 'finished with problems'}`,
      ...stored.phases.map(phaseLine),
    ];
  } catch {
    return null;
  }
}

/**
 * @what Formats a count for the rebuild report, or "not run" when its phase produced no stats
 * @how Returns the number as a string, or the literal "not run" for undefined
 * @why A zero and "this phase did not run" must not look the same in the report
 *
 * @param {number | undefined} value The count, or undefined when the phase did not produce it
 * @returns {string} The count, or "not run"
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain index-rebuild
 * @tags index-rebuild, reporting, formatting, pure
 */
function countOrNotRun(value: number | undefined): string {
  return value === undefined ? 'not run' : String(value);
}

/**
 * @what Describes what happened to the validation cache, for the rebuild report
 * @how "not cleared" when the validation-cache phase failed; otherwise the list of removed files, or "already clear" when there were none
 * @why The cache line is the one count that is a list of files, not a number
 *
 * @param {RebuildResult} result The rebuild result
 * @returns {string} The text after "Validation cache:"
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain index-rebuild
 * @tags index-rebuild, reporting, validation-cache, pure
 */
function validationCacheText(result: RebuildResult): string {
  const cachePhase = result.phases.find(p => p.name === 'validation-cache');
  if (cachePhase?.status !== 'ok') return 'not cleared';
  if (result.clearedArtifacts.length === 0) return 'already clear';
  return `cleared (${result.clearedArtifacts.join(', ')})`;
}

/**
 * @what Renders a RebuildResult as the lines of the rebuild report
 * @how For a rebuild that did not start: the heading "Index Rebuild Not Started", a sentence saying nothing was changed, and the configuration errors as a list, with no counts. Otherwise: a heading ("Index Rebuild Complete" only when every phase is ok, else "Index Rebuild Finished With Problems"), one line per phase with its status and detail, then the counts, with "not run" for any count whose phase produced no stats.
 * @why The MCP tool and the CLI print the same report, and the heading must never claim completion when a phase failed, was skipped or ran degraded
 *
 * @param {RebuildResult} result The rebuild result
 * @returns {string[]} Markdown lines, without trailing newlines
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain index-rebuild, mcp-server
 * @tags index-rebuild, reporting, markdown, phase-status, pure
 */
export function formatRebuildReport(result: RebuildResult): string[] {
  if (result.notStarted !== null) {
    return [
      '## Index Rebuild Not Started',
      '',
      'The project configuration has errors, so nothing was changed. The existing index was left as it was.',
      '',
      ...result.notStarted.map(problem => `- ${problem}`),
      '',
      'Fix the configuration and run the rebuild again.',
    ];
  }

  const { indexStats, graphStats, pyGraphStats } = result;
  return [
    result.allOk ? '## Index Rebuild Complete' : '## Index Rebuild Finished With Problems',
    '',
    ...result.phases.map(phaseLine),
    '',
    `**Files scanned:** ${countOrNotRun(indexStats?.filesScanned)}`,
    `**Files skipped (unchanged):** ${countOrNotRun(indexStats?.filesSkipped)}`,
    `**Tier 1 (JSDoc):** ${countOrNotRun(indexStats?.tier1Added)}`,
    `**Tier 2 (exports):** ${countOrNotRun(graphStats?.exportsDiscovered)}`,
    `**Tier 3 (docs):** ${countOrNotRun(indexStats?.tier3Added)}`,
    `**Embeddings generated:** ${countOrNotRun(indexStats?.embeddingsGenerated)}`,
    `**Call edges:** ${countOrNotRun(graphStats?.edgesCreated)}`,
    `**Python call edges:** ${countOrNotRun(pyGraphStats?.edgesCreated)}`,
    `**Inline comments:** ${countOrNotRun(indexStats?.commentsExtracted)}`,
    `**Doc sections:** ${countOrNotRun(indexStats?.docSectionsCreated)}`,
    `**Validation cache:** ${validationCacheText(result)}`,
  ];
}
