import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createIndexAPI } from '../src/shared/index-api.js';
import { openDatabase, insertFunction, insertDomains, insertTags, insertSystemLayers, insertCallEdge, insertComments, insertDocSections } from '../src/mcp-server/db.js';
import { generateEmbeddings } from '../src/mcp-server/embeddings.js';

describe('IndexAPI — synchronous methods', () => {
  let api: ReturnType<typeof createIndexAPI>;
  let db: ReturnType<typeof openDatabase>;

  before(() => {
    db = openDatabase(':memory:');

    // Seed test data
    const id1 = insertFunction(db, {
      name: 'calculateProfit',
      description: 'Calculates net profit after fees',
      file_path: 'src/utils/finance.ts',
      line_number: 10,
      is_exported: 1,
      declaration_type: 'function',
      side_effects: 'None',
      system_layer: 'Business Logic',
      tier: 1,
    });
    insertDomains(db, id1, ['finance', 'calculations']);
    insertTags(db, id1, ['profit', 'fees', 'calculation']);
    insertSystemLayers(db, id1, ['Business Logic']);

    const id2 = insertFunction(db, {
      name: 'formatCurrency',
      description: 'Formats a number as USD currency string',
      file_path: 'src/utils/finance.ts',
      line_number: 30,
      is_exported: 1,
      declaration_type: 'function',
      side_effects: 'None',
      system_layer: 'UI Helper',
      tier: 1,
    });
    insertDomains(db, id2, ['finance', 'formatting']);
    insertTags(db, id2, ['currency', 'formatting', 'usd']);
    insertSystemLayers(db, id2, ['UI Helper']);

    const id3 = insertFunction(db, {
      name: 'fetchPrices',
      description: 'Fetches current market prices from API',
      file_path: 'src/api/market.ts',
      line_number: 5,
      is_exported: 1,
      declaration_type: 'function',
      side_effects: 'API call to market data provider',
      system_layer: 'API',
      tier: 1,
    });
    insertDomains(db, id3, ['finance', 'market-data']);
    insertTags(db, id3, ['api', 'prices', 'market']);
    insertSystemLayers(db, id3, ['API']);

    // Call edge: calculateProfit calls fetchPrices
    insertCallEdge(db, id1, id3, 'call');

    // Comments
    insertComments(db, id1, [
      { comment_text: 'Subtract broker commission from gross profit', comment_type: 'line', line_offset: 3 },
    ]);

    // Doc section
    const docId = insertFunction(db, {
      name: 'Financial Patterns README',
      description: 'Documents financial calculation patterns and fee structures',
      file_path: 'docs/financial-patterns.md',
      line_number: 1,
      is_exported: 0,
      declaration_type: 'doc',
      side_effects: null,
      system_layer: null,
      tier: 3,
    });
    insertDocSections(db, docId, [
      { heading: 'Fee Calculation', heading_level: 2, body: 'All fee calculations must use the standard fee schedule.', section_type: 'prose', section_order: 1 },
    ]);

    api = createIndexAPI(db);
  });

  it('lookup finds a function by name', () => {
    const result = api.lookup('calculateProfit');
    assert.ok(result, 'Should find calculateProfit');
    assert.equal(result!.name, 'calculateProfit');
    assert.equal(result!.file_path, 'src/utils/finance.ts');
    assert.deepEqual(result!.domains, ['calculations', 'finance']);
  });

  it('lookup returns null for unknown function', () => {
    const result = api.lookup('nonexistent');
    assert.equal(result, null);
  });

  it('lookup filters by file path', () => {
    const result = api.lookup('calculateProfit', 'src/utils/finance.ts');
    assert.ok(result);
    const noResult = api.lookup('calculateProfit', 'src/other/file.ts');
    assert.equal(noResult, null);
  });

  it('lookupByFile returns all functions in a file', () => {
    const results = api.lookupByFile('src/utils/finance.ts');
    assert.equal(results.length, 2);
    const names = results.map(r => r.name);
    assert.ok(names.includes('calculateProfit'));
    assert.ok(names.includes('formatCurrency'));
  });

  it('functionsByDirectory returns functions in a directory', () => {
    const results = api.functionsByDirectory('src/utils');
    assert.equal(results.length, 2);
  });

  it('callers returns functions that call the target', () => {
    const results = api.callers('fetchPrices');
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'calculateProfit');
  });

  it('callees returns functions called by the target', () => {
    const results = api.callees('calculateProfit');
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'fetchPrices');
  });

  it('search finds functions via FTS', () => {
    const results = api.search('profit calculation');
    assert.ok(results.length > 0, 'Should find at least one result');
    const names = results.map(r => r.name);
    assert.ok(names.includes('calculateProfit'));
  });

  it('search filters by domain', () => {
    const results = api.search('profit', { domain: 'formatting' });
    const names = results.map(r => r.name);
    assert.ok(!names.includes('calculateProfit'), 'calculateProfit is not in formatting domain');
  });

  it('searchComments finds matching inline comments', () => {
    const results = api.searchComments('broker commission');
    assert.ok(results.length > 0);
    assert.ok(results[0].comment.comment_text.includes('broker commission'));
  });

  it('searchDocs finds matching documentation sections', () => {
    const results = api.searchDocs('fee calculation');
    assert.ok(results.length > 0);
    assert.equal(results[0].section.heading, 'Fee Calculation');
  });

  it('listDomains returns all domains with counts', () => {
    const results = api.listDomains();
    assert.ok(results.length > 0);
    const finance = results.find(d => d.domain === 'finance');
    assert.ok(finance, 'Should have finance domain');
    assert.equal(finance!.count, 3);
  });

  it('listTags returns tags, optionally filtered by domain', () => {
    const all = api.listTags();
    assert.ok(all.length > 0);
    const filtered = api.listTags('formatting');
    assert.ok(filtered.length > 0);
    const tagNames = filtered.map(t => t.tag);
    assert.ok(tagNames.includes('currency') || tagNames.includes('formatting'));
  });

  it('impact returns transitive callers with depth', () => {
    const results = api.impact('fetchPrices');
    assert.ok(results.length > 0);
    assert.equal(results[0].function.name, 'calculateProfit');
    assert.equal(results[0].depth, 1);
  });

  it('indexStatus returns metadata', () => {
    const status = api.indexStatus();
    assert.ok(status.functions_indexed >= 3);
    assert.ok(status.domains_count >= 1);
  });
});

