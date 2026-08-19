import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFirstAttemptPrompt } from '../src/hooks/helpers/claude-headless.js';
import type { ExtractedFunction, ExtractedType, PropertyAccess } from '../src/hooks/helpers/types.js';
import type { PatternContext, FunctionResult, RelevantDoc } from '../src/hooks/helpers/code-index-client.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────
//
// PV-2: buildFirstAttemptPrompt (src/hooks/helpers/claude-headless.ts) had no
// regression test at all before this file, despite two refactors touching it:
// P3.5 extracted the pattern-context section formatting into the shared
// formatPatternContextSections helper (also consumed by the Python builders,
// see tests/py-prompt.test.ts), and DC-1 moved the Python builders out of this
// module entirely. These tests lock the TS prompt's output so a future change
// to formatPatternContextSections that drops or garbles a section fails here.

const FILE_PATH = 'src/pricing/calculate.ts';

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
  name: 'computeSubtotal',
  description: 'Computes the subtotal for an order before tax.',
  file_path: 'src/pricing/helpers.ts',
  line_number: 5,
  is_exported: 1,
  declaration_type: 'function',
  side_effects: null,
  system_layer: 'Business Logic',
  tier: 1,
  language: 'ts',
  domains: ['pricing'],
  tags: ['calculation'],
  systemlayers: ['Business Logic'],
};

const SIMILAR_FUNC: FunctionResult = {
  id: 2,
  name: 'calcOrderTotal',
  description: 'Calculates an order total including tax and discounts.',
  file_path: 'src/cart/pricing.ts',
  line_number: 22,
  is_exported: 1,
  declaration_type: 'function',
  side_effects: null,
  system_layer: 'Business Logic',
  tier: 1,
  language: 'ts',
  domains: ['pricing'],
  tags: ['cart'],
  systemlayers: ['Business Logic'],
};

const CALLER_FUNC: FunctionResult = {
  id: 3,
  name: 'renderInvoice',
  description: 'Renders an invoice using the calculated total.',
  file_path: 'src/invoices/render.ts',
  line_number: 8,
  is_exported: 1,
  declaration_type: 'function',
  side_effects: 'writes PDF to disk',
  system_layer: 'UI Helper',
  tier: 1,
  language: 'ts',
  domains: ['invoices'],
  tags: ['pdf'],
  systemlayers: ['UI Helper'],
};

const RELEVANT_DOC: RelevantDoc = {
  name: 'Financial Calculation Pattern',
  filePath: 'docs/patterns/financial-calculation.md',
  descriptionPreview: 'Standard pattern for fee and gain/loss calculations across the codebase.',
  matchedDomains: ['pricing'],
  matchedTags: ['calculation'],
  matchScore: 3,
};

// Populated PatternContext, keyed by 'calculateTotal' — the name of the NEW
// function under edit in FUNCTIONS below — matching how buildPatternContext
// keys similarExistingFunctions/callerDetails by the modified/created function names.
const SAMPLE_PATTERN_CONTEXT: PatternContext = {
  directoryReadme: 'All pricing helpers in this directory must be pure functions.',
  siblingFunctions: [SIBLING_FUNC],
  calledFunctionDetails: new Map(),
  unknownCalledFunctions: [],
  callerDetails: new Map([['calculateTotal', [CALLER_FUNC]]]),
  similarExistingFunctions: new Map([['calculateTotal', [SIMILAR_FUNC]]]),
  relevantDocs: [RELEVANT_DOC],
  similarComments: [],
  directoryPatterns: {
    commonDomains: ['pricing'],
    commonSystemLayers: ['Business Logic'],
    commonTags: ['calculation'],
    hasSideEffects: false,
    namingExamples: ['computeSubtotal'],
  },
};

const FUNCTIONS: ExtractedFunction[] = [
  {
    name: 'calculateTotal',
    fullCode: 'function calculateTotal(items: Item[]): number {\n  return items.reduce((sum, i) => sum + i.price, 0);\n}',
    hasJSDoc: false,
    isNew: true,
    isModified: false,
    lineInFile: 10,
    requiresJSDoc: true,
  },
  {
    name: 'formatCurrency',
    fullCode: '/** formats a number as currency */\nfunction formatCurrency(amount: number): string {\n  return `$${amount.toFixed(2)}`;\n}',
    hasJSDoc: true,
    isNew: false,
    isModified: true,
    lineInFile: 25,
    requiresJSDoc: true,
  },
];

const EXTRACTED_TYPES: ExtractedType[] = [];

const PROPERTY_ACCESSES: PropertyAccess[] = [
  { object: 'items', property: 'price' },
];

const JSDOC_VIOLATIONS = new Map<string, string[]>([
  ['formatCurrency', ["@returns tag missing a description"]],
]);

const TYPE_JSDOC_VIOLATIONS = new Map<string, string[]>();

const BASE_CONTEXT = {
  filePath: FILE_PATH,
  extractedFunctions: FUNCTIONS,
  extractedTypes: EXTRACTED_TYPES,
  calledFunctions: [] as string[],
  propertyAccesses: PROPERTY_ACCESSES,
  jsdocViolations: JSDOC_VIOLATIONS,
  typeJsdocViolations: TYPE_JSDOC_VIOLATIONS,
};

