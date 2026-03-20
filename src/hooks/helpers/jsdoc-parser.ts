/**
 * @what Parses JSDoc comments and extracts all tags into structured format
 * @how Uses regex patterns to extract @tag values from JSDoc comment blocks
 * @why Enables validation of JSDoc completeness and accuracy
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain jsdoc, parsing, documentation-validation
 * @tags jsdoc-parser, regex, tag-extraction, documentation, validation-helper
 */

import { JSDocTags, ParamTag } from './types.js';

/**
 * @what Parses a JSDoc comment block and extracts all tags
 * @how Uses regex to find and parse each tag type (@what, @param, @returns, etc.)
 * @why Main entry point for JSDoc parsing used by function-extractor
 *
 * @param {string} jsdocComment The full JSDoc comment including /** and *\/
 * @returns {JSDocTags | null} Parsed tags or null if invalid JSDoc format
 *
 * @sideeffects None
 * @systemlayer Parsing
 * @domain jsdoc-parsing, tag-extraction
 * @tags jsdoc, parser, tag-extraction, regex, validation
 */
export function parseJSDocTags(jsdocComment: string): JSDocTags | null {
  // Remove leading/trailing whitespace
  const trimmed = jsdocComment.trim();

  // Validate it's a JSDoc comment (starts with /** and ends with */)
  if (!trimmed.startsWith('/**') || !trimmed.endsWith('*/')) {
    return null;
  }

  // Remove the /** and */ delimiters and clean up
  const content = trimmed
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map(line => line.trim().replace(/^\*\s?/, '')) // Remove leading * from each line
    .join('\n');

  return {
    what: extractSingleTag(content, 'what'),
    how: extractSingleTag(content, 'how'),
    why: extractSingleTag(content, 'why'),
    params: extractParamTags(content),
    returns: extractSingleTag(content, 'returns'),
    sideeffects: extractSingleTag(content, 'sideeffects'),
    systemlayer: extractSingleTag(content, 'systemlayer'),
    domain: extractSingleTag(content, 'domain'),
    tags: extractTagsList(content)
  };
}

/**
 * @what Extracts a single-line tag value from JSDoc content
 * @how Uses regex to find @tagname and capture everything until next @ or end
 * @why Simple tags like @what, @how, @why are single-value
 *
 * @param {string} content JSDoc content (without /** and *\/)
 * @param {string} tagName Name of tag to extract (without @)
 * @returns {string | undefined} Tag value or undefined if not found
 *
 * @sideeffects None
 * @systemlayer Parsing
 * @domain jsdoc-parsing, regex
 * @tags regex, tag-extraction, jsdoc, single-value
 */
function extractSingleTag(content: string, tagName: string): string | undefined {
  // Match @tagname followed by content until next @ or end
  const pattern = new RegExp(`@${tagName}\\s+([^@]+)`, 'i');
  const match = content.match(pattern);

  if (!match) {
    return undefined;
  }

  // Clean up the captured value (trim whitespace and newlines)
  return match[1].trim().replace(/\s+/g, ' ');
}

/**
 * @what Extracts all @param tags from JSDoc content
 * @how Finds all @param patterns and parses type, name, and description
 * @why Functions can have multiple parameters that all need to be documented
 *
 * @param {string} content JSDoc content (without /** and *\/)
 * @returns {ParamTag[]} Array of parsed param tags (empty if none found)
 *
 * @sideeffects None
 * @systemlayer Parsing
 * @domain jsdoc-parsing, parameter-extraction
 * @tags regex, parameters, jsdoc, multi-value, parsing
 */
function extractParamTags(content: string): ParamTag[] {
  const params: ParamTag[] = [];

  // Match @param {type} name description
  // Also support @param name description (without type)
  const pattern = /@param\s+(?:\{([^}]+)\}\s+)?(\w+)\s+([^@\n]+)/gi;

  let match;
  while ((match = pattern.exec(content)) !== null) {
    params.push({
      type: match[1] || 'any',  // Default to 'any' if type not specified
      name: match[2],
      description: match[3].trim().replace(/\s+/g, ' ')
    });
  }

  return params;
}

/**
 * @what Extracts comma-separated tags from @tags annotation
 * @how Splits tag value by commas and trims whitespace
 * @why @tags contains multiple comma-separated keywords for searchability
 *
 * @param {string} content JSDoc content (without /** and *\/)
 * @returns {string[]} Array of individual tags (empty if @tags not found)
 *
 * @sideeffects None
 * @systemlayer Parsing
 * @domain jsdoc-parsing, tag-splitting
 * @tags regex, tags-list, comma-separated, parsing, searchability
 */
function extractTagsList(content: string): string[] {
  const tagsValue = extractSingleTag(content, 'tags');

  if (!tagsValue) {
    return [];
  }

  // Split by comma and trim each tag
  return tagsValue
    .split(',')
    .map(tag => tag.trim())
    .filter(tag => tag.length > 0);
}

