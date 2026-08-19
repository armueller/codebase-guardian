/**
 * @what Python extraction adapter — invokes the guardian_py helper and maps its JSON contract to shared extraction types
 * @how Writes the post-edit buffer to a scratch temp file, runs `<GUARDIAN_HOME>/pyenv/bin/python -m guardian_py extract` via execFileSync with PYTHONPATH set to the installed helper source, then maps the returned units into ExtractedFunction/ExtractedClass
 * @why Wires the Phase-1 guardian_py helper into the Node hook so Python edits can be extracted the same way TypeScript edits are, without duplicating Python AST logic in Node
 *
 * @sideeffects Spawns a Python subprocess, writes and removes a temp file/directory
 * @systemlayer External Integration
 * @domain python-support, code-extraction, hook-adapter
 * @tags python, adapter, subprocess, extraction, fail-open
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getGuardianHome } from '../../../config.js';
import { fileURLToPath } from 'url';
import type { ExtractedClass, ExtractedFunction } from '../types.js';

// ─── guardian_py JSON contract (subset consumed here) ───────────────────────

interface PySignatureParam {
  name: string;
  annotation: string | null;
  default: string | null;
  kind: 'positional' | 'keyword_only';
}

interface PySignature {
  params: PySignatureParam[];
  returns: string | null;
  has_varargs: boolean;
  has_kwargs: boolean;
}

interface PyField {
  name: string;
  annotation: string | null;
  default: string | null;
  comment: string | null;
}

interface PyUnit {
  kind: 'module' | 'class' | 'dataclass' | 'function' | 'method';
  name: string;
  line: number;
  end_line: number;
  is_exported: boolean;
  decorators: string[];
  summary: string | null;
  docstring: string | null;
  domains: string[];
  tags: string[];
  layer: string | null;
  signature: PySignature | null;
  parent: string | null;
  fields?: PyField[];
}

interface PyModuleMeta {
  summary: string | null;
  docstring: string | null;
  domains: string[];
  tags: string[];
  layer: string | null;
}

interface PyExtractPayload {
  language: 'py';
  file: string;
  error?: string;
  detail?: string;
  module?: PyModuleMeta;
  units?: PyUnit[];
}

// ─── Public result type ──────────────────────────────────────────────────────

export type PyExtractResult =
  | {
      ok: true;
      functions: ExtractedFunction[];
      classes: ExtractedClass[];
      module: { docstring: string | null; domains: string[]; tags: string[]; layer: string | null };
    }
  | { ok: false; reason: 'syntax' | 'error' | 'unavailable'; detail?: string };

// ─── Signature reconstruction ────────────────────────────────────────────────

/**
 * @what Formats a single parameter from the guardian_py signature contract into readable Python
 * @how Concatenates name, optional `: annotation`, and optional ` = default`
 * @why Used to build a best-effort, human-readable `def` line for the validation prompt
 *
 * @param {PySignatureParam} param Parameter metadata from the extraction JSON
 * @returns {string} Formatted parameter text
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain python-support, formatting
 * @tags formatting, signature, python, utility
 */
function formatParam(param: PySignatureParam): string {
  let text = param.name;
  if (param.annotation) text += `: ${param.annotation}`;
  if (param.default !== null) text += ` = ${param.default}`;
  return text;
}

/**
 * @what Reconstructs a best-effort, readable `def name(params) -> returns:` line from the extraction JSON signature
 * @how Splits params by positional/keyword_only kind, inserts `*args`/bare `*`/`**kwargs` markers as needed (vararg/kwarg names are not captured by the helper, so generic names are used), and appends the return annotation
 * @why headless Claude needs a readable signature even though the helper only reports structured param metadata, not literal source text
 *
 * @param {string} name Function or method name
 * @param {PySignature | null} signature Structured signature from the extraction JSON, or null
 * @returns {string} A single `def ...:` line
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain python-support, formatting, signature-reconstruction
 * @tags formatting, signature, python, best-effort, utility
 */
