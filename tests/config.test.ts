import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reloadConfig, resolveConfig, DEFAULT_EXCLUDE } from '../src/config.js';

/** Creates an empty temp project root. */
function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'guardian-config-'));
}

/** Writes a file under root, creating parent folders. */
function put(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe('tsconfig resolution', () => {
  it('uses the configured tsconfig when the file exists', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ tsconfig: 'web/tsconfig.json' }));
    put(root, 'web/tsconfig.json', '{}');
    assert.deepEqual(reloadConfig(root).tsconfig, { kind: 'file', path: path.join(root, 'web/tsconfig.json') });
  });

  it('is invalid, with no fallback, when the configured tsconfig is missing', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ tsconfig: 'web/tsconfig.json' }));
    put(root, 'tsconfig.json', '{}'); // a root tsconfig must NOT be used as a fallback
    assert.deepEqual(reloadConfig(root).tsconfig, {
      kind: 'invalid',
      reason: 'tsconfig "web/tsconfig.json" from guardian.config.json does not exist',
    });
  });

  it('uses the root tsconfig.json when the field is not set', () => {
    const root = makeRoot();
    put(root, 'tsconfig.json', '{}');
    assert.deepEqual(reloadConfig(root).tsconfig, { kind: 'file', path: path.join(root, 'tsconfig.json') });
  });

  it('is none when the field is not set and there is no root tsconfig', () => {
    assert.deepEqual(reloadConfig(makeRoot()).tsconfig, { kind: 'none' });
  });

  for (const bad of [5, [], '']) {
    it(`is invalid when the field is ${JSON.stringify(bad)}`, () => {
      const root = makeRoot();
      put(root, 'guardian.config.json', JSON.stringify({ tsconfig: bad }));
      put(root, 'tsconfig.json', '{}');
      const resolved = reloadConfig(root).tsconfig;
      assert.equal(resolved.kind, 'invalid');
      assert.match((resolved as { reason: string }).reason, /must be a non-empty string/);
    });
  }
});

describe('config file errors', () => {
  it('reports an unparseable guardian.config.json and falls back to auto-detection', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', '{ not json');
    const config = reloadConfig(root);
    assert.equal(typeof config.configFileError, 'string');
    assert.ok(config.configFileError!.length > 0);
    assert.deepEqual(config.sourceDirectories, ['.']);
  });

  it('has no error when the config file is absent or valid', () => {
    assert.equal(reloadConfig(makeRoot()).configFileError, null);
    const root = makeRoot();
    put(root, 'guardian.config.json', '{}');
    assert.equal(reloadConfig(root).configFileError, null);
  });
});

describe('config field validation', () => {
  for (const [field, bad] of [
    ['excludeDirectories', [5]],
    ['excludeDirectories', 'node_modules'],
    ['sourceDirectories', 'src'],
    ['docsDirectories', { a: 1 }],
    ['fileExtensions', ['.ts', 7]],
  ] as const) {
    it(`ignores ${field} = ${JSON.stringify(bad)} with a warning, and uses the default`, () => {
      const root = makeRoot();
      put(root, 'guardian.config.json', JSON.stringify({ [field]: bad }));
      const config = reloadConfig(root);
      const fresh = reloadConfig(makeRoot());

      assert.deepEqual(config[field], fresh[field]);
      assert.deepEqual(config.configWarnings, [
        `"${field}" in guardian.config.json must be a list of strings; the default was used`,
      ]);
      assert.equal(config.configFileError, null);
    });
  }

  it('has no warnings for a valid config', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ excludeDirectories: ['x'], sourceDirectories: ['.'] }));
    const config = reloadConfig(root);
    assert.deepEqual(config.configWarnings, []);
    assert.deepEqual(config.excludeDirectories, [...DEFAULT_EXCLUDE, 'x']);
  });

  for (const rootValue of ['[]', 'null', '"text"', '5']) {
    it(`reports a config file whose root is ${rootValue}`, () => {
      const root = makeRoot();
      put(root, 'guardian.config.json', rootValue);
      const config = reloadConfig(root);
      assert.equal(config.configFileError, 'the file must contain a JSON object');
      assert.deepEqual(config.sourceDirectories, ['.']);
    });
  }
});

