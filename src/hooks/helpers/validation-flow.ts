/**
 * @what Language-agnostic validation-flow helpers shared by the TypeScript and Python hook paths
 * @how Pulls the session-staleness/circuit-breaker/identical-resubmission resolution and the cache/suggestion/denial-recording tail out of the per-language orchestrators, so both paths run byte-identical session and outcome logic
 * @why validateEdit and validatePythonEdit had near-verbatim copies of this logic; the session-store invariants in CLAUDE.md (on-disk vs proposed hashing, denial-never-lands) depend on the two paths never drifting, so the shared logic lives in one place
 *
 * @sideeffects None at module scope
 * @systemlayer Validation Logic
 * @domain validation-flow, session-management, circuit-breaker, dedup
 * @tags shared-helper, session-resolution, outcome-recording, dry, language-agnostic
 */

import crypto from 'crypto';
import path from 'path';
import { mkdirSync, appendFileSync } from 'fs';
import { HookResponse, ClaudeValidationResponse } from './types.js';
import { getSession, setDenialInfo, clearSession } from './validation-sessions.js';
import { shouldStandDown } from './circuit-breaker.js';
import { setCachedValidation, clearCacheForFile } from './validation-cache.js';

/**
 * @what Resolves session continuity for a validation attempt: stale-session clear, circuit-breaker stand-down, and identical-resubmission short-circuit
 * @how Loads the session, clears it if the on-disk file changed since the last denial, then (on a retry) stands down after MAX_CONSECUTIVE_DENIALS or returns the cached denial for an identical resubmission — returning an `earlyReturn` HookResponse when the caller should stop and return it immediately
 * @why Identical logic is needed by both the TypeScript and Python paths; the circuit-breaker check precedes the identical-resubmission check so a strict validator can never permanently trap an edit
 *
 * @param {object} args Resolution inputs
 * @param {string} args.sessionKey The session store key ({outerSessionId}:{filePath})
 * @param {string} args.currentFileOnDisk The pre-edit on-disk content (used for staleness hashing)
 * @param {string} args.fullFileContent The proposed post-edit content (used for identical-resubmission hashing)
 * @param {(message: string) => void} args.log Logger for [SESSION] lines
 * @param {string} args.logPrefix Log prefix ('' for TypeScript, '[PY]' for Python)
 * @returns {{ existingSession: ReturnType<typeof getSession>; isRetry: boolean; earlyReturn?: HookResponse }} The resolved session, whether this is a retry, and an optional response the caller must return immediately
 *
 * @sideeffects Reads and may clear the session store; writes [SESSION] log lines
 * @systemlayer Validation Logic
 * @domain session-management, circuit-breaker, retry-limiting
 * @tags session-resolution, staleness, circuit-breaker, identical-resubmission, shared-helper
 */
