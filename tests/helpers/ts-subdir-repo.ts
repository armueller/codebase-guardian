import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A small repo whose TypeScript app lives in web/, with its tsconfig there and none at the root.
 *
 * No function has JSDoc, so each one is a Tier 2 export. There are two `greet` functions on
 * purpose: `a-other/greet.ts` sorts before `lib/greet.ts`, so a name-only match picks the wrong
 * one. Only resolving the `~/` alias through web/tsconfig.json finds the right file.
 */
export const TS_SUBDIR_FILES: Record<string, string> = {
  'web/tsconfig.json': JSON.stringify({
    compilerOptions: { module: 'ES2022', moduleResolution: 'bundler', strict: true, paths: { '~/*': ['./app/*'] } },
  }),
  'web/app/a-other/greet.ts': "export function greet(n: string): string { return 'other ' + n; }\n",
  'web/app/lib/greet.ts': "export function greet(n: string): string { return 'hi ' + n; }\n",
  'web/app/lib/shout.ts': 'export function shout(s: string): string { return s.toUpperCase(); }\n',
  'web/app/main.ts': [
    "import { greet } from '~/lib/greet';",
    "import { shout } from './lib/shout';",
    "export function run(): string { return shout(greet('x')); }",
    '',
  ].join('\n'),
};

/**
 * @what Returns the source of a TypeScript file holding one documented, exported function
 * @how A doc block with a what line, a domain and three tags, followed by `export function <name>(): number`
 * @why The indexer writes a Tier 1 row only for a function whose doc block carries a domain; tests that need "a file that gets indexed" all need this same text
 *
 * @param {string} name The function's name
 * @returns {string} TypeScript source text
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain testing
 * @tags test-helper, fixture, tier-1
 */
export function documentedFunction(name: string): string {
  return [
    '/**',
    ` * @what Does the ${name} thing`,
    ' * @domain demo',
    ' * @tags a, b, c',
    ' */',
    `export function ${name}(): number { return 1; }`,
    '',
  ].join('\n');
}

const tempDirs: string[] = [];

/**
 * @what Creates a temp directory that cleanupTempDirs will remove
 * @how mkdtemp under the OS temp folder, remembering the path in a module-level list
 * @why Tests used to leave every temp project (and whole guardian data directories) behind
 *
 * @param {string} prefix Name prefix for the directory
 * @returns {string} Absolute path of the new directory
 *
 * @sideeffects Creates a directory; records it for later removal
 * @systemlayer Utility
 * @domain testing
 * @tags test-helper, temp-dir, cleanup
 */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * @what Removes every directory makeTempDir created in this test file
 * @how rmSync recursive + force on each recorded path, then empties the list; meant to be passed to node:test's `after`
 * @why Keeps the OS temp folder from filling with test projects
 *
 * @returns {void}
 *
 * @sideeffects Deletes directories
 * @systemlayer Utility
 * @domain testing
 * @tags test-helper, temp-dir, cleanup
 */
export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @what Writes files into a repo root, creating parent folders
 * @how mkdir -p for each file's folder, then writeFileSync
 * @why Tests add or overwrite files (a config, a broken tsconfig, an excluded folder) on top of the base tree
 *
 * @param {string} root Absolute repo root
 * @param {Record<string, string>} files Map of root-relative path to file content
 * @returns {void}
 *
 * @sideeffects Writes files to disk
 * @systemlayer Utility
 * @domain testing, call-graph
 * @tags test-helper, fixture, filesystem
 */
export function putFiles(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(root, relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/**
 * @what Creates a private temp copy of the sub-folder-tsconfig repo
 * @how mkdtemp, writes TS_SUBDIR_FILES, then any extra files (which may overwrite the base ones)
 * @why Each test needs its own writable repo: they write different guardian.config.json files and add or break files
 *
 * @param {Record<string, string>} [extra] Extra root-relative files, e.g. a guardian.config.json
 * @returns {string} Absolute path of the new repo root
 *
 * @sideeffects Creates a temp directory and writes files into it
 * @systemlayer Utility
 * @domain testing, call-graph
 * @tags test-helper, fixture, tsconfig, temp-dir
 */
export function makeTsSubdirRepo(extra: Record<string, string> = {}): string {
  const root = makeTempDir('guardian-ts-subdir-');
  putFiles(root, TS_SUBDIR_FILES);
  putFiles(root, extra);
  return root;
}
