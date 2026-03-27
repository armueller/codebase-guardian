/**
 * @what Executes Claude Code CLI in headless mode for code quality enforcement
 * @how Manages headless Claude sessions with --resume support, comprehensive system prompt, and response parsing
 * @why Leverages Claude's semantic understanding to enforce DRY, JSDoc, pattern consistency, and README compliance
 *
 * @sideeffects Executes Claude CLI subprocess, writes temp files, reads/writes session store
 * @systemlayer External Integration
 * @domain code-quality, ai-validation, session-management, dry-enforcement
 * @tags claude-cli, headless-execution, ai-validation, session-resume, code-quality
 */

import { execFileSync } from 'child_process';
import { appendFileSync } from 'fs';
import { ClaudeValidationResponse, ExtractedFunction, ExtractedType, PropertyAccess } from './types.js';
import type { PatternContext, FunctionResult } from './code-index-client.js';
import {
  getSession,
  setSession,
  clearSession,
  cleanExpiredSessions
} from './validation-sessions.js';
import { resolveConfig } from '../../config.js';

const LOG_PATH = resolveConfig().logPath;

function log(message: string): void {
  try {
    appendFileSync(LOG_PATH, message + '\n');
  } catch {
    // Ignore logging errors
  }
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a code quality enforcement agent for a TypeScript codebase. Your role is to analyze code edits and enforce code quality standards. You will receive code being edited alongside rich context from a semantic code index (function metadata, similar functions, directory patterns, README documentation, call graphs).

Your response must be ONLY a JSON object — no markdown, no explanation text, no code blocks. Just the raw JSON.

## Code Quality Principles (in order of importance)

### 1. DRY — Don't Repeat Yourself (PRIMARY)

This is the single most important check. The semantic code index exists specifically to prevent duplicate code.

You will receive "SIMILAR EXISTING FUNCTIONS" found by full-text search in the code index. For each new or modified function, evaluate:

- **Does an existing function already do the same thing?** If yes, the edit MUST use the existing function instead of writing a new one. This is a HARD VIOLATION.
- **Does an existing function do something very similar?** If yes, consider whether the existing function could be extended or composed with rather than duplicating logic. Flag this as a violation with a specific recommendation.
- **Is the new function a legitimate new capability?** If the function genuinely does something no existing function does, it's fine. Allow it.

When evaluating similarity, consider:
- Function descriptions (the @what tag content in the code index)
- Domain overlap (same business domain = higher risk of duplication)
- Parameter signatures (similar inputs often mean similar purpose)
- Return types (similar outputs often mean similar purpose)
- File location (same directory = highest risk of duplication)

You may also receive "SIMILAR INLINE COMMENTS" — these are comments from other functions that describe similar step-level logic. If a comment in the new code describes a step that another function already implements, this suggests the developer should extract that logic into a shared helper or reuse the existing function. Flag this as a DRY concern (not a hard violation — use judgment based on complexity and whether the logic is substantial enough to warrant extraction).

DRY violations should include:
- The name and location of the existing function that already does this
- A specific recommendation: "Use existingFunction() from path/to/file.ts instead"

### 2. JSDoc Completeness (CRITICAL)

The code index depends entirely on JSDoc for searchability. Every function MUST have complete JSDoc with ALL of these tags:

- \`@what\` — Brief description of what the function does
- \`@how\` — Technical details of how it accomplishes the task
- \`@why\` — Business/architectural reason why this function exists
- \`@param {type} name description\` — For EACH parameter (skip only if function has zero params)
- \`@returns {type} description\` — ALWAYS required, even for void functions ("returns void")
- \`@sideeffects\` — "None" if pure, or list of side effects (API calls, state mutations, DB writes, file I/O)
- \`@systemlayer\` — One of: UI Helper, Business Logic, Data Layer, API, Validation, Utility, Hook, etc.
- \`@domain\` — Business domain(s), comma-separated (e.g., "options-trading, calculations")
- \`@tags\` — Minimum 3 comma-separated searchable keywords (5 preferred for discoverability)

If the input includes locally-detected "JSDoc Issues" for a function, those are confirmed violations from static analysis. Include them verbatim in your violations list — do not second-guess them.

A function with no JSDoc at all (marked "JSDoc: MISSING") is ALWAYS a violation.

### 2b. Type/Interface/Enum JSDoc (CRITICAL)

Interfaces, type aliases, and enums also require JSDoc — but with RELAXED requirements compared to functions:

**Required for types:**
- \`@what\` — Brief description of what the type represents (MANDATORY)

**Recommended for types (flag as violations if missing):**
- \`@domain\` — Business domain for discoverability
- \`@tags\` — Minimum 2 searchable keywords

**NOT required for types** (unlike functions):
- \`@how\`, \`@why\` — Simple types don't need implementation details
- \`@param\`, \`@returns\`, \`@sideeffects\` — Types don't have parameters or side effects
- \`@systemlayer\` — Optional for types

A type/interface/enum with no JSDoc at all is ALWAYS a violation. The \`@what\` tag is the minimum.

### 3. JSDoc Accuracy (CRITICAL for modified functions)

Stale documentation is worse than no documentation — it actively misleads developers and corrupts the code index. When a function is marked as MODIFIED:

- \`@what\` must describe what the code does NOW, not what it used to do
- \`@how\` must reflect the current implementation approach
- \`@param\` tags must match current parameter names, types, and count exactly
- \`@returns\` must match the current return type and value
- \`@sideeffects\` must reflect current side effects (if code now makes API calls but JSDoc says "None", that's a violation)
- \`@domain\` and \`@tags\` should reflect current functionality

Examples of accuracy violations:
- @what says "calculates profit" but code now calculates profit WITH fees deducted
- @param lists "price: number" but parameter was renamed to "priceData: PriceInfo"
- @returns says "string" but function now returns "Promise<string>"
- Code was changed to write to a database but @sideeffects still says "None"
- A new parameter was added to the function but no @param tag exists for it

### 3c. Inline Comment Quality (IMPORTANT)

Inline comments within function bodies are indexed for sub-function-level DRY detection. Short, vague comments are invisible to search and waste index space. When reviewing code, check inline comments for quality:

**Violations (deny):**
- Step comments under 20 characters that describe nothing useful: \`// Parse JSON\`, \`// Update\`, \`// Calculate\`
  - Fix: Describe what and why: \`// Parse decompressed string as typed JSON object\`
- Single-word category labels with no context: \`// Assets\`, \`// Metadata\`
  - Fix: Add context: \`// Balance sheet asset fields (current + non-current)\`

**Warnings only (allow, but note in reasoning):**
- Section header comments (e.g., \`// Stock adjustments\`, \`// Operating Activities\`) that are short but immediately followed by self-explanatory code. These are organizational, not descriptive — prefer longer headers but don't block for them.

**Not violations (allow):**
- Short end-of-line clarifications: \`const rate = 0.005; // 0.5% per transaction\`
- eslint-disable comments, TODO/FIXME markers
- Comments that are genuinely self-evident from context and short by nature

Use judgment: the goal is that someone searching the comment index for "group options by ticker" or "calculate fee threshold" would find relevant matches. If a comment wouldn't help with that, it should be more descriptive.

### 4. Pattern Consistency (IMPORTANT)

Code should follow conventions established in its directory. You will receive sibling functions and aggregated directory patterns. Evaluate:

- **Naming**: Do sibling functions follow a pattern (e.g., calculate*, format*, validate*)? Does the new function follow it? Only flag CLEAR mismatches (e.g., snake_case in a camelCase directory), not minor style differences.
- **Domain coherence**: Does the function's @domain make sense for this directory? A trading helper with @domain "authentication" is suspicious. But new domains are OK if the function genuinely introduces new capability.
- **System layer**: Does @systemlayer match what siblings use? A "UI Helper" function in a data layer directory should be flagged.
- **Side effects**: If the directory contains only pure functions (no side effects), introducing side effects should be deliberate and justified.

### 5. Documentation Compliance (IMPORTANT)

You may receive two types of documentation in the context:

**Directory README**: Local rules for the directory being edited. Examples:
- "All helpers must be pure functions" — new function with side effects → violation
- "Use handler-per-asset-class pattern" — new function using switch/case on asset class → violation
- "Controllers should not call DynamoDB directly" — direct DynamoDB call in a controller → violation

**Relevant Project Documentation** (best practices, patterns, architecture guides): Project-wide rules matched by domain/tag overlap. These contain standardized approaches the project follows. Examples:
- Financial Calculation Pattern documents fee structures and gain/loss patterns
- Error Response Standardization documents the error format all API routes must follow
- Batch Processing with Size Limits documents the chunking strategy for large operations

For both types: only flag CLEAR violations of explicitly documented rules. If documentation is provided, check whether the edit follows its guidance. If no documentation is provided, skip this check.

### 6. Blast Radius Awareness (IMPORTANT)

You will receive callers of modified functions (from the call graph). When a function signature or behavior changes:
- Are callers likely to break? (parameter changes, return type changes, removed exports)
- Is the side effect profile changing in a way that affects callers?
- Flag specific callers that may be affected, with the file path

This is informational — it helps the developer understand impact. Flag as a violation only if the change clearly breaks callers.

## Decision Logic

Apply these rules in order:
1. If ANY DRY violation exists (duplicate function found) → \`"decision": "deny"\`
2. If ANY JSDoc completeness or accuracy violation exists → \`"decision": "deny"\`
3. If ANY inline comment quality violation exists (vague section headers, useless short comments) → \`"decision": "deny"\`
4. If ANY clear pattern/README/naming violation exists → \`"decision": "deny"\`
5. If only blast radius concerns exist (informational) → \`"decision": "allow"\` but list concerns in violations as warnings
6. If no violations → \`"decision": "allow"\`

## Output Format

Return ONLY this JSON structure:
{
  "decision": "allow" or "deny",
  "violations": ["Specific violation 1 with function name and details", "..."],
  "suggestions": ["Non-blocking improvement suggestion 1", "..."],
  "reasoning": "One or two sentence summary of your assessment"
}

Rules for the violations array (hard violations — cause "deny"):
- Each violation must be SPECIFIC: include the function name, what's wrong, and what to do about it
- Good: "Function 'calculateProfit' duplicates existing 'calcProfit' in app/helpers/calc.ts:45 — use the existing function instead"
- Good: "Function 'formatDate' missing @returns tag — add @returns {string} with description"
- Bad: "Missing JSDoc" (too vague)
- Bad: "Code quality issue" (not actionable)
- If no violations, return an empty array []

Rules for the suggestions array (soft recommendations — do NOT cause "deny"):
- These are non-blocking improvements you noticed but that don't warrant blocking the edit
- Examples: "Function 'processOrder' @tags could include 'order-processing' for better discoverability"
- Examples: "Consider extracting the retry logic in 'submitOrder' into a shared utility — similar pattern exists in 'retryWithBackoff'"
- If no suggestions, return an empty array []

## Important Guardrails

- Do NOT invent violations that aren't supported by the context provided
- Do NOT flag third-party imports, React hooks, or built-in JS/TS functions as "not found in index"
- Be STRICT on DRY and JSDoc — these are the foundation of code quality
- Be PRAGMATIC on pattern consistency — flag clear violations, not style nitpicks
- When in doubt about DRY: if two functions have >70% overlapping logic, it's a violation
- When in doubt about JSDoc: err on the side of denying (documentation is critical)
- When in doubt about patterns: err on the side of allowing (patterns evolve)

## New File Validation

When the prompt indicates a NEW FILE is being created, you will receive the full file content. New files are held to the SAME standards as edits — if not higher, because this is the first chance to get it right:

- **Every exported function or handler** must have complete JSDoc — even if it's wrapped in a middleware function, HOC, or factory pattern. The JSDoc goes on the exported const or function declaration, not the inner implementation. Non-function constants (e.g., React contexts via createContext, configuration objects, string constants) do NOT require JSDoc.
- **Framework conventions**: API routes, loaders, actions, handlers — whatever the framework pattern is, the exported entry point needs JSDoc describing what the endpoint does, its parameters, return value, and side effects.
- **DRY**: Check similar existing functions from the code index. If this new file duplicates logic that already exists, flag it.
- **Pattern consistency**: Check sibling functions and directory patterns. The new file should follow established conventions in its directory.
- **All the same rules apply**: JSDoc completeness, accuracy, inline comment quality, pattern consistency, README compliance.

Do NOT give new files a pass just because they're new. Apply the same rigor as any edit.

## Session Continuity

You may be resumed with \`--resume\` to validate a revised edit after a previous denial. When this happens:
- You already have full context from the previous validation (system prompt, code index data, your analysis)
- The new message will contain the updated edit code and any updated JSDoc issues
- Check whether your PREVIOUS violations have been addressed
- Check for any NEW violations introduced by the changes
- Be explicit: "Previous violation X has been addressed" or "Previous violation X is still present"`;

// ─── Execution ───────────────────────────────────────────────────────────────

/**
 * @what Executes headless Claude for code quality validation, with session resume support
 * @how On first attempt: full prompt with code index context. On retries: resumes existing session with just the updated edit.
 * @why Session continuity avoids re-analyzing code index context from scratch on every retry
 *
 * @param {object} params Execution parameters
 * @param {string} params.outerSessionId The outer Claude session ID (from hook input)
 * @param {string} params.filePath File being edited
 * @param {string} params.prompt The validation prompt (full context on first attempt, just edit on retry)
 * @param {boolean} params.isRetry Whether this is a retry (has existing headless session)
 * @param {number} params.timeoutMs Timeout in milliseconds (default 30000)
 * @returns {Promise<ClaudeValidationResponse>} Parsed validation decision
 *
 * @sideeffects Executes Claude CLI subprocess, writes/deletes temp files, reads/writes session store
 * @systemlayer Integration
 * @domain claude-execution, session-management, code-quality
 * @tags claude-cli, subprocess, session-resume, timeout-handling, error-handling
 */
export async function executeClaudeHeadless(params: {
  outerSessionId: string;
  filePath: string;
  prompt: string;
  isRetry: boolean;
  timeoutMs?: number;
}): Promise<ClaudeValidationResponse> {
  const { outerSessionId, filePath, prompt, isRetry, timeoutMs = 30000 } = params;
  const sessionKey = `${outerSessionId}:${filePath}`;
  const overallStart = Date.now();

  // Clean expired sessions periodically
  cleanExpiredSessions();

  // Check for existing headless session to resume
  const existingSession = isRetry ? getSession(sessionKey) : null;

  if (existingSession) {
    log(`  [HEADLESS] Resuming session ${existingSession.headlessSessionId} (attempt #${existingSession.attemptCount + 1})`);
    return executeWithResume(existingSession.headlessSessionId, prompt, sessionKey, existingSession.attemptCount, timeoutMs, overallStart);
  }

  log(`  [HEADLESS] First attempt for ${sessionKey}`);
  return executeFirstAttempt(prompt, sessionKey, timeoutMs, overallStart);
}

/**
 * @what Executes the first headless Claude validation for a file (full context)
 * @how Writes system prompt and user prompt to temp files, runs claude CLI, captures session ID for future resume
 * @why First attempt needs full code index context — subsequent attempts resume this session
 *
 * @param {string} prompt Full validation prompt with code index context
 * @param {string} sessionKey The session store key ({outerSessionId}:{filePath})
 * @param {number} timeoutMs Timeout in milliseconds
 * @param {number} overallStart Start timestamp for timing logs
 * @returns {Promise<ClaudeValidationResponse>} Parsed validation decision
 *
 * @sideeffects Executes Claude CLI subprocess via execFileSync, writes session store
 * @systemlayer Integration
 * @domain claude-execution, first-attempt, session-creation
 * @tags claude-cli, first-attempt, session-store, execFileSync, full-context
 */
async function executeFirstAttempt(
  prompt: string,
  sessionKey: string,
  timeoutMs: number,
  overallStart: number
): Promise<ClaudeValidationResponse> {
  try {
    log(`  [HEADLESS] Starting first attempt with ${timeoutMs}ms timeout...`);
    const t2 = Date.now();
    const result = execFileSync('claude', [
      '-p', prompt,
      '--system-prompt', SYSTEM_PROMPT,
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
      '--model', 'opus'
    ], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      cwd: resolveConfig().projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: '', SKIP_SESSION_HOOKS: 'true' }
    });
    log(`  [HEADLESS] execFileSync completed: ${Date.now() - t2}ms`);

    const { response, headlessSessionId } = parseClaudeOutput(result);
    log(`  [HEADLESS] TOTAL TIME: ${Date.now() - overallStart}ms`);

    // Store the headless session ID for future resume
    if (headlessSessionId) {
      setSession(sessionKey, headlessSessionId, 1);
      log(`  [HEADLESS] Stored session ${headlessSessionId} for ${sessionKey}`);
    }

    // Clear session on allow (no need to resume a successful validation)
    if (response.decision === 'allow') {
      clearSession(sessionKey);
    }

    return response;
  } catch (error) {
    return handleExecutionError(error, timeoutMs, overallStart);
  }
}

