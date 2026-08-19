/**
 * @what Shared helpers for invoking the guardian-managed Python toolchain from the hook
 * @how resolvePyenvBin locates a binary under `<GUARDIAN_HOME>/pyenv/bin`; withPyScratchFile
 *   runs a callback with a freshly-written scratch .py file (named after the original file's
 *   basename so path-scoped tool config can match) and always removes the temp dir afterward.
 * @why py-adapter.ts (extractPython) and py-tools.ts (runPyTools) both resolved pyenv binaries
 *   and managed a mkdtemp→write→finally-rm scratch file with verbatim-duplicated code; extracting
 *   them removes the drift risk and lets the scratch file carry the real basename (SUG-1/SUG-3).
 *
 * @sideeffects withPyScratchFile creates and removes a temp directory + file
 * @systemlayer External Integration
 * @domain python-support, subprocess, hook-adapter
 * @tags python, pyenv, scratch-file, dedup, fail-open
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getGuardianHome } from '../../config.js';

/**
 * @what Resolves a binary in the guardian-managed pyenv, or null if absent
 * @how Joins `<GUARDIAN_HOME>/pyenv/bin/<name>` and existsSync-checks it
 * @why Every Python subprocess call fails open when its binary is missing; centralizes that check
 *
 * @param {string} name Binary name (e.g. 'python', 'ruff', 'pydoclint')
 * @returns {string | null} Absolute path if it exists, else null
 *
 * @sideeffects Reads the filesystem
 * @systemlayer External Integration
 * @domain python-support, subprocess
 * @tags pyenv, binary-resolution, fail-open
 */
export function resolvePyenvBin(name: string): string | null {
  const bin = path.join(getGuardianHome(), 'pyenv', 'bin', name);
  return existsSync(bin) ? bin : null;
}

/**
 * @what Runs a callback with a scratch copy of Python source, cleaning up afterward
 * @how mkdtemps a unique dir, writes `content` to a file named after `originalPath`'s basename
 *   (falling back to `edit.py` for a non-.py name), invokes `fn(scratchPath)`, and removes the
 *   dir in a finally block. The basename preserves path-scoped tool config semantics (e.g. ruff
 *   per-file-ignores keyed on `test_*.py`) that a fixed `edit.py` name would defeat.
 * @why Deduplicates the identical scratch-file lifecycle in extractPython and runPyTools
 *
 * @param {string} originalPath The real path being edited (used only for the scratch basename)
 * @param {string} content The proposed post-edit Python source to write
 * @param {(scratchPath: string) => T} fn Callback given the scratch file's absolute path
 * @returns {T} Whatever `fn` returns
 *
 * @sideeffects Creates and removes a temp directory + file
 * @systemlayer External Integration
 * @domain python-support, subprocess
 * @tags scratch-file, temp-file, cleanup, dedup
 */
export function withPyScratchFile<T>(originalPath: string, content: string, fn: (scratchPath: string) => T): T {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'guardian-py-'));
  const base = path.basename(originalPath);
  const scratchName = base.endsWith('.py') ? base : 'edit.py';
  const scratchPath = path.join(tmpDir, scratchName);
  try {
    writeFileSync(scratchPath, content, 'utf-8');
    return fn(scratchPath);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — never let temp dir removal failures surface.
    }
  }
}
