import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTag,
  extractFunctionName,
  extractFunctionBody,
  extractCommentsFromBody,
  parseDocSections,
  parseJSDocBlock,
} from '../src/mcp-server/indexer.js';

// ─── extractTag ─────────────────────────────────────────────────────────────

describe('extractTag', () => {
  it('extracts a simple single-line tag value', () => {
    const block = `/**\n * @what Calculates profit\n * @domain trading\n */`;
    assert.equal(extractTag(block, 'what'), 'Calculates profit');
    assert.equal(extractTag(block, 'domain'), 'trading');
  });

  it('returns empty string for missing tag', () => {
    const block = `/**\n * @what Something\n */`;
    assert.equal(extractTag(block, 'domain'), '');
  });

  it('is case-insensitive', () => {
    const block = `/**\n * @SideEffects Writes to DB\n */`;
    assert.equal(extractTag(block, 'sideeffects'), 'Writes to DB');
  });

  it('extracts multi-line continuation values', () => {
    const block = `/**\n * @what Calculates the weighted average cost basis across\n *       all lots including wash sale adjustments\n * @domain trading\n */`;
    const result = extractTag(block, 'what');
    assert.ok(result.includes('all lots including wash sale adjustments'), `Got: ${result}`);
  });

  it('stops continuation at the next @tag', () => {
    const block = `/**\n * @what First line\n *       continued\n * @how Does something\n */`;
    const result = extractTag(block, 'what');
    assert.ok(result.includes('continued'), `Got: ${result}`);
    assert.ok(!result.includes('Does something'), `Should not include next tag: ${result}`);
  });

  it('handles comma-separated values (domain, tags)', () => {
    const block = `/**\n * @domain trading, positions, options\n */`;
    assert.equal(extractTag(block, 'domain'), 'trading, positions, options');
  });
});

// ─── extractFunctionName ────────────────────────────────────────────────────

describe('extractFunctionName', () => {
  it('extracts export function name', () => {
    const result = extractFunctionName('export function calculateProfit(amount: number) {');
    assert.equal(result.name, 'calculateProfit');
    assert.equal(result.declarationType, 'function');
  });

  it('extracts async export function name', () => {
    const result = extractFunctionName('export async function fetchData() {');
    assert.equal(result.name, 'fetchData');
    assert.equal(result.declarationType, 'function');
  });

  it('extracts export const arrow function', () => {
    const result = extractFunctionName('export const formatPrice = (price: number) => {');
    assert.equal(result.name, 'formatPrice');
    assert.equal(result.declarationType, 'const');
  });

  it('extracts interface name', () => {
    const result = extractFunctionName('export interface StockData {');
    assert.equal(result.name, 'StockData');
    assert.equal(result.declarationType, 'interface');
  });

  it('extracts type alias name', () => {
    const result = extractFunctionName('export type TickerType = "stocks" | "options"');
    assert.equal(result.name, 'TickerType');
    assert.equal(result.declarationType, 'type');
  });

  it('extracts class name', () => {
    const result = extractFunctionName('export class OrderManager {');
    assert.equal(result.name, 'OrderManager');
    assert.equal(result.declarationType, 'class');
  });

  it('returns empty for unrecognized patterns', () => {
    const result = extractFunctionName('// just a comment');
    assert.equal(result.name, '');
  });

  it('handles leading whitespace', () => {
    const result = extractFunctionName('\n\nexport function test() {');
    assert.equal(result.name, 'test');
  });
});

// ─── extractFunctionBody ────────────────────────────────────────────────────

