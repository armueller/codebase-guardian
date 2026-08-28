import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Point the state file at a throwaway dir (getGuardianHome reads this lazily).
process.env.GUARDIAN_HOME = mkdtempSync(path.join(tmpdir(), 'guardian-hint-'));

const { transition, recordSearchEvent } = await import('../src/hooks/helpers/search-hint-state.js');

describe('transition (pure)', () => {
  it('nudges on the first grep and arms the counter', () => {
    const { state, nudge } = transition(undefined, 'grep', 10);
    assert.equal(nudge, true);
    assert.equal(state.counter, 0);
    assert.equal(state.everNudged, true);
  });

  it('does not nudge on semantic search and resets the counter', () => {
    const prev = { counter: 7, everNudged: true, updatedAt: 0 };
    const { state, nudge } = transition(prev, 'semantic', 10);
    assert.equal(nudge, false);
    assert.equal(state.counter, 0);
  });

  it('stays quiet on greps below the re-arm threshold, then nudges at it', () => {
    let s = transition(undefined, 'grep', 3).state;    // nudge #1, counter 0
    let r = transition(s, 'grep', 3); s = r.state;      // counter 1
    assert.equal(r.nudge, false);
    r = transition(s, 'grep', 3); s = r.state;          // counter 2
    assert.equal(r.nudge, false);
    r = transition(s, 'grep', 3); s = r.state;          // counter+1 == 3 -> re-arm
    assert.equal(r.nudge, true);
    assert.equal(s.counter, 0);
  });
});

describe('recordSearchEvent (persisted)', () => {
  it('nudges once, re-arms after N greps, and resets on semantic search', () => {
    const sid = 'session-A';
    assert.equal(recordSearchEvent(sid, 'grep', 3), true, 'first grep nudges');
    assert.equal(recordSearchEvent(sid, 'grep', 3), false);
    assert.equal(recordSearchEvent(sid, 'semantic', 3), false, 'semantic resets, no nudge');
    // counter is back to 0, so it takes a full 3 more greps to re-arm
    assert.equal(recordSearchEvent(sid, 'grep', 3), false);
    assert.equal(recordSearchEvent(sid, 'grep', 3), false);
    assert.equal(recordSearchEvent(sid, 'grep', 3), true, 're-armed after 3 unheeded greps');
  });

  it('isolates state per session id', () => {
    assert.equal(recordSearchEvent('session-B', 'grep', 10), true, 'new session nudges on its first grep');
    assert.equal(recordSearchEvent('session-B', 'grep', 10), false);
  });

  it('never nudges without a session id', () => {
    assert.equal(recordSearchEvent('', 'grep', 1), false);
  });
});
