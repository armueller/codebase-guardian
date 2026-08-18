import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractPythonFile } from '../src/mcp-server/py-index.js';
import { openDatabase } from '../src/mcp-server/db.js';
import { buildIndex } from '../src/mcp-server/indexer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'pypkg');

// ─── extractPythonFile ──────────────────────────────────────────────────────
// Runs against the real provisioned pyenv + guardian_py helper (no mocking) —
// proves the raw-JSON extraction path is wired up correctly end to end.

describe('extractPythonFile', () => {
  it('extracts raw units with domains/tags from a fixture module (proves the raw-JSON path, not the lossy py-adapter)', () => {
    const result = extractPythonFile(path.join(FIXTURE_DIR, 'models.py'));
    assert.ok(result, 'extraction should succeed against the real guardian_py helper');
    assert.ok(result!.module.domains.length > 0, `module should carry domains, got: ${JSON.stringify(result!.module)}`);
    assert.ok(result!.module.domains.includes('data-models'), `module domains: ${result!.module.domains}`);

    const widget = result!.units.find(u => u.name === 'Widget');
    assert.ok(widget, 'should find the Widget dataclass unit');
    assert.equal(widget!.kind, 'dataclass');
    assert.ok(widget!.domains.includes('widgets'), `Widget domains: ${widget!.domains}`);
    assert.ok(widget!.tags.includes('dataclass'), `Widget tags: ${widget!.tags}`);

    const plainRecord = result!.units.find(u => u.name === 'PlainRecord');
    assert.ok(plainRecord, 'should find the PlainRecord class unit');
    assert.equal(plainRecord!.domains.length, 0, 'PlainRecord has no Domain of its own');
  });

  it('returns null for a nonexistent file (fail-open)', () => {
    const result = extractPythonFile(path.join(FIXTURE_DIR, 'does-not-exist.py'));
    assert.equal(result, null);
  });

  it('returns null (not a throw) for a file with a Python syntax error', () => {
    const brokenPath = path.join(__dirname, 'fixtures', 'py-syntax-error', 'broken.py');
    let result: ReturnType<typeof extractPythonFile> | undefined;
    assert.doesNotThrow(() => {
      result = extractPythonFile(brokenPath);
    });
    assert.equal(result, null, 'guardian_py syntax-error payload should map to null (fail-open)');
  });
});

// ─── buildIndex — Python extraction branch ─────────────────────────────────

describe('buildIndex — Python extraction branch', () => {
  let db: ReturnType<typeof openDatabase>;
  const originalProjectRoot = process.env.GUARDIAN_PROJECT_ROOT;

  before(async () => {
    // Force resolveConfig's project root detection to the fixture dir itself
    // (rather than the real git root of codebase-guardian), so sourceDirectories
    // falls back to ['.'] and walkDirectory scans exactly FIXTURE_DIR.
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
  });

  it('indexes Python rows tagged language=py', () => {
    const rows = db.prepare("SELECT * FROM functions WHERE language = 'py'").all() as any[];
    assert.ok(rows.length > 0, 'should have indexed at least one Python row');
  });

  it('indexes the dataclass with declaration_type=dataclass and populated domains', () => {
    const row = db.prepare("SELECT * FROM functions WHERE name = 'Widget' AND language = 'py'").get() as any;
    assert.ok(row, 'Widget row should exist');
    assert.equal(row.declaration_type, 'dataclass');
    assert.equal(row.tier, 1, 'Widget has its own Domain -> tier 1');
    const domains = (db.prepare('SELECT domain FROM function_domains WHERE function_id = ?').all(row.id) as any[]).map(d => d.domain);
    assert.ok(domains.includes('widgets'), `domains: ${JSON.stringify(domains)}`);
  });

  it('a unit lacking its own Domain inherits the module domain (denormalization)', () => {
    const row = db.prepare("SELECT * FROM functions WHERE name = 'PlainRecord' AND language = 'py'").get() as any;
    assert.ok(row, 'PlainRecord row should exist');
    const domains = (db.prepare('SELECT domain FROM function_domains WHERE function_id = ?').all(row.id) as any[]).map(d => d.domain).sort();

    const moduleRow = db.prepare("SELECT * FROM functions WHERE declaration_type = 'module' AND file_path = 'models.py'").get() as any;
    assert.ok(moduleRow, 'module row for models.py should exist');
    const moduleDomains = (db.prepare('SELECT domain FROM function_domains WHERE function_id = ?').all(moduleRow.id) as any[]).map(d => d.domain).sort();

    assert.ok(moduleDomains.length > 0, 'module should have domains to inherit');
    assert.deepEqual(domains, moduleDomains, 'PlainRecord should inherit the module domains');
  });

  it('creates a module row per Python file with declaration_type=module', () => {
    const modelsModule = db.prepare("SELECT * FROM functions WHERE declaration_type = 'module' AND file_path = 'models.py'").get() as any;
    const helpersModule = db.prepare("SELECT * FROM functions WHERE declaration_type = 'module' AND file_path = 'helpers.py'").get() as any;
    assert.ok(modelsModule, 'module row for models.py should exist');
    assert.ok(helpersModule, 'module row for helpers.py should exist');
    assert.equal(modelsModule.language, 'py');
    assert.equal(helpersModule.language, 'py');
  });

  it('public exported function gets tier 1 (has its own Domain) and is_exported=1', () => {
    const row = db.prepare("SELECT * FROM functions WHERE name = 'public_helper'").get() as any;
    assert.ok(row, 'public_helper should be indexed');
    assert.equal(row.tier, 1);
    assert.equal(row.is_exported, 1);
    assert.equal(row.declaration_type, 'function');
  });

  it('private (underscore-prefixed) function is still indexed but marked not-exported', () => {
    const row = db.prepare("SELECT * FROM functions WHERE name = '_private_helper'").get() as any;
    assert.ok(row, '_private_helper should still be indexed — guardian_py extracts it, indexing does not filter it out');
    assert.equal(row.is_exported, 0);
    assert.equal(row.tier, 2, '_private_helper has no Domain of its own -> tier 2');
  });

  it('skips test_*.py files entirely (no rows produced)', () => {
    const rows = db.prepare("SELECT * FROM functions WHERE file_path = 'test_helpers.py'").all() as any[];
    assert.equal(rows.length, 0, 'test_helpers.py should not have been indexed at all');
  });

  it('skips Python files under a /tests/ path segment even when the filename does not match test_*.py', () => {
    const rows = db.prepare("SELECT * FROM functions WHERE name = 'extra_helper'").all() as any[];
    assert.equal(rows.length, 0, 'nested/tests/helpers_extra.py should be skipped via the /tests/ segment rule');
  });

  it('does not walk into __pycache__ or .venv directories', () => {
    const pycacheRows = db.prepare("SELECT * FROM functions WHERE name = 'ignored_pycache_function'").all() as any[];
    const venvRows = db.prepare("SELECT * FROM functions WHERE name = 'ignored_venv_function'").all() as any[];
    assert.equal(pycacheRows.length, 0, '__pycache__ fixture must never be indexed');
    assert.equal(venvRows.length, 0, '.venv fixture must never be indexed');
  });

  it('still indexes the co-located .ts fixture as language=ts (TS indexing path untouched)', () => {
    const row = db.prepare("SELECT * FROM functions WHERE name = 'sampleTsFunction'").get() as any;
    assert.ok(row, 'TS fixture function should still be indexed');
    assert.equal(row.language, 'ts');
    assert.equal(row.tier, 1);
  });
});
