import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HAS_NVIM, startNvim, makeFixture, sampleTour, writeTour, waitFor, layout, marks, type Nvim, type Fixture } from './helpers/nvim-harness.js';

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

  it('the stop keys do nothing to the tour outside the tour tab', () => {
    load();
    nv.lua(`vim.cmd('tabfirst') return true`);
    nv.keys(']s');
    assert.equal(nv.lua(`return require('pr-tour.state').index`), 1);
  });

  it('gK opens the stop detail in a float', () => {
    load();
    const floats = () => nv.lua<number>(`local n = 0 for _, w in ipairs(vim.api.nvim_list_wins()) do if vim.api.nvim_win_get_config(w).relative ~= '' then n = n + 1 end end return n`);
    assert.equal(floats(), 0);
    nv.keys('gK');
    assert.equal(floats(), 1);
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

  it('clear keeps unsaved changes', () => {
    nv.lua(`vim.cmd('edit ' .. vim.fn.fnameescape([==[${head('src/modified.ts')}]==])) vim.api.nvim_buf_set_lines(0, 0, 1, false, { 'EDITED' }) return true`);
    load();
    nv.api('clear');
    const s = nv.lua<any>(`local b = vim.fn.bufnr([==[${head('src/modified.ts')}]==]) return { first = vim.api.nvim_buf_get_lines(b, 0, 1, false)[1], modified = vim.bo[b].modified }`);
    assert.deepEqual(s, { first: 'EDITED', modified: true });
  });

  it('entry points return JSON errors instead of throwing', () => {
    load();
    const r = nv.api('jump', 'nil');
    assert.equal(r.ok, false);
    assert.match(r.error, /attempt to index/);
  });
});