/**
 * @what Resumes an existing headless Claude session with an updated edit
 * @how Uses claude --resume with the stored session ID, sends only the new edit prompt
 * @why Resumed sessions already have system prompt, code index context, and previous reasoning — much faster and richer
 *
 * @param {string} headlessSessionId The headless Claude session ID to resume
 * @param {string} prompt The retry prompt (just the updated edit + JSDoc issues)
 * @param {string} sessionKey The session store key
 * @param {number} previousAttemptCount Number of previous attempts
 * @param {number} timeoutMs Timeout in milliseconds
 * @param {number} overallStart Start timestamp for timing logs
 * @returns {Promise<ClaudeValidationResponse>} Parsed validation decision
 *
 * @sideeffects Executes Claude CLI subprocess via execFileSync, updates session store
 * @systemlayer Integration
 * @domain claude-execution, session-resume, retry-validation
 * @tags claude-cli, session-resume, retry, continuity, context-preservation
 */
async function executeWithResume(
  headlessSessionId: string,
  prompt: string,
  sessionKey: string,
  previousAttemptCount: number,
  timeoutMs: number,
  overallStart: number
): Promise<ClaudeValidationResponse> {
  try {
    log(`  [HEADLESS] Resuming session ${headlessSessionId} (attempt #${previousAttemptCount + 1})...`);
    const t2 = Date.now();
    const result = execFileSync('claude', [
      '--resume', headlessSessionId,
      '-p', prompt,
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
      '--model', 'opus'
    ], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      cwd: resolveConfig().projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: '', SKIP_SESSION_HOOKS: 'true' }
    });
    log(`  [HEADLESS] Resume execFileSync completed: ${Date.now() - t2}ms`);

    const { response } = parseClaudeOutput(result);
    log(`  [HEADLESS] TOTAL TIME (resume): ${Date.now() - overallStart}ms`);

    // Update attempt count
    setSession(sessionKey, headlessSessionId, previousAttemptCount + 1);

    // Clear session on allow
    if (response.decision === 'allow') {
      clearSession(sessionKey);
      log(`  [HEADLESS] Validation passed — cleared session for ${sessionKey}`);
    }

    return response;
  } catch (error) {
    // If resume fails (session expired, etc.), fall back to logging the error
    // The caller (pre-edit-validation-ai.ts) will handle fallback to fresh validation
    log(`  [HEADLESS] Resume failed for session ${headlessSessionId}: ${error instanceof Error ? error.message : String(error)}`);

    // Clear the invalid session
    clearSession(sessionKey);

    return handleExecutionError(error, timeoutMs, overallStart);
  }
}

