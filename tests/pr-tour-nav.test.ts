import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HAS_NVIM, startNvim, makeFixture, sampleTour, writeTour, waitFor, sleep, layout, marks, type Nvim, type Fixture } from './helpers/nvim-harness.js';

describe('pr-tour navigation and queries', { skip: !HAS_NVIM && 'nvim not on PATH' }, () => {
  let fx: Fixture;
  let nv: Nvim;
  let head: (rel: string) => string;
  let base: (rel: string) => string;
  before(() => {
    fx = makeFixture();
    head = (rel) => `${fx.headRoot}/${rel}`;
    base = (rel) => `${fx.baseRoot}/${rel}`;
  });
  after(() => fx?.cleanup());
  beforeEach(() => {
    nv = startNvim(fx.headRoot);
  });
  afterEach(() => nv?.stop());

  const load = () => nv.api('load', `[==[${writeTour(fx.root, sampleTour(fx))}]==]`);
  const where = () => nv.api('where');

  it(']s and [s move between stops and stop at the ends', () => {
    load();
    nv.keys(']s');
    assert.equal(where().stop, 2);
    assert.deepEqual(layout(nv).wins.map((w: any) => w.name), [base('src/old-name.ts'), head('src/new-name.ts')]);
    nv.keys('[s');
    nv.keys('[s');
    assert.equal(where().stop, 1);
  });

  it('a single-pane stop closes the split and turns diff off', () => {
    load();
    nv.keys(']s');
    nv.keys(']s');
    const l = layout(nv);
    assert.equal(where().stop, 3);
    assert.equal(l.wins.length, 1);
    assert.equal(l.wins[0].diff, false);
  });

  it('changing stops does not print "Already only one window"', () => {
    load();
    nv.keys(']s');
    nv.keys(']s');
    nv.keys(']s');
    assert.doesNotMatch(nv.lua<string>(`return vim.fn.execute('messages')`), /Already only one window/);
  });

  it('the stop keys do nothing to the tour outside the tour tab', () => {
    load();
    nv.lua(`vim.cmd('tabfirst') return true`);
    nv.keys(']s');
    assert.equal(nv.lua(`return require('pr-tour.state').index`), 1);
  });

  it('gL opens the stop detail in a float', () => {
    load();
    const floats = () => nv.lua<number>(`local n = 0 for _, w in ipairs(vim.api.nvim_list_wins()) do if vim.api.nvim_win_get_config(w).relative ~= '' then n = n + 1 end end return n`);
    assert.equal(floats(), 0);
    nv.keys('gL');
    assert.equal(floats(), 1);
  });

  /**
   * Lines of the pr-tour detail float, or [] when none is open.
   * @returns the float buffer's lines; nv.lua encodes an empty Lua table as {}, so it is normalized here
   */
  const floatLines = (): string[] => {
    const r = nv.lua<string[] | Record<string, never>>(`for _, w in ipairs(vim.api.nvim_list_wins()) do if vim.api.nvim_win_get_config(w).relative ~= '' and vim.w[w]['pr-tour-more'] then return vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(w), 0, -1, false) end end return {}`);
    return Array.isArray(r) ? r : [];
  };
  const long = 'word '.repeat(60).trim();
  /**
   * Load a one-stop split tour on src/modified.ts:6 with the given head-side notes.
   * @param notes - head-side notes as [line, text] pairs
   */
  const loadSplit = (notes: Array<[number, string]>) => {
    const t = sampleTour(fx);
    t.stops = [{ title: 'split', file: 'src/modified.ts', view: 'split', line: 6,
      notes: notes.map(([line, text]) => ({ side: 'head', line, kind: 'explain', text })) }];
    nv.api('load', `[==[${writeTour(fx.root, t)}]==]`);
  };

  it('gL on a note line shows the full note, then the stop detail', () => {
    load();
    nv.keys('gL');
    const text = floatLines().join('\n');
    assert.ok(text.includes('◀ new line inserted'), text);
    assert.ok(text.includes('Longer detail.'), text);
    assert.ok(text.indexOf('new line inserted') < text.indexOf('Longer detail.'), text);
  });

  it('gL shows a trimmed note in full', () => {
    loadSplit([[6, long]]);
    nv.keys('gL');
    assert.ok(floatLines().join(' ').replace(/\s+/g, ' ').includes(long), floatLines().join('\n'));
  });

  it('moving onto a trimmed note line echoes the full note; other lines echo nothing', () => {
    loadSplit([[6, long], [8, 'short']]);
    assert.equal(nv.lua(`return require('pr-tour.nav').echo_note() or vim.NIL`), `◀ ${long}`);
    nv.keys('2j');
    assert.equal(nv.lua(`return require('pr-tour.nav').echo_note() or vim.NIL`), null, 'untrimmed notes are already readable');
  });

  it('the cursor echo fires on CursorMoved, and again after leaving and returning to the focus line', () => {
    loadSplit([[6, long]]);
    const spy = `local nav = require('pr-tour.nav') _G.prt_echoes = 0 local orig = nav.echo_note nav.echo_note = function() local r = orig() if r then _G.prt_echoes = _G.prt_echoes + 1 end return r end return true`;
    nv.lua(spy);
    nv.keys('j');
    nv.keys('k');
    assert.equal(nv.lua(`return _G.prt_echoes`), 1, 'returning to the trimmed focus line echoes it');
  });

  /** Record every echoed message's text in _G.prt_echoed, oldest first. */
  const spyEcho = () => nv.lua(`_G.prt_echoed = {} local orig = vim.api.nvim_echo vim.api.nvim_echo = function(chunks, ...) local t = {} for _, c in ipairs(chunks) do t[#t + 1] = c[1] end table.insert(_G.prt_echoed, table.concat(t)) return orig(chunks, ...) end return true`);
  /**
   * The newest echoed message, or null.
   * @returns the last text recorded by spyEcho
   */
  const lastEcho = () => nv.lua<string | null>(`return _G.prt_echoed[#_G.prt_echoed] or vim.NIL`);
  /**
   * Where the cursor is, as side:line.
   * @returns the current window's worktree side and cursor line
   */
  const at = () => {
    const w = where();
    return `${w.side}:${w.line}`;
  };

  it(']n steps through the notes by line, base before head at the same line, then stops', () => {
    load();
    spyEcho();
    nv.keys(']n');
    assert.equal(at(), 'base:6');
    assert.equal(lastEcho(), 'note 1/3: ◀ old value here');
    nv.keys(']n');
    assert.equal(at(), 'head:6');
    assert.equal(lastEcho(), 'note 2/3: ◀ new line inserted');
    nv.keys(']n');
    assert.equal(at(), 'head:10');
    assert.equal(lastEcho(), 'note 3/3: ◆ [med] suspicious');
    nv.keys(']n');
    assert.equal(at(), 'head:10', 'the cursor stays on the last note');
    assert.equal(lastEcho(), 'pr-tour: last note (3/3), ]s for the next stop');
  });

  it('[n steps back, and says so at the first note', () => {
    load();
    spyEcho();
    nv.keys(']n]n');
    nv.keys('[n');
    assert.equal(at(), 'base:6');
    assert.equal(lastEcho(), 'note 1/3: ◀ old value here');
    nv.keys('[n');
    assert.equal(at(), 'base:6');
    assert.equal(lastEcho(), 'pr-tour: no earlier note, [s for the previous stop');
  });

  it('the cursor echo does not overwrite the note counter on landing', () => {
    loadSplit([[6, long], [8, long]]);
    spyEcho();
    nv.keys(']n]n');
    sleep(50);
    assert.match(lastEcho() ?? '', /^note 2\/2: ◀ word word.* gL$/);
  });

  it('a new stop starts its notes from the first one', () => {
    load();
    nv.keys(']n]n]n');
    nv.keys(']s]s');
    spyEcho();
    nv.keys(']n');
    assert.equal(at(), 'head:3');
    assert.equal(lastEcho(), 'note 1/1: ◀ just passes through');
  });

  it(']n on a stop without notes says so', () => {
    load();
    nv.keys(']s');
    spyEcho();
    nv.keys(']n');
    assert.equal(lastEcho(), 'pr-tour: this stop has no notes');
  });

  it(']n opens a fold hiding the note', () => {
    const t = sampleTour(fx);
    t.stops = [{ title: 'far', file: 'src/long.ts', view: 'split', line: 5,
      notes: [{ side: 'head', line: 69, kind: 'explain', text: 'far note' }] }];
    nv.api('load', `[==[${writeTour(fx.root, t)}]==]`);
    nv.keys('zM');
    nv.keys(']n');
    assert.equal(nv.lua(`return vim.fn.foldclosed(69)`), -1);
    assert.equal(at(), 'head:69');
  });

  it(']n after a jump goes back to the stop and starts from its first note', () => {
    load();
    nv.api('jump', `{ file = 'src/unchanged.ts', line = 2 }`);
    nv.keys(']n');
    assert.equal(where().stop, 1);
    assert.equal(at(), 'base:6');
  });

  it(']n does nothing outside the tour tab', () => {
    load();
    nv.lua(`vim.cmd('tabfirst') return true`);
    nv.keys(']n');
    assert.equal(nv.lua(`return require('pr-tour.state').note_index`), 0);
  });

  it('arriving at a stop echoes its note count before the title', () => {
    load();
    spyEcho();
    nv.keys(']s');
    assert.equal(lastEcho(), 'pr-tour 2/5 · no notes: Renamed');
    nv.keys(']s');
    assert.equal(lastEcho(), 'pr-tour 3/5 · 1 note: Unchanged hop');
    nv.keys('[s[s');
    assert.equal(lastEcho(), 'pr-tour 1/5 · 3 notes: Modified pivot');
  });

  it('gL with no note on the line and no stop detail opens no float', () => {
    load();
    nv.keys(']s]s');
    nv.keys('gg');
    nv.keys('gL');
    assert.deepEqual(floatLines(), []);
  });

  it('where reports stop, side, file and cursor', () => {
    load();
    assert.deepEqual(where(), {
      ok: true, inTourTab: true, stop: 1, stops: 5, title: 'Modified pivot',
      side: 'head', file: 'src/modified.ts', line: 6, selection: null,
    });
  });

  it('where reports the selection after leaving visual mode', () => {
    load();
    nv.keys('Vj<Esc>');
    const sel = where().selection;
    assert.equal(sel.side, 'head');
    assert.equal(sel.file, 'src/modified.ts');
    assert.equal(sel.startLine, 6);
    assert.equal(sel.endLine, 7);
    assert.equal(sel.text, 'const inserted = true;\nconst n1 = 1;');
    assert.equal(typeof sel.ageSeconds, 'number');
  });

  it('where reports a live visual selection with age 0', () => {
    load();
    nv.input('Vj');
    waitFor(() => nv.lua<string>(`return vim.api.nvim_get_mode().mode`) === 'V');
    const sel = where().selection;
    assert.deepEqual([sel.startLine, sel.endLine, sel.ageSeconds], [6, 7, 0]);
  });

  it('jump moves within a pane already showing the file', () => {
    load();
    const r = nv.api('jump', `{ file = 'src/modified.ts', line = 15 }`);
    assert.deepEqual(r, { ok: true, side: 'head', file: 'src/modified.ts', line: 15 });
    const l = layout(nv);
    assert.equal(l.wins.length, 2);
    assert.equal(l.cursor, 15);
  });

  it('jump with before=true opens the base file alone, and ]s restores the tour', () => {
    load();
    nv.api('jump', `{ file = 'src/unchanged.ts', line = 4, before = true }`);
    let l = layout(nv);
    assert.deepEqual(l.wins.map((w: any) => w.name), [base('src/unchanged.ts')]);
    assert.equal(l.cursor, 4);
    assert.equal(l.wins[0].modifiable, false);
    nv.keys(']s');
    l = layout(nv);
    assert.equal(l.wins.length, 2);
    assert.equal(where().stop, 1);
    nv.keys(']s');
    assert.equal(where().stop, 2);
  });

  it('[s after a jump re-shows the current stop', () => {
    load();
    nv.keys(']s');
    nv.api('jump', `{ file = 'src/unchanged.ts', line = 4, before = true }`);
    nv.keys('[s');
    assert.equal(where().stop, 2);
    assert.equal(layout(nv).wins.length, 2);
  });

  it('jump from the last stop is not stranded: ]s returns to it', () => {
    load();
    nv.lua(`require('pr-tour.render').show(#require('pr-tour.state').tour.stops) return true`);
    nv.api('jump', `{ file = 'src/unchanged.ts', line = 4, before = true }`);
    nv.keys(']s');
    assert.equal(where().stop, 5);
  });

  it('jump into a diff pane opens the fold hiding the target line', () => {
    const t = sampleTour(fx);
    t.stops = [{ title: 'far', file: 'src/long.ts', view: 'split', line: 5, notes: [] }];
    nv.api('load', `[==[${writeTour(fx.root, t)}]==]`);
    nv.api('jump', `{ file = 'src/long.ts', line = 69 }`);
    assert.equal(nv.lua<number>(`return vim.fn.foldclosed(69)`), -1);
    assert.equal(layout(nv).wins.length, 2);
  });

  it('jump rejects lines outside the file', () => {
    load();
    const r = nv.api('jump', `{ file = 'src/modified.ts', line = 99 }`);
    assert.deepEqual(r, { ok: false, error: 'line 99 is outside the head file (22 lines)' });
  });

  it('base buffers opened later, as gd would, are locked', () => {
    load();
    const mod = nv.lua<boolean>(`vim.cmd('edit ' .. vim.fn.fnameescape([==[${base('src/unchanged.ts')}]==])) return vim.bo.modifiable`);
    assert.equal(mod, false);
  });

  it('clear removes the tab, pins, keymaps and base buffers', () => {
    load();
    assert.deepEqual(nv.api('clear'), { ok: true, cleared: true });
    assert.equal(layout(nv).tabs, 1);
    assert.deepEqual(marks(nv, head('src/modified.ts')), []);
    assert.equal(nv.lua(`return vim.fn.maparg(']s', 'n')`), '');
    const baseBufs = nv.lua<number>(`local n = 0 for _, b in ipairs(vim.api.nvim_list_bufs()) do if vim.startswith(vim.api.nvim_buf_get_name(b), [==[${fx.baseRoot}]==]) then n = n + 1 end end return n`);
    assert.equal(baseBufs, 0);
    assert.deepEqual(where(), { ok: false, error: 'no tour loaded' });
  });

  it("clear restores the reviewer's own mapping", () => {
    nv.lua(`vim.keymap.set('n', ']s', ':let g:mine = 1<CR>') return true`);
    load();
    nv.api('clear');
    assert.equal(nv.lua(`return vim.fn.maparg(']s', 'n')`), ':let g:mine = 1<CR>');
  });

  it('clear restores the global mapping even when the buffer has its own', () => {
    nv.lua(`vim.keymap.set('n', ']s', function() vim.g.mine = 'global' end, { desc = 'mine' }) vim.keymap.set('n', ']s', ':let g:mine = "local"<CR>', { buffer = 0 }) return true`);
    load();
    nv.api('clear');
    const g = nv.lua<any>(`for _, m in ipairs(vim.api.nvim_get_keymap('n')) do if m.lhs == ']s' then return { desc = m.desc, callback = type(m.callback) } end end return vim.NIL`);
    assert.deepEqual(g, { desc: 'mine', callback: 'function' });
  });

  it('clear keeps unsaved changes', () => {
    nv.lua(`vim.cmd('edit ' .. vim.fn.fnameescape([==[${head('src/modified.ts')}]==])) vim.api.nvim_buf_set_lines(0, 0, 1, false, { 'EDITED' }) return true`);
    load();
    nv.api('clear');
    const s = nv.lua<any>(`local b = vim.fn.bufnr([==[${head('src/modified.ts')}]==]) return { first = vim.api.nvim_buf_get_lines(b, 0, 1, false)[1], modified = vim.bo[b].modified }`);
    assert.deepEqual(s, { first: 'EDITED', modified: true });
  });

  /**
   * Start an in-process fake language server rooted at `root` and attach it to the given buffers.
   * @param root - the client's root_dir
   * @param files - absolute paths of loaded buffers to attach
   * @returns the client id
   */
  const fakeClient = (root: string, files: string[]): number => nv.lua<number>(
    `local function cmd(d) local closing = false return { ` +
    `request = function(method, _, cb) if method == 'initialize' then cb(nil, { capabilities = {} }) elseif method == 'shutdown' then cb(nil, vim.NIL) end return true, 1 end, ` +
    `notify = function(method) if method == 'exit' then closing = true vim.schedule(function() d.on_exit(0, 15) end) end return true end, ` +
    `is_closing = function() return closing end, terminate = function() closing = true end } end ` +
    `local files = vim.json.decode([==[${JSON.stringify(files)}]==]) ` +
    `local id = vim.lsp.start({ name = 'fake', cmd = cmd, root_dir = [==[${root}]==] }, { bufnr = vim.fn.bufnr(files[1]), reuse_client = function() return false end }) ` +
    `for i = 2, #files do vim.lsp.buf_attach_client(vim.fn.bufnr(files[i]), id) end return id`);
  /**
   * Whether a language client is still running (not stopped or stopping).
   * @param id - client id from fakeClient
   * @returns true while the client exists and is not stopped
   */
  const alive = (id: number) => nv.lua<boolean>(`local c = vim.lsp.get_client_by_id(${id}) return c ~= nil and not c:is_stopped()`);

  it('split stops read the head file before the base file', () => {
    nv.lua(`_G.prt_reads = {} vim.api.nvim_create_autocmd('BufReadPost', { callback = function(ev) table.insert(_G.prt_reads, vim.api.nvim_buf_get_name(ev.buf)) end }) return true`);
    load();
    const reads = nv.lua<string[]>(`return _G.prt_reads`);
    const h = reads.indexOf(head('src/modified.ts'));
    const b = reads.indexOf(base('src/modified.ts'));
    assert.ok(h !== -1 && b !== -1 && h < b, JSON.stringify(reads));
    assert.equal(layout(nv).wins[0].name, base('src/modified.ts'), 'base stays the left pane');
  });

  it('clear keeps a base-rooted language server that still serves head buffers', () => {
    load();
    const id = fakeClient(fx.baseRoot, [base('src/modified.ts'), head('src/modified.ts')]);
    assert.ok(alive(id));
    nv.api('clear');
    sleep(500);
    assert.ok(alive(id), 'stopping it would leave the head buffer without LSP');
  });

  it('clear stops a base-rooted language server that only served base buffers', () => {
    load();
    const id = fakeClient(fx.baseRoot, [base('src/modified.ts')]);
    assert.ok(alive(id));
    nv.api('clear');
    waitFor(() => !alive(id), 2000);
  });

  it('entry points return JSON errors instead of throwing', () => {
    load();
    const r = nv.api('jump', 'nil');
    assert.equal(r.ok, false);
    assert.match(r.error, /attempt to index/);
  });
});