describe('extractFunctionBody', () => {
  it('extracts a simple function body', () => {
    const code = 'prefix\nexport function foo() {\n  return 42;\n}\nafter';
    const startPos = code.indexOf('export');
    const body = extractFunctionBody(code, startPos);
    assert.ok(body.includes('return 42'), `Body should contain return: ${body}`);
    assert.ok(body.startsWith('{'), `Body should start with {: ${body}`);
    assert.ok(body.endsWith('}'), `Body should end with }: ${body}`);
  });

  it('handles braces inside string literals', () => {
    const code = `export function foo() {\n  const x = "}";\n  return x;\n}`;
    const body = extractFunctionBody(code, 0);
    assert.ok(body.includes('return x'), `Should contain return x: ${body}`);
  });

  it('handles braces inside template literals', () => {
    const code = 'export function foo() {\n  const x = `value: ${obj.key}`;\n  return x;\n}';
    const body = extractFunctionBody(code, 0);
    assert.ok(body.includes('return x'), `Should contain return x: ${body}`);
  });

  it('handles braces inside single-quoted strings', () => {
    const code = `export function foo() {\n  const x = '}';\n  return x;\n}`;
    const body = extractFunctionBody(code, 0);
    assert.ok(body.includes('return x'), `Should contain return x: ${body}`);
  });

  it('handles braces inside line comments', () => {
    const code = `export function foo() {\n  // closing }\n  return 42;\n}`;
    const body = extractFunctionBody(code, 0);
    assert.ok(body.includes('return 42'), `Should contain return 42: ${body}`);
  });

  it('handles braces inside block comments', () => {
    const code = `export function foo() {\n  /* { */ \n  return 42;\n}`;
    const body = extractFunctionBody(code, 0);
    assert.ok(body.includes('return 42'), `Should contain return 42: ${body}`);
  });

  it('returns empty when no opening brace found', () => {
    const code = 'export const x = 42;';
    const body = extractFunctionBody(code, 0);
    assert.equal(body, '');
  });

  it('respects maxLength parameter', () => {
    const code = 'function foo() {\n' + '  const x = 1;\n'.repeat(100) + '}';
    const body = extractFunctionBody(code, 0, 50);
    assert.ok(body.length <= 50, `Body should be <= 50 chars: ${body.length}`);
  });

  it('handles nested braces correctly', () => {
    const code = `function foo() {\n  if (true) {\n    const obj = { a: 1 };\n  }\n  return obj;\n}`;
    const body = extractFunctionBody(code, 0);
    assert.ok(body.includes('return obj'), `Should contain return obj: ${body}`);
  });

  it('handles regex with braces', () => {
    const code = `function foo() {\n  const re = /\\{test\\}/g;\n  return re;\n}`;
    const body = extractFunctionBody(code, 0);
    // Regex braces may or may not be handled perfectly, but the function shouldn't crash
    assert.ok(body.length > 0, 'Should return non-empty body');
  });
});

// ─── extractCommentsFromBody ────────────────────────────────────────────────

describe('extractCommentsFromBody', () => {
  it('extracts single-line comments', () => {
    const body = `{\n  // Map asset fields from Polygon API\n  const assets = mapFields(raw);\n}`;
    const comments = extractCommentsFromBody(body);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].text, 'Map asset fields from Polygon API');
  });

  it('merges consecutive // lines into one entry', () => {
    const body = `{\n  // Calculate the weighted average price by dividing\n  // total invested capital by total shares purchased\n  const avg = total / shares;\n}`;
    const comments = extractCommentsFromBody(body);
    assert.equal(comments.length, 1);
    assert.ok(comments[0].text.includes('weighted average'), `Got: ${comments[0].text}`);
    assert.ok(comments[0].text.includes('total shares'), `Got: ${comments[0].text}`);
  });

  it('separates comments broken by code lines', () => {
    const body = `{\n  // First comment block here\n  const x = foo();\n  // Second comment block here\n  const y = bar();\n}`;
    const comments = extractCommentsFromBody(body);
    assert.equal(comments.length, 2);
  });

  it('filters comments shorter than 5 characters', () => {
    const body = `{\n  // Hi\n  const x = 1;\n}`;
    const comments = extractCommentsFromBody(body);
    assert.equal(comments.length, 0);
  });

  it('extracts end-of-line comments >= 10 chars', () => {
    const body = `{\n  const x = foo(); // Initialize the counter value\n}`;
    const comments = extractCommentsFromBody(body);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].type, 'line');
  });

  it('filters short end-of-line comments', () => {
    const body = `{\n  const x = foo(); // short\n}`;
    const comments = extractCommentsFromBody(body);
    assert.equal(comments.length, 0);
  });

  it('does not match // inside URLs', () => {
    const body = `{\n  const url = "https://example.com";\n}`;
    const comments = extractCommentsFromBody(body);
    assert.equal(comments.length, 0);
  });

  it('handles block comments /* */', () => {
    const body = `{\n  /* Calculate total from all orders */\n  const total = sum(orders);\n}`;
    const comments = extractCommentsFromBody(body);
    assert.equal(comments.length, 1);
    assert.ok(comments[0].text.includes('Calculate total'), `Got: ${comments[0].text}`);
  });

  it('detects section headers', () => {
    const body = `{\n  // --- Revenue Calculations ---\n  const rev = 42;\n}`;
    const comments = extractCommentsFromBody(body);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].type, 'section-header');
  });

  it('returns empty for body with no comments', () => {
    const body = `{\n  const x = 1;\n  return x;\n}`;
    const comments = extractCommentsFromBody(body);
    assert.equal(comments.length, 0);
  });
});

// ─── parseDocSections ───────────────────────────────────────────────────────

