import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runPyTools,
  findNearestPyproject,
} from '../src/hooks/helpers/py-tools.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RUFF_UNUSED_IMPORT = `import os
import sys


def foo():
    return 2
`;

const RUFF_CLEAN = `"""A clean module."""


def foo() -> int:
    """Return two.

    Returns:
        int: Always 2.
    """
    return 2
`;

// Docstring lists a param ("c") that isn't in the signature — pydoclint DOC103.
// Long enough (has Args + Returns sections) to survive --skip-checking-short-docstrings.
const PYDOCLINT_MISMATCH = `def foo(a: int, b: int) -> int:
    """Add two numbers together and return the result value here.

    Args:
        a: The first number.
        b: The second number.
        c: A parameter that does not exist in the signature.

    Returns:
        int: The sum.
    """
    return a + b
`;

const tmpFilesRoot = mkdtempSync(path.join(tmpdir(), 'guardian-py-tools-test-'));
after(() => {
  try {
    rmSync(tmpFilesRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

const fakeFilePath = path.join(tmpFilesRoot, 'edit.py');

describe('runPyTools', () => {
  it('finds a ruff lint issue with a code and line', () => {
    const result = runPyTools(fakeFilePath, RUFF_UNUSED_IMPORT);

    assert.ok(result.ruff.length > 0, 'expected ruff findings for unused imports');
    const first = result.ruff[0];
    assert.equal(first.tool, 'ruff');
    assert.equal(typeof first.code, 'string');
    assert.ok(first.code.length > 0);
    assert.equal(typeof first.line, 'number');
    assert.ok(first.line !== null && first.line > 0);
  });

  it('returns no ruff findings for clean content', () => {
    const result = runPyTools(fakeFilePath, RUFF_CLEAN);

    assert.deepEqual(result.ruff, []);
  });

  it('finds a pydoclint doc mismatch (extra Args entry not in signature)', () => {
    const result = runPyTools(fakeFilePath, PYDOCLINT_MISMATCH);

    assert.ok(result.pydoclint.length > 0, 'expected pydoclint findings for docstring/signature mismatch');
    const first = result.pydoclint[0];
    assert.equal(first.tool, 'pydoclint');
    assert.match(first.code, /^DOC\d+$/);
    assert.equal(typeof first.message, 'string');
    assert.ok(first.message.length > 0);
  });

  it('fails open with empty results when GUARDIAN_HOME points at a nonexistent dir', () => {
    const original = process.env.GUARDIAN_HOME;
    process.env.GUARDIAN_HOME = '/tmp/guardian-home-does-not-exist-xyz-py-tools';

    try {
      const result = runPyTools(fakeFilePath, RUFF_UNUSED_IMPORT);
      assert.deepEqual(result.ruff, []);
      assert.deepEqual(result.pydoclint, []);
    } finally {
      if (original === undefined) {
        delete process.env.GUARDIAN_HOME;
      } else {
        process.env.GUARDIAN_HOME = original;
      }
    }
  });
});

describe('findNearestPyproject', () => {
  it('finds pyproject.toml from a nested path', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'guardian-pyproject-test-'));
    try {
      const pyprojectPath = path.join(root, 'pyproject.toml');
      writeFileSync(pyprojectPath, '[tool.ruff]\n', 'utf-8');

      const nestedDir = path.join(root, 'src', 'pkg', 'sub');
      mkdirSync(nestedDir, { recursive: true });
      const nestedFile = path.join(nestedDir, 'mod.py');

      const found = findNearestPyproject(nestedFile);
      assert.equal(found, pyprojectPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when no pyproject.toml exists up the tree', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'guardian-pyproject-none-test-'));
    try {
      const nestedDir = path.join(root, 'a', 'b');
      mkdirSync(nestedDir, { recursive: true });
      const nestedFile = path.join(nestedDir, 'mod.py');

      const found = findNearestPyproject(nestedFile);
      assert.equal(found, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
