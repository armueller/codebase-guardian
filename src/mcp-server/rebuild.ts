/**
 * The full index rebuild, as one sequence of isolated phases.
 *
 * Both entry points call this: the `rebuild_index` MCP tool and the `build-index` CLI. They used
 * to hold their own copies of the sequence, and one throwing phase aborted everything after it
 * with a bare error. Here each phase reports its own status, so the result says what ran, what
 * ran with a limitation, what failed and what was skipped.
 */
import type Database from 'better-sqlite3';
import type { GuardianConfig } from '../config.js';
import { clearAllData } from './db.js';
import { buildIndex, type IndexStats } from './indexer.js';
import { buildCallGraph, type CallGraphResult } from './call-graph.js';
import { buildPythonCallGraph } from './py-call-graph.js';
import { invalidateCache } from './embeddings.js';
import { clearValidationArtifacts } from './validation-artifacts.js';
import { missingConfiguredDirectories } from './file-walk.js';

/**
 * @what How one rebuild phase ended
 *
 * - `ok`: ran and did everything
 * - `degraded`: ran, with a stated limitation
 * - `failed`: threw; the error message is the detail
 * - `skipped`: not run, because a phase it depends on failed
 *
 * @domain rebuild, code-index
 * @tags rebuild, phase-status, reporting
 */
export type PhaseStatus = 'ok' | 'degraded' | 'failed' | 'skipped';

/**
 * @what Identifier of a rebuild phase, in run order: clear, index, ts-call-graph, py-call-graph, validation-cache
 * @domain rebuild, code-index
 * @tags rebuild, phase-name, pipeline
 */
export type PhaseName = 'clear' | 'index' | 'ts-call-graph' | 'py-call-graph' | 'validation-cache';

/**
 * @what The outcome of one rebuild phase, as shown in the rebuild report
 * @domain rebuild, code-index
 * @tags rebuild, phase-result, reporting
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
 * @what Everything a full rebuild produced: one result per phase plus the counts from the phases that ran
 * @domain rebuild, code-index
 * @tags rebuild, result, phase-status, stats
 */
export interface RebuildResult {
  /** Always all five phases, in run order */
  phases: PhaseResult[];
  /** null when indexing failed or was skipped */
  indexStats: IndexStats | null;
  /** null when the TypeScript call graph failed or was skipped */
  graphStats: CallGraphResult | null;
  /** null when the Python call graph failed or was skipped */
  pyGraphStats: { edgesCreated: number; note: string | null } | null;
  /** Validation cache and session files removed */
  clearedArtifacts: string[];
  /** True only when every phase is `ok` */
  allOk: boolean;
  /** True when clearing or indexing failed: the index itself is not trustworthy */
  indexingFailed: boolean;
}

/**
 * @what The phase implementations runRebuild calls, replaceable in tests
 * @domain rebuild, testing
 * @tags rebuild, dependency-injection, phases
 */
export interface RebuildDeps {
  clearAllData: typeof clearAllData;
  buildIndex: typeof buildIndex;
  buildCallGraph: typeof buildCallGraph;
  buildPythonCallGraph: typeof buildPythonCallGraph;
  clearValidationArtifacts: typeof clearValidationArtifacts;
  invalidateCache: typeof invalidateCache;
}

const DEFAULT_DEPS: RebuildDeps = {
  clearAllData,
  buildIndex,
  buildCallGraph,
  buildPythonCallGraph,
  clearValidationArtifacts,
  invalidateCache,
};

const LABELS: Record<PhaseName, string> = {
  'clear': 'Clear old index',
  'index': 'Index code and docs',
  'ts-call-graph': 'TypeScript call graph',
  'py-call-graph': 'Python call graph',
  'validation-cache': 'Validation cache',
};

/**
 * @what The result of running one phase body: its value, or the message of what it threw
 * @domain rebuild
 * @tags rebuild, error-isolation, result-type
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
 * @domain rebuild
 * @tags rebuild, error-isolation, try-catch, fail-open
 */
