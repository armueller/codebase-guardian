/**
 * @what Shared TypeScript interfaces for pre-edit validation system
 * @how Defines data structures used across all validation helper modules
 * @why Centralized type definitions ensure consistency and type safety
 *
 * @sideeffects None
 * @systemlayer Type Definitions
 * @domain validation, type-safety, interfaces
 * @tags typescript, interfaces, validation-types, shared-types, type-definitions
 */

/**
 * @what Represents a function extracted from source code with its JSDoc
 * @how Contains function code, JSDoc status, and metadata about how it's being edited
 * @why Used by function-extractor to return structured extraction results
 */
export interface ExtractedFunction {
  name: string;
  fullCode: string;        // JSDoc comment + function body (if JSDoc exists)
  hasJSDoc: boolean;       // Whether JSDoc was found above function
  isNew: boolean;          // Function is being created in this edit (not in old_string)
  isModified: boolean;     // Function existed before and is being modified
  lineInFile: number;      // Line number where function starts in full file
  jsdocTags?: JSDocTags;   // Parsed JSDoc tags (only if hasJSDoc is true)
}

/**
 * @what Represents a parsed JSDoc comment with all tags
 * @how Contains all required and optional JSDoc tags as structured data
 * @why Used by jsdoc-parser to return parsed tags for validation
 */
export interface JSDocTags {
  what?: string;           // @what tag value
  how?: string;            // @how tag value
  why?: string;            // @why tag value
  params: ParamTag[];      // @param tags
  returns?: string;        // @returns tag value
  sideeffects?: string;    // @sideeffects tag value
  systemlayer?: string;    // @systemlayer tag value
  domain?: string;         // @domain tag value
  tags: string[];          // @tags comma-separated values
}

/**
 * @what Represents a single @param tag from JSDoc
 * @how Contains parameter name, type, and description
 * @why Used to validate function parameters match their documentation
 */
export interface ParamTag {
  name: string;
  type: string;
  description: string;
}

/**
 * @what Represents a property access in code (e.g., order.assetClass)
 * @how Contains object name and property name
 * @why Used to validate property accesses against researched models
 */
export interface PropertyAccess {
  object: string;          // Object/variable name (e.g., "order")
  property: string;        // Property being accessed (e.g., "assetClass")
}

/**
 * @what Result of validation by headless Claude
 * @how Contains decision (allow/deny), violations, and reasoning
 * @why Returned by executeClaudeHeadless and used to block/allow edits
 */
export interface ValidationResult {
  decision: 'allow' | 'deny';
  violations: string[];    // List of specific issues found
  suggestions: string[];   // Non-blocking improvement suggestions (logged, not enforced)
  reasoning: string;       // Brief explanation of the decision
}

/**
 * @what Cache entry for storing validation results
 * @how Contains validation result and timestamp for TTL checking
 * @why Used by validation-cache to store and retrieve cached results
 */
export interface CacheEntry {
  result: ValidationResult;
  timestamp: number;       // Unix timestamp when cached
  filePath?: string;       // File path for targeted cache invalidation
}

/**
 * @what Input data received by the hook from Claude Code
 * @how Matches the JSON structure passed to PreToolUse hooks via stdin
 * @why Used to parse hook input and extract edit details
 */
export interface HookInput {
  session_id: string;
  tool_name: string;       // "Edit", "Write", etc.
  tool_input: {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    content?: string;      // For Write operations
    replace_all?: boolean; // For Edit operations with replace_all flag
    edits?: Array<{
      old_string: string;
      new_string: string;
    }>;
  };
}

/**
 * @what Output format for hook responses to Claude Code
 * @how Contains action (allow/deny/ask) and optional details
 * @why Used to communicate validation decision back to Claude Code
 */
export interface HookResponse {
  action: 'allow' | 'deny' | 'ask';
  message?: string;
  violations?: string[];
  suggestions?: string[];
}

/**
 * @what Response from headless Claude validation
 * @how Contains decision, violations, and reasoning in structured format
 * @why Returned by claude-headless.ts after parsing Claude's JSON response
 */
export interface ClaudeValidationResponse {
  decision: 'allow' | 'deny';
  violations: string[];
  suggestions: string[];   // Non-blocking improvement suggestions
  reasoning: string;
}

/**
 * @what Metadata about functions identified in an edit
 * @how Categorizes functions as called, modified, or created
 * @why Used by code-analyzer to organize function usage for validation
 */
export interface FunctionUsageAnalysis {
  called: string[];        // Functions called in the new code
  modified: string[];      // Functions that existed and were changed
  created: string[];       // Functions that are new in this edit
}

/**
 * @what Represents an interface, type alias, or enum extracted from source code with its JSDoc
 * @how Contains type code, JSDoc status, and metadata about how it's being edited
 * @why Used by function-extractor to return structured extraction results for types alongside functions
 */
export interface ExtractedType {
  name: string;
  kind: 'interface' | 'type' | 'enum';
  fullCode: string;        // JSDoc comment + type body
  hasJSDoc: boolean;
  isNew: boolean;
  isModified: boolean;
  lineInFile: number;
  jsdocTags?: JSDocTags;
}

/**
 * @what Metadata about types/interfaces/enums identified in an edit
 * @how Categorizes types as modified or created by comparing old vs new code
 * @why Used by code-analyzer to organize type usage for validation
 */
export interface TypeUsageAnalysis {
  modified: string[];      // Types that existed and were changed
  created: string[];       // Types that are new in this edit
}

/**
 * @what A declared type with its kind, used by extractDeclaredTypes
 * @how Stores the name and declaration kind (interface/type/enum) for each type found in code
 * @why Needed to pass kind information from extraction to JSDoc extraction step
 */
export interface DeclaredType {
  name: string;
  kind: 'interface' | 'type' | 'enum';
}
