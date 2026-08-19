import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../src/config.js';

// PV-3: validation-flow.ts (resolveSessionState / recordValidationOutcome) is the
// shared home of the load-bearing session invariants documented in CLAUDE.md
// ("Validation Cache vs Session Store"): on-disk-content-hash staleness detection
// vs proposed-content-hash identical-resubmission detection, and the
// circuit-breaker-before-identical-resubmission ordering. There was no test for
// this module at all — only circuit-breaker.test.ts covered shouldStandDown in
// isolation. These tests cover the shared flow end to end via its public API.
//
// Isolation note: validation-sessions.ts (SESSIONS_FILE) and validation-cache.ts
// (CACHE_FILE) each resolve their on-disk path as a MODULE-LEVEL constant from
// resolveConfig().databasePath, evaluated once at import time (see CLAUDE.md).
// Node's test runner isolates each *.test.ts file into its own child process (one
// file = one process), so it's safe to set GUARDIAN_HOME/GUARDIAN_PROJECT_ROOT here
// and then dynamically import validation-flow.js — its transitive imports
// (validation-sessions.js, validation-cache.js) haven't evaluated yet, so their
// module-level path constants resolve against these tmp dirs instead of whatever
// project happens to be checked out. resolveConfig() itself is side-effect-free at
// import time (paths are only computed inside function bodies), so it's safe to
// import statically above and call after the env vars are set.
const GUARDIAN_HOME = mkdtempSync(path.join(tmpdir(), 'guardian-vf-home-'));
const PROJECT_ROOT = mkdtempSync(path.join(tmpdir(), 'guardian-vf-project-'));
process.env.GUARDIAN_HOME = GUARDIAN_HOME;
process.env.GUARDIAN_PROJECT_ROOT = PROJECT_ROOT;

// The session/cache stores live alongside the database at
// {GUARDIAN_HOME}/indexes/{projectHash}/ — that directory doesn't exist yet from
// mkdtempSync alone, and writeStore()/setCachedValidation() fail OPEN (silently
// swallow ENOENT) rather than throw, per the hook's fail-open design. Create it now
// so setSession/recordValidationOutcome actually persist instead of silently no-op'ing.
mkdirSync(path.dirname(resolveConfig().databasePath), { recursive: true });

const { resolveSessionState, recordValidationOutcome } = await import('../src/hooks/helpers/validation-flow.js');
const { getSession, setSession } = await import('../src/hooks/helpers/validation-sessions.js');
const { MAX_CONSECUTIVE_DENIALS } = await import('../src/hooks/helpers/circuit-breaker.js');

const SUGGESTIONS_PATH = path.join(PROJECT_ROOT, '.guardian', 'suggestions.md');
const noopLog = (_message: string): void => {};

function denyResult(reasoning: string): { decision: 'deny'; violations: string[]; suggestions: string[]; reasoning: string } {
  return { decision: 'deny', violations: ['bad thing'], suggestions: [], reasoning };
}

function allowResult(reasoning: string): { decision: 'allow'; violations: string[]; suggestions: string[]; reasoning: string } {
  return { decision: 'allow', violations: [], suggestions: [], reasoning };
}

// ─── resolveSessionState ─────────────────────────────────────────────────────