/**
 * @what Validates that all required JSDoc tags are present
 * @how Checks for required tags and minimum tag count
 * @why Enforces documentation standards defined in CLAUDE.md
 *
 * @param {JSDocTags} jsdocTags Parsed JSDoc tags to validate
 * @returns {string[]} Array of missing/invalid tags (empty if all valid)
 *
 * @sideeffects None
 * @systemlayer Validation
 * @domain jsdoc-validation, completeness-check
 * @tags validation, completeness, required-tags, standards-enforcement, quality-check
 */
export function validateJSDocCompleteness(jsdocTags: JSDocTags): string[] {
  const violations: string[] = [];

  // Check required tags
  if (!jsdocTags.what) {
    violations.push('Missing @what tag');
  }

  if (!jsdocTags.how) {
    violations.push('Missing @how tag');
  }

  if (!jsdocTags.why) {
    violations.push('Missing @why tag');
  }

  if (!jsdocTags.returns) {
    violations.push('Missing @returns tag (required for ALL functions, even void)');
  }

  if (!jsdocTags.sideeffects) {
    violations.push('Missing @sideeffects tag (use "None" if no side effects)');
  }

  if (!jsdocTags.systemlayer) {
    violations.push('Missing @systemlayer tag');
  }

  if (!jsdocTags.domain) {
    violations.push('Missing @domain tag');
  }

  // Check @tags has minimum 3 tags
  if (jsdocTags.tags.length < 3) {
    violations.push(`@tags has only ${jsdocTags.tags.length} tags (minimum 3 required, 5 preferred)`);
  }

  return violations;
}

/**
 * @what Validates that required JSDoc tags are present for types/interfaces/enums
 * @how Checks for @what (mandatory) and reports missing recommended tags (@domain, @tags)
 * @why Types need documentation but have relaxed requirements vs functions (no @param, @returns, @sideeffects)
 *
 * @param {JSDocTags} jsdocTags Parsed JSDoc tags to validate
 * @returns {string[]} Array of missing/invalid tags (empty if all valid)
 *
 * @sideeffects None
 * @systemlayer Validation
 * @domain jsdoc-validation, type-completeness
 * @tags validation, completeness, type-jsdoc, standards-enforcement, relaxed-requirements
 */
export function validateTypeJSDocCompleteness(jsdocTags: JSDocTags): string[] {
  const violations: string[] = [];

  // @what is mandatory for types
  if (!jsdocTags.what) {
    violations.push('Missing @what tag (required for types/interfaces/enums)');
  }

  // @how and @why are recommended but not mandatory for types
  // (simple interfaces like { name: string } don't need @how)

  // @domain and @tags are recommended for discoverability
  if (!jsdocTags.domain) {
    violations.push('Missing @domain tag (recommended for types)');
  }

  if (jsdocTags.tags.length < 2) {
    violations.push(`@tags has only ${jsdocTags.tags.length} tags (minimum 2 recommended for types)`);
  }

  return violations;
}

/**
 * @what Extracts function parameter names from function signature
 * @how Uses regex to parse function declaration and extract param names
 * @why Used to validate that @param tags match actual function parameters
 *
 * @param {string} functionCode Function declaration line or full function code
 * @returns {string[]} Array of parameter names found in signature
 *
 * @sideeffects None
 * @systemlayer Parsing
 * @domain code-parsing, parameter-extraction
 * @tags regex, function-signature, parameters, validation-helper, code-analysis
 */
export function extractFunctionParameterNames(functionCode: string): string[] {
  // Match function declaration patterns and extract parameters
  const patterns = [
    /function\s+\w+\s*\(([^)]*)\)/,      // function name(params)
    /const\s+\w+\s*=\s*\(([^)]*)\)\s*=>/, // const name = (params) =>
    /const\s+\w+\s*=\s*function\s*\(([^)]*)\)/, // const name = function(params)
    /^\s*\w+\s*\(([^)]*)\)\s*{/,         // name(params) { (method style)
  ];

  for (const pattern of patterns) {
    const match = functionCode.match(pattern);
    if (match) {
      const paramsString = match[1].trim();

      if (!paramsString) {
        return []; // No parameters
      }

      // Split by comma and extract parameter names (ignore types, defaults, destructuring)
      return paramsString
        .split(',')
        .map(param => {
          // Handle destructuring: {a, b} -> extract first name
          if (param.includes('{')) {
            const destructured = param.match(/\{([^}]+)\}/);
            if (destructured) {
              return destructured[1].split(',')[0].trim().split(':')[0].trim();
            }
          }

          // Handle array destructuring: [a, b] -> extract first name
          if (param.includes('[')) {
            const destructured = param.match(/\[([^\]]+)\]/);
            if (destructured) {
              return destructured[1].split(',')[0].trim();
            }
          }

          // Normal param: name, name: type, name = default
          return param.trim().split(/[=:]/)[0].trim();
        })
        .filter(name => name.length > 0);
    }
  }

  return [];
}