async function attempt<T>(body: () => T | Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await body() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
 * @domain rebuild
 * @tags rebuild, phase-result, labels, pure
 */
function phase(name: PhaseName, status: PhaseStatus, detail: string | null = null): PhaseResult {
  return { name, label: LABELS[name], status, detail };
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
 * @domain rebuild, python-support
 * @tags rebuild, python, call-graph, degraded, phase-status
 */
function pythonPhase(db: Database.Database, note: string | null, pythonFilesSkipped: number): PhaseResult {
  if (note === null) return phase('py-call-graph', 'ok');
  const pyRows = (db.prepare("SELECT COUNT(*) AS c FROM functions WHERE language = 'py'").get() as { c: number }).c;
  if (pyRows > 0 || pythonFilesSkipped > 0) return phase('py-call-graph', 'degraded', note);
  return phase('py-call-graph', 'ok', 'no Python files indexed');
}

/**
 * @what Lists the reasons the index phase ran with a limitation, in report order
 * @how Collects, in this order: guardian.config.json being unusable, each ignored config field, configured source or docs directories that do not exist, and Python files that could not be extracted. An empty list means the phase is ok.
 * @why Each of these leaves part of the project out of the index while indexing itself "succeeds". The report must say so, and say all of them, not just the first.
 *
 * @param {GuardianConfig} config The config the index phase ran with
 * @param {IndexStats} stats What the index phase reported
 * @returns {string[]} One reason per limitation; empty when there are none
 *
 * @sideeffects Reads the filesystem (stat of the configured directories)
 * @systemlayer Business Logic
 * @domain rebuild, code-index
 * @tags rebuild, degraded, config-warning, missing-directory, python
 */
function indexLimitations(config: GuardianConfig, stats: IndexStats): string[] {
  const reasons: string[] = [];

  if (config.configFileError) {
    reasons.push(`guardian.config.json could not be parsed (${config.configFileError}); auto-detected settings were used`);
  }
  reasons.push(...config.configWarnings);

  const missing = missingConfiguredDirectories(config);
  if (missing.length === 1) {
    reasons.push(`configured directory does not exist: ${missing[0]}`);
  } else if (missing.length > 1) {
    reasons.push(`configured directories do not exist: ${missing.join(', ')}`);
  }

  const skipped = stats.pythonFilesSkipped;
  if (skipped > 0) {
    const subject = skipped === 1 ? '1 Python file was' : `${skipped} Python files were`;
    reasons.push(`${subject} not indexed (extraction failed, or the Python interpreter is missing)`);
  }

  return reasons;
}

/**
 * @what Runs a full index rebuild as five isolated phases and reports each one's outcome
 * @how In order: clear the old data, index code and docs, build the TypeScript call graph, build the Python call graph, clear the hook's validation cache and sessions. Each phase runs through attempt(), so a throw is recorded as `failed` and the next phase still runs. The index phase is `degraded` when indexLimitations finds anything (unusable or partly ignored config, a configured directory that does not exist, Python files that could not be extracted), with every reason listed. The two call graphs resolve against the index phase's rows, so they are `skipped` when clearing or indexing failed; the validation cache is always cleared. The embedding cache is invalidated once after the call graphs.
 * @why One sequence for the MCP tool and the CLI, and a rebuild that never looks complete when part of it did not run. Before this, a missing tsconfig aborted the Python call graph and the cache clear and returned a bare error.
 *
 * @param {Database.Database} db Open index database
 * @param {GuardianConfig} config Freshly resolved project config; its projectRoot, databasePath and configFileError are used here and it is passed to the phases
 * @param {Partial<RebuildDeps>} [deps] Phase implementations to substitute (tests)
 * @returns {Promise<RebuildResult>} Per-phase results plus the stats of the phases that ran
 *
 * @sideeffects Deletes and rewrites the index database contents; reads source files; loads the embedding model; may spawn a Python subprocess; deletes the validation cache and session files; logs to stderr
 * @systemlayer Business Logic
 * @domain rebuild, code-index
 * @tags rebuild, pipeline, phase-isolation, call-graph, indexing, validation-cache, reporting
 */
export async function runRebuild(
  db: Database.Database,
  config: GuardianConfig,
  deps: Partial<RebuildDeps> = {},
): Promise<RebuildResult> {
  const d: RebuildDeps = { ...DEFAULT_DEPS, ...deps };
  const root = config.projectRoot;
  const phases: PhaseResult[] = [];
  let indexStats: IndexStats | null = null;
  let graphStats: CallGraphResult | null = null;
  let pyGraphStats: { edgesCreated: number; note: string | null } | null = null;
  let clearedArtifacts: string[] = [];

  // Phase 1: clear old data, so stale Tier 2 rows and call edges cannot survive the rebuild.
  const cleared = await attempt(() => d.clearAllData(db));
  phases.push(cleared.ok ? phase('clear', 'ok') : phase('clear', 'failed', cleared.error));

  // Phase 2: index code and docs.
  if (!cleared.ok) {
    phases.push(phase('index', 'skipped', 'clearing the old index failed'));
  } else {
    console.error('Indexing code and docs...');
    const indexed = await attempt(() => d.buildIndex(db, root, { config }));
    if (!indexed.ok) {
      phases.push(phase('index', 'failed', indexed.error));
    } else {
      indexStats = indexed.value;
      const limitations = indexLimitations(config, indexStats);
      phases.push(limitations.length > 0
        ? phase('index', 'degraded', limitations.join('; '))
        : phase('index', 'ok'));
    }
  }

  // Phases 3 and 4 resolve against the rows phase 2 wrote.
  if (indexStats === null) {
    const why = cleared.ok ? 'indexing failed' : 'indexing did not run';
    phases.push(phase('ts-call-graph', 'skipped', why));
    phases.push(phase('py-call-graph', 'skipped', why));
  } else {
    console.error('Building call graph...');
    const graph = await attempt(() => d.buildCallGraph(db, root, { config }));
    if (graph.ok) {
      graphStats = graph.value;
      phases.push(phase('ts-call-graph', graph.value.status, graph.value.note));
    } else {
      phases.push(phase('ts-call-graph', 'failed', graph.error));
    }

    console.error('Building Python call graph...');
    const pyGraph = await attempt(async () => {
      const stats = await d.buildPythonCallGraph(db, root);
      return { stats, result: pythonPhase(db, stats.note, indexStats?.pythonFilesSkipped ?? 0) };
    });
    if (pyGraph.ok) {
      pyGraphStats = pyGraph.value.stats;
      phases.push(pyGraph.value.result);
    } else {
      phases.push(phase('py-call-graph', 'failed', pyGraph.error));
    }
  }

  // Not a phase of its own: an in-memory cache reset. A failure here must not hide the results above.
  const invalidated = await attempt(() => d.invalidateCache());
  if (!invalidated.ok) console.error(`Embedding cache invalidation failed: ${invalidated.error}`);

  // Phase 5: the hook's cached verdicts were computed against the old index. Always clear them.
  const artifacts = await attempt(() => d.clearValidationArtifacts(config.databasePath));
  if (artifacts.ok) {
    clearedArtifacts = artifacts.value;
    phases.push(phase('validation-cache', 'ok'));
  } else {
    phases.push(phase('validation-cache', 'failed', artifacts.error));
  }

  return {
    phases,
    indexStats,
    graphStats,
    pyGraphStats,
    clearedArtifacts,
    allOk: phases.every(p => p.status === 'ok'),
    indexingFailed: phases.some(p => (p.name === 'clear' || p.name === 'index') && p.status === 'failed'),
  };
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
 * @domain rebuild
 * @tags rebuild, reporting, formatting, pure
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
 * @domain rebuild
 * @tags rebuild, reporting, validation-cache, pure
 */
function validationCacheText(result: RebuildResult): string {
  const cachePhase = result.phases.find(p => p.name === 'validation-cache');
  if (cachePhase?.status !== 'ok') return 'not cleared';
  if (result.clearedArtifacts.length === 0) return 'already clear';
  return `cleared (${result.clearedArtifacts.join(', ')})`;
}

/**
 * @what Renders a RebuildResult as the lines of the rebuild report
 * @how A heading ("Index Rebuild Complete" only when every phase is ok, otherwise "Index Rebuild Finished With Problems"), one line per phase with its status and detail, then the counts, with "not run" for any count whose phase produced no stats
 * @why The MCP tool and the CLI print the same report, and the heading must never claim completion when a phase failed, was skipped or ran degraded
 *
 * @param {RebuildResult} result The rebuild result
 * @returns {string[]} Markdown lines, without trailing newlines
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain rebuild, mcp-server
 * @tags rebuild, reporting, markdown, phase-status, pure
 */
export function formatRebuildReport(result: RebuildResult): string[] {
  const { indexStats, graphStats, pyGraphStats } = result;
  const phaseLines = result.phases.map(p =>
    `- **${p.label}:** ${p.status}${p.detail ? ` (${p.detail})` : ''}`);

  return [
    result.allOk ? '## Index Rebuild Complete' : '## Index Rebuild Finished With Problems',
    '',
    ...phaseLines,
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
