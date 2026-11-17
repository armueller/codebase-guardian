import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeTsSubdirRepo, putFiles } from './helpers/ts-subdir-repo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// Drives the real MCP server over stdio (no mocks). This is the case that started the work: a
// long-lived server that was running before guardian.config.json existed must pick the file up
// on the next rebuild, and a repo with no root tsconfig must get a finished, honest rebuild.

/** Calls a tool and returns its text plus the error flag. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 170_000 });
  const content = result.content as { type: string; text: string }[];
  return { text: content.map(c => c.text).join('\n'), isError: result.isError === true };
}

describe('MCP server rebuild_index', () => {
  it('reports a degraded rebuild without a tsconfig, then picks up a config written while it runs', { timeout: 180_000 }, async () => {
    const root = makeTsSubdirRepo({
      'docs/notes.md': '# Notes\n\n@domain demo\n\nA short note that is long enough to be indexed as a section.\n',
    });
    execFileSync('git', ['init', '-q'], { cwd: root });

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== 'GUARDIAN_PROJECT_ROOT' && key !== 'CLAUDE_PLUGIN_DATA') env[key] = value;
    }
    env.GUARDIAN_HOME = mkdtempSync(path.join(tmpdir(), 'guardian-home-mcp-'));

    const transport = new StdioClientTransport({
      command: path.join(REPO, 'node_modules', '.bin', 'tsx'),
      args: [path.join(REPO, 'src', 'mcp-server', 'index.ts')],
      cwd: root,
      env,
      stderr: 'ignore',
    });
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

      // 2. Write the config while the server keeps running.
      putFiles(root, {
        'guardian.config.json': JSON.stringify({
          sourceDirectories: ['web/app'],
          docsDirectories: ['docs'],
          tsconfig: 'web/tsconfig.json',
        }),
      });

      // 3. The next rebuild uses it.
      const second = await call(client, 'rebuild_index');
      assert.equal(second.isError, false, second.text);
      assert.match(second.text, /## Index Rebuild Complete/);
      assert.match(second.text, /\*\*Tier 2 \(exports\):\*\* 4/);
      assert.match(second.text, /\*\*Tier 3 \(docs\):\*\* 1/);

      // 4. The call graph is queryable.
      const callers = await call(client, 'callers', { function_name: 'shout' });
      assert.match(callers.text, /run/);

      // 5. A configured tsconfig that does not exist fails that phase only, and says why.
      putFiles(root, {
        'guardian.config.json': JSON.stringify({ sourceDirectories: ['web/app'], tsconfig: 'nope/tsconfig.json' }),
      });
      const third = await call(client, 'rebuild_index');
      assert.equal(third.isError, false, third.text);
      assert.match(third.text, /## Index Rebuild Finished With Problems/);
      assert.match(
        third.text,
        /TypeScript call graph:\*\* failed \(tsconfig "nope\/tsconfig\.json" from guardian\.config\.json does not exist\)/,
      );
      assert.match(third.text, /Index code and docs:\*\* ok/);
      assert.match(third.text, /\*\*Tier 2 \(exports\):\*\* not run/);
    } finally {
      await client.close();
    }
  });
});
