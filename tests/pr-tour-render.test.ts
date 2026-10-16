import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HAS_NVIM, startNvim, makeFixture, sampleTour, writeTour, layout, marks, type Nvim, type Fixture } from './helpers/nvim-harness.js';

describe('pr-tour rendering', { skip: !HAS_NVIM && 'nvim not on PATH' }, () => {
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

  const load = (tour: unknown) => nv.api('load', `[==[${writeTour(fx.root, tour)}]==]`);

  it('reports stop and finding counts with an empty dropped list', () => {
    const r = load(sampleTour(fx));
    assert.deepEqual(r, { ok: true, title: 'Fixture tour', stops: 5, findings: 1, dropped: [] });
  });

  it('opens the first stop as a diff split in its own tab', () => {
    load(sampleTour(fx));
    const l = layout(nv);
    assert.equal(l.tabs, 2);
    assert.deepEqual(l.wins.map((w: any) => w.name), [base('src/modified.ts'), head('src/modified.ts')]);
    assert.ok(l.wins.every((w: any) => w.diff));
    assert.equal(l.current, head('src/modified.ts'));
    assert.equal(l.cursor, 6);
  });

  it('sets the filetype and locks only the base side', () => {
    load(sampleTour(fx));
    const [b, h] = layout(nv).wins;
    assert.equal(b.ft, 'typescript');
    assert.equal(h.ft, 'typescript');
    assert.equal(b.modifiable, false);
    assert.equal(b.readonly, true);
    assert.equal(h.modifiable, true);
  });

  it('pins notes, findings and the focus range on the right lines', () => {
    load(sampleTour(fx));
    const h = marks(nv, head('src/modified.ts'));
    assert.ok(h.some((m) => m.row === 5 && m.text === '◀ new line inserted'));
    assert.ok(h.some((m) => m.row === 9 && m.text === '◆ [med] suspicious' && m.sign === '◆'));
    assert.deepEqual(h.filter((m) => m.line_hl === 'PrTourFocus').map((m) => m.row), [5, 6]);
    const b = marks(nv, base('src/modified.ts'));
    assert.ok(b.some((m) => m.row === 5 && m.text === '◀ old value here'));
  });

  it('wraps a note too long for the window onto virtual lines', () => {
    const t = sampleTour(fx);
    t.stops = [{ title: 'long', file: 'src/unchanged.ts', view: 'head', line: 2,
      notes: [{ side: 'head', line: 2, kind: 'explain', text: 'word '.repeat(60).trim() }] }];
    load(t);
    const note = marks(nv, head('src/unchanged.ts')).find((m) => m.line_hl === '');
    assert.ok(note && note.virt_lines > 1 && note.text === '', JSON.stringify(note));
  });

  it("reuses the tab and clears the previous tour's marks on reload", () => {
    load(sampleTour(fx));
    const t = sampleTour(fx);
    t.stops = [t.stops[2]];
    assert.equal(load(t).ok, true);
    assert.equal(layout(nv).tabs, 2);
    assert.deepEqual(marks(nv, head('src/modified.ts')), []);
    assert.deepEqual(marks(nv, base('src/modified.ts')), []);
  });

  it("never discards the reviewer's unsaved changes", () => {
    nv.lua(`vim.cmd('edit ' .. vim.fn.fnameescape([==[${head('src/modified.ts')}]==])) vim.api.nvim_buf_set_lines(0, 0, 1, false, { 'EDITED' }) return true`);
    load(sampleTour(fx));
    const s = nv.lua<any>(`local b = vim.api.nvim_get_current_buf() return { first = vim.api.nvim_buf_get_lines(b, 0, 1, false)[1], modified = vim.bo[b].modified }`);
    assert.deepEqual(s, { first: 'EDITED', modified: true });
  });

  it('opens diff folds around a focus line and notes far from the hunk', () => {
    const t = sampleTour(fx);
    t.stops = [{ title: 'far', file: 'src/long.ts', view: 'split', line: 5,
      notes: [
        { side: 'head', line: 2, kind: 'explain', text: 'far head note' },
        { side: 'base', line: 69, kind: 'explain', text: 'far base note' },
      ] }];
    load(t);
    const closed = nv.lua<any>(`
      local s = require('pr-tour.state')
      local fc = function(side, row) return vim.api.nvim_win_call(s.wins[side], function() return vim.fn.foldclosed(row) end) end
      return { focus = fc('head', 5), head = fc('head', 2), base = fc('base', 69), baseFocus = fc('base', 5), untouched = fc('head', 69) }`);
    assert.deepEqual(closed, { focus: -1, head: -1, base: -1, baseFocus: -1, untouched: 68 });
  });

  it('opens files whose names contain spaces', () => {
    const t = sampleTour(fx);
    t.stops = [{ title: 'space', file: 'src/with space.ts', view: 'head', line: 2, notes: [] }];
    assert.equal(load(t).ok, true);
    assert.equal(layout(nv).current, head('src/with space.ts'));
  });

  it('rejects an invalid tour without touching the editor', () => {
    const r = load({ ...sampleTour(fx), version: 9 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'unsupported tour version: 9');
    assert.equal(layout(nv).tabs, 1);
  });

  it('wraps a short note onto virtual lines when the line leaves too little room', () => {
    const t = sampleTour(fx);
    t.stops = [{ title: 'room', file: 'src/modified.ts', view: 'head', line: 6,
      notes: [{ side: 'head', line: 6, kind: 'explain', text: 'x'.repeat(190) }] }];
    nv.lua(`vim.o.columns = 200 return true`);
    load(t);
    const note = marks(nv, head('src/modified.ts')).find((m) => m.virt_lines > 0);
    assert.ok(note, 'expected a virt_lines note');
  });

  it('trims a long note at end of line on a split stop instead of adding virtual lines', () => {
    const t = sampleTour(fx);
    t.stops = [{ title: 'split', file: 'src/modified.ts', view: 'split', line: 6,
      notes: [{ side: 'head', line: 6, kind: 'explain', text: 'word '.repeat(60).trim() }] }];
    load(t);
    const note = marks(nv, head('src/modified.ts')).find((m) => m.row === 5 && m.line_hl === '');
    assert.ok(note, 'expected the note mark');
    assert.equal(note.virt_lines, 0, 'virtual lines would push the diff panes out of line');
    assert.ok(note.text.startsWith('◀ word word') && note.text.endsWith('…'), note.text);
    const fits = nv.lua<boolean>(
      `local w = require('pr-tour.state').wins.head local info = vim.fn.getwininfo(w)[1] ` +
      `local line = vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(w), 5, 6, false)[1] ` +
      `return vim.fn.strdisplaywidth(line) + 2 + vim.fn.strdisplaywidth(${JSON.stringify(note.text)}) <= info.width - info.textoff`);
    assert.ok(fits, 'trimmed note must fit in the space left on the line');
  });

  it('re-trims split-stop notes when the editor is resized', () => {
    const t = sampleTour(fx);
    t.stops = [{ title: 'split', file: 'src/modified.ts', view: 'split', line: 6,
      notes: [{ side: 'head', line: 6, kind: 'explain', text: 'word '.repeat(60).trim() }] }];
    load(t);
    const before = marks(nv, head('src/modified.ts')).find((m) => m.row === 5 && m.line_hl === '')!.text;
    nv.lua(`vim.o.columns = 120 vim.cmd('wincmd =') vim.api.nvim_exec_autocmds('VimResized', {}) return true`);
    const after = marks(nv, head('src/modified.ts')).find((m) => m.row === 5 && m.line_hl === '')!.text;
    assert.ok(after.length < before.length, `${after.length} should be < ${before.length}`);
    assert.ok(after.endsWith('…'));
  });

  it('opens a file that has a swap file instead of prompting', () => {
    const other = startNvim(fx.headRoot, { swap: true });
    const swapped = startNvim(fx.headRoot, { swap: true });
    try {
      other.lua(`vim.cmd('edit ' .. vim.fn.fnameescape([==[${head('src/modified.ts')}]==])) return true`);
      const r = swapped.api('load', `[==[${writeTour(fx.root, sampleTour(fx))}]==]`);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(layout(swapped).wins.length, 2);
    } finally {
      other.stop();
      swapped.stop();
    }
  });
});
