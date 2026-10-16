/**
 * Test harness for the pr-tour Neovim plugin and CLI: headless Neovim on
 * short socket paths, a git fixture with head/base worktrees, and a CLI runner.
 * Not a test file itself (no .test.ts suffix).
 *
 * Note on `any`: tours and RPC/CLI responses are deliberately loosely typed
 * (`any`) so tests can mutate fixtures and assert on arbitrary JSON shapes
 * without a parallel schema type.
 *
 * @what Shared helpers for pr-tour tests
 * @domain testing, neovim
 * @tags test-harness, neovim, fixtures
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI = path.join(REPO, 'scripts', 'pr-tour');
export const HAS_NVIM = spawnSync('nvim', ['--version']).status === 0;

/**
 * @what Quote a string as a Vimscript single-quoted literal
 * @how Doubles embedded single quotes and wraps the result in single quotes
 * @why Lets arbitrary Lua/paths be embedded in remote-expr strings safely
 * @param {string} s - Raw string
 * @returns {string} Vimscript literal
 * @sideeffects None
 * @systemlayer Utility
 * @domain testing, neovim
 * @tags vimscript, quoting, test-harness
 */
export function vimStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * @what Block the current thread for a number of milliseconds
 * @how Atomics.wait on a private SharedArrayBuffer
 * @why Lets synchronous test code poll without going async
 * @param {number} ms - Milliseconds to wait
 * @returns {void}
 * @sideeffects Blocks the thread
 * @systemlayer Utility
 * @domain testing
 * @tags sleep, polling, test-harness
 */
export function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @what Poll a predicate until it is true or a deadline passes
 * @how Calls pred every 25ms using sleep
 * @why Neovim state changes (windows, autocmds) settle asynchronously
 * @param {() => boolean} pred - Condition to wait for
 * @param {number} ms - Deadline in milliseconds (default 3000)
 * @returns {void}
 * @sideeffects Blocks the thread; throws 'waitFor timed out' at the deadline
 * @systemlayer Utility
 * @domain testing
 * @tags polling, wait, test-harness
 */
export function waitFor(pred: () => boolean, ms = 3000): void {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    sleep(25);
  }
}

/**
 * @what Evaluate a Vimscript expression on a running Neovim via RPC
 * @how Spawns `nvim --server <sock> --remote-expr <expr>` synchronously
 * @why The only transport the CLI and tests share with a live editor
 * @param {string} sock - Neovim server socket path
 * @param {string} expr - Vimscript expression
 * @returns {{status: number | null, out: string}} Exit status and stdout
 * @sideeffects Spawns a child process
 * @systemlayer Utility
 * @domain testing, neovim
 * @tags rpc, neovim, test-harness
 */
export function rpc(sock: string, expr: string): { status: number | null; out: string } {
  const r = spawnSync('nvim', ['--server', sock, '--remote-expr', expr], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, out: r.stdout };
}

/**
 * @what Handle to a headless Neovim instance driven over RPC
 * @domain testing, neovim
 * @tags neovim, rpc, test-harness
 */
export interface Nvim {
  sock: string;
  pid: number;
  dir: string;
  /** Evaluate a Vimscript expression; throws on RPC failure. */
  expr(e: string): string;
  /**
   * Run a Lua function body (must `return` a value); result is JSON-decoded.
   * One line: no `--` comments. `T` defaults to `any` so tests can assert on
   * arbitrary decoded shapes without declaring a type per call.
   */
  lua<T = any>(body: string): T;
  /**
   * Call require('pr-tour').<fn>(<argLua>) and decode its JSON response.
   * Returns `any` so tests can assert on arbitrary response shapes.
   */
  api(fn: string, argLua?: string): any;
  /** Queue keys asynchronously (nvim_input) — leaves pending modes like Visual active. */
  input(keys: string): void;
  /** Execute keys synchronously with remapping (feedkeys 'mx'). */
  keys(keys: string): void;
  /** Kill the Neovim process. */
  stop(): void;
}

/**
 * @what Start headless Neovim in a directory, listening on a short socket path
 * @how Spawns `nvim --headless --clean --listen`, adds the repo's nvim/ dir to rtp, polls until the socket answers
 * @why Unix socket paths are limited to ~103 bytes, so the socket lives in a mkdtemp dir
 * @param {string} cwd - Working directory for Neovim
 * @param {{sockDir?: string, plugin?: boolean, swap?: boolean}} opts - Socket dir override; plugin=false skips adding the plugin to rtp; swap=true keeps swapfiles on (default is -n); the window is 200 columns wide
 * @returns {Nvim} Handle to the running instance
 * @sideeffects Creates a temp dir, spawns a Neovim process, blocks up to 5s waiting for the socket
 * @systemlayer Utility
 * @domain testing, neovim
 * @tags neovim, process, test-harness
 */