function buildSignatureLine(name: string, signature: PySignature | null): string {
  if (!signature) return `def ${name}():`;

  const positional = signature.params.filter(p => p.kind === 'positional');
  const keywordOnly = signature.params.filter(p => p.kind === 'keyword_only');

  const parts: string[] = positional.map(formatParam);

  if (signature.has_varargs) {
    parts.push('*args');
  } else if (keywordOnly.length > 0) {
    // Python requires a bare `*` separator before keyword-only params when
    // there's no *args to serve as the separator.
    parts.push('*');
  }

  parts.push(...keywordOnly.map(formatParam));

  if (signature.has_kwargs) {
    parts.push('**kwargs');
  }

  const returns = signature.returns ? ` -> ${signature.returns}` : '';
  return `def ${name}(${parts.join(', ')})${returns}:`;
}

/**
 * @what Builds the fullCode representation for a function/method unit
 * @how Reconstructs the signature line, appends the docstring (if any) as an indented body line, and — for methods — wraps the whole thing in a `class Parent:` stub so the enclosing class is visible in context
 * @why ExtractedFunction has no `parent` field, so a method's enclosing class must be surfaced through fullCode for it to be visible downstream (e.g. to headless Claude, or to callers inspecting the extraction result)
 *
 * @param {PyUnit} unit Function or method unit from the extraction JSON
 * @returns {string} Best-effort readable Python source for the unit
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain python-support, formatting, code-reconstruction
 * @tags formatting, fullCode, python, method, class-context, utility
 */
function buildFunctionFullCode(unit: PyUnit): string {
  const lines = [buildSignatureLine(unit.name, unit.signature)];
  if (unit.docstring) {
    lines.push(`    """${unit.docstring}"""`);
  }
  let code = lines.join('\n');

  if (unit.kind === 'method' && unit.parent) {
    const indented = code
      .split('\n')
      .map(line => `    ${line}`)
      .join('\n');
    code = `class ${unit.parent}:\n${indented}`;
  }

  return code;
}

// ─── Unit mapping ─────────────────────────────────────────────────────────────

/**
 * @what Maps a guardian_py function/method unit to an ExtractedFunction
 * @how Reconstructs fullCode via buildFunctionFullCode; hasJSDoc reflects docstring presence; requiresJSDoc reflects export status; isNew/isModified are left false for the caller to set
 * @why Lets the Python adapter's output slot directly into the same ExtractedFunction shape used by the TypeScript extraction path
 *
 * @param {PyUnit} unit Function or method unit from the extraction JSON
 * @returns {ExtractedFunction} Mapped extraction result
 *
 * @sideeffects None
 * @systemlayer Data Mapping
 * @domain python-support, extraction-mapping
 * @tags mapping, python, extracted-function, adapter
 */
function mapFunctionUnit(unit: PyUnit): ExtractedFunction {
  return {
    name: unit.name,
    fullCode: buildFunctionFullCode(unit),
    hasJSDoc: unit.docstring != null,
    isNew: false,
    isModified: false,
    lineInFile: unit.line,
    requiresJSDoc: unit.is_exported,
  };
}

/**
 * @what Maps a guardian_py class/dataclass/module unit to an ExtractedClass
 * @how Carries fields/parent/docstring/domains/tags/layer/line straight through from the unit; isNew/isModified are left false for the caller to set
 * @why Lets the Python adapter's output slot directly into the ExtractedClass shape consumed downstream by the hook
 *
 * @param {PyUnit} unit Class, dataclass, or module unit from the extraction JSON
 * @returns {ExtractedClass} Mapped extraction result
 *
 * @sideeffects None
 * @systemlayer Data Mapping
 * @domain python-support, extraction-mapping
 * @tags mapping, python, extracted-class, adapter
 */
