import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFTSQuery, openDatabase, insertFunction } from '../src/mcp-server/db.js';

describe('sanitizeFTSQuery', () => {
  it('converts multi-word query to OR-joined quoted tokens', () => {
    const result = sanitizeFTSQuery('group options by ticker');
    assert.equal(result, '"group" OR "options" OR "ticker"');
  });

  it('filters tokens shorter than 3 characters', () => {
    const result = sanitizeFTSQuery('group by id');
    // "by" and "id" are < 3 chars, only "group" remains
    assert.equal(result, '"group"');
  });

  it('wraps single valid token in quotes', () => {
    assert.equal(sanitizeFTSQuery('calculate'), '"calculate"');
  });

  it('returns safe empty query when all tokens are too short', () => {
    const result = sanitizeFTSQuery('UI');
    assert.equal(result, '""');
  });

  it('returns safe empty query for "do it"', () => {
    const result = sanitizeFTSQuery('do it');
    assert.equal(result, '""');
  });

  it('passes through queries with OR operator', () => {
    const result = sanitizeFTSQuery('"profit" OR "loss"');
    assert.equal(result, '"profit" OR "loss"');
  });

  it('passes through queries with AND operator', () => {
    const result = sanitizeFTSQuery('profit AND loss');
    assert.equal(result, 'profit AND loss');
  });

  it('passes through queries with NOT operator', () => {
    const result = sanitizeFTSQuery('profit NOT loss');
    assert.equal(result, 'profit NOT loss');
  });

  it('passes through queries with existing double quotes', () => {
    const result = sanitizeFTSQuery('"exact phrase"');
    assert.equal(result, '"exact phrase"');
  });

  it('preserves hyphens in tokens', () => {
    const result = sanitizeFTSQuery('options-trading');
    assert.equal(result, '"options-trading"');
  });

  it('strips FTS5 special characters from tokens', () => {
    const result = sanitizeFTSQuery('calc* (profit)');
    // * and () are stripped, leaving "calc" and "profit"
    assert.equal(result, '"calc" OR "profit"');
  });

  it('handles empty string', () => {
    const result = sanitizeFTSQuery('');
    assert.equal(result, '""');
  });

  it('handles whitespace-only string', () => {
    const result = sanitizeFTSQuery('   ');
    assert.equal(result, '""');
  });

  it('preserves underscores in tokens', () => {
    const result = sanitizeFTSQuery('my_function_name');
    assert.equal(result, '"my_function_name"');
  });
});

describe('functions.language column', () => {
  it('has a language column on fresh databases (PRAGMA table_info)', () => {
    const db = openDatabase(':memory:');
    const columns = db.prepare('PRAGMA table_info(functions)').all() as { name: string }[];
    assert.ok(columns.some(c => c.name === 'language'), 'expected functions table to have a language column');
    db.close();
  });

  it('stores an explicit language value and defaults missing language to ts', () => {
    const db = openDatabase(':memory:');

    const pyId = insertFunction(db, {
      name: 'calculate_profit',
      description: 'Calculates net profit',
      file_path: 'src/finance.py',
      line_number: 10,
      is_exported: true,
      declaration_type: 'function',
      side_effects: null,
      system_layer: 'Business Logic',
      tier: 1,
      language: 'py',
    });

    const tsId = insertFunction(db, {
      name: 'calculateProfit',
      description: 'Calculates net profit',
      file_path: 'src/finance.ts',
      line_number: 10,
      is_exported: true,
      declaration_type: 'function',
      side_effects: null,
      system_layer: 'Business Logic',
      tier: 1,
      // language omitted — should default to 'ts'
    });

    const pyRow = db.prepare('SELECT language FROM functions WHERE id = ?').get(pyId) as { language: string };
    const tsRow = db.prepare('SELECT language FROM functions WHERE id = ?').get(tsId) as { language: string };

    assert.equal(pyRow.language, 'py');
    assert.equal(tsRow.language, 'ts');

    db.close();
  });
});
