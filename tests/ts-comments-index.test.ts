import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase, searchCommentsByFTS } from '../src/mcp-server/db.js';
import { buildIndex, bodyRangeAfter, parseJSDocBlock } from '../src/mcp-server/indexer.js';
import { locateBodies, maskRanges } from '../src/mcp-server/ts-bodies.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ts-comments');
const FIXTURE = path.join(FIXTURE_DIR, 'editor.tsx');
const content = fs.readFileSync(FIXTURE, 'utf8');

/**
 * The body text the indexer locates for the declaration documented by the
 * JSDoc block that comes just before `marker`.
 * @param marker - text at the start of the declaration, e.g. 'export function pick'
 * @returns the body text, or undefined when none was found
 */
function bodyFor(marker: string): string | undefined {
  const declStart = content.indexOf(marker);
  assert.ok(declStart > 0, `marker not in fixture: ${marker}`);
  const blockEnd = content.lastIndexOf('*/', declStart) + 2;
  const range = bodyRangeAfter(content, locateBodies(content, FIXTURE), blockEnd);
  return range && content.slice(range.start, range.end);
}

describe('locateBodies', () => {
  it('skips a destructured parameter with an inline object type', () => {
    assert.match(bodyFor('export function shouldFocusContentsOnClick')!, /^\{\n {2}\/\/ Empty image wells/);
  });

  it('finds the function inside observer(...)', () => {
    assert.match(bodyFor('const Editor = observer')!, /^\{\n {2}\/\/ Swallow accidental/);
  });

  it('skips an object constraint on a type parameter', () => {
    assert.match(bodyFor('export function pick')!, /^\{\n {2}\/\/ Pick the first item/);
  });

  it("starts an expression-bodied arrow right after `=>`, keeping its leading comment", () => {
    assert.match(bodyFor('export const double')!, /\/\/ Double the input value/);
  });

  it('finds the function in export default observer(...)', () => {
    assert.match(bodyFor('export default observer(function Drawer')!, /^\{\n {2}\/\/ Render nothing/);
  });

  it('finds nested documented functions and class methods', () => {
    assert.match(bodyFor('const goToNode')!, /\/\/ Scroll the node into view/);
    assert.match(bodyFor('add(item: T)')!, /\/\/ Keep insertion order/);
  });

  it('returns nothing for an interface, so the indexer falls back to the text scan', () => {
    assert.equal(bodyFor('interface EditorProps'), undefined);
  });

  it('returns an empty map for text the parser cannot read, without throwing', () => {
    assert.doesNotThrow(() => locateBodies('function (', 'broken.ts'));
  });
});

describe('maskRanges', () => {
  it('blanks the ranges but keeps every newline', () => {
    const body = '{\n  a // keep\n  b // drop\n}';
    const start = 100;
    const dropAt = body.indexOf('b');
    const masked = maskRanges(body, start, [{ start: start + dropAt, end: start + body.indexOf('\n}') }]);
    assert.equal(masked.split('\n').length, body.split('\n').length);
    assert.ok(masked.includes('// keep') && !masked.includes('drop'), masked);
  });
});

describe('parseJSDocBlock with a located body', () => {
  it('uses the located body for the embedding text instead of the parameter list', () => {
    const declStart = content.indexOf('export function shouldFocusContentsOnClick');
    const blockStart = content.lastIndexOf('/**', declStart);
    const blockEnd = content.lastIndexOf('*/', declStart) + 2;
    const range = bodyRangeAfter(content, locateBodies(content, FIXTURE), blockEnd);
    const parsed = parseJSDocBlock(content.slice(blockStart, blockEnd), content, blockStart, range);
    assert.match(parsed!.body, /Empty image wells/);
  });
});

describe('buildIndex — inline comments in TSX', () => {
  let db: ReturnType<typeof openDatabase>;
  const originalProjectRoot = process.env.GUARDIAN_PROJECT_ROOT;

  before(async () => {
    process.env.GUARDIAN_PROJECT_ROOT = FIXTURE_DIR;
    db = openDatabase(':memory:');
    await buildIndex(db, FIXTURE_DIR);
  });

  after(() => {
    if (originalProjectRoot === undefined) delete process.env.GUARDIAN_PROJECT_ROOT;
    else process.env.GUARDIAN_PROJECT_ROOT = originalProjectRoot;
  });

  /**
   * Comment texts indexed under one function.
   * @param name - the function's indexed name
   * @returns its comments, in body order
   */
  const commentsOf = (name: string): string[] =>
    (db.prepare(`SELECT c.comment_text FROM function_comments c JOIN functions f ON f.id = c.function_id
      WHERE f.name = ? ORDER BY c.line_offset`).all(name) as { comment_text: string }[]).map(r => r.comment_text);

  it('indexes the comment in a function with a destructured parameter', () => {
    assert.deepEqual(commentsOf('shouldFocusContentsOnClick'),
      ['Empty image wells never enter CONTENTS_FOCUSED, there is nothing to edit yet']);
  });

  it("indexes an observer component's own comments, its undocumented callbacks', and merged // blocks", () => {
    const editor = commentsOf('Editor');
    assert.ok(editor.includes("Swallow accidental OS-file drops so the browser doesn't navigate the tab"), editor.join(' | '));
    assert.ok(editor.includes('Prefer explicit selection when present'), editor.join(' | '));
    assert.ok(editor.includes('The controls target the SMALLEST slot enclosing the selection: the selected focus area if there is one, otherwise the whole page.'), editor.join(' | '));
  });

  it('indexes each comment once, under the innermost documented function', () => {
    assert.deepEqual(commentsOf('goToNode'), ['Scroll the node into view before selecting it']);
    assert.deepEqual(commentsOf('onDrop'), ['Stop the browser from opening the dropped file']);
    const editor = commentsOf('Editor').join(' | ');
    assert.doesNotMatch(editor, /Scroll the node|Stop the browser|@what/);
  });

  it("credits a documented method's comments to its class, since methods get no row of their own", () => {
    assert.deepEqual(commentsOf('add'), []);
    assert.deepEqual(commentsOf('Store'), [
      'Items are only ever appended, never reordered',
      'Keep insertion order so the drawer lists items as they were added',
    ]);
  });

  it('indexes comments behind a generic constraint and in an expression-bodied arrow', () => {
    assert.deepEqual(commentsOf('pick'), ['Pick the first item that has an id']);
    assert.deepEqual(commentsOf('double'), ['Double the input value for display']);
  });

  it('still indexes a plain signature', () => {
    assert.deepEqual(commentsOf('buildContext'),
      ['Try semantic search first for better conceptual matching, fall back to FTS if embeddings are unavailable.']);
  });

  it('finds the comments through the search_comments query', () => {
    for (const [query, owner] of [
      ['swallow accidental OS file drops', 'Editor'],
      ['empty image wells never enter', 'shouldFocusContentsOnClick'],
      ['smallest slot enclosing the selection', 'Editor'],
      ['prefer explicit selection', 'Editor'],
    ] as const) {
      const hits = searchCommentsByFTS(db, query, 3);
      assert.equal(hits[0]?.function.name, owner, `${query} → ${hits.map(h => h.function.name).join(', ')}`);
    }
  });
});
