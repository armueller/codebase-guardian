/**
 * @what Invokes the guardian_py helper to extract raw module + unit metadata from an on-disk Python file for indexing
 * @how Resolves the guardian pyenv binary via getGuardianHome() and the guardian_py helper source relative to this module (../../python from src/mcp-server), then runs `python -m guardian_py extract <absFilePath>` with PYTHONPATH set to the helper source and parses the raw JSON payload from stdout
 * @why The indexer needs the RAW guardian_py units (with domains/tags/layer per unit) to write Tier 1/2 rows into the same functions table as TypeScript. The hook's py-adapter.ts (src/hooks/helpers/adapters/py-adapter.ts) intentionally maps this into the lossy ExtractedFunction/ExtractedClass shape (no domains/tags/layer), so it cannot be reused here — this module invokes guardian_py directly and returns the raw payload instead
 *
 * @sideeffects Spawns a Python subprocess via execFileSync
 * @systemlayer External Integration
 * @domain code-index, python-support
 * @tags python, extraction, subprocess, fail-open, indexer
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getGuardianHome } from '../config.js';

// ─── guardian_py raw JSON contract (see python/guardian_py/extract.py) ──────

export interface PyRawUnit {
  kind: string;
  name: string;
  line: number;
  is_exported: boolean;
  summary: string | null;
  docstring: string | null;
  domains: string[];
  tags: string[];
  layer: string | null;
  parent: string | null;
}

export interface PyModuleMeta {
  summary: string | null;
  docstring: string | null;
  domains: string[];
  tags: string[];
  layer: string | null;
}

export interface PyExtracted {
  module: PyModuleMeta;
  units: PyRawUnit[];
}

interface PyExtractPayload {
  language: 'py';
  file: string;
  error?: string;
  detail?: string;
  module?: PyModuleMeta;
  units?: PyRawUnit[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @what Extracts raw module + unit metadata from an on-disk Python file via the guardian_py helper
 * @how Resolves <GUARDIAN_HOME>/pyenv/bin/python (same resolution as py-adapter.ts, no fallback interpreter); if missing, fails open. Otherwise runs `python -m guardian_py extract <absFilePath>` with PYTHONPATH pointed at the bundled helper source (../../python from this module: dev -> <repo>/python, plugin -> $CLAUDE_PLUGIN_DATA/app/python), parses stdout as JSON, and returns the raw {module, units} payload. Any failure (missing interpreter, subprocess error, non-zero/malformed output, JSON parse failure, or a guardian_py-reported error such as syntax/not_found/internal) returns null instead of throwing.
 * @why Gives the indexer's Python branch the exact raw JSON shape guardian_py emits (with domains/tags/layer per unit, plus module-level metadata) so Tier 1/2 rows can be written the same way the TS JSDoc path writes Tier 1 rows
 *
 * @param {string} absFilePath Absolute path to the on-disk .py file to extract
 * @param {{timeoutMs?: number}} [opts] Optional subprocess timeout override (default 5000ms)
 * @returns {PyExtracted | null} The raw {module, units} payload, or null on any failure (fail-open — caller should skip the file)
 *
 * @sideeffects Spawns a Python subprocess via execFileSync
 * @systemlayer External Integration
 * @domain code-index, python-support
 * @tags python, extraction, subprocess, fail-open, indexer, execFileSync
 */
export function extractPythonFile(absFilePath: string, opts?: { timeoutMs?: number }): PyExtracted | null {
  const guardianHome = getGuardianHome();
  const pyBin = path.join(guardianHome, 'pyenv', 'bin', 'python');
  // The guardian_py helper source ships next to the compiled code, not under the
  // data dir — resolve it relative to this module: dev -> <repo>/python, plugin ->
  // $CLAUDE_PLUGIN_DATA/app/python (both are two levels up from mcp-server/).
  const pyPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../python');

  if (!existsSync(pyBin)) {
    return null;
  }

  let stdout: string;
  try {
    stdout = execFileSync(pyBin, ['-m', 'guardian_py', 'extract', absFilePath], {
      timeout: opts?.timeoutMs ?? 5000,
      encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: pyPath },
    });
  } catch {
    return null;
  }

  let payload: PyExtractPayload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return null;
  }

  if (payload.error || !payload.module) {
    return null;
  }

  return {
    module: payload.module,
    units: payload.units ?? [],
  };
}
