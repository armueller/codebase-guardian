import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { HAS_NVIM, startNvim, makeFixture, sampleTour, writeTour, type Nvim, type Fixture } from './helpers/nvim-harness.js';

describe('pr-tour tour validation', { skip: !HAS_NVIM && 'nvim not on PATH' }, () => {
  let fx: Fixture;
  let nv: Nvim;
  before(() => {
    fx = makeFixture();
    nv = startNvim(fx.headRoot);
  });
  after(() => {
    nv?.stop();
    fx?.cleanup();
  });

  const validateFile = (p: string) =>
    nv.lua<{ ok: boolean; err?: string; dropped: string[]; stops?: any[] }>(`
      local T = require('pr-tour.tour')
      local raw, read_err = T.read([==[${p}]==])
      if not raw then return { ok = false, err = read_err, dropped = {} } end
      local t, err, dropped = T.validate(raw)
      return { ok = t ~= nil, err = err, dropped = dropped, stops = t and t.stops or nil }`);
  const validate = (tour: unknown) => validateFile(writeTour(fx.root, tour));

  it('accepts a tour covering every view', () => {
    const r = validate(sampleTour(fx));
    assert.equal(r.ok, true, r.err);
    assert.deepEqual(r.dropped, []);
    assert.equal(r.stops!.length, 5);
  });

  it('defaults baseFile to file and resolves both sides', () => {
    const s = validate(sampleTour(fx)).stops![0];
    assert.equal(s.paths.base, `${fx.baseRoot}/src/modified.ts`);
    assert.equal(s.paths.head, `${fx.headRoot}/src/modified.ts`);
    assert.equal(s.focus, 'head');
    assert.equal(s.endLine, 7);
  });

  it('uses baseFile for renames and focuses the base side for deleted files', () => {
    const stops = validate(sampleTour(fx)).stops!;
    assert.equal(stops[1].paths.base, `${fx.baseRoot}/src/old-name.ts`);
    assert.equal(stops[3].focus, 'base');
    assert.equal(stops[3].paths.head, undefined);
  });

  it('drops bad notes with reasons but keeps the stop', () => {
    const t = sampleTour(fx);
    t.stops[0].notes = [
      { side: 'head', line: 300, kind: 'explain', text: 'past EOF' },
      { side: 'head', line: 2, kind: 'finding', text: 'no severity' },
      { side: 'head', line: 2, kind: 'explain', text: '' },
      { side: 'base', line: 2, kind: 'shout', text: 'bad kind' },
      { side: 'head', line: 2, kind: 'explain', text: 'good' },
    ];
    t.stops[2].notes = [{ side: 'base', line: 1, kind: 'explain', text: 'head-only view' }];
    const r = validate(t);
    assert.equal(r.ok, true);
    assert.equal(r.stops![0].notes.length, 1);
    assert.deepEqual(r.dropped, [
      'stop 1 note 1 dropped: line 300 is outside the head file (22 lines)',
      'stop 1 note 2 dropped: finding needs severity low|med|high',
      'stop 1 note 3 dropped: text is required',
      'stop 1 note 4 dropped: unknown kind: shout',
      "stop 3 note 1 dropped: side 'base' is not shown by view 'head'",
    ]);
  });

  it('drops a stop whose file is missing, and an added file shown as split', () => {
    const t = sampleTour(fx);
    t.stops.push({ title: 'ghost', file: 'src/nope.ts', view: 'head', line: 1, notes: [] });
    t.stops.push({ title: 'added split', file: 'src/added.ts', baseFile: null, view: 'split', line: 1, notes: [] });
    const r = validate(t);
    assert.equal(r.stops!.length, 5);
    assert.deepEqual(r.dropped, [
      `stop 6 dropped: head file not found: ${fx.headRoot}/src/nope.ts`,
      "stop 7 dropped: view 'split' needs a base file (use view 'head' for added files)",
    ]);
  });

  it('drops a stop whose line is outside its focus file', () => {
    const t = sampleTour(fx);
    t.stops.push({ title: 'far', file: 'src/unchanged.ts', view: 'head', line: 99, notes: [] });
    assert.deepEqual(validate(t).dropped, ['stop 6 dropped: line 99 is outside the head file (12 lines)']);
  });

  it('keeps a stop with a bad endLine, reporting the correction', () => {
    const t = sampleTour(fx);
    t.stops[0].endLine = 2;
    t.stops[2].endLine = 50;
    const r = validate(t);
    assert.equal(r.stops![0].endLine, 6);
    assert.equal(r.stops![2].endLine, 12);
    assert.deepEqual(r.dropped, [
      'stop 1: endLine 2 is invalid; using line 6',
      'stop 3: endLine 50 is past the end; using 12',
    ]);
  });

  it('fails on an unsupported version', () => {
    const r = validate({ ...sampleTour(fx), version: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.err, 'unsupported tour version: 2');
  });

  it('fails when every stop is dropped', () => {
    const r = validate({ ...sampleTour(fx), stops: [{ view: 'nope', line: 1 }] });
    assert.equal(r.ok, false);
    assert.equal(r.err, 'every stop was dropped');
    assert.deepEqual(r.dropped, ['stop 1 dropped: unknown view: nope']);
  });

  it('fails on invalid JSON', () => {
    const p = path.join(fx.root, 'broken.json');
    writeFileSync(p, '{nope');
    const r = validateFile(p);
    assert.equal(r.ok, false);
    assert.match(r.err!, /^tour file is not valid JSON/);
  });
});
