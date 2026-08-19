/**
 * @what Deterministic Python tool runners — invokes the guardian-pinned ruff and pydoclint binaries and parses their findings
 * @how Writes postEditContent to a scratch temp file, runs `ruff check --output-format=json` and `pydoclint` via execFileSync against the guardian pyenv binaries, and parses each tool's output into a shared PyFinding shape. Both tools exit nonzero when they report findings, so results are read from the thrown error's stdio rather than treated as failures.
 * @why Gives the Python hook path deterministic, non-AI findings (lint + docstring/signature mismatches) to fold into the validation prompt alongside headless Claude's judgment — mirrors the role ts-morph/eslint-style checks play on the TypeScript path
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getGuardianHome } from '../../config.js';

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * @what A single finding from a deterministic Python tool (ruff or pydoclint)
 * @domain python-support, static-analysis
 * @tags finding, ruff, pydoclint, tool-result
 */
export interface PyFinding {
  tool: 'ruff' | 'pydoclint';
  code: string;
  message: string;
  line: number | null;
}

/**
 * @what Aggregated findings from both deterministic Python tools for one edit
 * @domain python-support, static-analysis
 * @tags results, ruff, pydoclint, tool-result
 */
export interface PyToolResults {
  ruff: PyFinding[];
  pydoclint: PyFinding[];
}

// ─── pyproject.toml discovery ────────────────────────────────────────────────

/**
 * @what Finds the nearest pyproject.toml by walking up from a file's directory
 * @how Starts at path.dirname(filePath), checks for pyproject.toml at each level, and steps up via path.dirname until it either finds one or reaches the filesystem root
 * @why ruff should honor project-level config (line length, selected rules, etc.) when it can be found, rather than always falling back to defaults
 *
 * @param {string} filePath File path to search upward from (its containing directory is the starting point)
 * @returns {string | null} Absolute path to the nearest pyproject.toml, or null if none exists up the tree
 *
 * @sideeffects Reads the filesystem (existsSync checks only)
 * @systemlayer Utility
 * @domain python-support, config-discovery
 * @tags pyproject, config-discovery, directory-walk, utility
 */
export function findNearestPyproject(filePath: string): string | null {
  let dir = path.dirname(filePath);

  for (let depth = 0; depth < 128; depth++) {
    const candidate = path.join(dir, 'pyproject.toml');
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      // Reached filesystem root without finding one.
      return null;
    }
    dir = parent;
  }

  // Pathological depth (e.g. symlink cycle) — fail open rather than pin the hook.
  return null;
}

// ─── ruff ─────────────────────────────────────────────────────────────────────

/**
 * @what Row/column position of a ruff diagnostic within the scanned file
 * @domain python-support, static-analysis
 * @tags ruff, location, diagnostic, tool-result
 */
interface RuffLocation {
  row: number;
  column: number;
}

/**
 * @what One entry in ruff's `--output-format=json` diagnostics array
 * @domain python-support, static-analysis
 * @tags ruff, diagnostic, json-output, tool-result
 */
interface RuffDiagnostic {
  code: string | null;
  message: string;
  location?: RuffLocation;
}

/**
 * @what Runs ruff against a scratch file and parses its JSON diagnostics
 * @how Invokes `ruff check --output-format=json [--config <nearestPyproject>] <tmpFile>` via execFileSync. Ruff exits 0 with `[]` on stdout when clean, and exits nonzero with the findings JSON still on stdout when it has diagnostics — execFileSync throws on the latter, so findings are read from the thrown error's `.stdout`. Any missing binary, timeout, non-JSON output, or unexpected throw shape fails open to an empty array.
 * @why Isolates ruff's subprocess/parsing quirks (nonzero exit on findings) from the rest of the Python tool runner
 *
 * @param {string} ruffBin Absolute path to the guardian-pinned ruff binary
 * @param {string} tmpFile Absolute path to the scratch .py file holding postEditContent
 * @param {string | null} nearestPyproject Absolute path to the nearest pyproject.toml, or null to use ruff defaults
 * @param {number} timeoutMs Subprocess timeout in milliseconds
 * @returns {PyFinding[]} Parsed ruff findings, or [] on any failure
 *
 * @sideeffects Spawns a ruff subprocess via execFileSync
 * @systemlayer External Integration
 * @domain python-support, static-analysis, ruff
 * @tags ruff, subprocess, json-parsing, fail-open, execFileSync
 */
