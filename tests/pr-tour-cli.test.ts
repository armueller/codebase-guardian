import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HAS_NVIM, startNvim, makeFixture, sampleTour, writeTour, cli, rpc, sleep, waitFor, type Nvim, type Fixture } from './helpers/nvim-harness.js';

describe('pr-tour CLI', { skip: !HAS_NVIM && 'nvim not on PATH' }, () => {
  let fx: Fixture;
  let procs: Nvim[] = [];
  before(() => {
    fx = makeFixture();
  });
  after(() => fx?.cleanup());
  afterEach(() => {
    procs.forEach((p) => p.stop());
    procs = [];
  });

  /** Fresh socket dir + state dir per test. */
  const setup = () => {
    const sockDir = mkdtempSync(path.join(tmpdir(), 'prt-'));
    const stateDir = mkdtempSync(path.join(tmpdir(), 'prt-st-'));
    const env = { PR_TOUR_SOCKET_DIRS: sockDir, PR_TOUR_STATE_DIR: stateDir };
    const spawnIn = (cwd: string, opts: { plugin?: boolean } = {}) => {
      const nv = startNvim(cwd, { sockDir, ...opts });
      procs.push(nv);
      return nv;
    };
    const kill = (nv: Nvim) => {
      nv.stop();
      waitFor(() => rpc(nv.sock, '1').status !== 0);
    };
    return { sockDir, stateDir, env, spawnIn, kill };
  };

  it('attach picks the Neovim open in headRoot', () => {
    const { env, spawnIn } = setup();
    const h = spawnIn(fx.headRoot);
    spawnIn(fx.baseRoot);
    const r = cli(['attach', fx.headRoot], env);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.json.socket, h.sock);
    assert.equal(r.json.pid, h.pid);
  });

  it('attach matches an instance in a subdirectory of headRoot', () => {
    const { env, spawnIn } = setup();
    const h = spawnIn(path.join(fx.headRoot, 'src'));
    assert.equal(cli(['attach', fx.headRoot], env).json.socket, h.sock);
  });

  it('attach resolves a symlinked headRoot', () => {
    const { env, spawnIn } = setup();
    const h = spawnIn(fx.headRoot);
    const link = path.join(fx.root, `link-${Math.random().toString(36).slice(2, 6)}`);
    symlinkSync(fx.headRoot, link);
    assert.equal(cli(['attach', link], env).json.socket, h.sock);
  });

  it('attach with no match explains what to do', () => {
    const { env, spawnIn } = setup();
    spawnIn(fx.baseRoot);
    const r = cli(['attach', fx.headRoot], env);
    assert.equal(r.status, 1);
    assert.match(r.json.error, /no Neovim is open in .*head/);
  });

  it('attach lists candidates when several match', () => {
    const { env, spawnIn } = setup();
    spawnIn(fx.headRoot);
    spawnIn(fx.headRoot);
    const r = cli(['attach', fx.headRoot], env);
    assert.equal(r.status, 1);
    assert.equal(r.json.candidates.length, 2);
  });

  it('attach skips dead sockets', () => {
    const { env, spawnIn, kill } = setup();
    kill(spawnIn(fx.headRoot));
    const live = spawnIn(fx.headRoot);
    assert.equal(cli(['attach', fx.headRoot], env).json.socket, live.sock);
  });

  it('attach refuses a Neovim without the plugin', () => {
    const { env, spawnIn } = setup();
    spawnIn(fx.headRoot, { plugin: false });
    assert.match(cli(['attach', fx.headRoot], env).json.error, /does not have the pr-tour plugin/);
  });

  it('load, where, goto and clear pass through to the plugin', () => {
    const { env, spawnIn } = setup();
    spawnIn(fx.headRoot);
    cli(['attach', fx.headRoot], env);
    const tourPath = writeTour(path.join(fx.root, "it's a dir"), sampleTour(fx));
    const loaded = cli(['load', tourPath], env);
    assert.equal(loaded.status, 0, loaded.stdout);
    assert.equal(loaded.json.stops, 5);
    assert.equal(cli(['where'], env).json.stop, 1);
    assert.equal(cli(['goto', 'src/modified.ts', '15'], env).json.line, 15);
    const bad = cli(['goto', 'src/modified.ts', '99'], env);
    assert.equal(bad.status, 1);
    assert.equal(bad.json.ok, false);
    assert.deepEqual(cli(['clear'], env).json, { ok: true, cleared: true });
  });

  it('goto validates its arguments', () => {
    const { env, spawnIn } = setup();
    spawnIn(fx.headRoot);
    cli(['attach', fx.headRoot], env);
    assert.match(cli(['goto', 'src/x.ts', 'abc'], env).json.error, /line must be a positive integer/);
    assert.match(cli(['goto', 'src/x.ts', '1', '--sideways'], env).json.error, /^usage:/);
  });

  it('commands before attach say how to attach', () => {
    const { env } = setup();
    assert.match(cli(['where'], env).json.error, /not attached; run: pr-tour attach/);
  });

  it('re-discovers when the attached Neovim restarts', () => {
    const { env, stateDir, spawnIn, kill } = setup();
    const first = spawnIn(fx.headRoot);
    cli(['attach', fx.headRoot], env);
    kill(first);
    const second = spawnIn(fx.headRoot);
    assert.equal(cli(['clear'], env).json.ok, true);
    assert.equal(readFileSync(path.join(stateDir, 'attached'), 'utf8').split('\n')[0], second.sock);
  });

  it('times out instead of hanging on a blocked Neovim', () => {
    const { env, spawnIn } = setup();
    const h = spawnIn(fx.headRoot);
    cli(['attach', fx.headRoot], env);
    rpc(h.sock, `luaeval('vim.defer_fn(function() vim.uv.sleep(4000) end, 50)')`);
    sleep(200);
    const t0 = Date.now();
    const r = cli(['clear'], { ...env, PR_TOUR_TIMEOUT: '1' });
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
    assert.match(r.json.error, /did not respond within 1s/);
  });

  it('attach blames an unresponsive Neovim instead of saying none is open', () => {
    const { env, spawnIn } = setup();
    const h = spawnIn(fx.headRoot);
    spawnIn(fx.baseRoot);
    rpc(h.sock, `luaeval('vim.defer_fn(function() vim.uv.sleep(4000) end, 50)')`);
    sleep(200);
    const r = cli(['attach', fx.headRoot], { ...env, PR_TOUR_TIMEOUT: '1' });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.json.error, /^1 Neovim instance\(s\) did not respond within 1s .*waiting at a prompt; press Esc in Neovim and retry/);
  });

  it('rejects an override socket path over the macOS limit', () => {
    const { env } = setup();
    const r = cli(['attach', fx.headRoot], { ...env, PR_TOUR_NVIM_SOCKET: `/tmp/${'x'.repeat(120)}` });
    assert.match(r.json.error, /limited to 103/);
  });

  it('prints valid JSON even when the error contains quotes', () => {
    const { env } = setup();
    const r = cli(['attach', '/nonexistent/"quoted"'], env);
    assert.ok(r.json, r.stdout);
    assert.match(r.json.error, /"quoted"/);
  });

  it('unknown subcommands print usage', () => {
    const r = cli(['frobnicate']);
    assert.equal(r.status, 1);
    assert.match(r.json.error, /^usage:/);
  });
});