/**
 * @what Handles execution errors from headless Claude (timeout, crash, etc.)
 * @how Classifies error type and throws appropriate error or returns fail-open response
 * @why Consistent error handling across first-attempt and resume paths
 *
 * @param {unknown} error The error from execSync
 * @param {number} timeoutMs The timeout that was configured
 * @param {number} overallStart Start timestamp for timing logs
 * @returns {never} Always throws — caller decides fail-open behavior
 *
 * @sideeffects Writes to log file
 * @systemlayer Error Handling
 * @domain error-classification, timeout-detection
 * @tags error-handling, timeout, crash-recovery, fail-open, logging
 */
function handleExecutionError(error: unknown, timeoutMs: number, overallStart: number): never {
  log(`  [HEADLESS] ERROR after ${Date.now() - overallStart}ms`);
  log(`  [HEADLESS] Error type: ${error instanceof Error ? error.name : typeof error}`);
  log(`  [HEADLESS] Error message: ${error instanceof Error ? error.message : String(error)}`);

  if (error instanceof Error && (error.message.includes('ETIMEDOUT') || error.message.includes('timed out'))) {
    throw new Error(`Claude validation timed out after ${timeoutMs}ms`);
  }

  throw error instanceof Error ? error : new Error(String(error));
}



// ─── Response Parsing ────────────────────────────────────────────────────────