describe('reloadConfig', () => {
  it('sees a guardian.config.json written after the first resolve, and refreshes the cache', () => {
    const root = makeRoot();
    assert.deepEqual(reloadConfig(root).sourceDirectories, ['.']);

    put(root, 'guardian.config.json', JSON.stringify({ sourceDirectories: ['lib'] }));
    assert.deepEqual(reloadConfig(root).sourceDirectories, ['lib']);

    const original = process.env.GUARDIAN_PROJECT_ROOT;
    process.env.GUARDIAN_PROJECT_ROOT = root;
    try {
      assert.deepEqual(resolveConfig(root).sourceDirectories, ['lib']);
    } finally {
      if (original === undefined) delete process.env.GUARDIAN_PROJECT_ROOT;
      else process.env.GUARDIAN_PROJECT_ROOT = original;
    }
  });

  it('keeps the cache for resolveConfig: a file written without a reload is not seen', () => {
    const root = makeRoot();
    const original = process.env.GUARDIAN_PROJECT_ROOT;
    process.env.GUARDIAN_PROJECT_ROOT = root;
    try {
      assert.deepEqual(resolveConfig(root).sourceDirectories, ['.']);
      put(root, 'guardian.config.json', JSON.stringify({ sourceDirectories: ['lib'] }));
      assert.deepEqual(resolveConfig(root).sourceDirectories, ['.']);
    } finally {
      if (original === undefined) delete process.env.GUARDIAN_PROJECT_ROOT;
      else process.env.GUARDIAN_PROJECT_ROOT = original;
    }
  });
});

describe('excludeDirectories from guardian.config.json', () => {
  it('adds to the default list; the defaults always apply', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ excludeDirectories: ['web/data', 'generated'] }));
    assert.deepEqual(reloadConfig(root).excludeDirectories, [...DEFAULT_EXCLUDE, 'web/data', 'generated']);
  });

  it('does not repeat an entry that is already a default or listed twice', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({
      excludeDirectories: ['node_modules', 'web/data', '.venv', 'web/data'],
    }));
    assert.deepEqual(reloadConfig(root).excludeDirectories, [...DEFAULT_EXCLUDE, 'web/data']);
  });

  it('an empty list leaves the defaults in place', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ excludeDirectories: [] }));
    assert.deepEqual(reloadConfig(root).excludeDirectories, DEFAULT_EXCLUDE);
  });
});

describe('excludeDirectories default', () => {
  it('is the 15-entry walker list', () => {
    assert.deepEqual(reloadConfig(makeRoot()).excludeDirectories, DEFAULT_EXCLUDE);
    assert.equal(DEFAULT_EXCLUDE.length, 15);
    for (const name of ['node_modules', 'build', '.venv', '__pycache__', 'site-packages', '.ruff_cache']) {
      assert.ok(DEFAULT_EXCLUDE.includes(name), `${name} should be excluded by default`);
    }
  });
});

describe('source directory auto-detection', () => {
  it('reads include from a sub-folder tsconfig, relative to that folder', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ tsconfig: 'web/tsconfig.json' }));
    put(root, 'web/tsconfig.json', JSON.stringify({ include: ['src/**/*'] }));
    mkdirSync(path.join(root, 'web/src'), { recursive: true });
    assert.deepEqual(reloadConfig(root).sourceDirectories, ['web/src']);
  });

  it('falls back to the common folder names under the tsconfig folder', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ tsconfig: 'web/tsconfig.json' }));
    put(root, 'web/tsconfig.json', JSON.stringify({ include: ['**/*'] }));
    mkdirSync(path.join(root, 'web/app'), { recursive: true });
    assert.deepEqual(reloadConfig(root).sourceDirectories, ['web/app']);
  });

  it('falls back to the tsconfig folder itself when nothing else matches', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ tsconfig: 'web/tsconfig.json' }));
    put(root, 'web/tsconfig.json', JSON.stringify({ include: ['**/*'] }));
    assert.deepEqual(reloadConfig(root).sourceDirectories, ['web']);
  });

  it('is unchanged for a root tsconfig', () => {
    const root = makeRoot();
    put(root, 'tsconfig.json', JSON.stringify({ include: ['src/**/*', 'app/**/*'] }));
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'app'));
    assert.deepEqual(reloadConfig(root).sourceDirectories, ['src', 'app']);
  });
});
