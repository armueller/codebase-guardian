import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildPythonCallGraph } from '../src/mcp-server/py-call-graph.js';
import { openDatabase, getFunctionByFileAndLine, getFunctionByName } from '../src/mcp-server/db.js';
import { buildIndex } from '../src/mcp-server/indexer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'pypkg');

// Runs against the real provisioned pyenv + guardian_py helper (no mocking) — proves the
// callgraph subprocess invocation, abs->relative path conversion, and def-line resolution
// are wired up correctly end to end, mirroring tests/py-index.test.ts.

describe('buildPythonCallGraph', () => {
  let db: ReturnType<typeof openDatabase>;
  const originalProjectRoot = process.env.GUARDIAN_PROJECT_ROOT;

  before(async () => {
    // Same trick as py-index.test.ts: force resolveConfig's project root detection to the
    // fixture dir itself so buildIndex's walkDirectory scans exactly FIXTURE_DIR.
    process.env.GUARDIAN_PROJECT_ROOT = FIXTURE_DIR;
    db = openDatabase(':memory:');
    await buildIndex(db, FIXTURE_DIR);
  });

  after(() => {
    if (originalProjectRoot === undefined) {
      delete process.env.GUARDIAN_PROJECT_ROOT;
    } else {
      process.env.GUARDIAN_PROJECT_ROOT = originalProjectRoot;
    }
    db.close();
  });

  it('invokes guardian_py callgraph against the fixture and creates at least one Python call edge', async () => {
    const stats = await buildPythonCallGraph(db, FIXTURE_DIR);
    assert.ok(stats.edgesCreated >= 1, `expected at least one edge, got ${stats.edgesCreated}`);
  });

  it('resolves the cross-file call into the CORRECT same-named method row via def-line disambiguation', async () => {
    // helpers.py's widget_summary() calls Widget(...).to_dict() (models.py). Both Widget and
    // PlainRecord define a `to_dict` method in models.py — the exact name collision the
    // P3.3 carry-forward constraint warns about. Only (file, definition-line) is unique.
    await buildPythonCallGraph(db, FIXTURE_DIR);

    const caller = getFunctionByFileAndLine(db, 'helpers.py', 23); // def widget_summary(): line
    assert.ok(caller, 'widget_summary row should be indexed at its def line (23)');

    const widgetToDict = getFunctionByFileAndLine(db, 'models.py', 20); // Widget.to_dict def line
    const plainRecordToDict = getFunctionByFileAndLine(db, 'models.py', 36); // PlainRecord.to_dict def line
    assert.ok(widgetToDict, 'Widget.to_dict row should be indexed at line 20');
    assert.ok(plainRecordToDict, 'PlainRecord.to_dict row should be indexed at line 36');
    assert.notEqual(widgetToDict!.id, plainRecordToDict!.id, 'the two same-named to_dict methods must be distinct rows');

    // Sanity check: a name-only (name, file) resolver — the pre-P3.4 fallback path — cannot
    // disambiguate these two rows at all; getFunctionByName only ever returns one arbitrary
    // match for ('to_dict', 'models.py'). This proves the collision is real in this fixture.
    const nameOnlyMatch = getFunctionByName(db, 'to_dict', 'models.py');
    assert.ok(nameOnlyMatch, 'name-only lookup should find *a* to_dict row (proving the collision exists)');

    const edgeToWidget = db
      .prepare('SELECT * FROM call_edges WHERE source_function_id = ? AND target_function_id = ?')
      .get(caller!.id, widgetToDict!.id);
    const edgeToPlainRecord = db
      .prepare('SELECT * FROM call_edges WHERE source_function_id = ? AND target_function_id = ?')
      .get(caller!.id, plainRecordToDict!.id);

    assert.ok(edgeToWidget, 'call edge should point at Widget.to_dict (the correct target)');
    assert.equal(edgeToPlainRecord, undefined, 'call edge must NOT point at PlainRecord.to_dict (the wrong target)');
  });

  it('fails open (returns {edgesCreated: 0}, does not throw) for a nonexistent root', async () => {
    let stats: { edgesCreated: number } | undefined;
    await assert.doesNotReject(async () => {
      stats = await buildPythonCallGraph(db, '/nonexistent/path/does-not-exist-guardian-test');
    });
    assert.deepEqual(stats, { edgesCreated: 0 });
  });

  it('fails open (returns {edgesCreated: 0}, does not throw) when the pyenv interpreter is missing', async () => {
    const originalGuardianHome = process.env.GUARDIAN_HOME;
    process.env.GUARDIAN_HOME = path.join(__dirname, 'fixtures', 'does-not-exist-guardian-home');
    try {
      let stats: { edgesCreated: number } | undefined;
      await assert.doesNotReject(async () => {
        stats = await buildPythonCallGraph(db, FIXTURE_DIR);
      });
      assert.deepEqual(stats, { edgesCreated: 0 });
    } finally {
      if (originalGuardianHome === undefined) {
        delete process.env.GUARDIAN_HOME;
      } else {
        process.env.GUARDIAN_HOME = originalGuardianHome;
      }
    }
  });
});
