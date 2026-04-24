import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { executeInSandbox } from '../src/mcp-server/execute-sandbox.js';
import { createIndexAPI } from '../src/shared/index-api.js';
import { openDatabase, insertFunction, insertDomains, insertTags, insertCallEdge } from '../src/mcp-server/db.js';

describe('executeInSandbox', () => {
  let api: ReturnType<typeof createIndexAPI>;
  let db: ReturnType<typeof openDatabase>;

  before(() => {
    db = openDatabase(':memory:');

    const id1 = insertFunction(db, {
      name: 'calculateProfit',
      description: 'Calculates net profit',
      file_path: 'src/utils/finance.ts',
      line_number: 10,
      is_exported: 1,
      declaration_type: 'function',
      side_effects: 'None',
      system_layer: 'Business Logic',
      tier: 1,
    });
    insertDomains(db, id1, ['finance']);
    insertTags(db, id1, ['profit']);

    const id2 = insertFunction(db, {
      name: 'fetchPrices',
      description: 'Fetches market prices',
      file_path: 'src/api/market.ts',
      line_number: 5,
      is_exported: 1,
      declaration_type: 'function',
      side_effects: 'API call',
      system_layer: 'API',
      tier: 1,
    });
    insertDomains(db, id2, ['finance']);
    insertTags(db, id2, ['api', 'prices']);

    insertCallEdge(db, id1, id2, 'call');

    api = createIndexAPI(db);
  });

  it('executes simple return statement', async () => {
    const result = await executeInSandbox(api, 'return 42;');
    assert.equal(result, 42);
  });

  it('accesses api.lookup', async () => {
    const result = await executeInSandbox(api, `
      const fn = api.lookup("calculateProfit");
      return fn ? fn.name : null;
    `);
    assert.equal(result, 'calculateProfit');
  });

  it('composes multi-step queries', async () => {
    const result = await executeInSandbox(api, `
      const fn = api.lookup("calculateProfit");
      const callees = api.callees("calculateProfit");
      return {
        name: fn.name,
        calls: callees.map(c => c.name),
      };
    `) as { name: string; calls: string[] };
    assert.equal(result.name, 'calculateProfit');
    assert.deepEqual(result.calls, ['fetchPrices']);
  });

  it('supports await for async methods', async () => {
    const result = await executeInSandbox(api, `
      const results = await api.semanticSearch("profit");
      return typeof results.length;
    `);
    assert.equal(result, 'number');
  });

  it('cannot access process', async () => {
    await assert.rejects(
      () => executeInSandbox(api, 'return process.env;'),
      (err: Error) => err.message.includes('process is not defined') || err.message.includes('process'),
    );
  });

  it('cannot access require', async () => {
    await assert.rejects(
      () => executeInSandbox(api, 'return require("fs");'),
      (err: Error) => err.message.includes('require is not defined') || err.message.includes('require'),
    );
  });

  it('times out on infinite loops', async () => {
    await assert.rejects(
      () => executeInSandbox(api, 'while(true) {}', 100),
      (err: Error) => /timed out|timeout|Script execution/i.test(err.message),
    );
  });

  it('returns script errors as thrown exceptions', async () => {
    await assert.rejects(
      () => executeInSandbox(api, 'throw new Error("test error");'),
      /test error/,
    );
  });

  it('provides JSON in sandbox', async () => {
    const result = await executeInSandbox(api, `
      return JSON.parse('{"a": 1}');
    `);
    assert.deepEqual(result, { a: 1 });
  });
});