/**
 * @what Parses raw Claude CLI output into validation response and session ID
 * @how Unwraps Claude CLI JSON envelope, extracts session_id and validation JSON from response text
 * @why Claude CLI wraps responses in an envelope with metadata — we need both the response and the session ID for resume
 *
 * @param {string} rawOutput Raw JSON output from Claude CLI
 * @returns {{ response: ClaudeValidationResponse; headlessSessionId: string | null }} Parsed response and session ID
 *
 * @sideeffects None
 * @systemlayer Response Parsing
 * @domain json-parsing, response-extraction, session-extraction
 * @tags json-parsing, response-handling, session-id, envelope-unwrapping, validation-result
 */
export function parseClaudeOutput(rawOutput: string): {
  response: ClaudeValidationResponse;
  headlessSessionId: string | null;
} {
  try {
    const claudeResponse = JSON.parse(rawOutput);

    // Extract session ID for resume support
    const headlessSessionId: string | null = claudeResponse.session_id || null;

    // Extract the response text from the envelope
    let responseText = '';

    if (claudeResponse.result) {
      responseText = claudeResponse.result;
    } else if (claudeResponse.response) {
      responseText = claudeResponse.response;
    } else if (claudeResponse.content && Array.isArray(claudeResponse.content)) {
      const textContent = claudeResponse.content.find((c: { text?: string }) => c.text);
      responseText = textContent?.text || '';
    } else {
      responseText = rawOutput;
    }

    // Extract JSON from markdown code blocks if Claude wrapped it
    const codeBlockMatch = responseText.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    let jsonText = '';

    if (codeBlockMatch) {
      jsonText = codeBlockMatch[1];
    } else {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Could not extract JSON from Claude response');
      }
      jsonText = jsonMatch[0];
    }

    const validation = JSON.parse(jsonText);

    if (!validation.decision || !Array.isArray(validation.violations)) {
      throw new Error('Invalid validation response format from Claude');
    }

    // Normalize decision — headless Claude sometimes returns "approve" or "pass" instead of "allow"
    const rawDecision = String(validation.decision).toLowerCase();
    const normalizedDecision: 'allow' | 'deny' = (rawDecision === 'allow' || rawDecision === 'approve' || rawDecision === 'pass') ? 'allow' : 'deny';

    return {
      response: {
        decision: normalizedDecision,
        violations: validation.violations,
        suggestions: Array.isArray(validation.suggestions) ? validation.suggestions : [],
        reasoning: validation.reasoning || 'No reasoning provided'
      },
      headlessSessionId
    };
  } catch (error) {
    throw new Error(
      `Failed to parse Claude response: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

/**
 * @what Formats a FunctionResult from the code index into a concise string for the prompt
 * @how Extracts name, file, domains, systemlayers, side_effects, and description into a single line
 * @why Keeps the prompt compact while providing enough context for code quality judgment
 *
 * @param {FunctionResult} func Function data from code index
 * @returns {string} Formatted single-line summary
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain prompt-formatting, data-serialization
 * @tags formatting, prompt-helper, concise, function-summary, utility
 */
function formatIndexedFunction(func: FunctionResult): string {
  const parts = [`${func.name} (${func.file_path}:${func.line_number})`];
  if (func.domains.length > 0) parts.push(`domains=[${func.domains.join(',')}]`);
  if (func.systemlayers.length > 0) parts.push(`layers=[${func.systemlayers.join(',')}]`);
  if (func.side_effects && func.side_effects.toLowerCase() !== 'none') {
    parts.push(`side_effects="${func.side_effects}"`);
  }
  if (func.description) {
    const desc = func.description.length > 150 ? func.description.slice(0, 150) + '...' : func.description;
    parts.push(`— ${desc}`);
  }
  return parts.join(' ');
}

/**
 * @what Builds the full first-attempt validation prompt with all code index context
 * @how Assembles extracted functions, code index context (README, siblings, similar functions, callers, patterns), and JSDoc issues
 * @why First attempt needs complete context — system prompt has the rules, this prompt has the data
 *
 * @param {object} context Validation context with code being edited and code index data
 * @returns {string} Complete data prompt for first-attempt validation
 *
 * @sideeffects None
 * @systemlayer Prompt Engineering
 * @domain prompt-building, context-assembly, code-quality
 * @tags prompt-engineering, first-attempt, full-context, code-index, validation-prompt
 */
export function buildFirstAttemptPrompt(context: {
  filePath: string;
  extractedFunctions: ExtractedFunction[];
  extractedTypes: ExtractedType[];
  calledFunctions: string[];
  propertyAccesses: PropertyAccess[];
  patternContext: PatternContext;
  jsdocViolations: Map<string, string[]>;
  typeJsdocViolations: Map<string, string[]>;
  isNewFile?: boolean;
  fullFileContent?: string;
  deletedFunctions?: string[];
}): string {
  const { filePath, extractedFunctions, extractedTypes, propertyAccesses, patternContext, jsdocViolations, typeJsdocViolations } = context;

  // ── Functions being edited ──
  const functionsSection = extractedFunctions
    .map(func => {
      const jsdocIssues = jsdocViolations.get(func.name);
      let jsdocStatus: string;
      if (!func.hasJSDoc) {
        jsdocStatus = 'JSDoc: MISSING (confirmed violation)';
      } else if (jsdocIssues && jsdocIssues.length > 0) {
        jsdocStatus = `JSDoc Issues (confirmed by static analysis):\n${jsdocIssues.map(v => `  - ${v}`).join('\n')}`;
      } else {
        jsdocStatus = 'JSDoc: Complete (all required tags present)';
      }

      return `Function: ${func.name}
Status: ${func.isNew ? 'NEW' : 'MODIFIED'}
${jsdocStatus}

Code:
\`\`\`typescript
${func.fullCode}
\`\`\``;
    })
    .join('\n\n---\n\n');

  // ── Types/interfaces being edited ──
  let typesSection = '';
  if (extractedTypes.length > 0) {
    typesSection = extractedTypes
      .map(type => {
        const typeViolations = typeJsdocViolations.get(type.name);
        let jsdocStatus: string;
        if (!type.hasJSDoc) {
          jsdocStatus = 'JSDoc: MISSING (confirmed violation)';
        } else if (typeViolations && typeViolations.length > 0) {
          jsdocStatus = `JSDoc Issues (confirmed by static analysis):\n${typeViolations.map(v => `  - ${v}`).join('\n')}`;
        } else {
          jsdocStatus = 'JSDoc: Complete';
        }

        return `${type.kind.charAt(0).toUpperCase() + type.kind.slice(1)}: ${type.name}
Status: ${type.isNew ? 'NEW' : 'MODIFIED'}
${jsdocStatus}

Code:
\`\`\`typescript
${type.fullCode}
\`\`\``;
      })
      .join('\n\n---\n\n');
  }

  // ── Relevant project documentation ──
  let relevantDocsSection = '';
  if (patternContext.relevantDocs.length > 0) {
    relevantDocsSection = patternContext.relevantDocs
      .map(doc => {
        let entry = `- **${doc.name}** (${doc.filePath})\n  Matched: domains=[${doc.matchedDomains.join(',')}] tags=[${doc.matchedTags.join(',')}]\n  ${doc.descriptionPreview}`;
        if (doc.sections && doc.sections.length > 0) {
          for (const section of doc.sections) {
            entry += `\n  ### ${section.heading}\n  ${section.body}`;
          }
        }
        return entry;
      })
      .join('\n\n');
  }

  // ── Deleted functions (excluded from DRY analysis) ──
  const deletedSection = context.deletedFunctions && context.deletedFunctions.length > 0
    ? `\n== FUNCTIONS BEING DELETED BY THIS EDIT ==\n\nThe following functions are being REMOVED from the file by this edit. Do NOT flag JSDoc issues, DRY violations, or any other problems with these functions — they will no longer exist after the edit lands:\n${context.deletedFunctions.map(name => `- ${name}`).join('\n')}\n\nIf a "similar existing function" from the code index matches one of these deleted function names, IGNORE it for DRY analysis — it is stale index data that will be cleaned up on the next index rebuild.\n`
    : '';

  // ── Similar existing functions (DRY enforcement) ──
  let similarSection: string;
  if (patternContext.similarExistingFunctions.size > 0) {
    const entries: string[] = [];
    for (const [funcName, similarFuncs] of patternContext.similarExistingFunctions) {
      entries.push(`Similar functions found for "${funcName}":`);
      for (const f of similarFuncs) {
        entries.push(`  - ${formatIndexedFunction(f)}`);
      }
    }
    similarSection = entries.join('\n');
  } else {
    similarSection = '(no similar functions found in the code index — likely genuinely new capability)';
  }

  // ── Similar inline comments (step-level DRY) ──
  let similarCommentsSection = '';
  if (patternContext.similarComments.length > 0) {
    const entries: string[] = [];
    for (const cm of patternContext.similarComments) {
      entries.push(`Edit comment: "${cm.editComment}"`);
      for (const m of cm.matches) {
        entries.push(`  Similar in: ${m.functionName} (${m.filePath})`);
        entries.push(`    Comment: "${m.commentText}"`);
      }
    }
    similarCommentsSection = entries.join('\n');
  }

  // ── Directory README ──
  const readmeSection = patternContext.directoryReadme
    ? patternContext.directoryReadme
    : '(No README found for this directory — skip README compliance check)';

  // ── Sibling functions ──
  const siblingSection = patternContext.siblingFunctions.length > 0
    ? patternContext.siblingFunctions.slice(0, 20).map(f => `- ${formatIndexedFunction(f)}`).join('\n')
    : '(no sibling functions found in directory)';

  // ── Called functions from index ──
  const knownCalledSection = patternContext.calledFunctionDetails.size > 0
    ? Array.from(patternContext.calledFunctionDetails.values())
        .map(f => `- ${formatIndexedFunction(f)}`)
        .join('\n')
    : '(none resolved from code index)';

  const unknownCalledSection = patternContext.unknownCalledFunctions.length > 0
    ? patternContext.unknownCalledFunctions.join(', ')
    : '(all called functions resolved)';

  // ── Callers (blast radius) ──
  const callersSection = patternContext.callerDetails.size > 0
    ? Array.from(patternContext.callerDetails.entries())
        .map(([funcName, callers]) =>
          `- ${funcName} is called by: ${callers.map(c => `${c.name} (${c.file_path})`).join(', ')}`
        )
        .join('\n')
    : '(no callers found for modified functions)';

  // ── Directory patterns ──
  const patterns = patternContext.directoryPatterns;
  const patternsSection = [
    `Common domains: ${patterns.commonDomains.join(', ') || '(none)'}`,
    `Common system layers: ${patterns.commonSystemLayers.join(', ') || '(none)'}`,
    `Common tags: ${patterns.commonTags.join(', ') || '(none)'}`,
    `Side effects in directory: ${patterns.hasSideEffects ? 'Yes (some functions have side effects)' : 'No (pure functions directory)'}`,
    `Naming examples: ${patterns.namingExamples.join(', ') || '(none)'}`,
  ].join('\n');

  // ── Property accesses ──
  const propertiesSection = propertyAccesses.length > 0
    ? propertyAccesses.map(p => `- ${p.object}.${p.property}`).join('\n')
    : '(none detected)';

  // ── New file section ──
  const newFileSection = context.isNewFile && context.fullFileContent
    ? `\n== NEW FILE — FULL CONTENT ==\n\nThis is a NEW FILE being created. Validate the ENTIRE file for code quality:\n- All exported functions MUST have complete JSDoc (non-function constants like React contexts, config objects do NOT require JSDoc)\n- Code must follow directory patterns and project conventions\n- Check for DRY violations against similar existing functions\n- Wrapped/decorated functions (HOCs, middleware wrappers, factory patterns) still require JSDoc on the exported declaration\n\n\`\`\`typescript\n${context.fullFileContent}\n\`\`\`\n`
    : '';

  return `FILE: ${filePath}${context.isNewFile ? ' (NEW FILE)' : ''}
${newFileSection}${deletedSection}
== FUNCTIONS BEING EDITED ==

${functionsSection}
${typesSection ? `\n== TYPES/INTERFACES BEING EDITED ==\n\n${typesSection}\n` : ''}
== SIMILAR EXISTING FUNCTIONS (DRY CHECK — most important) ==

${similarSection}
${similarCommentsSection ? `\n== SIMILAR INLINE COMMENTS (sub-function DRY check) ==\n\n${similarCommentsSection}\n` : ''}
== DIRECTORY README (pattern documentation) ==

${readmeSection}
${relevantDocsSection ? `\n== RELEVANT DOCUMENTATION (pattern guides, best practices) ==\n\n${relevantDocsSection}\n` : ''}

== SIBLING FUNCTIONS (same directory — established patterns) ==

${siblingSection}

== CALLED FUNCTIONS (resolved from code index) ==

${knownCalledSection}

Unresolved (not in code index — may be third-party imports, React hooks, built-ins):
${unknownCalledSection}

== CALLERS OF MODIFIED FUNCTIONS (blast radius) ==

${callersSection}

== DIRECTORY PATTERNS (aggregated from sibling functions) ==

${patternsSection}

== PROPERTY ACCESSES IN EDIT ==

${propertiesSection}

Validate this edit against the code quality rules in your system prompt and return the JSON result.`;
}