export function startNvim(cwd: string, opts: { sockDir?: string; plugin?: boolean; swap?: boolean } = {}): Nvim {
  const dir = opts.sockDir ?? mkdtempSync(path.join(tmpdir(), 'prt-'));
  mkdirSync(dir, { recursive: true });
  const sock = path.join(dir, `nvim.${process.pid}.${Math.random().toString(36).slice(2, 8)}`);
  const args = ['--headless', '--clean', '--cmd', 'set columns=200', '--listen', sock];
  if (!opts.swap) args.push('-n');
  if (opts.plugin !== false) args.push('--cmd', `set rtp+=${path.join(REPO, 'nvim')}`);
  const proc = spawn('nvim', args, { cwd, stdio: 'ignore' });
  const deadline = Date.now() + 5000;
  while (rpc(sock, '1').status !== 0) {
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`nvim did not start on ${sock}`);
    }
    sleep(50);
  }
  const nv: Nvim = {
    sock,
    pid: proc.pid!,
    dir,
    /**
     * @what Evaluate a Vimscript expression on this instance
     * @how Delegates to rpc and throws on a non-zero status
     * @why Single choke point so failures name the offending expression
     * @param {string} e - Expression
     * @returns {string} Raw stdout
     * @sideeffects RPC call; throws when it fails
     * @systemlayer Utility
     * @domain testing, neovim
     * @tags neovim, rpc, test-harness
     */
    expr(e) {
      const r = rpc(sock, e);
      if (r.status !== 0) throw new Error(`remote-expr failed (${r.status}): ${e}`);
      return r.out;
    },
    /**
     * @what Run a Lua function body and JSON-decode its return value
     * @how Wraps the body in vim.json.encode((function() ... end)()) and luaeval's it
     * @why Tests inspect editor state as plain JSON
     * @param {string} body - Lua body that returns a value
     * @returns {any} Decoded result
     * @sideeffects Executes Lua in the editor
     * @systemlayer Utility
     * @domain testing, neovim
     * @tags neovim, lua, test-harness
     */
    lua(body) {
      const chunk = `vim.json.encode((function() ${body.replace(/\n/g, ' ')} end)())`;
      return JSON.parse(nv.expr(`luaeval(${vimStr(chunk)})`));
    },
    /**
     * @what Call a pr-tour API function and decode its JSON string reply
     * @how luaeval of require('pr-tour').<fn>(<argLua>) then JSON.parse
     * @why Mirrors what the CLI does over RPC
     * @param {string} fn - Function name on require('pr-tour')
     * @param {string} argLua - Lua argument expression
     * @returns {any} Decoded response
     * @sideeffects Executes plugin code in the editor
     * @systemlayer Utility
     * @domain testing, neovim
     * @tags neovim, api, test-harness
     */
    api(fn, argLua = 'nil') {
      return JSON.parse(nv.expr(`luaeval(${vimStr(`require('pr-tour').${fn}(${argLua})`)})`));
    },
    /**
     * @what Queue keys asynchronously via nvim_input
     * @how Calls nvim_input through remote-expr
     * @why Leaves pending modes (Visual) active for assertions
     * @param {string} keys - Key notation
     * @returns {void}
     * @sideeffects Feeds input to the editor
     * @systemlayer Utility
     * @domain testing, neovim
     * @tags neovim, keys, test-harness
     */
    input(keys) {
      nv.expr(`nvim_input(${vimStr(keys)})`);
    },
    /**
     * @what Execute keys synchronously with remapping
     * @how nvim_feedkeys with mode 'mx'
     * @why Lets tests exercise user mappings deterministically
     * @param {string} keys - Key notation
     * @returns {void}
     * @sideeffects Feeds input to the editor
     * @systemlayer Utility
     * @domain testing, neovim
     * @tags neovim, keys, test-harness
     */
    keys(keys) {
      nv.lua(`vim.api.nvim_feedkeys(vim.keycode([==[${keys}]==]), 'mx', false) return true`);
    },
    /**
     * @what Kill the Neovim process
     * @how SIGKILL on the spawned child
     * @why Tests must not leave editors running
     * @returns {void}
     * @sideeffects Sends SIGKILL
     * @systemlayer Utility
     * @domain testing, neovim
     * @tags neovim, process, test-harness
     */
    stop() {
      proc.kill('SIGKILL');
    },
  };
  return nv;
}

