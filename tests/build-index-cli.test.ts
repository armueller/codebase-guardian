import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTsSubdirRepo, makeTempDir, cleanupTempDirs } from './helpers/ts-subdir-repo.js';

after(cleanupTempDirs);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// Runs the real build-index CLI in a child process (the module runs main() on import, so it
// cannot be imported into a test).

/** Runs the CLI against a project and returns its exit code and output. */
function runCli(projectRoot: string): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'CLAUDE_PLUGIN_DATA') env[key] = value;
  }
  env.GUARDIAN_PROJECT_ROOT = projectRoot;
  env.GUARDIAN_HOME = makeTempDir('guardian-home-cli-');
  const proc = spawnSync(
    path.join(REPO, 'node_modules', '.bin', 'tsx'),
    [path.join(REPO, 'src', 'mcp-server', 'build-index.ts')],
    { env, encoding: 'utf-8', timeout: 120_000 },
  );
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

describe('build-index CLI', () => {
  it('exits 0 and prints the report for a complete rebuild', { timeout: 150_000 }, () => {
    const root = makeTsSubdirRepo({
      'guardian.config.json': JSON.stringify({ sourceDirectories: ['web/app'], tsconfig: 'web/tsconfig.json' }),
    });
    const { status, stdout, stderr } = runCli(root);
    assert.equal(status, 0, stderr);
    assert.match(stdout, /## Index Rebuild Complete/);
    assert.match(stdout, /\*\*Tier 2 \(exports\):\*\* 4/);
  });

  it('exits 0 for a degraded rebuild: the index is usable', { timeout: 150_000 }, () => {
    const root = makeTsSubdirRepo({
      'guardian.config.json': JSON.stringify({ sourceDirectories: ['web/app'] }),
    });
    const { status, stdout, stderr } = runCli(root);
    assert.equal(status, 0, stderr);
    assert.match(stdout, /## Index Rebuild Finished With Problems/);
    assert.match(stdout, /TypeScript call graph:\*\* degraded/);
  });

  it('exits 1 without touching anything when the configuration is broken', { timeout: 150_000 }, () => {
    const root = makeTsSubdirRepo({
      'guardian.config.json': JSON.stringify({ sourceDirectories: ['web/app'], tsconfig: 'nope/tsconfig.json' }),
    });
    const { status, stdout } = runCli(root);
    assert.equal(status, 1);
    assert.match(stdout, /## Index Rebuild Not Started/);
    assert.match(stdout, /tsconfig "nope\/tsconfig\.json" from guardian\.config\.json does not exist/);
  });
});