function runRuff(
  ruffBin: string,
  tmpFile: string,
  nearestPyproject: string | null,
  timeoutMs: number,
  onError?: (msg: string) => void
): PyFinding[] {
  const args = ['check', '--output-format=json'];
  if (nearestPyproject) {
    args.push('--config', nearestPyproject);
  }
  args.push(tmpFile);

  let stdout: string;
  try {
    stdout = execFileSync(ruffBin, args, { timeout: timeoutMs, encoding: 'utf-8' });
  } catch (err: unknown) {
    // ruff exits nonzero when it reports findings — the JSON is still on stdout.
    const stdoutFromError = (err as { stdout?: string })?.stdout;
    if (typeof stdoutFromError !== 'string') {
      // No stdout means a real failure (ENOENT / timeout / signal), NOT findings.
      // Fail open, but log so a broken ruff is not mistaken for a clean file.
      onError?.(`ruff subprocess failed: ${(err as Error)?.message ?? 'unknown error'}`);
      return [];
    }
    stdout = stdoutFromError;
  }

  try {
    const diagnostics = JSON.parse(stdout) as RuffDiagnostic[];
    if (!Array.isArray(diagnostics)) return [];

    return diagnostics.map(d => ({
      tool: 'ruff' as const,
      code: d.code ?? '',
      message: d.message ?? '',
      line: d.location?.row ?? null,
    }));
  } catch {
    onError?.('ruff output was not valid JSON');
    return [];
  }
}

// ─── pydoclint ────────────────────────────────────────────────────────────────

// Matches pydoclint's indented finding lines, e.g.:
//   "    12: DOC103: Function `foo`: Docstring arguments are different..."
// Line number and code are captured; everything after the second `: ` is the message.
const PYDOCLINT_FINDING_RE = /^\s*(\d+):\s+(DOC\d+):\s*(.*)$/;

/**
 * @what Runs pydoclint against a scratch file and parses its text findings
 * @how Invokes pydoclint with pragmatic convention flags (google style, no arg-type-hints/return-type checks, skip short docstrings) via execFileSync. pydoclint prints ALL output — including on success — to stderr, never stdout; it exits nonzero only when it has findings. Findings are read from the thrown error's `.stderr` and parsed line-by-line with PYDOCLINT_FINDING_RE. A clean file exits 0 (no throw), which is treated as no findings without inspecting output.
 * @why Isolates pydoclint's subprocess/parsing quirks (stderr-only output, nonzero exit on findings) from the rest of the Python tool runner
 *
 * @param {string} pydoclintBin Absolute path to the guardian-pinned pydoclint binary
 * @param {string} tmpFile Absolute path to the scratch .py file holding postEditContent
 * @param {number} timeoutMs Subprocess timeout in milliseconds
 * @returns {PyFinding[]} Parsed pydoclint findings, or [] on any failure or when clean
 *
 * @sideeffects Spawns a pydoclint subprocess via execFileSync
 * @systemlayer External Integration
 * @domain python-support, static-analysis, pydoclint
 * @tags pydoclint, subprocess, text-parsing, fail-open, execFileSync
 */