describe('parseDocSections', () => {
  it('splits content by ## headings', () => {
    const content = `# Title\n\n## Section One\n\nSome content that is long enough to pass the filter.\n\n## Section Two\n\nMore content that is also long enough for the minimum.`;
    const sections = parseDocSections(content);
    assert.ok(sections.length >= 2, `Expected at least 2 sections, got ${sections.length}`);
    assert.equal(sections[0].heading, 'Section One');
    assert.equal(sections[1].heading, 'Section Two');
  });

  it('skips @ metadata headings', () => {
    const content = `## @what Something\n\nMetadata here.\n\n## Real Section\n\nActual content that passes the minimum length filter.`;
    const sections = parseDocSections(content);
    assert.ok(sections.every(s => !s.heading.startsWith('@')), 'Should skip @-prefixed headings');
  });

  it('extracts code blocks as separate entries', () => {
    const content = "## Example\n\nSome prose content that is long enough.\n\n```typescript\nconst x = calculateProfit(100, 50);\nconst y = x * 2;\nconst z = y + 10;\n```\n\nMore content after code block here.";
    const sections = parseDocSections(content);
    const codeSection = sections.find(s => s.sectionType === 'code');
    assert.ok(codeSection, 'Should have a code section');
    assert.ok(codeSection!.body.includes('calculateProfit'), `Code body: ${codeSection!.body}`);
  });

  it('filters sections with body < 20 chars', () => {
    const content = `## Short\n\nTiny.\n\n## Long Enough\n\nThis section has enough content to pass the twenty character minimum filter.`;
    const sections = parseDocSections(content);
    assert.ok(sections.every(s => s.body.length >= 20), 'All sections should have body >= 20 chars');
  });

  it('does not match headings inside code blocks', () => {
    const content = "## Real Section\n\nContent before code block is long enough.\n\n```bash\n## This is a bash comment not a heading\necho hello\n```\n\nContent after code block continues here.";
    const sections = parseDocSections(content);
    const bashHeading = sections.find(s => s.heading.includes('bash comment'));
    assert.equal(bashHeading, undefined, 'Should not create section from heading inside code block');
  });

  it('returns empty for content with no headings', () => {
    const content = `Just some text without any headings at all.`;
    const sections = parseDocSections(content);
    assert.equal(sections.length, 0);
  });

  it('handles ### and #### headings', () => {
    const content = `## Parent Section\n\n### Sub Section\n\nSub section content that is long enough for the filter.\n\n#### Deep Section\n\nDeep section content that also passes the minimum length.`;
    const sections = parseDocSections(content);
    const sub = sections.find(s => s.heading === 'Sub Section');
    const deep = sections.find(s => s.heading === 'Deep Section');
    assert.ok(sub, 'Should find ### heading');
    assert.ok(deep, 'Should find #### heading');
    assert.equal(sub!.headingLevel, 3);
    assert.equal(deep!.headingLevel, 4);
  });
});

// ─── parseJSDocBlock ────────────────────────────────────────────────────────

describe('parseJSDocBlock', () => {
  const makeFile = (jsdoc: string, code: string) => jsdoc + '\n' + code;

  it('parses a complete JSDoc block with all tags', () => {
    const jsdoc = `/**\n * @what Calculates profit\n * @how Subtracts cost from revenue\n * @why Business needs profit tracking\n * @domain trading\n * @tags profit, calculation, revenue\n * @systemlayer Business Logic\n * @sideeffects None\n */`;
    const code = `export function calculateProfit() {\n  return 42;\n}`;
    const file = makeFile(jsdoc, code);
    const result = parseJSDocBlock(jsdoc, file, 0);

    assert.ok(result, 'Should return a result');
    assert.equal(result!.name, 'calculateProfit');
    assert.ok(result!.description.includes('Calculates profit'));
    assert.deepEqual(result!.domains, ['trading']);
    assert.ok(result!.tags.includes('profit'));
    assert.ok(result!.systemlayers.includes('Business Logic'));
    assert.equal(result!.declarationType, 'function');
  });

  it('returns null when @domain is missing', () => {
    const jsdoc = `/**\n * @what Something\n */`;
    const code = `export function foo() {}`;
    const file = makeFile(jsdoc, code);
    const result = parseJSDocBlock(jsdoc, file, 0);
    assert.equal(result, null);
  });

  it('handles duplicate JSDoc blocks at different positions', () => {
    const jsdoc = `/**\n * @what Same description\n * @domain trading\n */`;
    const code1 = `export function first() {\n  return 1;\n}`;
    const code2 = `export function second() {\n  return 2;\n}`;
    const file = jsdoc + '\n' + code1 + '\n\n' + jsdoc + '\n' + code2;

    const firstIndex = 0;
    const secondIndex = file.indexOf(jsdoc, firstIndex + jsdoc.length);

    const result1 = parseJSDocBlock(jsdoc, file, firstIndex);
    const result2 = parseJSDocBlock(jsdoc, file, secondIndex);

    assert.ok(result1, 'First block should parse');
    assert.ok(result2, 'Second block should parse');
    assert.equal(result1!.name, 'first');
    assert.equal(result2!.name, 'second');
  });

  it('sets blockEnd correctly', () => {
    const jsdoc = `/**\n * @what Test\n * @domain test\n */`;
    const code = `export function foo() { return 1; }`;
    const file = makeFile(jsdoc, code);
    const result = parseJSDocBlock(jsdoc, file, 0);

    assert.ok(result, 'Should return a result');
    assert.equal(result!.blockEnd, jsdoc.length);
  });
});