function mapClassUnit(unit: PyUnit): ExtractedClass {
  return {
    name: unit.name,
    kind: unit.kind as 'class' | 'dataclass' | 'module',
    fields: unit.fields ?? [],
    parent: unit.parent,
    docstring: unit.docstring,
    domains: unit.domains,
    tags: unit.tags,
    layer: unit.layer,
    isNew: false,
    isModified: false,
    lineInFile: unit.line,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @what Extracts functions, classes, and module metadata from a Python source buffer via the guardian_py helper
 * @how Resolves the guardian pyenv binary under getGuardianHome() and the guardian_py helper source relative to this module (it ships alongside the compiled code: repo/python in dev, $CLAUDE_PLUGIN_DATA/app/python under the plugin); if the pyenv python binary is missing, fails open as 'unavailable'. Otherwise writes postEditContent to a scratch temp file, runs `python -m guardian_py extract <file>` with PYTHONPATH set to the helper source, parses the JSON result, and maps it to ExtractedFunction/ExtractedClass. The temp directory is always removed, even on error.
 * @why Wires the Phase-1 guardian_py Python helper into the Node hook so Python edits can be validated using the same extraction shape as TypeScript edits, without ever throwing out of the adapter
 *
 * @param {string} filePath File path being edited (used only for context; the actual disk read is from a scratch temp file, not this path)
 * @param {string} postEditContent The proposed post-edit Python source
 * @param {{ timeoutMs?: number }} [opts] Optional subprocess timeout override (default 5000ms)
 * @returns {PyExtractResult} Ok result with mapped functions/classes/module, or a fail-open sentinel ('syntax' | 'error' | 'unavailable')
 *
 * @sideeffects Spawns a Python subprocess via execFileSync; writes and removes a temp file/directory
 * @systemlayer External Integration
 * @domain python-support, code-extraction, hook-adapter
 * @tags python, adapter, subprocess, extraction, fail-open, execFileSync
 */
export function extractPython(
  filePath: string,
  postEditContent: string,
  opts?: { timeoutMs?: number }
): PyExtractResult {
  const guardianHome = getGuardianHome();
  const pyBin = path.join(guardianHome, 'pyenv', 'bin', 'python');
  // The guardian_py helper source ships next to the compiled code, not under the
  // data dir — resolve it relative to this module: dev → <repo>/python, plugin →
  // $CLAUDE_PLUGIN_DATA/app/python (both are four levels up from adapters/).
  const pyPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../python');

  if (!existsSync(pyBin)) {
    return { ok: false, reason: 'unavailable' };
  }

  let tmpDir: string | null = null;
  try {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'guardian-py-'));
    const tmpFile = path.join(tmpDir, 'edit.py');
    writeFileSync(tmpFile, postEditContent, 'utf-8');

    let stdout: string;
    try {
      stdout = execFileSync(pyBin, ['-m', 'guardian_py', 'extract', tmpFile], {
        timeout: opts?.timeoutMs ?? 5000,
        encoding: 'utf-8',
        env: { ...process.env, PYTHONPATH: pyPath },
      });
    } catch (e) {
      return { ok: false, reason: 'error', detail: `guardian_py extract failed: ${(e as Error)?.message ?? 'unknown error'}` };
    }

    let payload: PyExtractPayload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      return { ok: false, reason: 'error', detail: 'guardian_py output was not valid JSON' };
    }

    if (payload.error === 'syntax') {
      return { ok: false, reason: 'syntax' };
    }
    if (payload.error) {
      return { ok: false, reason: 'error', detail: `guardian_py reported: ${payload.error}` };
    }

    const functions: ExtractedFunction[] = [];
    const classes: ExtractedClass[] = [];

    for (const unit of payload.units ?? []) {
      if (unit.kind === 'function' || unit.kind === 'method') {
        functions.push(mapFunctionUnit(unit));
      } else {
        classes.push(mapClassUnit(unit));
      }
    }

    const moduleMeta = payload.module;
    return {
      ok: true,
      functions,
      classes,
      module: {
        docstring: moduleMeta?.docstring ?? null,
        domains: moduleMeta?.domains ?? [],
        tags: moduleMeta?.tags ?? [],
        layer: moduleMeta?.layer ?? null,
      },
    };
  } catch {
    return { ok: false, reason: 'error' };
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
