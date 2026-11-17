import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { reloadConfig } from '../src/config.js';
import { openDatabase, getFunctionByName } from '../src/mcp-server/db.js';
import { buildIndex } from '../src/mcp-server/indexer.js';
import { buildCallGraph } from '../src/mcp-server/call-graph.js';
import { makeTsSubdirRepo, TS_SUBDIR_FILES } from './helpers/ts-subdir-repo.js';

type Db = ReturnType<typeof openDatabase>;

/** Runs phase 1 and the TypeScript call graph for a repo, with config read fresh from its root. */
async function build(root: string): Promise<{ db: Db; result: Awaited<ReturnType<typeof buildCallGraph>> }> {
  const config = reloadConfig(root);
  const db = openDatabase(':memory:');
  await buildIndex(db, root, { config });
  const result = await buildCallGraph(db, root, { config });
  return { db, result };
}

/** True when a call edge exists between the two named functions in the two named files. */
function hasEdge(db: Db, caller: [string, string], callee: [string, string]): boolean {
  const source = getFunctionByName(db, caller[0], caller[1]);
  const target = getFunctionByName(db, callee[0], callee[1]);
  assert.ok(source, `${caller[0]} should be indexed in ${caller[1]}`);
  assert.ok(target, `${callee[0]} should be indexed in ${callee[1]}`);
  const row = db
    .prepare('SELECT 1 FROM call_edges WHERE source_function_id = ? AND target_function_id = ?')
    .get(source!.id, target!.id);
  return row !== undefined;
}

const RUN: [string, string] = ['run', 'web/app/main.ts'];
const GREET_LIB: [string, string] = ['greet', 'web/app/lib/greet.ts'];
const GREET_OTHER: [string, string] = ['greet', 'web/app/a-other/greet.ts'];
const SHOUT: [string, string] = ['shout', 'web/app/lib/shout.ts'];

/** guardian.config.json content as a files entry. */
function configFile(config: Record<string, unknown>): Record<string, string> {
  return { 'guardian.config.json': JSON.stringify(config) };
}

describe('buildCallGraph with a tsconfig outside the git root', () => {
  it('uses the configured sub-folder tsconfig and resolves alias calls to the right file', async () => {
    const root = makeTsSubdirRepo(configFile({ sourceDirectories: ['web/app'], tsconfig: 'web/tsconfig.json' }));
    const { db, result } = await build(root);

    assert.equal(result.status, 'ok');
    assert.equal(result.note, null);
    assert.equal(result.exportsDiscovered, 4);
    assert.equal(hasEdge(db, RUN, GREET_LIB), true, 'run -> lib/greet through the ~/ alias');
    assert.equal(hasEdge(db, RUN, GREET_OTHER), false, 'run must not be linked to the other greet');
    assert.equal(hasEdge(db, RUN, SHOUT), true, 'run -> shout through a relative import');
    db.close();
  });

  it('falls back to compiler defaults, reported as degraded, when there is no tsconfig', async () => {
    const root = makeTsSubdirRepo(configFile({ sourceDirectories: ['web/app'] }));
    const { db, result } = await build(root);

    assert.equal(result.status, 'degraded');
    assert.match(result.note ?? '', /calls through path aliases are not linked/);
    assert.match(result.note ?? '', /Set "tsconfig" in guardian\.config\.json/);
    assert.equal(result.exportsDiscovered, 4);
    assert.equal(hasEdge(db, RUN, SHOUT), true, 'relative imports still resolve to their file');
    // An unresolvable alias import resolves to its own import specifier, in the calling file, so
    // the callee lookup finds nothing: the edge is missing, not guessed from the name.
    assert.equal(hasEdge(db, RUN, GREET_LIB), false, 'the alias call has no edge without a tsconfig');
    assert.equal(hasEdge(db, RUN, GREET_OTHER), false, 'and is not linked to a same-named function either');
    db.close();
  });

  it('fails, without falling back, when the configured tsconfig does not exist', async () => {
    const root = makeTsSubdirRepo({
      ...configFile({ sourceDirectories: ['web/app'], tsconfig: 'nope/tsconfig.json' }),
      // A root tsconfig is present and must not be used in its place.
      'tsconfig.json': TS_SUBDIR_FILES['web/tsconfig.json'],
    });
    const config = reloadConfig(root);
    const db = openDatabase(':memory:');
    await buildIndex(db, root, { config });

    await assert.rejects(
      () => buildCallGraph(db, root, { config }),
      { message: 'tsconfig "nope/tsconfig.json" from guardian.config.json does not exist' },
    );
    db.close();
  });

  it('names the tsconfig in the error when it cannot be parsed', async () => {
    const root = makeTsSubdirRepo({
      ...configFile({ sourceDirectories: ['web/app'], tsconfig: 'web/tsconfig.json' }),
      'web/tsconfig.json': '{ not json',
    });
    const config = reloadConfig(root);
    const db = openDatabase(':memory:');
    await buildIndex(db, root, { config });

    await assert.rejects(
      () => buildCallGraph(db, root, { config }),
      /^Error: could not load tsconfig "web\/tsconfig\.json": .+/,
    );
    db.close();
  });

  it('still uses a root tsconfig.json when the field is not set', async () => {
    const root = makeTsSubdirRepo({
      ...configFile({ sourceDirectories: ['web/app'] }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: { module: 'ES2022', moduleResolution: 'bundler', strict: true, paths: { '~/*': ['./web/app/*'] } },
      }),
    });
    const { db, result } = await build(root);

    assert.equal(result.status, 'ok');
    assert.equal(result.exportsDiscovered, 4);
    assert.equal(hasEdge(db, RUN, GREET_LIB), true);
    assert.equal(hasEdge(db, RUN, GREET_OTHER), false);
    assert.equal(hasEdge(db, RUN, SHOUT), true);
    db.close();
  });

  it('does not load files from excluded folders', async () => {
    const root = makeTsSubdirRepo({
      ...configFile({ sourceDirectories: ['web/app'], tsconfig: 'web/tsconfig.json' }),
      'web/app/node_modules/p/x.ts': 'export function leaked(): number { return 1; }\n',
    });
    const { db, result } = await build(root);

    assert.equal(result.exportsDiscovered, 4);
    assert.equal(getFunctionByName(db, 'leaked'), null);
    db.close();
  });

  it('loads files whose names contain glob characters', async () => {
    const root = makeTsSubdirRepo({
      ...configFile({ sourceDirectories: ['web/app'], tsconfig: 'web/tsconfig.json' }),
      'web/app/routes/[id].ts': 'export function bracketRoute(): number { return 1; }\n',
      'web/app/routes/(group)/$slug.ts': 'export function dollarRoute(): number { return 2; }\n',
    });
    const { db } = await build(root);

    assert.ok(getFunctionByName(db, 'bracketRoute', 'web/app/routes/[id].ts'));
    assert.ok(getFunctionByName(db, 'dollarRoute', 'web/app/routes/(group)/$slug.ts'));
    db.close();
  });

  it('reports ok with a note when the source directories hold no TypeScript', async () => {
    const root = makeTsSubdirRepo(configFile({ sourceDirectories: ['empty'] }));
    mkdirSync(path.join(root, 'empty'));
    const { db, result } = await build(root);

    assert.deepEqual(result, {
      exportsDiscovered: 0,
      edgesCreated: 0,
      status: 'ok',
      note: 'no TypeScript files in the source directories',
    });
    db.close();
  });
});