/**
 * @what Temp git repo with detached head/base worktrees plus a cleanup callback
 * @domain testing, git
 * @tags fixture, git, test-harness
 */
export interface Fixture {
  root: string;
  repo: string;
  headRoot: string;
  baseRoot: string;
  cleanup(): void;
}

/**
 * @what Build N numbered `const` declaration lines
 * @how Array.from over n, newline-joined and newline-terminated
 * @why Gives fixture files predictable line counts and content
 * @param {string} prefix - Identifier prefix
 * @param {number} n - Line count
 * @returns {string} File body
 * @sideeffects None
 * @systemlayer Utility
 * @domain testing
 * @tags fixture, text, test-harness
 */
const lines = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `const ${prefix}${i + 1} = ${i + 1};`).join('\n') + '\n';

/**
 * @what Run a git command synchronously and return trimmed stdout
 * @how spawnSync git with the given args in cwd
 * @why Fixture setup needs a small throwing git wrapper
 * @param {string} cwd - Directory to run in
 * @param {...string} args - git arguments
 * @returns {string} Trimmed stdout
 * @sideeffects Runs git, which may change repo state; throws on non-zero exit
 * @systemlayer Utility
 * @domain testing, git
 * @tags git, process, test-harness
 */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Repo with a base and a head commit covering every stop view (modified,
 * renamed, deleted, added, unchanged, and a filename with a space), checked
 * out as two detached worktrees.
 *
 * @what Create the git fixture used by pr-tour tests
 * @how git init, two commits, then two detached worktrees (head/base)
 * @why Tours need real base and head checkouts to validate against
 * @returns {Fixture} Paths plus a cleanup callback
 * @sideeffects Creates a temp directory, runs git init/commit/worktree; caller must call cleanup()
 * @systemlayer Utility
 * @domain testing, git
 * @tags fixture, git, test-harness
 */
export function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'prt-fx-')));
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  /**
   * @what Write a fixture file relative to the repo
   * @how writeFileSync to path.join(repo, rel)
   * @why Keeps fixture setup terse
   * @param {string} rel - Repo-relative path
   * @param {string} body - File contents
   * @returns {void}
   * @sideeffects Writes a file
   * @systemlayer Utility
   * @domain testing, git
   * @tags fixture, file-write, test-harness
   */
  const w = (rel: string, body: string) => writeFileSync(path.join(repo, rel), body);
  w('src/modified.ts', lines('m', 20));
  w('src/old-name.ts', lines('r', 10));
  w('src/deleted.ts', lines('d', 8));
  w('src/unchanged.ts', lines('u', 12));
  w('src/with space.ts', lines('s', 6));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  w('src/modified.ts', lines('m', 5) + 'const inserted = true;\n' + lines('n', 16)); // 22 lines
  git(repo, 'mv', 'src/old-name.ts', 'src/new-name.ts');
  w('src/new-name.ts', lines('r', 11));
  git(repo, 'rm', '-q', 'src/deleted.ts');
  w('src/added.ts', lines('a', 4));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'head');
  const headSha = git(repo, 'rev-parse', 'HEAD');
  const headRoot = path.join(root, 'head');
  const baseRoot = path.join(root, 'base');
  git(repo, 'worktree', 'add', '-q', '--detach', headRoot, headSha);
  git(repo, 'worktree', 'add', '-q', '--detach', baseRoot, baseSha);
  return { root, repo, headRoot, baseRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * @what A valid tour over the fixture, one stop per view kind
 * @how Builds a plain object referencing the fixture's head/base roots
 * @why Tests start from a known-good tour and mutate it
 * @param {Fixture} fx - Fixture from makeFixture
 * @returns {object} Tour object (stops typed `any[]` on purpose so tests can mutate them)
 * @sideeffects None
 * @systemlayer Utility
 * @domain testing
 * @tags fixture, tour, test-harness
 */
export function sampleTour(fx: Fixture) {
  return {
    version: 1,
    title: 'Fixture tour',
    headRoot: fx.headRoot,
    baseRoot: fx.baseRoot,
    stops: [
      {
        title: 'Modified pivot', file: 'src/modified.ts', view: 'split', line: 6, endLine: 7,
        notes: [
          { side: 'base', line: 6, kind: 'explain', text: 'old value here' },
          { side: 'head', line: 6, kind: 'explain', text: 'new line inserted' },
          { side: 'head', line: 10, kind: 'finding', severity: 'med', text: 'suspicious' },
        ],
        more: 'Longer detail.',
      },
      { title: 'Renamed', file: 'src/new-name.ts', baseFile: 'src/old-name.ts', view: 'split', line: 11, notes: [] },
      {
        title: 'Unchanged hop', file: 'src/unchanged.ts', view: 'head', line: 3,
        notes: [{ side: 'head', line: 3, kind: 'explain', text: 'just passes through' }],
      },
      { title: 'Deleted', baseFile: 'src/deleted.ts', view: 'base', line: 2, notes: [] },
      { title: 'Added', file: 'src/added.ts', baseFile: null, view: 'head', line: 1, notes: [] },
    ] as any[],
  };
}

/**
 * @what Write a tour object to a JSON file
 * @how mkdir -p the directory, then JSON.stringify to dir/name
 * @why Tests hand tour files to the plugin and CLI by path
 * @param {string} dir - Target directory
 * @param {unknown} tour - Tour object
 * @param {string} name - File name (defaults to a random tour-*.json)
 * @returns {string} Written file path
 * @sideeffects Creates the directory and writes a file
 * @systemlayer Utility
 * @domain testing
 * @tags fixture, tour, test-harness
 */
export function writeTour(dir: string, tour: unknown, name = `tour-${Math.random().toString(36).slice(2, 8)}.json`): string {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify(tour));
  return p;
}