describe('resolveSessionState', () => {
  it('resolves a first attempt (no prior session) as non-stale, non-resubmission, with no earlyReturn', () => {
    const sessionKey = 'outer-session-1:file-a.ts';
    const result = resolveSessionState({
      sessionKey,
      currentFileOnDisk: 'const a = 1;',
      fullFileContent: 'const a = 2;',
      log: noopLog,
      logPrefix: '',
    });

    assert.equal(result.existingSession, null);
    assert.equal(result.isRetry, false);
    assert.equal(result.earlyReturn, undefined);
  });

  it('detects an identical resubmission after a denial is recorded', () => {
    const sessionKey = 'outer-session-2:file-b.ts';
    const onDisk = 'const b = 1;';
    const proposed = 'const b = 2; // still bad';

    // Simulate executeFirstAttempt's session creation on first attempt, then the
    // hook orchestrator recording the deny outcome — mirrors the real call order.
    setSession(sessionKey, 'headless-session-b', 1);
    recordValidationOutcome({
      cacheKey: 'cache-key-b',
      filePath: 'file-b.ts',
      sessionKey,
      sessionId: 'outer-session-2',
      validationResult: denyResult('missing JSDoc'),
      currentFileOnDisk: onDisk,
      fullFileContent: proposed,
      suggestionsPath: SUGGESTIONS_PATH,
      log: noopLog,
      logPrefix: '',
    });

    // Retry with the EXACT same proposed content, and the SAME on-disk content
    // (denied edits never land on disk, per the invariant in CLAUDE.md).
    const result = resolveSessionState({
      sessionKey,
      currentFileOnDisk: onDisk,
      fullFileContent: proposed,
      log: noopLog,
      logPrefix: '',
    });

    assert.equal(result.isRetry, true);
    assert.ok(result.earlyReturn, 'expected an earlyReturn for identical resubmission');
    assert.equal(result.earlyReturn?.action, 'deny');
    assert.match(result.earlyReturn?.message ?? '', /identical resubmission/i);
  });

  it('marks the session stale (clears it) when the on-disk file changed since the last denial', () => {
    const sessionKey = 'outer-session-3:file-c.ts';
    const onDiskAtDenial = 'const c = 1;';
    const proposed = 'const c = 2; // still bad';

    setSession(sessionKey, 'headless-session-c', 1);
    recordValidationOutcome({
      cacheKey: 'cache-key-c',
      filePath: 'file-c.ts',
      sessionKey,
      sessionId: 'outer-session-3',
      validationResult: denyResult('missing JSDoc'),
      currentFileOnDisk: onDiskAtDenial,
      fullFileContent: proposed,
      suggestionsPath: SUGGESTIONS_PATH,
      log: noopLog,
      logPrefix: '',
    });

    // A different, allowed edit landed on disk between retries.
    const changedOnDisk = 'const c = 1; // an unrelated allowed edit landed here';
    const result = resolveSessionState({
      sessionKey,
      currentFileOnDisk: changedOnDisk,
      fullFileContent: proposed, // same proposed edit as the denied one
      log: noopLog,
      logPrefix: '',
    });

    // Staleness clears the session — this resolves exactly like a first attempt.
    assert.equal(result.isRetry, false);
    assert.equal(result.existingSession, null);
    assert.equal(result.earlyReturn, undefined);
    assert.equal(getSession(sessionKey), null);
  });

  it('stands down after MAX_CONSECUTIVE_DENIALS, and this check fires even on an identical resubmission (proves circuit-breaker-before-identical-resubmission ordering)', () => {
    const sessionKey = 'outer-session-4:file-d.ts';
    const onDisk = 'const d = 1;';
    const proposed = 'const d = 2; // still bad';

    // Simulate MAX_CONSECUTIVE_DENIALS consecutive denials already recorded for
    // this session (attemptCount reaches the threshold at which shouldStandDown
    // trips — see circuit-breaker.test.ts for the exact boundary).
    setSession(sessionKey, 'headless-session-d', MAX_CONSECUTIVE_DENIALS);
    recordValidationOutcome({
      cacheKey: 'cache-key-d',
      filePath: 'file-d.ts',
      sessionKey,
      sessionId: 'outer-session-4',
      validationResult: denyResult('still missing JSDoc'),
      currentFileOnDisk: onDisk,
      fullFileContent: proposed,
      suggestionsPath: SUGGESTIONS_PATH,
      log: noopLog,
      logPrefix: '',
    });

    // Retry with the IDENTICAL proposed content, which ALSO satisfies the
    // identical-resubmission condition. If the circuit breaker were evaluated
    // after the identical-resubmission short-circuit, this would return a 'deny'
    // earlyReturn (cached denial) instead of standing down and allowing.
    const result = resolveSessionState({
      sessionKey,
      currentFileOnDisk: onDisk,
      fullFileContent: proposed,
      log: noopLog,
      logPrefix: '',
    });

    assert.ok(result.earlyReturn, 'expected an earlyReturn for the circuit breaker stand-down');
    assert.equal(result.earlyReturn?.action, 'allow');
    assert.match(result.earlyReturn?.message ?? '', /standing down/i);
    // Standing down clears the session so the agent gets a genuinely fresh start.
    assert.equal(getSession(sessionKey), null);
  });
});

// ─── recordValidationOutcome ─────────────────────────────────────────────────

describe('recordValidationOutcome', () => {
  it('stores the on-disk hash, proposed hash, and reason on deny, reachable by a later resolveSessionState call', () => {
    const sessionKey = 'outer-session-5:file-e.ts';
    setSession(sessionKey, 'headless-session-e', 1);
    recordValidationOutcome({
      cacheKey: 'cache-key-e',
      filePath: 'file-e.ts',
      sessionKey,
      sessionId: 'outer-session-5',
      validationResult: denyResult('DRY violation: use existingFn'),
      currentFileOnDisk: 'const e = 1;',
      fullFileContent: 'const e = 2;',
      suggestionsPath: SUGGESTIONS_PATH,
      log: noopLog,
      logPrefix: '',
    });

    const session = getSession(sessionKey);
    assert.ok(session);
    assert.equal(session?.lastDeniedReason, 'DRY violation: use existingFn');
    assert.ok(session?.lastDeniedContentHash);
    assert.ok(session?.lastDeniedProposedHash);
  });

  it('does not record denial info on allow (no lastDeniedReason set)', () => {
    const sessionKey = 'outer-session-6:file-f.ts';
    setSession(sessionKey, 'headless-session-f', 1);
    recordValidationOutcome({
      cacheKey: 'cache-key-f',
      filePath: 'file-f.ts',
      sessionKey,
      sessionId: 'outer-session-6',
      validationResult: allowResult('looks good'),
      currentFileOnDisk: 'const f = 1;',
      fullFileContent: 'const f = 2;',
      suggestionsPath: SUGGESTIONS_PATH,
      log: noopLog,
      logPrefix: '',
    });

    const session = getSession(sessionKey);
    assert.ok(session);
    assert.equal(session?.lastDeniedReason, undefined);
  });
});
