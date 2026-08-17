/**
 * @fileoverview Describes exactly what an edit changed, so the validator judges only added/changed
 * lines. A partial edit to a large function (e.g. a 1300-line React component) otherwise makes the
 * validator scrutinize the WHOLE function body and flag pre-existing, unchanged nested code as if it
 * were part of the diff. Grounding the validator in the actual change stops that false-positive class
 * (unchanged nested functions, self-matches) without re-litigating shipped code.
 */

const MAX_SIDE = 4000; // cap each side of the scope so a huge edit doesn't blow up the prompt

/**
 * @what Caps a string to MAX_SIDE characters, appending a truncation marker when it overflows
 * @how Returns the string unchanged if short enough, else the first MAX_SIDE chars plus a "… (N more chars truncated)" note
 * @why Keeps the change-scope section of the validation prompt bounded so a huge edit can't blow up the token budget
 *
 * @param {string} s The string to cap
 * @returns {string} The original string, or a truncated copy with a marker
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain change-scoping, formatting
 * @tags truncate, string-cap, prompt-size, formatting, diff
 */
function truncate(s: string): string {
  return s.length > MAX_SIDE ? `${s.slice(0, MAX_SIDE)}\n… (${s.length - MAX_SIDE} more chars truncated)` : s;
}

/**
 * @what Isolates the changed region of a full-file Write by trimming common leading/trailing lines
 * @how Skips the shared prefix and suffix lines; what remains in the middle is the change
 * @why A contiguous edit (the common case) is captured precisely without a full LCS diff
 *
 * @param {string} oldContent Pre-edit file content
 * @param {string} newContent Post-edit file content
 * @returns {string} Human-readable description of the removed/added region
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain diff, change-scoping
 * @tags prefix-suffix-diff, line-diff, change-region
 */
function diffByPrefixSuffix(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  let start = 0;
  const maxStart = Math.min(oldLines.length, newLines.length);
  while (start < maxStart && oldLines[start] === newLines[start]) start++;

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const removed = oldLines.slice(start, oldEnd).join('\n');
  const added = newLines.slice(start, newEnd).join('\n');
  if (!removed && !added) return '(no textual change detected)';

  const parts: string[] = [];
  if (removed) parts.push(`This edit REMOVED (near line ${start + 1}):\n\`\`\` removed\n${truncate(removed)}\n\`\`\``);
  if (added) parts.push(`This edit ADDED (near line ${start + 1}):\n\`\`\` added\n${truncate(added)}\n\`\`\``);
  return parts.join('\n');
}

/**
 * @what Builds the "what this edit changed" description for the validation prompt
 * @how Dispatches on edit kind: new file (all new), Edit (old→new replacement), or full-file Write (region diff)
 * @why Lets the validator restrict violations to the actual change and treat surrounding code as context
 *
 * @param {object} params Edit inputs
 * @param {boolean} params.isNewFile True when writing a brand-new file
 * @param {string} params.oldString The Edit tool's old_string (empty for Write)
 * @param {string} params.newString The Edit tool's new_string (empty for Write)
 * @param {string} params.currentFileOnDisk Pre-edit file content
 * @param {string} params.newContent Post-edit file content
 * @returns {string} A prompt-ready description of the change scope
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain change-scoping, diff, validation
 * @tags edit-scope, diff, change-attribution, prompt
 */
export function describeEditScope(params: {
  isNewFile: boolean;
  oldString: string;
  newString: string;
  currentFileOnDisk: string;
  newContent: string;
}): string {
  const { isNewFile, oldString, newString, currentFileOnDisk, newContent } = params;

  if (isNewFile) {
    return '(NEW FILE — every line is added by this edit; the entire file is in scope.)';
  }

  if (oldString) {
    return [
      'This edit REPLACED:',
      '``` removed',
      truncate(oldString),
      '```',
      'with:',
      '``` added',
      truncate(newString),
      '```',
    ].join('\n');
  }

  return diffByPrefixSuffix(currentFileOnDisk, newContent);
}