function runPydoclint(pydoclintBin: string, tmpFile: string, timeoutMs: number, onError?: (msg: string) => void): PyFinding[] {
  const args = [
    '--style=google',
    '--arg-type-hints-in-docstring=false',
    '--check-return-types=false',
    '--skip-checking-short-docstrings=true',
    tmpFile,
  ];

  let stderr: string;
  try {
    // Success (exit 0) means pydoclint found nothing to report.
    execFileSync(pydoclintBin, args, { timeout: timeoutMs, encoding: 'utf-8' });
    return [];
  } catch (err: unknown) {
    // pydoclint exits nonzero when it reports findings — the text output is on stderr, not stdout.
    const stderrFromError = (err as { stderr?: string })?.stderr;
    if (typeof stderrFromError !== 'string') {
      // No stderr means a real failure, not findings. Fail open, but log it.
      onError?.(`pydoclint subprocess failed: ${(err as Error)?.message ?? 'unknown error'}`);
      return [];
    }
    stderr = stderrFromError;
  }

  const findings: PyFinding[] = [];
  for (const line of stderr.split('\n')) {
    const match = line.match(PYDOCLINT_FINDING_RE);
    if (!match) continue;

    const [, lineStr, code, message] = match;
    findings.push({
      tool: 'pydoclint',
      code,
      message,
      line: Number(lineStr),
    });
  }

  return findings;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @what Runs ruff and pydoclint against a proposed Python edit and returns their findings
 * @how Resolves the guardian-pinned binaries under `<GUARDIAN_HOME>/pyenv/bin`; a missing binary makes that tool's result []. Writes postEditContent to a mkdtempSync scratch .py file (always removed via finally), then runs each tool independently — a failure in one tool never affects the other.
 * @why Gives the Python hook path deterministic findings to fold into the validation prompt, without depending on either tool being installed or on either tool succeeding
 *
 * @param {string} filePath File path being edited (used only to locate the nearest pyproject.toml for ruff config; the actual disk read is from a scratch temp file)
 * @param {string} postEditContent The proposed post-edit Python source
 * @param {{ timeoutMs?: number }} [opts] Optional per-tool subprocess timeout override (default 8000ms)
 * @returns {PyToolResults} Findings from ruff and pydoclint, each independently fail-open to []
 *
 * @sideeffects Spawns ruff and pydoclint subprocesses via execFileSync; writes and removes a scratch temp file
 * @systemlayer External Integration
 * @domain python-support, static-analysis, hook-adapter
 * @tags python, ruff, pydoclint, subprocess, fail-open, execFileSync
 */
export function runPyTools(
  filePath: string,
  postEditContent: string,
  opts?: { timeoutMs?: number; onError?: (msg: string) => void }
): PyToolResults {
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const onError = opts?.onError;
  const guardianHome = getGuardianHome();
  const ruffBin = path.join(guardianHome, 'pyenv', 'bin', 'ruff');
  const pydoclintBin = path.join(guardianHome, 'pyenv', 'bin', 'pydoclint');

  const ruffAvailable = existsSync(ruffBin);
  const pydoclintAvailable = existsSync(pydoclintBin);

  if (!ruffAvailable && !pydoclintAvailable) {
    return { ruff: [], pydoclint: [] };
  }

  let tmpDir: string | null = null;
  try {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'guardian-py-tools-'));
    const tmpFile = path.join(tmpDir, 'edit.py');
    writeFileSync(tmpFile, postEditContent, 'utf-8');

    let ruff: PyFinding[] = [];
    if (ruffAvailable) {
      try {
        const nearestPyproject = findNearestPyproject(filePath);
        ruff = runRuff(ruffBin, tmpFile, nearestPyproject, timeoutMs, onError);
      } catch (e) {
        onError?.(`ruff runner threw: ${(e as Error)?.message ?? 'unknown error'}`);
        ruff = [];
      }
    }

    let pydoclint: PyFinding[] = [];
    if (pydoclintAvailable) {
      try {
        pydoclint = runPydoclint(pydoclintBin, tmpFile, timeoutMs, onError);
      } catch (e) {
        onError?.(`pydoclint runner threw: ${(e as Error)?.message ?? 'unknown error'}`);
        pydoclint = [];
      }
    }

    return { ruff, pydoclint };
  } catch (e) {
    onError?.(`py-tools scratch-file setup failed: ${(e as Error)?.message ?? 'unknown error'}`);
    return { ruff: [], pydoclint: [] };
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup — never let temp dir removal failures surface.
      }
    }
  }
}
