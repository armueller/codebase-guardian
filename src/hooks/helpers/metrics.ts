/**
 * @fileoverview Durable, cross-project store of every validation decision the hook makes.
 * The debug log is verbose and rotates (2 generations), so it cannot answer "is the guardian
 * useful over time?". This records one compact row per validation into a single global SQLite
 * database (`<guardianHome>/metrics.db`) that survives log rotation, index rebuilds, and plugin
 * data changes — enabling allow/deny, reason-category, timing, and per-project analysis over any
 * time range. Recording is strictly fail-safe: a metrics error must NEVER break the hook.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { getGuardianHome } from '../../config.js';

/**
 * @what One validation decision to persist for metrics
 * @domain metrics, decisions, validation
 * @tags decision-record, metrics, schema
 */
export interface DecisionMetric {
  decision: 'allow' | 'deny';
  message?: string;
  violations?: string[];
  numSuggestions?: number;
  filePath?: string;
  projectHash?: string;
  projectName?: string;
  projectRoot?: string;
  toolName?: string;
  headlessRan?: boolean;
  headlessMs?: number;
  validationMs?: number;
  wasCached?: boolean;
  isRetry?: boolean;
  attemptCount?: number;
  sessionId?: string;
}

const CATEGORY_RULES: Array<{ category: string; pattern: RegExp }> = [
  { category: 'dry', pattern: /\bdry\b|duplicat|reimplement|already (exists|implement)|line-for-line|use (the )?existing/i },
  { category: 'jsdoc-missing', pattern: /missing all jsdoc|no jsdoc|jsdoc: missing|missing @|has no jsdoc|undocumented/i },
  { category: 'jsdoc-accuracy', pattern: /@how|@what|@why|@sideeffects|@param|@returns|inaccurate|stale doc|does not (match|describe)|misdescrib|misplac|detached|drifted/i },
  { category: 'domain', pattern: /@domain|canonical domain/i },
  { category: 'inline-comment', pattern: /inline comment|comment (quality|reverses|is (vague|wrong|false|misleading))|misleading comment|vague comment/i },
  { category: 'logging', pattern: /console\.|eslint-disable|no-console/i },
  { category: 'orphaned-code', pattern: /orphan|dead code|\bunused\b|inert|fake (reference|sink)/i },
  { category: 'naming-pattern', pattern: /naming|convention|snake_case|camelcase|pattern mismatch/i },
  { category: 'runtime-correctness', pattern: /undefined|referenceerror|does not exist on type|unreachable|runtime error|type error/i },
  { category: 'terminology', pattern: /terminolog|data-model|\bspread\b|semantic type/i },
];

/**
 * @what Tags a denial's reasoning/violations with the quality-issue categories it involves
 * @how Runs each category's regex over the combined violation + reasoning text; a decision can match several
 * @why Category tags make the store queryable ("what does the guardian block most?") without storing full violation text
 *
 * @param {string[]} violations The violation strings (empty for allows)
 * @param {string} reasoning The headless reasoning / decision message
 * @returns {string[]} Distinct category tags (empty if none matched)
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain metrics, categorization
 * @tags violation-categories, tagging, metrics, analysis
 */
export function categorizeViolations(violations: string[], reasoning: string): string[] {
  const text = `${(violations || []).join(' ')} ${reasoning || ''}`;
  const hits: string[] = [];
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) hits.push(rule.category);
  }
  return hits;
}

/**
 * @what Classifies a decision into a coarse outcome bucket from its message
 * @how Keyword-matches the decision message (skip, no-index, timeout, error, no-decl, circuit-breaker, cached, identical, quality-pass, blocked)
 * @why The outcome bucket separates genuine code-quality judgments from skips and fail-opens when analyzing metrics
 *
 * @param {'allow' | 'deny'} decision The final decision
 * @param {string} message The decision message
 * @returns {string} A single outcome bucket label
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain metrics, classification
 * @tags outcome-bucket, classification, metrics
 */
