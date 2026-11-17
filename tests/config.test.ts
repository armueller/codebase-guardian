import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reloadConfig, resolveConfig, configProblems, DEFAULT_EXCLUDE } from '../src/config.js';
import { parseJsonc } from '../src/tsconfig-resolution.js';

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
        `"${field}" in guardian.config.json must be a list of strings`,
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

describe('tsconfig resolution: paths that must be rejected or normalised', () => {
  it('treats null as not set', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ tsconfig: null }));
    put(root, 'tsconfig.json', '{}');
    assert.deepEqual(reloadConfig(root).tsconfig, { kind: 'file', path: path.join(root, 'tsconfig.json') });
  });

  it('trims surrounding whitespace from the configured path', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ tsconfig: ' web/tsconfig.json ' }));
    put(root, 'web/tsconfig.json', '{}');
    assert.deepEqual(reloadConfig(root).tsconfig, { kind: 'file', path: path.join(root, 'web/tsconfig.json') });
  });

  it('rejects a folder', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ tsconfig: 'web' }));
    mkdirSync(path.join(root, 'web'));
    assert.deepEqual(reloadConfig(root).tsconfig, {
      kind: 'invalid',
      reason: 'tsconfig "web" from guardian.config.json is a folder, not a file',
    });
  });

  for (const outside of ['.', '..', '../other/tsconfig.json', '/etc/hosts']) {
    it(`rejects ${JSON.stringify(outside)}, and never detects source directories outside the root`, () => {
      const root = makeRoot();
      put(root, 'guardian.config.json', JSON.stringify({ tsconfig: outside }));
      const config = reloadConfig(root);
      assert.equal(config.tsconfig.kind, 'invalid');
      for (const dir of config.sourceDirectories) {
        assert.ok(!dir.startsWith('..') && !path.isAbsolute(dir), `source directory ${dir} escapes the root`);
      }
    });
  }

  it('names the reason for a path outside the project root', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ tsconfig: '../other/tsconfig.json' }));
    assert.deepEqual(reloadConfig(root).tsconfig, {
      kind: 'invalid',
      reason: 'tsconfig "../other/tsconfig.json" from guardian.config.json is outside the project root',
    });
  });

  it('does not treat a folder named tsconfig.json at the root as a tsconfig', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, 'tsconfig.json'));
    assert.deepEqual(reloadConfig(root).tsconfig, { kind: 'none' });
  });
});

describe('source directory auto-detection: include entries that are not folders', () => {
  it('ignores an include entry that names a file', () => {
    const root = makeRoot();
    put(root, 'tsconfig.json', JSON.stringify({ include: ['src', 'vite.config.ts'] }));
    put(root, 'vite.config.ts', '');
    mkdirSync(path.join(root, 'src'));
    assert.deepEqual(reloadConfig(root).sourceDirectories, ['src']);
  });

  it('handles the create-next-app default include, at the root and in a sub-folder', () => {
    const include = ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'];
    const rootApp = makeRoot();
    put(rootApp, 'tsconfig.json', JSON.stringify({ include }));
    put(rootApp, 'next-env.d.ts', '');
    mkdirSync(path.join(rootApp, 'app'));
    assert.deepEqual(reloadConfig(rootApp).sourceDirectories, ['app']);

    const subApp = makeRoot();
    put(subApp, 'guardian.config.json', JSON.stringify({ tsconfig: 'web/tsconfig.json' }));
    put(subApp, 'web/tsconfig.json', JSON.stringify({ include }));
    put(subApp, 'web/next-env.d.ts', '');
    mkdirSync(path.join(subApp, 'web/app'), { recursive: true });
    assert.deepEqual(reloadConfig(subApp).sourceDirectories, ['web/app']);
  });

  it('reads include from a tsconfig with comments and trailing commas', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ tsconfig: 'web/tsconfig.json' }));
    put(root, 'web/tsconfig.json', '{\n  // what tsc --init writes\n  "include": ["source/**/*",], /* block */\n}\n');
    mkdirSync(path.join(root, 'web/source'), { recursive: true });
    mkdirSync(path.join(root, 'web/other'), { recursive: true });
    assert.deepEqual(reloadConfig(root).sourceDirectories, ['web/source']);
  });

  it('accepts include patterns written with a leading ./', () => {
    const root = makeRoot();
    put(root, 'tsconfig.json', JSON.stringify({ include: ['./source/**/*'] }));
    mkdirSync(path.join(root, 'source'));
    assert.deepEqual(reloadConfig(root).sourceDirectories, ['source']);
  });
});