/**
 * Run scripts/pr-tour; `json` is its single stdout line parsed, or null.
 *
 * @what Run the pr-tour CLI and capture its result
 * @how spawnSync CLI with merged env, then try JSON.parse on stdout
 * @why CLI tests assert on exit status and the single JSON stdout line
 * @param {string[]} args - CLI arguments
 * @param {Record<string, string>} env - Extra environment variables
 * @returns {{status: number | null, stdout: string, stderr: string, json: any}} Result (json is `any` on purpose so tests can assert on arbitrary shapes)
 * @sideeffects Runs scripts/pr-tour synchronously
 * @systemlayer Utility
 * @domain testing
 * @tags cli, process, test-harness
 */
export function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(CLI, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // left null; callers assert on it
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/**
 * Visible (non-float) windows of the current tab, plus tab count and cursor.
 *
 * @what Snapshot the editor's window layout
 * @how Runs a Lua body that walks the current tabpage's non-floating windows
 * @why Rendering tests assert on split structure, diff mode, filetype and locks
 * @param {Nvim} nv - Running Neovim handle
 * @returns {any} Layout object (any on purpose: tests assert on arbitrary shapes)
 * @sideeffects None (reads editor state over RPC)
 * @systemlayer Utility
 * @domain testing, neovim
 * @tags neovim, layout, test-harness
 */
export const layout = (nv: Nvim) =>
  nv.lua<any>(`
    local out = { tabs = #vim.api.nvim_list_tabpages(), wins = {}, current = vim.api.nvim_buf_get_name(0), cursor = vim.api.nvim_win_get_cursor(0)[1] }
    for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
      if vim.api.nvim_win_get_config(w).relative == '' then
        local b = vim.api.nvim_win_get_buf(w)
        out.wins[#out.wins + 1] = { name = vim.api.nvim_buf_get_name(b), diff = vim.wo[w].diff, ft = vim.bo[b].filetype, modifiable = vim.bo[b].modifiable, readonly = vim.bo[b].readonly }
      end
    end
    return out`);

/**
 * pr-tour extmarks on the buffer for `file`, flattened.
 *
 * @what List pr-tour extmarks in one buffer
 * @how Looks up the buffer by name and reads extmarks in the pr-tour namespace
 * @why Tests assert on pinned notes, signs and focus highlights
 * @param {Nvim} nv - Running Neovim handle
 * @param {string} file - Absolute path of the buffer
 * @returns {any[]} Flattened marks (any on purpose: tests assert on arbitrary shapes)
 * @sideeffects None (reads editor state over RPC)
 * @systemlayer Utility
 * @domain testing, neovim
 * @tags neovim, extmarks, test-harness
 */
export const marks = (nv: Nvim, file: string) =>
  nv.lua<any[]>(`
    local buf = vim.fn.bufnr([==[${file}]==])
    if buf < 0 then return {} end
    local ns = vim.api.nvim_create_namespace('pr-tour')
    local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, { details = true })) do
      local d = m[4]
      local text = ''
      for _, chunk in ipairs(d.virt_text or {}) do text = text .. chunk[1] end
      out[#out + 1] = { row = m[2], text = text, sign = vim.trim(d.sign_text or ''), line_hl = d.line_hl_group or '', virt_lines = d.virt_lines and #d.virt_lines or 0 }
    end
    return out`);
