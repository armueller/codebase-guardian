/**
 * Field-by-field validation of guardian.config.json values.
 *
 * Every helper takes the raw value and a `warnings` accumulator. A value with the wrong shape is
 * never returned: the helper records one sentence naming the field and returns undefined, so the
 * caller falls back to the default. None of them throws, because the hook builds its config
 * through `reloadConfig` and must stay fail-open. Dependency-free on purpose (see
 * tsconfig-resolution.ts for why config loading must stay light).
 */

/**
 * @what Validates a config field that must be a list of strings
 * @how Returns undefined when the field is absent; the value when it is an array whose entries are all strings; otherwise records a warning sentence naming the field and returns undefined, so the caller falls back to the default
 * @why These fields are now consumed directly (excludeDirectories drives the file walk). A wrong shape such as [5] or "node_modules" used to be harmless and would now throw mid-rebuild, after the old index was cleared, or silently iterate a string's characters.
 *
 * @param {unknown} value The raw field value from guardian.config.json
 * @param {string} name The field name, for the warning
 * @param {string[]} warnings Accumulator the warning sentence is pushed onto
 * @returns {string[] | undefined} The validated list, or undefined when absent or invalid
 *
 * @sideeffects Pushes onto the warnings array
 * @systemlayer Configuration
 * @domain config
 * @tags guardian-config, validation, string-list, config-warning
 */
export function stringListField(value: unknown, name: string, warnings: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) return value as string[];
  warnings.push(`"${name}" in guardian.config.json must be a list of strings`);
  return undefined;
}

/**
 * @what Validates a config field that must be an object (the `jsdoc` and `searchHint` groups)
 * @how Returns undefined when the field is absent; the value when it is a plain object; otherwise records a warning naming the field and returns undefined, so every setting in the group falls back to its default
 * @why The hook reads these groups on every edit. A list or a string in their place must not reach it as if it were settings.
 *
 * @param {unknown} value The raw field value from guardian.config.json
 * @param {string} name The field name, for the warning
 * @param {string[]} warnings Accumulator the warning sentence is pushed onto
 * @returns {Record<string, unknown> | undefined} The object, or undefined when absent or invalid
 *
 * @sideeffects Pushes onto the warnings array
 * @systemlayer Configuration
 * @domain config
 * @tags guardian-config, validation, object-field, config-warning
 */
export function objectField(value: unknown, name: string, warnings: string[]): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  warnings.push(`"${name}" in guardian.config.json must be an object`);
  return undefined;
}

/**
 * @what Validates a config setting that must be a number that is zero or more
 * @how Returns undefined when the setting is absent; the value when it is a finite number of at least zero; otherwise records a warning naming the setting and returns undefined, so the caller uses the default
 * @why Counts and thresholds (minTags, rearmAfter, …) are compared numerically by the hooks; a string such as "3" or a negative number would silently change those comparisons
 *
 * @param {unknown} value The raw setting value
 * @param {string} name The dotted setting name, for the warning
 * @param {string[]} warnings Accumulator the warning sentence is pushed onto
 * @returns {number | undefined} The number, or undefined when absent or invalid
 *
 * @sideeffects Pushes onto the warnings array
 * @systemlayer Configuration
 * @domain config
 * @tags guardian-config, validation, number-field, config-warning
 */
export function countField(value: unknown, name: string, warnings: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  warnings.push(`"${name}" in guardian.config.json must be a number that is zero or more`);
  return undefined;
}

/**
 * @what Validates a config setting that must be true or false
 * @how Returns undefined when the setting is absent; the value when it is a boolean; otherwise records a warning naming the setting and returns undefined, so the caller uses the default
 * @why A string such as "no" is truthy; an on/off switch must not be turned on by a mistyped value
 *
 * @param {unknown} value The raw setting value
 * @param {string} name The dotted setting name, for the warning
 * @param {string[]} warnings Accumulator the warning sentence is pushed onto
 * @returns {boolean | undefined} The boolean, or undefined when absent or invalid
 *
 * @sideeffects Pushes onto the warnings array
 * @systemlayer Configuration
 * @domain config
 * @tags guardian-config, validation, boolean-field, config-warning
 */
export function flagField(value: unknown, name: string, warnings: string[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  warnings.push(`"${name}" in guardian.config.json must be true or false`);
  return undefined;
}

/**
 * @what Cleans the project's excludeDirectories entries and rejects the ones that can never match
 * @how Trims each entry and drops empty ones. An entry containing `*` or `?` is dropped with a warning: matching is by folder name or by exact path, never by pattern.
 * @why An entry such as "**\/generated" or "web/data/**" looks right and silently excludes nothing, so the folder it was meant to hide gets indexed
 *
 * @param {string[]} entries The validated list from guardian.config.json
 * @param {string[]} warnings Accumulator the warning sentences are pushed onto
 * @returns {string[]} The usable entries, trimmed
 *
 * @sideeffects Pushes onto the warnings array
 * @systemlayer Configuration
 * @domain config, file-walk
 * @tags exclude-directories, validation, glob, config-warning
 */
export function usableExcludes(entries: string[], warnings: string[]): string[] {
  const usable: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === '') continue;
    if (/[*?]/.test(entry)) {
      warnings.push(
        `"excludeDirectories" entry "${entry}" in guardian.config.json uses a glob pattern, which is not supported; ` +
        'use a folder name or a path from the project root',
      );
      continue;
    }
    usable.push(entry);
  }
  return usable;
}

/**
 * @what Checks that every configured file extension starts with a dot
 * @how Returns the list unchanged when every entry starts with "."; otherwise records one warning per offending entry and returns undefined, so the default extensions are used
 * @why Extensions are compared with path.extname, which includes the dot. A list written as ["ts", "tsx"] matches no file, and the rebuild would index nothing while reading complete.
 *
 * @param {string[]} entries The validated list from guardian.config.json
 * @param {string[]} warnings Accumulator the warning sentences are pushed onto
 * @returns {string[] | undefined} The list, or undefined when any entry is unusable
 *
 * @sideeffects Pushes onto the warnings array
 * @systemlayer Configuration
 * @domain config, file-walk
 * @tags file-extensions, validation, config-warning
 */
export function dottedExtensions(entries: string[], warnings: string[]): string[] | undefined {
  const bad = entries.filter(entry => !entry.startsWith('.'));
  for (const entry of bad) {
    warnings.push(`"fileExtensions" entry "${entry}" in guardian.config.json must start with a dot`);
  }
  return bad.length === 0 ? entries : undefined;
}