export function deriveOutcome(decision: 'allow' | 'deny', message: string): string {
  const m = (message || '').toLowerCase();
  if (decision === 'deny') {
    if (m.includes('identical resubmission')) return 'deny_identical_resubmit';
    if (m.includes('(cached)')) return 'deny_cached';
    return 'deny_blocked';
  }
  if (m.includes('skipping validation') || m.includes('not an edit/write')) return 'skip';
  if (m.includes('index unavailable') || m.includes('index database not available')) return 'fail_open_no_index';
  if (m.includes('timed out')) return 'fail_open_timeout';
  if (m.includes('validation error') || m.includes('hook validation error') || m.includes('fatal error')) return 'fail_open_error';
  if (m.includes('no function or type declarations') || m.includes('no functions or types')) return 'no_decl_changed';
  if (m.includes('standing down')) return 'circuit_breaker';
  if (m.includes('parse too incomplete') || m.includes('intermediate syntax')) return 'skip_intermediate_syntax';
  return 'quality_pass';
}

let cachedDb: Database.Database | null = null;
let dbUnavailable = false;

/**
 * @what Opens (once) the global metrics database, creating its schema on first use
 * @how Lazily opens `<guardianHome>/metrics.db` in WAL mode with a busy timeout for concurrent hook processes; caches the handle
 * @why A single shared handle avoids re-opening per call; WAL + busy timeout let parallel hook invocations write safely
 *
 * @returns {Database.Database | null} The database handle, or null if it could not be opened
 *
 * @sideeffects Opens/creates a SQLite file and its schema on disk
 * @systemlayer Data Layer
 * @domain metrics, persistence
 * @tags sqlite, wal, lazy-open, metrics-db
 */
function getMetricsDb(): Database.Database | null {
  if (cachedDb) return cachedDb;
  if (dbUnavailable) return null;
  try {
    const dbPath = path.join(getGuardianHome(), 'metrics.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        project_hash TEXT, project_name TEXT, project_root TEXT,
        file_path TEXT, file_ext TEXT, tool_name TEXT,
        decision TEXT NOT NULL, outcome TEXT NOT NULL,
        headless_ran INTEGER NOT NULL DEFAULT 0,
        was_cached INTEGER NOT NULL DEFAULT 0,
        is_retry INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        violation_categories TEXT,
        num_violations INTEGER NOT NULL DEFAULT 0,
        num_suggestions INTEGER NOT NULL DEFAULT 0,
        reasoning TEXT,
        validation_ms INTEGER, headless_ms INTEGER,
        session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);
      CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_hash);
    `);
    cachedDb = db;
    return db;
  } catch {
    dbUnavailable = true;
    return null;
  }
}

/**
 * @what Persists one validation decision to the metrics store
 * @how Derives the outcome bucket and violation categories, then inserts a row; all work is wrapped so a failure is swallowed
 * @why Durable metrics are the only way to measure the guardian's usefulness over time — but recording must never break the fail-open hook
 *
 * @param {DecisionMetric} m The decision to record
 * @returns {void}
 *
 * @sideeffects Inserts a row into the metrics SQLite database (best-effort; errors are swallowed)
 * @systemlayer Data Layer
 * @domain metrics, persistence, validation
 * @tags record-decision, metrics, fail-safe, sqlite
 */
export function recordDecision(m: DecisionMetric): void {
  try {
    const db = getMetricsDb();
    if (!db) return;
    const outcome = deriveOutcome(m.decision, m.message || '');
    const categories = m.decision === 'deny' ? categorizeViolations(m.violations || [], m.message || '') : [];
    const ext = m.filePath ? path.extname(m.filePath) : '';
    const reasoning = (m.message || '').slice(0, 1000);
    db.prepare(`
      INSERT INTO decisions (
        ts, project_hash, project_name, project_root, file_path, file_ext, tool_name,
        decision, outcome, headless_ran, was_cached, is_retry, attempt_count,
        violation_categories, num_violations, num_suggestions, reasoning,
        validation_ms, headless_ms, session_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      new Date().toISOString(),
      m.projectHash ?? null, m.projectName ?? null, m.projectRoot ?? null,
      m.filePath ?? null, ext || null, m.toolName ?? null,
      m.decision, outcome,
      m.headlessRan ? 1 : 0, m.wasCached ? 1 : 0, m.isRetry ? 1 : 0, m.attemptCount ?? 0,
      categories.length ? JSON.stringify(categories) : null,
      (m.violations || []).length, m.numSuggestions ?? 0, reasoning || null,
      m.validationMs ?? null, m.headlessMs ?? null, m.sessionId ?? null
    );
  } catch {
    // Metrics must never break the hook — swallow all errors.
  }
}
