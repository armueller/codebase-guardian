import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { categorizeViolations, deriveOutcome, recordDecision } from '../src/hooks/helpers/metrics.js';
import { buildMetricsReport } from '../src/mcp-server/metrics-query.js';

// Point the store at a throwaway dir. getGuardianHome() reads this lazily (on the first
// recordDecision call), so setting it here — before any test runs — is sufficient.
const dir = mkdtempSync(path.join(tmpdir(), 'guardian-metrics-'));
process.env.GUARDIAN_HOME = dir;

describe('categorizeViolations', () => {
  it('tags DRY duplication', () => {
    assert.ok(categorizeViolations(['duplicates existing computeFoo in utils.ts'], '').includes('dry'));
  });
  it('tags missing JSDoc', () => {
    assert.ok(categorizeViolations(['has no JSDoc at all (confirmed MISSING)'], '').includes('jsdoc-missing'));
  });
  it("tags harmony's terminology rule", () => {
    assert.ok(categorizeViolations(["names a slide instance as 'spread'"], '').includes('terminology'));
  });
  it('returns [] when nothing matches', () => {
    assert.deepEqual(categorizeViolations([], 'looks good, no issues'), []);
  });
});

describe('deriveOutcome', () => {
  it('classifies skip / no-index / circuit-breaker / quality-pass / blocked / cached', () => {
    assert.equal(deriveOutcome('allow', 'Skipping validation for x.md'), 'skip');
    assert.equal(deriveOutcome('allow', 'Code index unavailable (fail-open)'), 'fail_open_no_index');
    assert.equal(deriveOutcome('allow', '⚠️ Code Quality is standing down after 3 blocked attempts'), 'circuit_breaker');
    assert.equal(deriveOutcome('allow', 'Code Quality Passed: all good'), 'quality_pass');
    assert.equal(deriveOutcome('deny', 'BLOCKED: duplicate'), 'deny_blocked');
    assert.equal(deriveOutcome('deny', 'BLOCKED (cached): duplicate'), 'deny_cached');
  });
});

describe('recordDecision', () => {
  it('inserts a queryable row with derived outcome + categories', () => {
    recordDecision({
      decision: 'deny',
      message: 'BLOCKED: dup',
      violations: ['duplicates existing foo'],
      filePath: '/x/y.ts',
      projectName: 'proj',
      headlessRan: true,
      headlessMs: 1234,
    });
    const db = new Database(path.join(dir, 'metrics.db'), { readonly: true });
    const row = db.prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    db.close();
    assert.equal(row.decision, 'deny');
    assert.equal(row.outcome, 'deny_blocked');
    assert.ok(String(row.violation_categories || '').includes('dry'));
    assert.equal(row.headless_ran, 1);
    assert.equal(row.headless_ms, 1234);
    assert.equal(row.file_ext, '.ts');
    assert.equal(row.project_name, 'proj');
  });
});

describe('buildMetricsReport', () => {
  it('renders rate, outcome, and per-project sections over recorded decisions', () => {
    recordDecision({ decision: 'allow', message: 'Code Quality Passed', projectName: 'reportproj', headlessRan: true, headlessMs: 900 });
    recordDecision({ decision: 'deny', message: 'BLOCKED: dup', violations: ['duplicates existing foo'], projectName: 'reportproj', headlessRan: true, headlessMs: 1100 });

    const report = buildMetricsReport({ sinceDays: null, projectFilter: null });
    assert.match(report, /Decision Metrics/);
    assert.match(report, /Overall:/);
    assert.match(report, /Genuine judgments:/);
    assert.match(report, /By project:/);
    assert.ok(report.includes('reportproj'), 'names the project it recorded');
    assert.match(report, /Headless validation time/);
  });

  it('returns a clear message when the filter matches nothing', () => {
    const report = buildMetricsReport({ sinceDays: null, projectFilter: 'no-such-project-xyz' });
    assert.equal(report, 'No decisions match that filter.');
  });
});