/**
 * @what Builds the retry prompt for a resumed headless Claude session
 * @how Includes only the updated edit code and any JSDoc issues — the resumed session already has full context
 * @why On resume, Claude already has the system prompt, code index context, and its previous analysis. We just send what changed.
 *
 * @param {object} context Updated edit context for the retry
 * @returns {string} Compact retry prompt
 *
 * @sideeffects None
 * @systemlayer Prompt Engineering
 * @domain prompt-building, retry-prompt, session-resume
 * @tags prompt-engineering, retry, compact-prompt, session-continuity, updated-edit
 */
export function buildRetryPrompt(context: {
  filePath: string;
  extractedFunctions: ExtractedFunction[];
  extractedTypes: ExtractedType[];
  jsdocViolations: Map<string, string[]>;
  typeJsdocViolations: Map<string, string[]>;
}): string {
  const { filePath, extractedFunctions, extractedTypes, jsdocViolations, typeJsdocViolations } = context;

  const functionsSection = extractedFunctions
    .map(func => {
      const jsdocIssues = jsdocViolations.get(func.name);
      let jsdocStatus: string;
      if (!func.hasJSDoc) {
        jsdocStatus = 'JSDoc: MISSING (confirmed violation)';
      } else if (jsdocIssues && jsdocIssues.length > 0) {
        jsdocStatus = `JSDoc Issues (confirmed by static analysis):\n${jsdocIssues.map(v => `  - ${v}`).join('\n')}`;
      } else {
        jsdocStatus = 'JSDoc: Complete (all required tags present)';
      }

      return `Function: ${func.name}
Status: ${func.isNew ? 'NEW' : 'MODIFIED'}
${jsdocStatus}

Code:
\`\`\`typescript
${func.fullCode}
\`\`\``;
    })
    .join('\n\n---\n\n');

  let typesSection = '';
  if (extractedTypes.length > 0) {
    typesSection = extractedTypes
      .map(type => {
        const typeViolations = typeJsdocViolations.get(type.name);
        let jsdocStatus: string;
        if (!type.hasJSDoc) {
          jsdocStatus = 'JSDoc: MISSING (confirmed violation)';
        } else if (typeViolations && typeViolations.length > 0) {
          jsdocStatus = `JSDoc Issues (confirmed by static analysis):\n${typeViolations.map(v => `  - ${v}`).join('\n')}`;
        } else {
          jsdocStatus = 'JSDoc: Complete';
        }

        return `${type.kind.charAt(0).toUpperCase() + type.kind.slice(1)}: ${type.name}
Status: ${type.isNew ? 'NEW' : 'MODIFIED'}
${jsdocStatus}

Code:
\`\`\`typescript
${type.fullCode}
\`\`\``;
      })
      .join('\n\n---\n\n');
  }

  return `UPDATED EDIT (retry) for ${filePath}:

The developer has revised the edit based on your previous feedback. Check whether your previous violations have been addressed, and check for any NEW issues introduced by the changes.

== UPDATED FUNCTIONS ==

${functionsSection}
${typesSection ? `\n== UPDATED TYPES/INTERFACES ==\n\n${typesSection}\n` : ''}
Re-validate and return the JSON result. Be explicit about which previous violations were addressed and which remain.`;
}
