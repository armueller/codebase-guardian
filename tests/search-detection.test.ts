import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifySearch } from '../src/hooks/helpers/search-detection.js';

const bash = (command: string) => classifySearch('Bash', { command });

describe('classifySearch — tools', () => {
  it('maps Grep and Glob to grep-search', () => {
    assert.equal(classifySearch('Grep', { pattern: 'foo' }), 'grep-search');
    assert.equal(classifySearch('Glob', { pattern: '**/*.ts' }), 'grep-search');
  });

  it('maps the guardian semantic-search MCP tools to semantic', () => {
    assert.equal(classifySearch('mcp__codebase-guardian__search', { query: 'x' }), 'semantic');
    assert.equal(classifySearch('mcp__codebase-guardian__search_comments', { query: 'x' }), 'semantic');
    assert.equal(classifySearch('mcp__codebase-guardian__search_doc_sections', { query: 'x' }), 'semantic');
  });

  it('maps unrelated tools to none', () => {
    assert.equal(classifySearch('Edit', { file_path: 'x.ts' }), 'none');
    assert.equal(classifySearch('Read', { file_path: 'x.ts' }), 'none');
  });
});

describe('classifySearch — Bash codebase searches (grep-search)', () => {
  it('recognizes recursive-by-default tools', () => {
    for (const c of ['rg foo', 'rg -n TODO src/', 'ag pattern', 'ack thing', 'fd config', 'ug foo', 'rga foo']) {
      assert.equal(bash(c), 'grep-search', c);
    }
  });
  it('recognizes git grep', () => {
    assert.equal(bash('git grep foo'), 'grep-search');
  });
  it('recognizes recursive grep and grep over a dir/glob', () => {
    for (const c of ['grep -r foo .', 'grep -rn foo src/', 'grep -R foo lib', 'grep foo src/', 'grep foo "src/**"']) {
      assert.equal(bash(c), 'grep-search', c);
    }
  });
  it('recognizes find by name/path', () => {
    for (const c of ["find . -name '*.ts'", 'find src -iname foo', 'find . -path "*/helpers/*"']) {
      assert.equal(bash(c), 'grep-search', c);
    }
  });
  it('sees through command wrappers and env assignments', () => {
    assert.equal(bash('sudo rg foo src/'), 'grep-search');
    assert.equal(bash('FOO=1 grep -r x src'), 'grep-search');
  });
  it('nudges when a leading stage is a search even if later stages filter', () => {
    assert.equal(bash('rg foo | grep bar'), 'grep-search');
    assert.equal(bash('grep -r foo src/ | wc -l'), 'grep-search');
  });
});

describe('classifySearch — Bash non-searches (none)', () => {
  it('skips piped grep filters', () => {
    assert.equal(bash('ps aux | grep node'), 'none');
    assert.equal(bash('cat file.ts | grep foo'), 'none');
    assert.equal(bash('history | grep git'), 'none');
  });
  it('skips single-file grep (reading a known file)', () => {
    assert.equal(bash('grep foo package.json'), 'none');
    assert.equal(bash('grep TODO src/index.ts'), 'none');
  });
  it('skips non-search find, including a name predicate combined with an action', () => {
    assert.equal(bash('find . -type f -delete'), 'none');
    assert.equal(bash('find build -type d'), 'none');
    assert.equal(bash("find . -name '*.tmp' -delete"), 'none');
    assert.equal(bash("find . -name '*.log' -exec rm {} +"), 'none');
  });
  it('skips unrelated commands', () => {
    for (const c of ['echo hi', 'ls -R', 'npm test', 'cat foo.ts', 'git status']) {
      assert.equal(bash(c), 'none', c);
    }
  });
  it('handles empty / missing command', () => {
    assert.equal(bash(''), 'none');
    assert.equal(classifySearch('Bash', {}), 'none');
  });
});