// ─── buildFirstAttemptPrompt ────────────────────────────────────────────────

describe('buildFirstAttemptPrompt', () => {
  it('includes the file path and both edited functions by name', () => {
    const prompt = buildFirstAttemptPrompt({ ...BASE_CONTEXT, patternContext: SAMPLE_PATTERN_CONTEXT });
    assert.ok(prompt.includes(FILE_PATH));
    assert.ok(prompt.includes('Function: calculateTotal'));
    assert.ok(prompt.includes('Function: formatCurrency'));
  });

  it('marks a brand-new function with no JSDoc as MISSING, and a modified function with local violations as JSDoc Issues', () => {
    const prompt = buildFirstAttemptPrompt({ ...BASE_CONTEXT, patternContext: SAMPLE_PATTERN_CONTEXT });
    assert.match(prompt, /calculateTotal[\s\S]{0,20}Status: NEW[\s\S]{0,40}JSDoc: MISSING \(confirmed violation\)/);
    assert.match(prompt, /formatCurrency[\s\S]{0,20}Status: MODIFIED[\s\S]{0,80}JSDoc Issues \(confirmed by static analysis\)/);
    assert.ok(prompt.includes('@returns tag missing a description'));
  });

  it('renders the SIMILAR EXISTING FUNCTIONS (DRY) section keyed by the edited function name, with the similar function and its file path', () => {
    const prompt = buildFirstAttemptPrompt({ ...BASE_CONTEXT, patternContext: SAMPLE_PATTERN_CONTEXT });
    assert.ok(prompt.includes('== SIMILAR EXISTING FUNCTIONS (DRY CHECK — most important) =='));
    assert.ok(prompt.includes('Similar functions found for "calculateTotal"'));
    assert.ok(prompt.includes('calcOrderTotal'));
    assert.ok(prompt.includes('src/cart/pricing.ts'));
  });

  it('renders the directory README and sibling functions', () => {
    const prompt = buildFirstAttemptPrompt({ ...BASE_CONTEXT, patternContext: SAMPLE_PATTERN_CONTEXT });
    assert.ok(prompt.includes('== DIRECTORY README (pattern documentation) =='));
    assert.ok(prompt.includes('All pricing helpers in this directory must be pure functions.'));
    assert.ok(prompt.includes('== SIBLING FUNCTIONS (same directory — established patterns) =='));
    assert.ok(prompt.includes('computeSubtotal'));
    assert.ok(prompt.includes('src/pricing/helpers.ts'));
  });

  it('renders callers (blast radius) for the modified/created function', () => {
    const prompt = buildFirstAttemptPrompt({ ...BASE_CONTEXT, patternContext: SAMPLE_PATTERN_CONTEXT });
    assert.ok(prompt.includes('== CALLERS OF MODIFIED FUNCTIONS (blast radius) =='));
    assert.ok(prompt.includes('calculateTotal is called by: renderInvoice (src/invoices/render.ts)'));
  });

  it('renders relevant project documentation matched by domain/tag overlap', () => {
    const prompt = buildFirstAttemptPrompt({ ...BASE_CONTEXT, patternContext: SAMPLE_PATTERN_CONTEXT });
    assert.ok(prompt.includes('== RELEVANT DOCUMENTATION (pattern guides, best practices) =='));
    assert.ok(prompt.includes('Financial Calculation Pattern'));
    assert.ok(prompt.includes('docs/patterns/financial-calculation.md'));
    assert.ok(prompt.includes('Standard pattern for fee and gain/loss calculations across the codebase.'));
  });

  it('ends with the validation instruction', () => {
    const prompt = buildFirstAttemptPrompt({ ...BASE_CONTEXT, patternContext: SAMPLE_PATTERN_CONTEXT });
    assert.ok(prompt.includes('Validate this edit against the code quality rules in your system prompt and return the JSON result.'));
  });

  // ─── Empty PatternContext ───────────────────────────────────────────────────

  it('builds without throwing when PatternContext is entirely empty', () => {
    assert.doesNotThrow(() => {
      buildFirstAttemptPrompt({ ...BASE_CONTEXT, patternContext: EMPTY_PATTERN_CONTEXT });
    });
  });

  it('still renders the always-present section headers with placeholder text when PatternContext is empty', () => {
    const prompt = buildFirstAttemptPrompt({ ...BASE_CONTEXT, patternContext: EMPTY_PATTERN_CONTEXT });
    assert.ok(prompt.includes('(no similar functions found in the code index — likely genuinely new capability)'));
    assert.ok(prompt.includes('(No README found for this directory — skip README compliance check)'));
    assert.ok(prompt.includes('(no sibling functions found in directory)'));
    assert.ok(prompt.includes('(no callers found for modified functions)'));
  });

  it('omits the optional RELEVANT DOCUMENTATION and SIMILAR INLINE COMMENTS section headers when PatternContext is empty', () => {
    const prompt = buildFirstAttemptPrompt({ ...BASE_CONTEXT, patternContext: EMPTY_PATTERN_CONTEXT });
    assert.ok(!prompt.includes('== RELEVANT DOCUMENTATION (pattern guides, best practices) =='));
    assert.ok(!prompt.includes('== SIMILAR INLINE COMMENTS (sub-function DRY check) =='));
  });
});