export function resolveSessionState(args: {
  sessionKey: string;
  currentFileOnDisk: string;
  fullFileContent: string;
  log: (message: string) => void;
  logPrefix: string;
}): { existingSession: ReturnType<typeof getSession>; isRetry: boolean; earlyReturn?: HookResponse } {
  const { sessionKey, currentFileOnDisk, fullFileContent, log, logPrefix } = args;

  let existingSession = getSession(sessionKey);

  if (existingSession && existingSession.lastDeniedContentHash) {
    const onDiskHash = crypto.createHash('sha256').update(currentFileOnDisk).digest('hex').slice(0, 16);
    if (onDiskHash !== existingSession.lastDeniedContentHash) {
      log(`${logPrefix}[SESSION] File content changed since last denial — clearing stale session for fresh validation`);
      clearSession(sessionKey);
      existingSession = null;
    }
  }

  const isRetry = existingSession !== null;
  log(`${logPrefix}[SESSION] ${isRetry ? `Retry attempt #${existingSession!.attemptCount + 1} (session: ${existingSession!.headlessSessionId})` : 'First attempt'}`);

  if (isRetry && shouldStandDown(existingSession!.attemptCount)) {
    const priorReason = existingSession!.lastDeniedReason || 'see the previous validation output';
    log(`${logPrefix}[SESSION] Circuit breaker: ${existingSession!.attemptCount} consecutive denials — standing down to avoid a permanent block`);
    clearSession(sessionKey);
    return {
      existingSession,
      isRetry,
      earlyReturn: {
        action: 'allow',
        message: `⚠️ Code Quality is standing down after ${existingSession!.attemptCount} blocked attempts to avoid trapping this edit. The edit is being ALLOWED, but the last review's concerns were NOT resolved — please address them in a follow-up: ${priorReason}`,
        suggestions: [
          `The guardian blocked this edit ${existingSession!.attemptCount}× without the issues being resolved and is now allowing it through so work is not permanently blocked. Unresolved concerns: ${priorReason}`
        ]
      }
    };
  }

  if (isRetry && existingSession!.lastDeniedProposedHash) {
    const proposedHash = crypto.createHash('sha256').update(fullFileContent).digest('hex').slice(0, 16);
    if (proposedHash === existingSession!.lastDeniedProposedHash) {
      log(`${logPrefix}[SESSION] Identical resubmission detected — returning cached denial (saved ~10s headless call)`);
      return {
        existingSession,
        isRetry,
        earlyReturn: {
          action: 'deny',
          message: `BLOCKED (identical resubmission): ${existingSession!.lastDeniedReason || 'Same code as previously denied — please fix the violations before retrying'}`,
          violations: ['Code is identical to the previously denied submission. Fix the issues described above before retrying.']
        }
      };
    }
  }

  return { existingSession, isRetry };
}

/**
 * @what Records the side effects of a completed headless validation: cache, suggestions, and denial info
 * @how On allow, clears the file's prior cached results; caches the new result; appends any non-blocking suggestions to the project suggestions file (non-fatal on I/O error); and on deny, stores the on-disk + proposed hashes for staleness and identical-resubmission detection
 * @why Both the TypeScript and Python paths must persist outcomes identically so the session-store invariants hold; the caller keeps only its language-specific response shaping
 *
 * @param {object} args Outcome inputs
 * @param {string} args.cacheKey The validation cache key for this edit
 * @param {string} args.filePath The edited file path
 * @param {string} args.sessionKey The session store key ({outerSessionId}:{filePath})
 * @param {string} args.sessionId The outer Claude session id (for the suggestions log header)
 * @param {ClaudeValidationResponse} args.validationResult The headless decision to persist
 * @param {string} args.currentFileOnDisk The pre-edit on-disk content (for the denial on-disk hash)
 * @param {string} args.fullFileContent The proposed post-edit content (for the denial proposed hash)
 * @param {string} args.suggestionsPath Absolute path to the project's suggestions log file
 * @param {(message: string) => void} args.log Logger for [SUGGESTIONS] lines
 * @param {string} args.logPrefix Log prefix ('' for TypeScript, '[PY]' for Python)
 * @returns {void}
 *
 * @sideeffects Writes the validation cache; may create a directory and append to the suggestions file; writes the session denial info on deny; writes log lines
 * @systemlayer Validation Logic
 * @domain outcome-recording, caching, suggestion-logging, session-management
 * @tags outcome-recording, cache-write, suggestions, denial-info, shared-helper
 */
export function recordValidationOutcome(args: {
  cacheKey: string;
  filePath: string;
  sessionKey: string;
  sessionId: string;
  validationResult: ClaudeValidationResponse;
  currentFileOnDisk: string;
  fullFileContent: string;
  suggestionsPath: string;
  log: (message: string) => void;
  logPrefix: string;
}): void {
  const {
    cacheKey, filePath, sessionKey, sessionId, validationResult,
    currentFileOnDisk, fullFileContent, suggestionsPath, log, logPrefix
  } = args;

  if (validationResult.decision === 'allow') {
    clearCacheForFile(filePath);
  }

  setCachedValidation(cacheKey, validationResult, filePath);

  if (validationResult.suggestions && validationResult.suggestions.length > 0) {
    try {
      mkdirSync(path.dirname(suggestionsPath), { recursive: true });
      const timestamp = new Date().toISOString();
      const header = `\n## Session: ${sessionId} — ${timestamp}\n\n`;
      const entries = validationResult.suggestions
        .map(s => `- **File:** \`${filePath}\`\n  **Suggestion:** ${s}\n`)
        .join('\n');
      appendFileSync(suggestionsPath, header + entries, 'utf-8');
      log(`${logPrefix}[SUGGESTIONS] Logged ${validationResult.suggestions.length} suggestions`);
    } catch {
      // Non-fatal — don't block the edit for suggestion logging failures
    }
  }

  if (validationResult.decision !== 'allow') {
    const onDiskHash = crypto.createHash('sha256').update(currentFileOnDisk).digest('hex').slice(0, 16);
    const proposedHash = crypto.createHash('sha256').update(fullFileContent).digest('hex').slice(0, 16);
    setDenialInfo(sessionKey, onDiskHash, validationResult.reasoning, proposedHash);
  }
}
