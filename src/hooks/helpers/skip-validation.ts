/**
 * @what Decides which files the PreToolUse validation hook will run on
 * @how Allow-lists the file extensions the extraction pipeline can actually parse, and applies path-based skips for infrastructure/secret files that must never be validated regardless of extension
 * @why The ts-morph/JSDoc extraction pipeline (validateEdit) is TypeScript-only. Running it on other languages — e.g. Python — mangles them: the TS parser emits spurious syntax errors, extracts zero functions, and the code index has no siblings for them, which produced false denials on RMWM2's `ml/` tree. An allow-list means unsupported languages are cleanly skipped until a real extraction path exists, instead of the previous deny-list which validated anything it did not explicitly exclude. Python (`.py`) is now supported via a dedicated adapter — the guardian_py extractor (py-adapter.ts) reached through validatePythonEdit (py-validate.ts) — so it is allow-listed here without going through the TS-only pipeline.
 *
 * @sideeffects None
 * @systemlayer Filtering
 * @domain file-filtering, validation-exemption, language-support
 * @tags allow-list, skip-patterns, language-detection, filtering, smart-filtering
 */

import path from 'path';

/**
 * @what File extensions the validation pipeline can actually parse and extract
 * @how A set of lower-cased extensions (including the leading dot) matched against `path.extname`
 * @why TypeScript sources go through the ts-morph pipeline (validateEdit) for meaningful extraction and
 *   index context. Python sources (`.py`) are dispatched to a dedicated extraction path — the guardian_py
 *   adapter (py-adapter.ts) via validatePythonEdit (py-validate.ts) — rather than the ts-morph pipeline.
 *   Adding a language means adding its extension here AND a matching extraction dispatch — never one
 *   without the other, or that language reproduces the Python breakage this allow-list originally fixed.
 *   `.py` is safe to enable globally because validatePythonEdit fails open (allows) whenever the guardian
 *   Python tooling is absent — see py-adapter.ts's 'unavailable' sentinel.
 *
 * @systemlayer Filtering
 * @domain file-filtering, language-support
 * @tags allow-list, extensions, supported-languages, python
 */
export const VALIDATABLE_EXTENSIONS = new Set<string>(['.ts', '.tsx', '.py']);

/**
 * @what Path patterns skipped even when the file's extension is otherwise validatable
 * @how Regexes tested against the full file path before the extension allow-list is consulted
 * @why Local/secret config and the validation infrastructure itself are `.ts`/`.env`/etc. but must never be validated: hook files would recursively validate the validator, and secret/local config is out of scope.
 *
 * @systemlayer Filtering
 * @domain file-filtering, validation-exemption
 * @tags skip-patterns, infrastructure, secrets, path-based-skip
 */
export const SKIP_PATH_PATTERNS: RegExp[] = [
  /CLAUDE\.local/,      // Local Claude config
  /\.env/,              // Environment files
  /\.claude\/hooks\//   // Hook files (validation infrastructure)
];

/**
 * @what Determines if a file should skip validation
 * @how Returns true if the path matches an infrastructure/secret skip pattern, or if its extension is not in the validatable allow-list
 * @why Some files (docs, config, JSON, other languages) have no meaningful TypeScript validation; skipping them avoids false denials and wasted headless Claude calls
 *
 * @param {string} filePath Absolute path to the file being edited
 * @returns {boolean} True if validation should be skipped
 *
 * @sideeffects None
 * @systemlayer Filtering
 * @domain file-filtering, validation-exemption
 * @tags filtering, exemptions, allow-list, skip-patterns, language-detection
 */
export function shouldSkipValidation(filePath: string): boolean {
  if (SKIP_PATH_PATTERNS.some(pattern => pattern.test(filePath))) {
    return true;
  }
  const ext = path.extname(filePath).toLowerCase();
  return !VALIDATABLE_EXTENSIONS.has(ext);
}

/**
 * @what Determines whether a file path is a Python source file
 * @how Lower-cases the path and checks for a trailing `.py` extension
 * @why Shared by pre-edit-validation.ts (to dispatch to validatePythonEdit instead of the ts-morph
 *   pipeline) and requiresCodeIndex below. Lives here rather than in pre-edit-validation.ts because
 *   that module auto-runs main() on import and cannot be imported from a test — this is the importable
 *   language-detection home.
 *
 * @param {string} filePath Absolute path to the file being edited
 * @returns {boolean} True if the file is a `.py` source
 *
 * @sideeffects None
 * @systemlayer Filtering
 * @domain file-filtering, language-detection, python-support
 * @tags language-detection, python, filtering, extension-check
 */
export function isPythonFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.py');
}

/**
 * @what Determines whether a file needs the TypeScript code index to be validated
 * @how Returns false for Python files, true otherwise
 * @why The PreToolUse hook's main() gates ALL validation on the TS code index being available
 *   (isIndexAvailable), since the TS path (validateEdit) queries it directly. Python IS indexed as of
 *   P3.3–P3.5 (guardian_py definitions + Jedi call edges, with Domain/Tags docstring metadata
 *   normalized into the same domains/tags columns as TypeScript) and validatePythonEdit pulls that
 *   pre-injected pattern context via buildPatternContext(..., 'py') — but it does so defensively,
 *   catching a missing/empty/corrupt index and falling back to an empty pattern context rather than
 *   failing. So requiresCodeIndex still returns false for Python: the main() gate exists to protect the
 *   TS path specifically, and applying it to Python edits too would incorrectly block a Python-only
 *   project (or one whose index hasn't been rebuilt yet) from ever reaching a path that already
 *   tolerates an absent index on its own.
 *
 * @param {string} filePath Absolute path to the file being edited
 * @returns {boolean} True if the file's validation path depends on the TS code index
 *
 * @sideeffects None
 * @systemlayer Filtering
 * @domain file-filtering, language-detection, python-support, index-availability
 * @tags language-detection, python, code-index, fail-open, gating
 */
export function requiresCodeIndex(filePath: string): boolean {
  return !isPythonFile(filePath);
}
