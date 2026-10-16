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
