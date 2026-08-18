import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPythonFirstAttemptPrompt,
  buildPythonRetryPrompt,
} from '../src/hooks/helpers/claude-headless.js';
import type { ExtractedFunction, ExtractedClass } from '../src/hooks/helpers/types.js';
import type { PyFinding } from '../src/hooks/helpers/py-tools.js';
import type { PatternContext, FunctionResult } from '../src/hooks/helpers/code-index-client.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FILE_PATH = 'src/widgets/widget.py';

const EMPTY_PATTERN_CONTEXT: PatternContext = {
  directoryReadme: null,
  siblingFunctions: [],
  calledFunctionDetails: new Map(),
  unknownCalledFunctions: [],
  callerDetails: new Map(),
  similarExistingFunctions: new Map(),
  relevantDocs: [],
  similarComments: [],
  directoryPatterns: {
    commonDomains: [],
    commonSystemLayers: [],
    commonTags: [],
    hasSideEffects: false,
    namingExamples: [],
  },
};

const SIBLING_FUNC: FunctionResult = {
  id: 1,
  name: 'compute_subtotal',
  description: 'Computes the subtotal for a widget before tax.',
  file_path: 'src/widgets/helpers.py',
  line_number: 5,
  is_exported: 1,
  declaration_type: 'function',
  side_effects: null,
  system_layer: 'Business Logic',
  tier: 1,
  language: 'py',
  domains: ['widgets'],
  tags: ['pricing'],
  systemlayers: ['Business Logic'],
};

const SIMILAR_FUNC: FunctionResult = {
  id: 2,
  name: 'calc_widget_total',
  description: 'Calculates a widget total including tax and discounts.',
  file_path: 'src/cart/pricing.py',
  line_number: 22,
  is_exported: 1,
  declaration_type: 'function',
  side_effects: null,
  system_layer: 'Business Logic',
  tier: 1,
  language: 'py',
  domains: ['pricing'],
  tags: ['cart'],
  systemlayers: ['Business Logic'],
};

const CALLER_FUNC: FunctionResult = {
  id: 3,
  name: 'render_invoice',
  description: 'Renders an invoice using the widget total.',
  file_path: 'src/invoices/render.py',
  line_number: 8,
  is_exported: 1,
  declaration_type: 'function',
  side_effects: 'writes PDF to disk',
  system_layer: 'UI Helper',
  tier: 1,
  language: 'py',
  domains: ['invoices'],
  tags: ['pdf'],
  systemlayers: ['UI Helper'],
};

// A populated PatternContext, standing in for what buildPatternContext returns once the
// index has Python rows for the directory (P3.3/P3.4). Keyed by 'compute_total' — the
// name of the function under edit in FUNCTIONS below — matching how buildPatternContext
// keys similarExistingFunctions/callerDetails by the modified/created function names.
const SAMPLE_PATTERN_CONTEXT: PatternContext = {
  directoryReadme: 'All pricing helpers in this directory must be pure functions.',
  siblingFunctions: [SIBLING_FUNC],
  calledFunctionDetails: new Map(),
  unknownCalledFunctions: [],
  callerDetails: new Map([['compute_total', [CALLER_FUNC]]]),
  similarExistingFunctions: new Map([['compute_total', [SIMILAR_FUNC]]]),
  relevantDocs: [],
  similarComments: [],
  directoryPatterns: {
    commonDomains: ['widgets'],
    commonSystemLayers: ['Business Logic'],
    commonTags: ['pricing'],
    hasSideEffects: false,
    namingExamples: ['compute_subtotal'],
  },
};

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
  patternContext: EMPTY_PATTERN_CONTEXT,
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

  it('contains convention keywords (Domain:, allow-with-suggestion) and the index/MCP availability note, but NOT the old no-index notice', () => {
    const prompt = buildPythonFirstAttemptPrompt(BASE_FIRST_ATTEMPT_OPTS);
    assert.ok(prompt.includes('Domain:'));
    assert.ok(/allow-with-suggestion/.test(prompt));
    assert.ok(prompt.includes('INDEX & MCP TOOLS AVAILABLE'));
    assert.ok(!prompt.includes('index does NOT yet cover Python'));
    assert.ok(!prompt.includes('NO-INDEX NOTICE'));
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

  // ─── Pattern context injection (P3.5) ──────────────────────────────────────

  it('omits the RELATED CODE IN THE INDEX section header entirely when patternContext is empty', () => {
    const prompt = buildPythonFirstAttemptPrompt(BASE_FIRST_ATTEMPT_OPTS);
    // The always-present availability note references the section by name in prose
    // ("the RELATED CODE IN THE INDEX section above (when present)"), so assert against
    // the exact `==`-wrapped section header rather than the bare phrase.
    assert.ok(!prompt.includes('== RELATED CODE IN THE INDEX =='));
  });

  it('injects the RELATED CODE IN THE INDEX section with README, siblings, similar functions, and callers when patternContext is populated', () => {
    const prompt = buildPythonFirstAttemptPrompt({
      ...BASE_FIRST_ATTEMPT_OPTS,
      patternContext: SAMPLE_PATTERN_CONTEXT,
    });

    assert.ok(prompt.includes('== RELATED CODE IN THE INDEX =='));

    // Directory README
    assert.ok(prompt.includes('All pricing helpers in this directory must be pure functions.'));

    // Sibling function (name, file, domain)
    assert.ok(prompt.includes('compute_subtotal'));
    assert.ok(prompt.includes('src/widgets/helpers.py'));

    // Similar existing function (DRY signal) keyed by the edited function's name
    assert.ok(prompt.includes('Similar functions found for "compute_total"'));
    assert.ok(prompt.includes('calc_widget_total'));
    assert.ok(prompt.includes('src/cart/pricing.py'));

    // Caller (blast radius)
    assert.ok(prompt.includes('render_invoice'));
    assert.ok(prompt.includes('src/invoices/render.py'));
  });

  it('omits empty pattern-context subsections individually (e.g. relevant docs, similar comments) even when other sections are populated', () => {
    const prompt = buildPythonFirstAttemptPrompt({
      ...BASE_FIRST_ATTEMPT_OPTS,
      patternContext: SAMPLE_PATTERN_CONTEXT,
    });
    // SAMPLE_PATTERN_CONTEXT has no relevantDocs or similarComments
    assert.ok(!prompt.includes('### Relevant Documentation'));
    assert.ok(!prompt.includes('### Similar Inline Comments'));
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
