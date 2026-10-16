import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.join(__dirname, '..', 'skills');
const read = (rel: string) => readFileSync(path.join(SKILLS, rel), 'utf8');
const headings = (md: string) => md.split('\n').filter((l) => /^#{2,3} /.test(l));

const CORE_HEADINGS = [
  '## Configuration',
  '## Phase 0 — Pin the ground',
  '## Phase 1 — Classify and quarantine',
  '## Phase 2 — Build the slice map',
  '## Phase 3 — Analyze each slice',
  '### Rules for this phase',
  '## Phase 4 — Cross-slice synthesis',
  '## Phase 4.5 — Plain-language recap (the comprehension check)',
  '## Phase 5 — Draft, approve, post',
  '## Blind-spot taxonomy by change kind',
  '## Machine-authored PR failure modes',
  '## Review record',
];

describe('shared PR review core', () => {
  const core = read('_shared/pr-review-core.md');
  const walkthrough = read('pr-walkthrough/SKILL.md');

  it('holds every shared phase and reference section', () => {
    for (const h of CORE_HEADINGS) assert.ok(headings(core).includes(h), `core is missing: ${h}`);
  });

  it('is loaded by pr-walkthrough, which keeps only its presentation rules', () => {
    assert.ok(walkthrough.includes('../_shared/pr-review-core.md'));
    assert.ok(walkthrough.includes('**One slice per message. Never batch.**'));
    assert.ok(walkthrough.includes('**Number your paragraphs**'));
    assert.ok(!walkthrough.includes('## Phase 0 — Pin the ground'), 'Phase 0 must live only in the core');
  });

  it('does not duplicate a heading across the two files', () => {
    const shared = headings(walkthrough).filter((h) => headings(core).includes(h));
    assert.deepEqual(shared, []);
  });
});
