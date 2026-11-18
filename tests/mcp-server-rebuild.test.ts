import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  makeTsSubdirRepo, makeTempDir, cleanupTempDirs, putFiles, documentedFunction,
} from './helpers/ts-subdir-repo.js';

after(cleanupTempDirs);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// Drives the real MCP server over stdio (no mocks). This is the case that started the work: a
// long-lived server that was running before guardian.config.json existed must pick the file up
// on the next call, and a repo with no root tsconfig must get a finished, honest rebuild.

/** Calls a tool and returns its text plus the error flag. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 170_000 });
  const content = result.content as { type: string; text: string }[];
  return { text: content.map(c => c.text).join('\n'), isError: result.isError === true };
}

const GOOD_CONFIG = { sourceDirectories: ['web/app'], docsDirectories: ['docs'], tsconfig: 'web/tsconfig.json' };
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe('MCP server', () => {
  it('rebuilds honestly, keeps its status, and follows config changes without a restart', { timeout: 300_000 }, async () => {
    const root = makeTsSubdirRepo({
      'docs/notes.md': '# Notes\n\n@domain demo\n\nA short note that is long enough to be indexed as a section.\n',
    });
    execFileSync('git', ['init', '-q'], { cwd: root });

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== 'GUARDIAN_PROJECT_ROOT' && key !== 'CLAUDE_PLUGIN_DATA') env[key] = value;
    }
    const guardianHome = makeTempDir('guardian-home-mcp-');
    env.GUARDIAN_HOME = guardianHome;

    const transport = new StdioClientTransport({
      command: path.join(REPO, 'node_modules', '.bin', 'tsx'),
      args: [path.join(REPO, 'src', 'mcp-server', 'index.ts')],
      cwd: root,
      env,
      stderr: 'pipe',
    });
    let serverStderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => { serverStderr += chunk.toString(); });
    const client = new Client({ name: 'guardian-test', version: '0.0.0' });
    await client.connect(transport);

    try {
      // 1. No guardian.config.json and no root tsconfig: the rebuild finishes and says what is limited.
      const first = await call(client, 'rebuild_index');
      assert.equal(first.isError, false, first.text);
      assert.match(first.text, /## Index Rebuild Finished With Problems/);
      assert.match(first.text, /TypeScript call graph:\*\* degraded/);
      assert.match(first.text, /Python call graph:\*\* ok/);
      assert.match(first.text, /Validation cache:\*\* ok/);

      // index_status repeats what that rebuild reported.
      const statusAfterFirst = await call(client, 'index_status');
      assert.match(statusAfterFirst.text, /\*\*Last rebuild:\*\* finished with problems/);
      assert.match(statusAfterFirst.text, /TypeScript call graph:\*\* degraded/);

      // 2. Write the config while the server keeps running. The next rebuild uses it.
      putFiles(root, { 'guardian.config.json': JSON.stringify(GOOD_CONFIG) });
      const second = await call(client, 'rebuild_index');
      assert.equal(second.isError, false, second.text);
      assert.match(second.text, /## Index Rebuild Complete/);
      assert.match(second.text, /\*\*Tier 2 \(exports\):\*\* 4/);
      assert.match(second.text, /\*\*Tier 3 \(docs\):\*\* 1/);
      assert.match((await call(client, 'index_status')).text, /\*\*Last rebuild:\*\* complete/);

      // 3. The call graph is queryable: shout is called by run, in main.ts.
      const callers = await call(client, 'callers', { function_name: 'shout' });
      assert.match(callers.text, /## run \[Export\]/);
      assert.match(callers.text, /\*\*File:\*\* web\/app\/main\.ts/);

      // 4. A broken configuration: the rebuild does not start, and the index is left as it was.
      putFiles(root, { 'guardian.config.json': JSON.stringify({ ...GOOD_CONFIG, tsconfig: 'nope/tsconfig.json' }) });
      const third = await call(client, 'rebuild_index');
      assert.equal(third.isError, true, third.text);
      assert.match(third.text, /## Index Rebuild Not Started/);
      assert.match(third.text, /tsconfig "nope\/tsconfig\.json" from guardian\.config\.json does not exist/);
      const callersAfter = await call(client, 'callers', { function_name: 'shout' });
      assert.match(callersAfter.text, /\*\*File:\*\* web\/app\/main\.ts/, 'the previous index is still there');
      assert.match((await call(client, 'index_status')).text, /\*\*Last rebuild:\*\* complete/);

      // 5. index_status re-reads the config. Commit everything dated a day ahead, so it all counts
      //    as "changed since the last build": the file in other/ is counted only once its folder
      //    is in the config.
      putFiles(root, {
        'guardian.config.json': JSON.stringify(GOOD_CONFIG),
        'other/x.ts': documentedFunction('otherThing'),
      });
      const when = new Date(Date.now() + ONE_DAY_MS).toISOString();
      const gitEnv = { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
      execFileSync('git', ['add', '-A'], { cwd: root, env: gitEnv });
      execFileSync(
        'git',
        ['-c', 'user.name=guardian-test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'everything'],
        { cwd: root, env: gitEnv },
      );
      const changed = /Files changed since last build \(committed, per git\):\*\* (\d+)/;
      const outsideScope = Number((await call(client, 'index_status')).text.match(changed)?.[1]);
      putFiles(root, { 'guardian.config.json': JSON.stringify({ ...GOOD_CONFIG, sourceDirectories: ['web/app', 'other'] }) });
      const inScope = Number((await call(client, 'index_status')).text.match(changed)?.[1]);
      assert.equal(outsideScope, 5, 'four web/app files and docs/notes.md');
      assert.equal(inScope, 6, 'plus other/x.ts once its folder is a source directory');

      // 6. Auto-sync re-reads the config too, and applies the rules a full rebuild applies: a dirty
      //    file under a folder excluded since the server started is not indexed.
      putFiles(root, {
        'guardian.config.json': JSON.stringify({ ...GOOD_CONFIG, excludeDirectories: ['generated'] }),
        'web/app/generated/g.ts': documentedFunction('generatedThing'),
        'web/app/lib/fresh.ts': documentedFunction('freshThing'),
      });
      const indexDirs = readdirSync(path.join(guardianHome, 'indexes'));
      assert.equal(indexDirs.length, 1);
      writeFileSync(
        path.join(guardianHome, 'indexes', indexDirs[0], '.dirty-files'),
        'web/app/generated/g.ts\nweb/app/lib/fresh.ts\n',
      );
      const fresh = await call(client, 'search', { query: 'freshThing' });
      assert.match(fresh.text, /## freshThing/);
      const generated = await call(client, 'search', { query: 'generatedThing' });
      assert.doesNotMatch(generated.text, /## generatedThing/);
    } catch (err) {
      // The server's own log is the first thing needed to understand a failure here.
      if (err instanceof Error) err.message += `\n--- server stderr (tail) ---\n${serverStderr.slice(-2000)}`;
      throw err;
    } finally {
      await client.close();
    }
  });
});
