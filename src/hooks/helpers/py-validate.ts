/**
 * @what Self-contained Python validation path for the PreToolUse hook
 * @how Runs the same cache → session-resolution → headless → outcome-recording flow as validateEdit,
 *   but via the shared validation-flow.ts helpers (resolveSessionState / recordValidationOutcome) plus
 *   guardian_py extraction (py-adapter.ts), deterministic tool findings (py-tools.ts), pragmatic
 *   doc-completeness checks (py-doc-check.ts), pre-injected code index pattern context
 *   (buildPatternContext, built defensively so a missing/empty Python index never blocks), a bounded
 *   read-only MCP tool allowlist (PY_INDEX_TOOLS — no filesystem tools), and a neutral Python system
 *   prompt. Every early-return path fails open (allow).
 * @why Python edits need the same DRY/documentation enforcement as TypeScript edits, but the
 *   extraction, doc-completeness convention, and prompt shape differ enough (docstrings instead of
 *   JSDoc, PEP 604 type annotations) that a dedicated module keeps the TS validateEdit flow untouched.
 *   The code index now has Python coverage (P3.3 definitions, P3.4 call edges), so this path (P3.5)
 *   injects the same kind of sibling/similar/caller/doc context the TypeScript path gets, instead of
 *   letting headless Claude explore the filesystem ad-hoc to find it — that ad-hoc exploration was the
 *   root cause of this path's former multi-minute timeouts. The language-agnostic session/outcome
 *   logic now lives in validation-flow.ts and is shared with this path (a matching migration of
 *   validateEdit is a deferred follow-up) so the session-store invariants can't drift between the two.
 *
 * @sideeffects Spawns Python subprocesses (via extractPython/runPyTools), executes headless Claude,
 *   reads/writes the validation cache and session store, logs to the validation debug log
 * @systemlayer Validation Logic
 * @domain python-support, validation-orchestration, code-quality-workflow
 * @tags python, validation-flow, hook-adapter, session-resume, fail-open
 */

import { appendFileSync, existsSync, statSync, renameSync } from 'fs';
import { HookInput, HookResponse } from './types.js';
import { extractPython } from './adapters/py-adapter.js';
import { runPyTools } from './py-tools.js';
import { markUnitNovelty, checkPythonDocCompleteness } from './py-doc-check.js';
import { resolveSessionState, recordValidationOutcome } from './validation-flow.js';
import {
  executeClaudeHeadless,
  buildPythonFirstAttemptPrompt,
  buildPythonRetryPrompt,
  PY_SYSTEM_PROMPT
} from './claude-headless.js';
import { buildPatternContext, type PatternContext } from './code-index-client.js';
import {
  getCachedValidation,
  generateCacheKey,
  clearCacheForFile
} from './validation-cache.js';
import { resolveConfig } from '../../config.js';

// ─── Bounded MCP Tools ────────────────────────────────────────────────────────

// The read-only code-index MCP tools ONLY — no Read/Bash/Grep/Glob/Write/Edit. This is
// what replaces the Python path's former ad-hoc filesystem exploration (the root cause
// of its multi-minute timeouts): the headless agent must answer from the pre-injected
// pattern context (see buildPatternContext below) plus these bounded index queries,
// never by wandering the filesystem. Excludes `rebuild_index` (mutating) and `execute`
// (arbitrary SQL) — confirmed against the full tool registration in src/mcp-server/index.ts.
const PY_INDEX_TOOLS = [
  'mcp__codebase-guardian__search',
  'mcp__codebase-guardian__callers',
  'mcp__codebase-guardian__callees',
  'mcp__codebase-guardian__impact',
  'mcp__codebase-guardian__search_comments',
  'mcp__codebase-guardian__search_doc_sections',
  'mcp__codebase-guardian__list_domains',
  'mcp__codebase-guardian__list_tags',
  'mcp__codebase-guardian__list_systemlayers',
  'mcp__codebase-guardian__index_status',
];

// An all-empty PatternContext, returned when buildPatternContext is unavailable or
// throws (no index yet, corrupt DB, etc.) so a missing Python index can never break
// or block a Python edit — see the defensive buildPatternContext call below.
const EMPTY_PATTERN_CONTEXT: PatternContext = {
  directoryReadme: null,
  siblingFunctions: [],
  calledFunctionDetails: new Map(),
  unknownCalledFunctions: [],
  callerDetails: new Map(),
  similarExistingFunctions: new Map(),
  relevantDocs: [],
  similarComments: [],
  directoryPatterns: {
    commonDomains: [],
    commonSystemLayers: [],
    commonTags: [],
    hasSideEffects: false,
    namingExamples: [],
  },
};

