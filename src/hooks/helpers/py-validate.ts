/**
 * @what Self-contained Python validation path for the PreToolUse hook
 * @how Mirrors validateEdit's cache/session/circuit-breaker/headless/decision scaffolding
 *   (pre-edit-validation.ts, ~lines 305-524), substituting guardian_py extraction (py-adapter.ts),
 *   deterministic tool findings (py-tools.ts), and pragmatic doc-completeness checks (py-doc-check.ts)
 *   for the ts-morph/JSDoc pieces the TypeScript path uses. Every early-return path fails open (allow).
 * @why Python edits need the same DRY/documentation enforcement as TypeScript edits, but the
 *   extraction, doc-completeness convention, and prompt shape differ enough (no code index coverage,
 *   docstrings instead of JSDoc, PEP 604 type annotations) that reusing validateEdit directly would
 *   require threading Python-specific branches through every step of the TS flow. A dedicated module
 *   keeps the TS path byte-for-byte untouched — some cache/session orchestration is duplicated between
 *   the two paths, which is the accepted tradeoff for that isolation.
 *
 * @sideeffects Spawns Python subprocesses (via extractPython/runPyTools), executes headless Claude,
 *   reads/writes the validation cache and session store, logs to the validation debug log
 * @systemlayer Validation Logic
 * @domain python-support, validation-orchestration, code-quality-workflow
 * @tags python, validation-flow, hook-adapter, session-resume, fail-open
 */