describe('IndexAPI — semantic search', () => {
  let api: ReturnType<typeof createIndexAPI>;
  let db: ReturnType<typeof openDatabase>;

  before(async () => {
    db = openDatabase(':memory:');

    const id1 = insertFunction(db, {
      name: 'calculateProfit',
      description: 'Calculates net profit after fees and commissions',
      file_path: 'src/utils/finance.ts',
      line_number: 10,
      is_exported: 1,
      declaration_type: 'function',
      side_effects: 'None',
      system_layer: 'Business Logic',
      tier: 1,
    });
    insertDomains(db, id1, ['finance']);
    insertTags(db, id1, ['profit', 'fees']);

    const id2 = insertFunction(db, {
      name: 'renderButton',
      description: 'Renders a styled button component',
      file_path: 'src/components/Button.tsx',
      line_number: 5,
      is_exported: 1,
      declaration_type: 'function',
      side_effects: 'None',
      system_layer: 'UI Helper',
      tier: 1,
    });
    insertDomains(db, id2, ['ui']);
    insertTags(db, id2, ['button', 'component']);

    // Generate embeddings for both functions
    await generateEmbeddings(db, {
      functionId: id1,
      name: 'calculateProfit',
      description: 'Calculates net profit after fees and commissions',
      domains: ['finance'],
      systemlayers: ['Business Logic'],
      tags: ['profit', 'fees'],
      body: 'return grossProfit - fees - commissions;',
    });

    await generateEmbeddings(db, {
      functionId: id2,
      name: 'renderButton',
      description: 'Renders a styled button component',
      domains: ['ui'],
      systemlayers: ['UI Helper'],
      tags: ['button', 'component'],
      body: 'return <button className={styles.btn}>{children}</button>;',
    });

    api = createIndexAPI(db);
  });

  it('semanticSearch returns functions ranked by similarity', async () => {
    const results = await api.semanticSearch('compute financial gains and losses');
    assert.ok(results.length > 0, 'Should find at least one result');
    // calculateProfit should rank higher than renderButton for a finance query
    assert.equal(results[0].name, 'calculateProfit');
  });

  it('semanticSearch respects limit', async () => {
    const results = await api.semanticSearch('function', 1);
    assert.equal(results.length, 1);
  });
});