/**
 * @what Extracts Python comments (both standalone `#` lines and trailing `# ...` comments after code) from a source buffer
 * @how Scans each line for the first `#` character and, when present, takes the trimmed text after it as a comment; comments shorter than 5 characters are dropped as noise
 * @why Feeds buildPatternContext's step-level DRY comment search (searchCommentsForDRY) with the Python edit's inline comments, mirroring extractInlineComments' role for the TypeScript path. Unlike extractInlineComments (which only captures full-line `//` comments), this also captures trailing `# ...` comments — Python's dominant comment style keeps short trailing notes on the code line itself rather than a leading standalone line. String-embedded `#` characters (e.g. inside a docstring or string literal) are not distinguished from real comments — an acceptable heuristic for this best-effort search-query generator, matching the TS extractor's own pragmatism
 *
 * @param {string} source Python source text (typically the proposed post-edit content)
 * @returns {string[]} Extracted comment strings, at least 5 characters each
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain comment-extraction, dry-detection, python-support
 * @tags comments, extraction, python, hook-side, lightweight
 */
export function extractPythonComments(source: string): string[] {
  const comments: string[] = [];
  for (const line of source.split('\n')) {
    const hashIndex = line.indexOf('#');
    if (hashIndex === -1) continue;
    const text = line.slice(hashIndex + 1).trim();
    if (text.length >= 5) {
      comments.push(text);
    }
  }
  return comments;
}

const hookConfig = resolveConfig();
const LOG_PATH = hookConfig.logPath;

const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2MB rotation threshold
let logRotationChecked = false;

/**
 * @what Logs a Python-path message to the shared validation debug log
 * @how Rotates the log once per process if it exceeds 2MB, then appends the message with a newline
 * @why Debugging Python validation decisions alongside the TypeScript path's log lines in the same file
 *
 * @param {string} message Message to log
 * @returns {void}
 *
 * @sideeffects Writes to the log file
 * @systemlayer Logging
 * @domain debugging, logging, python-support
 * @tags logging, debugging, file-append, python
 */
function log(message: string): void {
  try {
    if (!logRotationChecked) {
      logRotationChecked = true;
      if (existsSync(LOG_PATH)) {
        const size = statSync(LOG_PATH).size;
        if (size > MAX_LOG_SIZE) {
          renameSync(LOG_PATH, LOG_PATH + '.old');
        }
      }
    }
    appendFileSync(LOG_PATH, message + '\n');
  } catch {
    // Ignore logging errors
  }
}

/**
 * @what Validates a proposed edit to a Python file and returns an allow/deny decision
 * @how Extracts functions/classes/module metadata via guardian_py (extractPython), marks novelty
 *   against the pre-edit file, applies the pragmatic doc-completeness convention (relaxed to empty
 *   for test files), runs ruff/pydoclint for deterministic findings, checks the validation cache,
 *   resolves session/circuit-breaker/identical-resubmission state exactly as the TypeScript path does,
 *   builds a first-attempt or retry Python prompt — on first attempt, pulling pre-injected pattern
 *   context (siblings/similar/callers/docs/comments) from buildPatternContext, called defensively so a
 *   missing or empty Python index never breaks or blocks the edit — and executes headless Claude,
 *   bounded to the read-only code-index MCP tools (PY_INDEX_TOOLS, no filesystem tools), to render the
 *   final decision. Every extraction failure mode (unavailable tooling, syntax/partial-parse, extractor
 *   error) and any unexpected throw returns an allow decision — this path never blocks on its own account.
 * @why Gives Python edits the same DRY/documentation enforcement headless Claude provides for
 *   TypeScript, without touching validateEdit's TS-only flow — reached by a single early branch so the
 *   two languages' orchestration can diverge (docstrings vs JSDoc, no JSDoc-style tag requirements)
 *   without coupling. Injecting pattern context and bounding the tool set (P3.5) replaces the ad-hoc
 *   filesystem exploration that previously caused this path's multi-minute timeouts, while preserving
 *   — and improving — its cross-file DRY/pattern/caller coverage.
 *
 * @param {HookInput} input Edit operation to validate (session id, tool name, tool_input)
 * @param {string} fullFileContent Proposed post-edit file content, already constructed by the caller
 * @param {string} currentFileOnDisk Pre-edit file content on disk ('' for a new file)
 * @param {number} startTime Timestamp (Date.now()) when validation started, for total-time logging
 * @returns {Promise<HookResponse>} Validation decision (allow/deny with violations/suggestions)
 *
 * @sideeffects Spawns Python subprocesses, executes headless Claude, reads/writes cache and session
 *   store, logs
 * @systemlayer Validation Logic
 * @domain python-support, validation-orchestration, code-quality-workflow
 * @tags python, validation-flow, extraction, ai-validation, session-resume, fail-open
 */
