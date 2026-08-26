/**
 * @fileoverview Per-session throttle state for the search-hint hook. Nudge once on the first
 * grep-family search of a session, then stay quiet until the agent has run the re-arm threshold
 * of grep searches WITHOUT using semantic search in between — at which point nudge again. Using the
 * semantic `search` tool resets the counter (the agent is already doing the right thing). State is
 * a small global JSON keyed by session id (`${guardianHome}/.search-hint-state.json`), so it needs
 * no per-project resolution and survives context compaction (the session id is stable across it).
 * Strictly best-effort: any read/write error is swallowed and simply yields no nudge.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { getGuardianHome } from '../../config.js';

// Sessions expire from the store after an hour of inactivity (keeps the file small).
const STATE_TTL_MS = 60 * 60 * 1000;

/**
 * @what The throttle state for one session
 * @domain search-hint, throttle
 * @tags hint-state, throttle, schema
 */
export interface SessionHintState {
  /** grep-family searches counted since the last nudge or semantic-search reset. */
  counter: number;
  /** whether this session has ever been nudged (gates the first, always-fire nudge). */
  everNudged: boolean;
  /** epoch ms of the last update, for TTL pruning. */
  updatedAt: number;
}

type Store = Record<string, SessionHintState>;
type HintEvent = 'grep' | 'semantic';

/**
 * @what Computes the next throttle state and whether to nudge, for one event (pure)
 * @how A semantic event resets the counter and never nudges; a grep event nudges on the first-ever grep or once the counter reaches rearmAfter, resetting the counter, otherwise just increments
 * @why Keeping the transition pure (no clock, no I/O) makes the "nudge once, then re-arm after N unheeded greps, reset on semantic search" rule directly unit-testable
 *
 * @param {SessionHintState | undefined} prev The prior state for the session, if any
 * @param {HintEvent} event 'grep' for a grep-family search, 'semantic' for a semantic search
 * @param {number} rearmAfter Greps-without-semantic-search before re-arming the nudge
 * @returns {{ state: SessionHintState, nudge: boolean }} The next state (updatedAt carried from prev; caller stamps it) and whether to nudge now
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain search-hint, throttle
 * @tags transition, re-arm, throttle, pure
 */
export function transition(
  prev: SessionHintState | undefined,
  event: HintEvent,
  rearmAfter: number
): { state: SessionHintState; nudge: boolean } {
  const counter = prev?.counter ?? 0;
  const everNudged = prev?.everNudged ?? false;
  const updatedAt = prev?.updatedAt ?? 0;

  if (event === 'semantic') {
    return { state: { counter: 0, everNudged, updatedAt }, nudge: false };
  }
  if (!everNudged || counter + 1 >= rearmAfter) {
    return { state: { counter: 0, everNudged: true, updatedAt }, nudge: true };
  }
  return { state: { counter: counter + 1, everNudged: true, updatedAt }, nudge: false };
}

/**
 * @what Resolves the global search-hint state file path
 * @how Joins the guardian home dir with `.search-hint-state.json`
 * @why One global (not per-project) store keeps the frequent counter path free of git-root resolution
 *
 * @returns {string} Absolute path to the state file
 *
 * @sideeffects None
 * @systemlayer Data Layer
 * @domain search-hint, persistence
 * @tags state-path, guardian-home
 */
function statePath(): string {
  return path.join(getGuardianHome(), '.search-hint-state.json');
}

/**
 * @what Reads the throttle store from disk, dropping entries older than the TTL
 * @how Parses the JSON file (empty object if missing/corrupt) and filters out sessions not updated within STATE_TTL_MS
 * @why Centralizes read + pruning so the store cannot grow without bound across many sessions
 *
 * @param {number} now Current epoch ms (for TTL comparison)
 * @returns {Store} The pruned store
 *
 * @sideeffects Reads the state file
 * @systemlayer Data Layer
 * @domain search-hint, persistence
 * @tags read-store, ttl-prune, json-parse
 */
function readStore(now: number): Store {
  try {
    const p = statePath();
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Store;
    const pruned: Store = {};
    for (const [id, s] of Object.entries(raw)) {
      if (s && typeof s.updatedAt === 'number' && now - s.updatedAt < STATE_TTL_MS) pruned[id] = s;
    }
    return pruned;
  } catch {
    return {};
  }
}

/**
 * @what Records a search event for a session and reports whether to nudge now
 * @how Reads (and prunes) the store, applies the pure transition, stamps updatedAt, writes the store back, and returns the nudge decision — swallowing any error to a no-nudge
 * @why This is the hook's single entry point for throttle decisions; it must be fail-safe so a state error never breaks the tool call
 *
 * @param {string} sessionId The Claude session id (no id → never nudge, since there is nothing to throttle on)
 * @param {HintEvent} event 'grep' or 'semantic'
 * @param {number} rearmAfter Greps-without-semantic before re-arming
 * @param {number} [now] Current epoch ms (injectable for tests; defaults to Date.now())
 * @returns {boolean} True if the caller should emit a nudge
 *
 * @sideeffects Reads and writes the state file
 * @systemlayer Data Layer
 * @domain search-hint, throttle, persistence
 * @tags apply-event, re-arm, fail-safe, persistence
 */
export function recordSearchEvent(sessionId: string, event: HintEvent, rearmAfter: number, now: number = Date.now()): boolean {
  if (!sessionId) return false;
  try {
    const store = readStore(now);
    const { state, nudge } = transition(store[sessionId], event, rearmAfter);
    state.updatedAt = now;
    store[sessionId] = state;
    writeFileSync(statePath(), JSON.stringify(store));
    return nudge;
  } catch {
    return false;
  }
}