describe('parseJsonc', () => {
  it('ignores comments and trailing commas but not their look-alikes inside strings', () => {
    assert.deepEqual(
      parseJsonc('{ "a": "http://x/*y*/", // c\n "b": [1, 2,], /* d */ "c": "k,]" ,}'),
      { a: 'http://x/*y*/', b: [1, 2], c: 'k,]' },
    );
  });

  it('throws on text that is not JSON', () => {
    assert.throws(() => parseJsonc('{ not json'));
  });
});

describe('config validation beyond the list fields', () => {
  it('trims exclude entries and rejects one that uses a glob pattern', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ excludeDirectories: [' generated ', '**/tmp', 'web/data/**', ''] }));
    const config = reloadConfig(root);
    assert.deepEqual(config.excludeDirectories, [...DEFAULT_EXCLUDE, 'generated']);
    assert.deepEqual(config.configWarnings, [
      '"excludeDirectories" entry "**/tmp" in guardian.config.json uses a glob pattern, which is not supported; use a folder name or a path from the project root',
      '"excludeDirectories" entry "web/data/**" in guardian.config.json uses a glob pattern, which is not supported; use a folder name or a path from the project root',
    ]);
  });

  it('rejects file extensions without a leading dot and uses the default list', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ fileExtensions: ['ts', '.tsx'] }));
    const config = reloadConfig(root);
    assert.deepEqual(config.fileExtensions, reloadConfig(makeRoot()).fileExtensions);
    assert.deepEqual(config.configWarnings, [
      '"fileExtensions" entry "ts" in guardian.config.json must start with a dot',
    ]);
  });

  it('validates the jsdoc and searchHint settings the hook reads', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({
      jsdoc: { requiredTags: 'what', minTags: '3', minCommentLength: -1 },
      searchHint: { enabled: 'yes', rearmAfter: null, stalenessThreshold: 20 },
    }));
    const config = reloadConfig(root);
    const defaults = reloadConfig(makeRoot());

    assert.deepEqual(config.jsdoc, defaults.jsdoc);
    assert.equal(config.searchHint.enabled, defaults.searchHint.enabled);
    assert.equal(config.searchHint.rearmAfter, defaults.searchHint.rearmAfter);
    assert.equal(config.searchHint.stalenessThreshold, 20);
    assert.deepEqual(config.configWarnings, [
      '"jsdoc.requiredTags" in guardian.config.json must be a list of strings',
      '"jsdoc.minTags" in guardian.config.json must be a number that is zero or more',
      '"jsdoc.minCommentLength" in guardian.config.json must be a number that is zero or more',
      '"searchHint.enabled" in guardian.config.json must be true or false',
      '"searchHint.rearmAfter" in guardian.config.json must be a number that is zero or more',
    ]);
  });

  it('reports a jsdoc or searchHint value that is not an object', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ jsdoc: [], searchHint: 'on' }));
    const config = reloadConfig(root);
    assert.deepEqual(config.jsdoc, reloadConfig(makeRoot()).jsdoc);
    assert.deepEqual(config.configWarnings, [
      '"jsdoc" in guardian.config.json must be an object',
      '"searchHint" in guardian.config.json must be an object',
    ]);
  });
});

describe('configProblems', () => {
  it('is empty for a healthy config', () => {
    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ sourceDirectories: ['.'] }));
    assert.deepEqual(configProblems(reloadConfig(root)), []);
    assert.deepEqual(configProblems(reloadConfig(makeRoot())), []);
  });

  it('lists an unusable config file, ignored fields and an invalid tsconfig', () => {
    const broken = makeRoot();
    put(broken, 'guardian.config.json', '{ not json');
    const brokenProblems = configProblems(reloadConfig(broken));
    assert.equal(brokenProblems.length, 1);
    assert.match(brokenProblems[0], /^guardian\.config\.json could not be used: /);

    const root = makeRoot();
    put(root, 'guardian.config.json', JSON.stringify({ sourceDirectories: 'src', tsconfig: 'nope.json' }));
    assert.deepEqual(configProblems(reloadConfig(root)), [
      '"sourceDirectories" in guardian.config.json must be a list of strings',
      'tsconfig "nope.json" from guardian.config.json does not exist',
    ]);
  });
});