export async function validatePythonEdit(
  input: HookInput,
  fullFileContent: string,
  currentFileOnDisk: string,
  startTime: number
): Promise<HookResponse> {
  const filePath = input.tool_input.file_path || '';
  const sessionId = input.session_id;

  try {
    // ── Step 1: Extract proposed functions/classes/module metadata ──

    const extracted = extractPython(filePath, fullFileContent, { timeoutMs: 5000 });
    if (!extracted.ok) {
      if (extracted.reason === 'unavailable') {
        log('[PY] tooling unavailable — skipping');
        return { action: 'allow', message: 'Python tooling unavailable (skipping)' };
      }
      if (extracted.reason === 'syntax') {
        log('[PY] intermediate/partial parse — allowing');
        return { action: 'allow', message: 'Python edit is a partial/intermediate state (allowing)' };
      }
      log('[PY] extractor error — allowing (fail-open)');
      return { action: 'allow', message: 'Python extraction error (allowing edit)' };
    }

    // ── Step 2: Mark novelty by diffing against the pre-edit file's unit names ──

    const oldUnitNames = new Set<string>();
    if (currentFileOnDisk) {
      const oldExtracted = extractPython(filePath, currentFileOnDisk, { timeoutMs: 5000 });
      if (oldExtracted.ok) {
        for (const fn of oldExtracted.functions) oldUnitNames.add(fn.name);
        for (const cls of oldExtracted.classes) oldUnitNames.add(cls.name);
      }
    }
    markUnitNovelty(oldUnitNames, extracted.functions, extracted.classes);
    const isNewFile = input.tool_name === 'Write' && currentFileOnDisk === '';

    // ── Step 3: Test-file relaxation — tests are exempt from docstring requirements ──

    const isTestFile =
      /(^|\/)tests?\//.test(filePath) ||
      /(^|\/)test_[^/]*\.py$/.test(filePath) ||
      /_test\.py$/.test(filePath);
    const docViolations = isTestFile
      ? new Map<string, string[]>()
      : checkPythonDocCompleteness(extracted.functions, extracted.classes, extracted.module);

    // ── Step 4: Deterministic tool findings (ruff + pydoclint) ──

    const toolFindings = runPyTools(filePath, fullFileContent, { timeoutMs: 8000 });
    log(`[PY] tools ruff:${toolFindings.ruff.length} pydoclint:${toolFindings.pydoclint.length}`);

    // ── Step 5: Check validation cache (exact same edit = skip AI) ──

    const oldString = input.tool_input.old_string || '';
    const newString = input.tool_input.new_string || input.tool_input.content || '';
    const cacheKey = generateCacheKey(filePath, oldString, newString);
    const cachedResult = getCachedValidation(cacheKey);
    if (cachedResult) {
      log(`[PY][CACHE] Returning cached result: ${cachedResult.decision}`);
      return {
        action: cachedResult.decision === 'allow' ? 'allow' : 'deny',
        message: cachedResult.decision === 'allow'
          ? `Validation Passed (cached): ${cachedResult.reasoning}`
          : `BLOCKED (cached): ${cachedResult.reasoning}`,
        violations: cachedResult.violations
      };
    }

    // ── Step 6: Session + circuit breaker + identical resubmission ──

    const sessionKey = `${sessionId}:${filePath}`;
    const { isRetry, earlyReturn } = resolveSessionState({
      sessionKey,
      currentFileOnDisk,
      fullFileContent,
      log,
      logPrefix: '[PY]'
    });
    if (earlyReturn) return earlyReturn;

    // ── Step 7: Build prompt ──

    let prompt: string;

    if (isRetry) {
      // Retry mirrors the TypeScript path: no pattern context rebuild — the resumed
      // headless session already has the first attempt's injected index context.
      prompt = buildPythonRetryPrompt({
        filePath,
        functions: extracted.functions,
        classes: extracted.classes,
        docViolations,
        toolFindings
      });
    } else {
      // First attempt: gather the same modified/created/comment context the TypeScript
      // path gathers, then pull pre-injected sibling/similar/caller/doc context from the
      // code index (P3.3/P3.4 gave it Python coverage). calledFunctions is passed as []
      // — guardian_py's extract contract has no call-name field per unit, and running
      // callgraph mode per-edit would reintroduce the Jedi-driven latency this task is
      // removing. DRY/siblings/callers do not depend on it; it only adds "called-function
      // detail" that the Python prompt doesn't render anyway (see buildPythonRelatedCodeSection).
      const modified = [
        ...extracted.functions.filter(f => f.isModified).map(f => f.name),
        ...extracted.classes.filter(c => c.isModified).map(c => c.name),
      ];
      const created = [
        ...extracted.functions.filter(f => f.isNew).map(f => f.name),
        ...extracted.classes.filter(c => c.isNew).map(c => c.name),
      ];
      const editComments = extractPythonComments(newString);

      const t7 = Date.now();
      // Pass 'py' so the DRY-similarity and sibling lookups are language-scoped —
      // the code index is shared across languages, so an unfiltered search could
      // otherwise surface TypeScript functions as "similar" to this Python edit.
      const patternContext = await buildPatternContext(filePath, modified, created, [], editComments, 'py')
        .catch(() => EMPTY_PATTERN_CONTEXT);
      log(`[PY][TIMING] Build pattern context: ${Date.now() - t7}ms`);
      log(`[PY][CONTEXT] README: ${patternContext.directoryReadme ? 'found' : 'none'}, Siblings: ${patternContext.siblingFunctions.length}, Similar: ${patternContext.similarExistingFunctions.size}, Callers: ${patternContext.callerDetails.size}, RelevantDocs: ${patternContext.relevantDocs.length}, SimilarComments: ${patternContext.similarComments.length}`);

      prompt = buildPythonFirstAttemptPrompt({
        filePath,
        functions: extracted.functions,
        classes: extracted.classes,
        module: extracted.module,
        docViolations,
        toolFindings,
        isNewFile,
        patternContext,
        syntaxNote: false
      });
    }

    // ── Step 8: Execute headless Claude ──

    try {
      log('[PY] Executing headless Claude...');
      const t9 = Date.now();
      const validationResult = await executeClaudeHeadless({
        outerSessionId: sessionId,
        filePath,
        prompt,
        isRetry,
        // Reverted from the 300s ceiling: the agent is now bounded to the read-only
        // code-index MCP tools (PY_INDEX_TOOLS) and answers from pre-injected pattern
        // context instead of ad-hoc filesystem exploration (Read/Bash/Grep), so a
        // multi-minute exploratory tail is no longer expected — 120s matches the
        // TypeScript path's timeout.
        timeoutMs: 120000,
        // Python gets a neutral system prompt (not the TS JSDoc/"err-toward-deny" one).
        // The code index now covers Python (P3.3/P3.4), so useMcp is on — but bounded
        // to PY_INDEX_TOOLS (no Read/Bash/Grep/Glob/Write/Edit) so the agent can only
        // query the index, never wander the filesystem.
        systemPrompt: PY_SYSTEM_PROMPT,
        useMcp: true,
        allowedTools: PY_INDEX_TOOLS
      });
      log(`[PY][TIMING] Headless Claude execution: ${Date.now() - t9}ms`);
      log(`[PY] Decision: ${validationResult.decision}`);
      log(`[PY] Reasoning: ${validationResult.reasoning}`);
      log(`[PY] Violations: ${JSON.stringify(validationResult.violations)}`);
      log(`[PY] Suggestions: ${JSON.stringify(validationResult.suggestions)}`);
      log(`[PY][TIMING] TOTAL VALIDATION TIME: ${Date.now() - startTime}ms`);

      recordValidationOutcome({
        cacheKey,
        filePath,
        sessionKey,
        sessionId,
        validationResult,
        currentFileOnDisk,
        fullFileContent,
        suggestionsPath: hookConfig.suggestionsPath,
        log,
        logPrefix: '[PY]'
      });

      // Python violations are NOT run through enhanceViolationWithQueryHint: those hints
      // reference api.semanticSearch/api.callers — the sandboxed API surface of the
      // `execute` MCP tool, which is deliberately excluded from PY_INDEX_TOOLS (arbitrary
      // SQL, not a bounded read-only query). Appending an `execute`-shaped hint the agent
      // has no access to would only mislead. Return raw.
      return {
        action: validationResult.decision === 'allow' ? 'allow' : 'deny',
        message: validationResult.decision === 'allow'
          ? `Code Quality Passed: ${validationResult.reasoning}`
          : `BLOCKED: ${validationResult.reasoning}`,
        violations: validationResult.violations,
        suggestions: validationResult.suggestions.length > 0 ? validationResult.suggestions : undefined
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (errorMsg.includes('timed out')) {
        log('[PY] Validation timed out — allowing edit (fail-open)');
        clearCacheForFile(filePath);
        return { action: 'allow', message: 'Validation timed out (allowing edit)' };
      }

      log(`[PY] Validation error: ${errorMsg}`);
      clearCacheForFile(filePath);
      return { action: 'allow', message: `Validation error (allowing edit): ${errorMsg}` };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`[PY] Unexpected error — allowing edit (fail-open): ${errorMsg}`);
    return { action: 'allow', message: `Python validation error (allowing edit): ${errorMsg}` };
  }
}