import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { HookInput, HookResponse } from './types.js';
import { extractPython } from './adapters/py-adapter.js';
import { runPyTools } from './py-tools.js';
import { markUnitNovelty, checkPythonDocCompleteness } from './py-doc-check.js';
import {
  executeClaudeHeadless,
  buildPythonFirstAttemptPrompt,
  buildPythonRetryPrompt
} from './claude-headless.js';
import {
  getCachedValidation,
  setCachedValidation,
  generateCacheKey,
  clearCacheForFile
} from './validation-cache.js';
import { getSession, setDenialInfo, clearSession } from './validation-sessions.js';
import { shouldStandDown } from './circuit-breaker.js';
import { enhanceViolationWithQueryHint } from './denial-hints.js';
import { resolveConfig } from '../../config.js';

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
 *   builds a first-attempt or retry Python prompt, and executes headless Claude to render the final
 *   decision. Every extraction failure mode (unavailable tooling, syntax/partial-parse, extractor
 *   error) and any unexpected throw returns an allow decision — this path never blocks on its own account.
 * @why Gives Python edits the same DRY/documentation enforcement headless Claude provides for
 *   TypeScript, without touching validateEdit's TS-only flow — reached by a single early branch so the
 *   two languages' orchestration can diverge (no code index, docstrings vs JSDoc) without coupling.
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
    let existingSession = getSession(sessionKey);

    if (existingSession && existingSession.lastDeniedContentHash) {
      const onDiskHash = crypto.createHash('sha256').update(currentFileOnDisk).digest('hex').slice(0, 16);
      if (onDiskHash !== existingSession.lastDeniedContentHash) {
        log('[PY][SESSION] File content changed since last denial — clearing stale session for fresh validation');
        clearSession(sessionKey);
        existingSession = null;
      }
    }

    const isRetry = existingSession !== null;
    log(`[PY][SESSION] ${isRetry ? `Retry attempt #${existingSession!.attemptCount + 1} (session: ${existingSession!.headlessSessionId})` : 'First attempt'}`);

    if (isRetry && shouldStandDown(existingSession!.attemptCount)) {
      const priorReason = existingSession!.lastDeniedReason || 'see the previous validation output';
      log(`[PY][SESSION] Circuit breaker: ${existingSession!.attemptCount} consecutive denials — standing down to avoid a permanent block`);
      clearSession(sessionKey);
      return {
        action: 'allow',
        message: `⚠️ Code Quality is standing down after ${existingSession!.attemptCount} blocked attempts to avoid trapping this edit. The edit is being ALLOWED, but the last review's concerns were NOT resolved — please address them in a follow-up: ${priorReason}`,
        suggestions: [
          `The guardian blocked this edit ${existingSession!.attemptCount}× without the issues being resolved and is now allowing it through so work is not permanently blocked. Unresolved concerns: ${priorReason}`
        ]
      };
    }

    if (isRetry && existingSession!.lastDeniedProposedHash) {
      const proposedHash = crypto.createHash('sha256').update(fullFileContent).digest('hex').slice(0, 16);
      if (proposedHash === existingSession!.lastDeniedProposedHash) {
        log('[PY][SESSION] Identical resubmission detected — returning cached denial (saved ~10s headless call)');
        return {
          action: 'deny',
          message: `BLOCKED (identical resubmission): ${existingSession!.lastDeniedReason || 'Same code as previously denied — please fix the violations before retrying'}`,
          violations: ['Code is identical to the previously denied submission. Fix the issues described above before retrying.']
        };
      }
    }

    // ── Step 7: Build prompt ──

    const prompt = isRetry
      ? buildPythonRetryPrompt({
          filePath,
          functions: extracted.functions,
          classes: extracted.classes,
          docViolations,
          toolFindings
        })
      : buildPythonFirstAttemptPrompt({
          filePath,
          functions: extracted.functions,
          classes: extracted.classes,
          module: extracted.module,
          docViolations,
          toolFindings,
          isNewFile,
          syntaxNote: false
        });

    // ── Step 8: Execute headless Claude ──

    try {
      log('[PY] Executing headless Claude...');
      const t9 = Date.now();
      const validationResult = await executeClaudeHeadless({
        outerSessionId: sessionId,
        filePath,
        prompt,
        isRetry,
        timeoutMs: 120000
      });
      log(`[PY][TIMING] Headless Claude execution: ${Date.now() - t9}ms`);
      log(`[PY] Decision: ${validationResult.decision}`);
      log(`[PY] Reasoning: ${validationResult.reasoning}`);
      log(`[PY] Violations: ${JSON.stringify(validationResult.violations)}`);
      log(`[PY] Suggestions: ${JSON.stringify(validationResult.suggestions)}`);
      log(`[PY][TIMING] TOTAL VALIDATION TIME: ${Date.now() - startTime}ms`);

      if (validationResult.decision === 'allow') {
        clearCacheForFile(filePath);
      }

      setCachedValidation(cacheKey, validationResult, filePath);

      if (validationResult.suggestions && validationResult.suggestions.length > 0) {
        try {
          const suggestionsPath = hookConfig.suggestionsPath;
          mkdirSync(path.dirname(suggestionsPath), { recursive: true });
          const timestamp = new Date().toISOString();
          const header = `\n## Session: ${sessionId} — ${timestamp}\n\n`;
          const entries = validationResult.suggestions
            .map(s => `- **File:** \`${filePath}\`\n  **Suggestion:** ${s}\n`)
            .join('\n');
          appendFileSync(suggestionsPath, header + entries, 'utf-8');
          log(`[PY][SUGGESTIONS] Logged ${validationResult.suggestions.length} suggestions`);
        } catch {
          // Non-fatal — don't block the edit for suggestion logging failures
        }
      }

      if (validationResult.decision !== 'allow') {
        const onDiskHash = crypto.createHash('sha256').update(currentFileOnDisk).digest('hex').slice(0, 16);
        const proposedHash = crypto.createHash('sha256').update(fullFileContent).digest('hex').slice(0, 16);
        setDenialInfo(sessionKey, onDiskHash, validationResult.reasoning, proposedHash);
      }

      const enhancedViolations = validationResult.violations.map(enhanceViolationWithQueryHint);

      return {
        action: validationResult.decision === 'allow' ? 'allow' : 'deny',
        message: validationResult.decision === 'allow'
          ? `Code Quality Passed: ${validationResult.reasoning}`
          : `BLOCKED: ${validationResult.reasoning}`,
        violations: enhancedViolations,
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
