import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPythonFirstAttemptPrompt,
  buildPythonRetryPrompt,
} from '../src/hooks/helpers/claude-headless.js';
import type { ExtractedFunction, ExtractedClass } from '../src/hooks/helpers/types.js';
import type { PyFinding } from '../src/hooks/helpers/py-tools.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FILE_PATH = 'src/widgets/widget.py';

const FUNCTIONS: ExtractedFunction[] = [
  {
    name: 'compute_total',
    fullCode: 'def compute_total(widget, count):\n    return widget.price * count',
    hasJSDoc: false,
    isNew: true,
    isModified: false,
    lineInFile: 10,
    requiresJSDoc: true,
  },
];

const CLASSES: ExtractedClass[] = [
  {
    name: 'Widget',
    kind: 'dataclass',
    fields: [{ name: 'price', annotation: 'float', default: null, comment: null }],
    parent: null,
    docstring: 'A widget.',
    domains: ['widgets'],
    tags: [],
    layer: null,
    isNew: false,
    isModified: true,
    lineInFile: 1,
  },
];

const MODULE = { docstring: 'Widget module.\n\nDomain: widgets.', domains: ['widgets'], tags: [], layer: null };

const DOC_VIOLATIONS = new Map<string, string[]>([
  ['compute_total', ["public function 'compute_total' is missing a docstring"]],
]);

const RUFF_FINDING: PyFinding = { tool: 'ruff', code: 'F401', message: 'imported but unused', line: 3 };
const PYDOCLINT_FINDING: PyFinding = { tool: 'pydoclint', code: 'DOC101', message: 'Docstring missing parameter', line: 10 };

const TOOL_FINDINGS = { ruff: [RUFF_FINDING], pydoclint: [PYDOCLINT_FINDING] };

const BASE_FIRST_ATTEMPT_OPTS = {
  filePath: FILE_PATH,
  functions: FUNCTIONS,
  classes: CLASSES,
  module: MODULE,
  docViolations: DOC_VIOLATIONS,
  toolFindings: TOOL_FINDINGS,
  isNewFile: false,
};

const RETRY_OPTS = {
  filePath: FILE_PATH,
  functions: FUNCTIONS,
  classes: CLASSES,
  docViolations: DOC_VIOLATIONS,
  toolFindings: TOOL_FINDINGS,
};

/**
 * Assertions shared by both builders: file path, a rendered ruff finding, a
 * rendered local doc-completeness violation, and the JSON-only response envelope.
 */
function assertCommonPromptContract(prompt: string): void {
  assert.ok(prompt.includes(FILE_PATH));
  assert.ok(prompt.includes('F401'));
  assert.ok(prompt.includes("public function 'compute_total' is missing a docstring"));
  assert.ok(prompt.includes('"decision"'));
  assert.ok(prompt.includes('"violations"'));
  assert.ok(prompt.includes('"suggestions"'));
  assert.ok(prompt.includes('"reasoning"'));
}

// ─── buildPythonFirstAttemptPrompt ──────────────────────────────────────────

describe('buildPythonFirstAttemptPrompt', () => {
  it('satisfies the shared prompt contract (file path, tool findings, doc violations, JSON envelope)', () => {
    const prompt = buildPythonFirstAttemptPrompt(BASE_FIRST_ATTEMPT_OPTS);
    assertCommonPromptContract(prompt);
  });

  it('contains convention keywords (Domain:, allow-with-suggestion, no-index notice)', () => {
    const prompt = buildPythonFirstAttemptPrompt(BASE_FIRST_ATTEMPT_OPTS);
    assert.ok(prompt.includes('Domain:'));
    assert.ok(/allow-with-suggestion/.test(prompt));
    assert.ok(prompt.includes('index does NOT yet cover Python'));
  });

  it('renders a pydoclint finding code', () => {
    const prompt = buildPythonFirstAttemptPrompt(BASE_FIRST_ATTEMPT_OPTS);
    assert.ok(prompt.includes('DOC101'));
  });

  it('renders the unit code fenced as python with NEW/MODIFIED status', () => {
    const prompt = buildPythonFirstAttemptPrompt(BASE_FIRST_ATTEMPT_OPTS);
    assert.ok(prompt.includes('```python'));
    assert.ok(prompt.includes('def compute_total(widget, count):'));
    assert.match(prompt, /compute_total[\s\S]{0,40}NEW/);
    assert.match(prompt, /Widget[\s\S]{0,40}MODIFIED/);
  });

  it('omits the syntax-note by default', () => {
    const prompt = buildPythonFirstAttemptPrompt(BASE_FIRST_ATTEMPT_OPTS);
    assert.ok(!/partial\/intermediate state/i.test(prompt));
  });

  it('adds a syntax-note when syntaxNote is true', () => {
    const prompt = buildPythonFirstAttemptPrompt({ ...BASE_FIRST_ATTEMPT_OPTS, syntaxNote: true });
    assert.ok(/partial\/intermediate state/i.test(prompt));
  });

  it('renders a placeholder instead of an empty section when there are no tool findings', () => {
    const prompt = buildPythonFirstAttemptPrompt({
      ...BASE_FIRST_ATTEMPT_OPTS,
      toolFindings: { ruff: [], pydoclint: [] },
    });
    assert.ok(!prompt.includes('F401'));
    assert.ok(!prompt.includes('DOC101'));
    assert.ok(prompt.includes('(no ruff or pydoclint findings)'));
  });
});

// ─── buildPythonRetryPrompt ──────────────────────────────────────────────────

describe('buildPythonRetryPrompt', () => {
  it('satisfies the shared prompt contract (file path, tool findings, doc violations, JSON envelope)', () => {
    const prompt = buildPythonRetryPrompt(RETRY_OPTS);
    assertCommonPromptContract(prompt);
  });

  it('renders the updated unit code', () => {
    const prompt = buildPythonRetryPrompt(RETRY_OPTS);
    assert.ok(prompt.includes('def compute_total(widget, count):'));
  });
});
