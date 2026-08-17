/**
 * @what Pragmatic Python doc-completeness convention check + novelty marking for extracted Python units
 * @how markUnitNovelty compares extracted unit names against the pre-edit file's unit-name set to set isNew/isModified. checkPythonDocCompleteness applies a small, intentionally shallow rule set (module docstring+Domain, class/dataclass docstring+Domain, public function docstring) rather than the TS path's full JSDoc-tag validation — depth (Args/Returns/Raises accuracy) is left to pydoclint and headless Claude's judgment.
 * @why Gives the Python hook path the same "confirmed by static analysis" local violations the TS path gets from jsdoc-parser.ts, without over-specifying a convention Python doesn't share with JSDoc (types live in annotations, not docstring prose; docstring depth requirements should scale with signature complexity)
 *
 * @sideeffects None
 * @systemlayer Validation
 * @domain python-support, doc-completeness, validation
 * @tags python, docstring, convention-check, novelty-tracking, pragmatic
 */

import { ExtractedClass, ExtractedFunction } from './types.js';

/**
 * @what Marks each proposed Python function/class as new or modified by comparing its name against the pre-edit file's unit names
 * @how For each function and class, looks up `name` in `oldUnitNames`: present → isModified=true/isNew=false, absent → isNew=true/isModified=false. Mutates the passed-in arrays in place.
 * @why The guardian_py extractor has no diff view of the file, so novelty must be determined in Node by set-membership — mirrors how the TypeScript path (function-extractor.ts) distinguishes NEW vs MODIFIED functions for the validation prompt
 *
 * @param {Set<string>} oldUnitNames Names of functions/classes present in the file BEFORE this edit (empty set for a brand-new file, in which case every unit is marked new)
 * @param {ExtractedFunction[]} functions Proposed functions/methods to mark, mutated in place
 * @param {ExtractedClass[]} classes Proposed classes/dataclasses/modules to mark, mutated in place
 * @returns {void} Mutates isNew/isModified on each element of functions and classes
 *
 * @sideeffects Mutates the isNew/isModified fields of every element in functions and classes
 * @systemlayer Validation
 * @domain python-support, novelty-tracking
 * @tags python, novelty, mutation, diffing, extraction
 */
export function markUnitNovelty(
  oldUnitNames: Set<string>,
  functions: ExtractedFunction[],
  classes: ExtractedClass[]
): void {
  for (const fn of functions) {
    const existed = oldUnitNames.has(fn.name);
    fn.isNew = !existed;
    fn.isModified = existed;
  }
  for (const cls of classes) {
    const existed = oldUnitNames.has(cls.name);
    cls.isNew = !existed;
    cls.isModified = existed;
  }
}

/**
 * @what Applies the pragmatic Python doc-completeness convention to module, class/dataclass, and public-function units
 * @how Checks module.docstring/module.domains for the `__module__` key; for each class/dataclass in `classes` (kind==='module' entries are skipped — module-level info comes from the separate `module` param, not the classes array) checks docstring+domains; for each function in `functions` where requiresJSDoc is true (public/exported), checks hasJSDoc. Only units with at least one violation are added to the returned map. Does NOT check Args/Returns/Tags depth — that is intentionally left to pydoclint and headless Claude's judgment per the pragmatic convention.
 * @why Gives the Python validation prompt the same kind of "confirmed by static analysis" local violations the TS path gets from jsdoc-parser.ts, scoped to what's cheap and unambiguous to check locally (presence, not depth/accuracy)
 *
 * @param {ExtractedFunction[]} functions Proposed functions/methods to check
 * @param {ExtractedClass[]} classes Proposed classes/dataclasses (and possibly module-kind entries, which are skipped) to check
 * @param {{ docstring: string | null; domains: string[]; tags: string[]; layer: string | null }} module Module-level metadata extracted separately from the classes array
 * @returns {Map<string, string[]>} Map of unit name (or '__module__') to its violation strings; units with no violations are omitted, so an all-clean edit returns an empty map
 *
 * @sideeffects None
 * @systemlayer Validation
 * @domain python-support, doc-completeness, validation
 * @tags python, docstring, convention-check, module, class, function
 */
export function checkPythonDocCompleteness(
  functions: ExtractedFunction[],
  classes: ExtractedClass[],
  module: { docstring: string | null; domains: string[]; tags: string[]; layer: string | null }
): Map<string, string[]> {
  const violations = new Map<string, string[]>();

  const moduleViolations: string[] = [];
  if (!module.docstring || module.docstring.trim().length === 0) {
    moduleViolations.push("Module is missing a docstring (one-line 'what' + Domain: line)");
  }
  if (module.domains.length === 0) {
    moduleViolations.push("Module docstring is missing a 'Domain:' line");
  }
  if (moduleViolations.length > 0) {
    violations.set('__module__', moduleViolations);
  }

  for (const cls of classes) {
    if (cls.kind === 'module') continue; // module-level info comes from the `module` param, not this array

    const classViolations: string[] = [];
    if (!cls.docstring || cls.docstring.trim().length === 0) {
      classViolations.push(`class '${cls.name}' is missing a docstring`);
    }
    if (cls.domains.length === 0) {
      classViolations.push(`class '${cls.name}' docstring is missing a 'Domain:' line`);
    }
    if (classViolations.length > 0) {
      violations.set(cls.name, classViolations);
    }
  }

  for (const fn of functions) {
    if (!fn.requiresJSDoc) continue; // private/unexported functions have no docstring requirement
    if (!fn.hasJSDoc) {
      violations.set(fn.name, [`public function '${fn.name}' is missing a docstring`]);
    }
  }

  return violations;
}
