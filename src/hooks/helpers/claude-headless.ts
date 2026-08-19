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
import { appendFileSync, existsSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { ClaudeValidationResponse, ExtractedClass, ExtractedFunction, ExtractedType, PropertyAccess } from './types.js';
import type { PatternContext, FunctionResult } from './code-index-client.js';
import type { PyFinding } from './py-tools.js';
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

// ─── MCP Config for Headless ────────────────────────────────────────────────

/**
 * Generates a temporary MCP config file pointing to the codebase-guardian server.
 * Returns the path to the config file, or null if the server source isn't available.
 */
function getMcpConfigPath(): string | null {
  // Where to write the temp MCP config for the headless validator.
  const home = process.env.CLAUDE_PLUGIN_DATA
    || process.env.GUARDIAN_HOME
    || path.join(os.homedir(), '.codebase-guardian');

  let serverConfig: { command: string; args: string[] };
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    // Plugin mode: reuse the MCP launcher wrapper — it resolves Node and points
    // at the built server under ${CLAUDE_PLUGIN_DATA}/app.
    const runMcp = path.join(pluginRoot, 'scripts', 'run-mcp.sh');
    if (!existsSync(runMcp)) return null;
    serverConfig = { command: 'bash', args: [runMcp] };
  } else {
    // Standalone mode (legacy shell install).
    const serverEntry = path.join(home, 'source', 'dist', 'mcp-server', 'index.js');
    if (!existsSync(serverEntry)) return null;
    serverConfig = { command: 'node', args: [serverEntry] };
  }

  const configPath = path.join(home, '.headless-mcp-config.json');
  const config = { mcpServers: { 'codebase-guardian': serverConfig } };

  try {
    writeFileSync(configPath, JSON.stringify(config));
    return configPath;
  } catch {
    return null;
  }
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a code quality enforcement agent for a TypeScript codebase. Your role is to analyze code edits and enforce code quality standards. You will receive code being edited alongside rich context from a semantic code index (function metadata, similar functions, directory patterns, README documentation, call graphs).

Your response must be ONLY a JSON object — no markdown, no explanation text, no code blocks. Just the raw JSON.

## Change Scope — Judge ONLY What This Edit Changed

You are shown the full body of each edited function for CONTEXT, but a large function is often only PARTIALLY changed by an edit. The "WHAT THIS EDIT ACTUALLY CHANGED" section shows the exact lines this edit added/removed.

**Raise violations ONLY for code this edit added or changed.** Pre-existing, unchanged code — including nested functions, hooks, helpers, or blocks that appear inside an edited function's body but are NOT in the "WHAT THIS EDIT ACTUALLY CHANGED" section — is CONTEXT ONLY. Never flag it (no DRY, no best-practice, no inline-comment quality, no "extract this helper"). It shipped previously and is not part of this edit; blocking it forces the developer to refactor code they did not touch.

In scope: (a) the added/changed lines themselves; (b) a genuinely NEW function or type (all its lines are added); (c) a MODIFIED function whose OWN JSDoc is now inaccurate BECAUSE of this change, or whose signature/behavior changed (and its caller blast radius). Out of scope: pre-existing issues in unchanged code, however tempting.

If the only problems you can find live in unchanged code, the decision is "allow". You may still surface an unchanged-code concern as a non-blocking suggestion, but it must NOT be a violation.

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

### 1b. Index Staleness — Guard Against DRY False Positives

The code index is a snapshot and can lag the working tree — most often right after a git merge, rebase, branch switch, or bulk refactor. The classic symptom is a **DRY "duplicate" false positive**: a "SIMILAR EXISTING FUNCTION" that looks byte-for-byte identical to the function being edited, but is actually a stale copy of the SAME function — e.g. the "duplicate" is reported in the EXACT file being edited, or its indexed body matches the pre-edit code rather than any genuinely separate function.

Before denying on a DRY duplicate, sanity-check: could the "existing" function be a stale or self-match of the one under edit rather than a distinct function? If you deny (or are meaningfully uncertain) on a DRY or pattern violation that could rest on stale index data, append this reminder as the LAST entry in your \`violations\` array:

"If this looks wrong, the code index may be stale (common right after a merge or branch switch). Rebuild it with the codebase-guardian \`rebuild_index\` MCP tool (or \`npm run build-index\`) and retry — a stale index can report a function that no longer exists, or the file's own pre-edit copy, as a duplicate."

Only add this note when index staleness is genuinely plausible. Do NOT append it to every deny.

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
1. If ANY runtime correctness issue exists (undefined variables, guaranteed type errors, unreachable code, broken references) → \`"decision": "deny"\`. **Exception:** if the edit appears to be part of a multi-step refactor (e.g., renaming a variable, swapping an import, adding a function that will be defined in a follow-up edit), allow the edit but flag the runtime concern as a **suggestion** so the developer is reminded to complete the refactor.
2. If ANY DRY violation exists (duplicate function found) → \`"decision": "deny"\`
3. If ANY JSDoc completeness or accuracy violation exists → \`"decision": "deny"\`
4. If ANY inline comment quality violation exists (vague section headers, useless short comments) → \`"decision": "deny"\`
5. If ANY clear pattern/README/naming violation exists → \`"decision": "deny"\`
6. If only blast radius concerns exist (informational) → \`"decision": "allow"\` but list concerns in violations as warnings
7. If no violations → \`"decision": "allow"\`

## Output Format

Return ONLY this JSON structure:
{
  "decision": "allow" or "deny",
  "violations": ["Specific violation 1 with function name and details", "..."],
  "suggestions": ["Non-blocking improvement suggestion 1", "..."],
  "reasoning": "One or two sentence summary of your assessment"
}

Rules for the violations array (hard violations — cause "deny"):
- **List EVERY violation you find in a single response.** Do not report just the most prominent one — the developer needs to see the complete picture so they can fix everything in one pass. Reporting violations one at a time forces unnecessary retry cycles.
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
- Be STRICT on runtime correctness — references to undefined variables, guaranteed ReferenceErrors, type mismatches that will crash at runtime, and unreachable code paths are ALWAYS hard violations. Never put these in suggestions.
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

## Coding Best Practices (Adapted from NASA's Power of Ten)

In addition to any best practice rules found via semantic search and project documentation, the following 10 principles should be enforced to the best of your ability on all edits. Use judgment on severity — not all violations warrant a hard denial, but all are worth flagging. Flag clear violations as violations (deny). Flag borderline cases or minor concerns as suggestions (allow but note).

### 1. Keep it linear
No deep nesting. Code should read top to bottom. If a function has more than 3 levels of nesting (conditionals inside conditionals inside conditionals), flag it. Suggest flattening with early returns, guard clauses, or extraction into helper functions.

### 2. Bound every loop
Every loop, retry mechanism, and polling interval needs an explicit upper bound. Flag \`while(true)\` without a break condition, unbounded recursion, retry logic without a max attempt count, and polling without a timeout. "This will practically never exceed N" is not a bound.

### 3. Know what you own
Every resource opened must be closed — database connections, file handles, event listeners, timers. Check error paths too, not just the happy path. A \`try\` that opens a connection but only closes it in the success branch is a resource leak.

### 4. One function, one job
Functions should do exactly one thing, describable in a sentence without the word "and." Flag functions longer than ~60 lines — they almost always need decomposition. Monolithic functions that handle multiple concerns should be split.

### 5. State your assumptions
Functions with preconditions should validate them. If a function assumes a parameter is non-null, non-empty, within a range, or of a specific shape, that assumption should be checked — via type narrowing, assertions, or guard clauses. Don't flag every missing check, but flag functions where unstated assumptions could lead to silent corruption.

### 6. Never swallow errors
Empty \`catch {}\` blocks, bare \`catch (e) { /* ignore */ }\`, and unchecked error returns are violations. Every error must be logged, re-thrown, or explicitly handled. Silent failure suppresses information needed for debugging. The only exception is intentional fire-and-forget operations that explicitly document why the error is safe to discard.

### 7. Narrow your state
Data should live as close to its use as possible. Flag module-level mutable variables (\`let\` at module scope), unnecessary class-level state that could be local, and functions that read/write distant global state. Prefer passing data explicitly over reaching into shared mutable state.

### 8. Surface your side effects
I/O, mutations, network calls, and database writes should be obvious at the call site. Flag functions with innocent-looking names (e.g., \`getUser\`, \`formatData\`) that contain hidden writes, API calls, or state mutations. Side effects should be declared in \`@sideeffects\` and reflected in naming (\`fetch\`, \`save\`, \`update\`, \`send\` — not \`get\` or \`compute\`).

### 9. One layer of magic
Excessive indirection makes code untraceable. Flag deeply chained abstractions where following "what actually runs" requires jumping through 3+ layers of wrappers, decorators, or dynamic dispatch. Prefer composition you can read linearly over cleverness you have to decode.

### 10. Warnings are errors
TypeScript strict mode violations, eslint-disable comments, \`@ts-ignore\`, and \`any\` type assertions are red flags. Flag liberal use of \`as any\`, \`// @ts-ignore\`, and \`eslint-disable\` without explanatory comments. These suppress the tools designed to catch bugs.

## Session Continuity

You may be resumed with \`--resume\` to validate a revised edit after a previous denial. When this happens:
- You already have full context from the previous validation (system prompt, code index data, your analysis)
- The new message will contain the updated edit code and any updated JSDoc issues
- Check whether your PREVIOUS violations have been addressed
- Check for any NEW violations introduced by the changes
- Be explicit: "Previous violation X has been addressed" or "Previous violation X is still present"
- **Do NOT surface violations that existed in the previous review but were not reported.** If you missed a violation on the first pass, that is your fault — do not punish the developer by introducing it as "new" on the retry. Only report violations that are genuinely new (introduced by the fix attempt) or that were already listed in your previous response and remain unaddressed.

## Index Query Tools

You have access to the codebase index via MCP tools. Use the \`execute\` tool to write TypeScript queries when the pre-loaded context above is insufficient to make a confident judgment.

Examples of when to query:
- You see an unfamiliar invocation pattern and want to check if sibling files use the same pattern: \`return api.functionsByDirectory("src/utils").map(f => ({ name: f.name, desc: f.description }))\`
- You suspect a DRY violation but none of the pre-loaded similar functions are close enough: \`return await api.semanticSearch("validate user input and sanitize")\`
- You want to check callers of a function that wasn't in the pre-loaded blast radius: \`return api.callers("helperFunction").map(c => ({ name: c.name, file: c.file_path }))\`
- You want to search documentation for a specific pattern or convention: \`return api.searchDocs("error handling pattern")\`

Do NOT query for information already present in the pre-loaded context above. Only query when you need to go deeper. Each query adds latency, so be targeted.

Your response must still be ONLY a JSON object — any tool calls happen before your final response.`;

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
 * @param {string} params.systemPrompt First-attempt system prompt (defaults to the TypeScript SYSTEM_PROMPT; the Python path supplies a neutral, Python-appropriate one)
 * @param {boolean} params.useMcp Whether to wire the code-index MCP server (defaults true; both the TypeScript and Python paths use it now that the index covers Python)
 * @param {string[]} [params.allowedTools] Restricts the headless agent to exactly these tool names via `--allowedTools` (e.g. the bounded read-only code-index MCP tools for the Python path). Omitted → no restriction, so under `--permission-mode bypassPermissions` all default tools (Read/Bash/Grep/Glob/etc.) remain available — this is the TypeScript path's unchanged behavior.
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
  systemPrompt?: string;
  useMcp?: boolean;
  allowedTools?: string[];
  permissionMode?: string;
  disallowedTools?: string[];
}): Promise<ClaudeValidationResponse> {
  const { outerSessionId, filePath, prompt, isRetry, timeoutMs = 30000, systemPrompt = SYSTEM_PROMPT, useMcp = true, allowedTools, permissionMode = 'bypassPermissions', disallowedTools } = params;
  const sessionKey = `${outerSessionId}:${filePath}`;
  const overallStart = Date.now();

  // Clean expired sessions periodically
  cleanExpiredSessions();

  // Check for existing headless session to resume
  const existingSession = isRetry ? getSession(sessionKey) : null;

  if (existingSession) {
    log(`  [HEADLESS] Resuming session ${existingSession.headlessSessionId} (attempt #${existingSession.attemptCount + 1})`);
    return executeWithResume(existingSession.headlessSessionId, prompt, sessionKey, existingSession.attemptCount, timeoutMs, overallStart, useMcp, allowedTools, permissionMode, disallowedTools);
  }

  log(`  [HEADLESS] First attempt for ${sessionKey}`);
  return executeFirstAttempt(prompt, sessionKey, timeoutMs, overallStart, systemPrompt, useMcp, allowedTools, permissionMode, disallowedTools);
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
 * @param {string} systemPrompt System prompt passed to the CLI (the TypeScript SYSTEM_PROMPT, or the Python path's neutral one)
 * @param {boolean} useMcp Whether to wire the code-index MCP server (both TypeScript and Python pass true now that the index covers Python)
 * @param {string[]} [allowedTools] Restricts the headless agent to exactly these tool names via `--allowedTools`; omitted leaves all default tools available
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
  overallStart: number,
  systemPrompt: string,
  useMcp: boolean,
  allowedTools?: string[],
  permissionMode: string = 'bypassPermissions',
  disallowedTools?: string[]
): Promise<ClaudeValidationResponse> {
  try {
    log(`  [HEADLESS] Starting first attempt with ${timeoutMs}ms timeout...`);
    const mcpConfig = useMcp ? getMcpConfigPath() : null;
    if (mcpConfig) log(`  [HEADLESS] MCP config available at ${mcpConfig}`);

    const cliArgs = [
      '-p', prompt,
      '--system-prompt', systemPrompt,
      '--output-format', 'json',
      '--permission-mode', permissionMode,
      '--model', 'opus',
    ];
    if (mcpConfig) {
      cliArgs.push('--mcp-config', mcpConfig);
    }
    if (allowedTools && allowedTools.length > 0) {
      cliArgs.push('--allowedTools', allowedTools.join(','));
    }
    if (disallowedTools && disallowedTools.length > 0) {
      cliArgs.push('--disallowedTools', disallowedTools.join(','));
    }

    const t2 = Date.now();
    const result = execFileSync('claude', cliArgs, {
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
 * @param {boolean} useMcp Whether to wire the code-index MCP server (the resumed session inherits its first-attempt system prompt regardless)
 * @param {string[]} [allowedTools] Restricts the headless agent to exactly these tool names via `--allowedTools`; omitted leaves all default tools available. Passed again on resume so the bounded tool set is enforced for retries too, not just the first attempt.
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
  overallStart: number,
  useMcp: boolean,
  allowedTools?: string[],
  permissionMode: string = 'bypassPermissions',
  disallowedTools?: string[]
): Promise<ClaudeValidationResponse> {
  try {
    log(`  [HEADLESS] Resuming session ${headlessSessionId} (attempt #${previousAttemptCount + 1})...`);
    const mcpConfig = useMcp ? getMcpConfigPath() : null;

    const cliArgs = [
      '--resume', headlessSessionId,
      '-p', prompt,
      '--output-format', 'json',
      '--permission-mode', permissionMode,
      '--model', 'opus',
    ];
    if (mcpConfig) {
      cliArgs.push('--mcp-config', mcpConfig);
    }
    if (allowedTools && allowedTools.length > 0) {
      cliArgs.push('--allowedTools', allowedTools.join(','));
    }
    if (disallowedTools && disallowedTools.length > 0) {
      cliArgs.push('--disallowedTools', disallowedTools.join(','));
    }

    const t2 = Date.now();
    const result = execFileSync('claude', cliArgs, {
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
 * @what Renders every PatternContext field into its formatted prompt-section text, shared by both the TypeScript and Python first-attempt prompt builders
 * @how Reuses formatIndexedFunction for each function-shaped row (siblings, similar, callers) and formats relevant docs, similar comments, README, and aggregated directory patterns into individual section strings. This is a straight extraction of buildFirstAttemptPrompt's original inline section-building code — the exact per-field formatting rules (placeholder text when empty, truncation, joins) are UNCHANGED so buildFirstAttemptPrompt's output stays byte-identical to before this helper existed
 * @why buildPythonFirstAttemptPrompt now also needs to render sibling/similar/caller/doc/comment context (P3.5), and duplicating this formatting logic between the TS and Python builders would let the two silently diverge over time — factoring it into one shared helper in the same module means both builders always render PatternContext identically
 *
 * @param {PatternContext} patternContext Aggregated code index context for the edit
 * @returns {object} One formatted string per PatternContext section, ready to interpolate into either prompt builder's template
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain prompt-formatting, context-assembly, code-quality
 * @tags formatting, prompt-helper, pattern-context, shared, dry
 */
function formatPatternContextSections(patternContext: PatternContext): {
  relevantDocsSection: string;
  similarSection: string;
  similarCommentsSection: string;
  readmeSection: string;
  siblingSection: string;
  knownCalledSection: string;
  unknownCalledSection: string;
  callersSection: string;
  patternsSection: string;
} {
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

  return {
    relevantDocsSection,
    similarSection,
    similarCommentsSection,
    readmeSection,
    siblingSection,
    knownCalledSection,
    unknownCalledSection,
    callersSection,
    patternsSection,
  };
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
  isTestFile?: boolean;
  fullFileContent?: string;
  deletedFunctions?: string[];
  syntaxErrors?: string[];
  editScope?: string;
}): string {
  const { filePath, extractedFunctions, extractedTypes, propertyAccesses, patternContext, jsdocViolations, typeJsdocViolations } = context;

  // ── Functions being edited ──
  const functionsSection = extractedFunctions
    .map(func => {
      const jsdocIssues = jsdocViolations.get(func.name);
      let jsdocStatus: string;
      if (!func.requiresJSDoc) {
        jsdocStatus = 'JSDoc: Not required for this declaration (do NOT flag missing JSDoc as a violation)';
      } else if (!func.hasJSDoc) {
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

  // ── Pattern context sections (README, siblings, similar, called, callers, docs, comments, patterns) ──
  // Shared with buildPythonFirstAttemptPrompt via formatPatternContextSections — see that
  // function's JSDoc for why this is factored out rather than duplicated.
  const {
    relevantDocsSection,
    similarSection,
    similarCommentsSection,
    readmeSection,
    siblingSection,
    knownCalledSection,
    unknownCalledSection,
    callersSection,
    patternsSection,
  } = formatPatternContextSections(patternContext);

  // ── Deleted functions (excluded from DRY analysis) ──
  const deletedSection = context.deletedFunctions && context.deletedFunctions.length > 0
    ? `\n== FUNCTIONS BEING DELETED BY THIS EDIT ==\n\nThe following functions are being REMOVED from the file by this edit. Do NOT flag JSDoc issues, DRY violations, or any other problems with these functions — they will no longer exist after the edit lands:\n${context.deletedFunctions.map(name => `- ${name}`).join('\n')}\n\nIf a "similar existing function" from the code index matches one of these deleted function names, IGNORE it for DRY analysis — it is stale index data that will be cleaned up on the next index rebuild.\n`
    : '';

  // ── Property accesses ──
  const propertiesSection = propertyAccesses.length > 0
    ? propertyAccesses.map(p => `- ${p.object}.${p.property}`).join('\n')
    : '(none detected)';

  // ── Syntax errors section (intermediate multi-step edit) ──
  const syntaxSection = context.syntaxErrors && context.syntaxErrors.length > 0
    ? `\n== INTERMEDIATE SYNTAX STATE ==\n\nThis file currently has ${context.syntaxErrors.length} syntax error(s) from an in-progress multi-step edit. Do NOT deny based on syntax issues — the developer is mid-refactor and will fix syntax in subsequent edits. However, still validate everything else: JSDoc completeness/accuracy, DRY, runtime correctness (undefined variables that aren't just syntax artifacts), patterns, and best practices.\n\nSyntax errors:\n${context.syntaxErrors.map(e => `- ${e}`).join('\n')}\n`
    : '';

  // ── Test file section ──
  const testFileSection = context.isTestFile
    ? `\n== TEST FILE — MODIFIED VALIDATION RULES ==

This is a TEST FILE. The following rules are OVERRIDDEN:
- **JSDoc is NOT required.** Do NOT flag missing @what, @how, @why, @param, @returns, @sideeffects, @systemlayer, @domain, or @tags on any function, type, or variable. Ignore any "JSDoc: MISSING" markers below.
- **Inline comment quality rules do NOT apply.** Test descriptions live in describe/it blocks, not comments.

The following rules STILL APPLY with full rigor:
- **Runtime correctness (CRITICAL):** Flag references to undefined variables, non-existent API methods, non-existent imports, and calls to functions/methods that don't exist on the target object. This is the #1 reason test files are validated — catch hallucinated APIs before they waste debugging time.
- **Pattern consistency:** Compare against sibling test files. If sibling tests use \`expect.poll\`, this test should not invent \`vi.waitUntil\`. If sibling tests use \`page.getByTestId(...)\`, this test should not fabricate \`.filter({ hasText: '' })\` methods that don't exist on the locator API. Match the testing patterns already established in the directory.
- **DRY:** Flag duplicated test setup, shared helpers that should be extracted, and copy-pasted assertion blocks.
- **Best practices:** Bounded loops, no swallowed errors, and clean resource management still apply in tests.\n`
    : '';

  // ── New file section ──
  const newFileSection = context.isNewFile && context.fullFileContent
    ? `\n== NEW FILE — FULL CONTENT ==\n\nThis is a NEW FILE being created. Validate the ENTIRE file for code quality:\n- All exported functions MUST have complete JSDoc (non-function constants like React contexts, config objects do NOT require JSDoc)\n- Code must follow directory patterns and project conventions\n- Check for DRY violations against similar existing functions\n- Wrapped/decorated functions (HOCs, middleware wrappers, factory patterns) still require JSDoc on the exported declaration\n\n\`\`\`typescript\n${context.fullFileContent}\n\`\`\`\n`
    : '';

  return `FILE: ${filePath}${context.isTestFile ? ' (TEST FILE)' : ''}${context.isNewFile ? ' (NEW FILE)' : ''}${context.syntaxErrors && context.syntaxErrors.length > 0 ? ' (INTERMEDIATE SYNTAX — multi-step edit in progress)' : ''}
${testFileSection}${syntaxSection}${newFileSection}${deletedSection}${context.editScope ? `\n== WHAT THIS EDIT ACTUALLY CHANGED (judge ONLY this — see "Change Scope" in your instructions) ==\n\n${context.editScope}\n` : ''}
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
 * @how Renders three sections — updated functions (with JSDoc status), any updated types/interfaces, and a conditional change-scope block from editScope — while the resumed session reuses the system prompt and code index context from the first attempt
 * @why On resume, Claude already has the system prompt, code index context, and its previous analysis, so we resend only what changed — including the change-scope guardrail so the resumed session also judges only edited lines, not unchanged surrounding code
 *
 * @param {object} context Updated edit context for the retry
 * @returns {string} Compact retry prompt
 *
 * @sideeffects None
 * @systemlayer Prompt Engineering
 * @domain prompt-building, retry-prompt, session-resume, change-scope
 * @tags prompt-engineering, retry, compact-prompt, session-continuity, edit-scope
 */
export function buildRetryPrompt(context: {
  filePath: string;
  extractedFunctions: ExtractedFunction[];
  extractedTypes: ExtractedType[];
  jsdocViolations: Map<string, string[]>;
  typeJsdocViolations: Map<string, string[]>;
  editScope?: string;
}): string {
  const { filePath, extractedFunctions, extractedTypes, jsdocViolations, typeJsdocViolations, editScope } = context;

  const functionsSection = extractedFunctions
    .map(func => {
      const jsdocIssues = jsdocViolations.get(func.name);
      let jsdocStatus: string;
      if (!func.requiresJSDoc) {
        jsdocStatus = 'JSDoc: Not required for this declaration (do NOT flag missing JSDoc as a violation)';
      } else if (!func.hasJSDoc) {
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
${typesSection ? `\n== UPDATED TYPES/INTERFACES ==\n\n${typesSection}\n` : ''}${editScope ? `\n== WHAT THIS EDIT ACTUALLY CHANGED (judge ONLY this — see "Change Scope" in your instructions) ==\n\n${editScope}\n` : ''}
Re-validate and return the JSON result. Be explicit about which previous violations were addressed and which remain.`;
}

// ─── Python Prompt Builders ──────────────────────────────────────────────────

// Neutral system prompt for the Python validation path. Passed as the CLI
// --system-prompt for .py edits INSTEAD of the TypeScript SYSTEM_PROMPT, whose
// JSDoc mandates, "err toward deny", and code-index queries are all wrong for
// Python and were fighting the (self-contained) Python user prompt. This one
// defers to the user prompt and disclaims the TS/JSDoc + code-index assumptions.
export const PY_SYSTEM_PROMPT = `You are a code-quality reviewer for Python edits. The user message is fully self-contained — it states the project's Python conventions, the deterministic tool findings, the code under review, and the exact allow/deny criteria and JSON-only response format. Follow it precisely. Do NOT apply TypeScript or JSDoc expectations, do NOT require @param/@returns-style tags. A Python-aware semantic code index and a bounded set of read-only code-index MCP tools ARE available — the user message contains pre-injected related-code context (siblings, similar functions, callers, docs) pulled from that index, and you may call the provided MCP tools for additional targeted lookups. Prefer that injected context and those MCP tools over guessing; do NOT attempt to read files off disk — you do not have filesystem tools. Respond with ONLY the raw JSON object the user message specifies — no markdown, no code fences, no extra text.`;

/**
 * @what The JSON-only response contract shared by every Python validation prompt, copied verbatim from SYSTEM_PROMPT's "Your response must be ONLY a JSON object" line and its "## Output Format" JSON structure
 * @how A plain string constant embedded at the end of both Python prompt builders. The Python path runs under a neutral system prompt (PY_SYSTEM_PROMPT); this contract still travels inside the self-contained user prompt so the response shape is guaranteed regardless of the system prompt
 * @why parseClaudeOutput (~line 604) requires a `decision` field and a `violations` array on the parsed JSON; reusing the exact TS wording keeps both paths compatible with the same parser and prevents the Python path from drifting into a differently-shaped response
 */
const PY_RESPONSE_CONTRACT = `Your response must be ONLY a JSON object — no markdown, no explanation text, no code blocks. Just the raw JSON.

Return ONLY this JSON structure:
{
  "decision": "allow" or "deny",
  "violations": ["Specific violation 1 with function name and details", "..."],
  "suggestions": ["Non-blocking improvement suggestion 1", "..."],
  "reasoning": "One or two sentence summary of your assessment"
}`;

/**
 * @what Formats a single PyFinding (ruff or pydoclint) into a concise one-line string for the prompt
 * @how Joins tool, code, line, and message into "tool:CODE (line N) — message"; renders "line ?" when line is null
 * @why Keeps the DETERMINISTIC TOOL FINDINGS section compact and scannable, mirroring formatIndexedFunction's role for the TS prompt
 *
 * @param {PyFinding} finding A single ruff or pydoclint finding
 * @returns {string} Formatted single-line summary
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain prompt-formatting, python-support
 * @tags formatting, prompt-helper, python, ruff, pydoclint
 */
function formatPyFinding(finding: PyFinding): string {
  const line = finding.line !== null ? `line ${finding.line}` : 'line ?';
  return `${finding.tool}:${finding.code} (${line}) — ${finding.message}`;
}

/**
 * @what Renders the combined ruff + pydoclint findings into the DETERMINISTIC TOOL FINDINGS prompt section
 * @how Concatenates ruff findings then pydoclint findings, each via formatPyFinding, one per line; returns a placeholder line when both arrays are empty
 * @why Both Python prompt builders (first-attempt and retry) need this identical rendering, so it's factored out once rather than duplicated
 *
 * @param {{ ruff: PyFinding[]; pydoclint: PyFinding[] }} toolFindings Findings from both deterministic Python tools
 * @returns {string} Multi-line rendered findings, or a "(none)" placeholder when both are empty
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain prompt-formatting, python-support
 * @tags formatting, prompt-helper, python, ruff, pydoclint, tool-findings
 */
function formatPyToolFindings(toolFindings: { ruff: PyFinding[]; pydoclint: PyFinding[] }): string {
  const findingLines = [...toolFindings.ruff, ...toolFindings.pydoclint].map(f => `- ${formatPyFinding(f)}`);
  return findingLines.length > 0 ? findingLines.join('\n') : '(no ruff or pydoclint findings)';
}

/**
 * @what Renders the local doc-completeness violations map into the LOCAL DOC-COMPLETENESS prompt section
 * @how Iterates the Map's entries, rendering each unit name as a heading followed by its violation strings as a bullet list
 * @why Both Python prompt builders need this identical rendering of checkPythonDocCompleteness's output, so it's factored out once rather than duplicated
 *
 * @param {Map<string, string[]>} docViolations Unit name (or '__module__') to violation strings, from checkPythonDocCompleteness
 * @returns {string} Multi-line rendered violations, or a "(none)" placeholder when the map is empty
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain prompt-formatting, python-support
 * @tags formatting, prompt-helper, python, doc-completeness, violations
 */
function formatDocViolations(docViolations: Map<string, string[]>): string {
  if (docViolations.size === 0) return '(no local doc-completeness violations)';

  const entries: string[] = [];
  for (const [unitName, unitViolations] of docViolations) {
    entries.push(`${unitName}:`);
    for (const v of unitViolations) {
      entries.push(`  - ${v}`);
    }
  }
  return entries.join('\n');
}

/**
 * @what Synthesizes a best-effort, readable Python declaration block for a class/dataclass unit
 * @how Builds `class Name(Parent):` or `class Name:` from cls.parent, appends the docstring as an indented triple-quoted line when present, then appends each entry in cls.fields as `    name: annotation = default  # comment` (omitting parts that are null); falls back to a `pass` body when there's neither docstring nor fields
 * @why ExtractedClass (unlike ExtractedFunction) has no `fullCode` property — the UNITS section needs something to fence as python, so this reconstructs a plausible declaration from the structured fields/parent/docstring/kind guardian_py already extracted, mirroring py-adapter.ts's buildFunctionFullCode
 *
 * @param {ExtractedClass} cls Class/dataclass unit to render
 * @returns {string} A synthesized `class ...:` declaration block
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain prompt-formatting, python-support
 * @tags formatting, prompt-helper, python, class, dataclass, code-reconstruction
 */
function buildClassDeclaration(cls: ExtractedClass): string {
  const header = cls.parent ? `class ${cls.name}(${cls.parent}):` : `class ${cls.name}:`;
  const lines = [header];

  if (cls.docstring) {
    lines.push(`    """${cls.docstring}"""`);
  }
  for (const field of cls.fields) {
    let fieldLine = `    ${field.name}`;
    if (field.annotation) fieldLine += `: ${field.annotation}`;
    if (field.default !== null) fieldLine += ` = ${field.default}`;
    if (field.comment) fieldLine += `  # ${field.comment}`;
    lines.push(fieldLine);
  }
  if (lines.length === 1) {
    lines.push('    pass');
  }

  return lines.join('\n');
}

/**
 * @what Renders a single Python function/method unit into a UNITS prompt entry
 * @how Formats name, NEW/MODIFIED status, docstring-present status (from hasJSDoc), and fullCode fenced as python
 * @why Isolates the function-unit rendering rule so formatPyUnits can compose it with formatPyClassUnit without duplicating the block layout
 *
 * @param {ExtractedFunction} fn Function/method unit to render
 * @returns {string} A single UNITS entry for this function
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain prompt-formatting, python-support
 * @tags formatting, prompt-helper, python, function, method
 */
function formatPyFunctionUnit(fn: ExtractedFunction): string {
  const docStatus = fn.hasJSDoc ? 'Docstring: present' : 'Docstring: MISSING';
  return `Function: ${fn.name}
Status: ${fn.isNew ? 'NEW' : 'MODIFIED'}
${docStatus}

Code:
\`\`\`python
${fn.fullCode}
\`\`\``;
}

/**
 * @what Renders a single Python class/dataclass unit into a UNITS prompt entry
 * @how Formats kind (capitalized), name, NEW/MODIFIED status, docstring-present status, and a synthesized declaration block from buildClassDeclaration
 * @why Isolates the class-unit rendering rule so formatPyUnits can compose it with formatPyFunctionUnit without duplicating the block layout
 *
 * @param {ExtractedClass} cls Class/dataclass unit to render
 * @returns {string} A single UNITS entry for this class
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain prompt-formatting, python-support
 * @tags formatting, prompt-helper, python, class, dataclass
 */
function formatPyClassUnit(cls: ExtractedClass): string {
  const docStatus = cls.docstring ? 'Docstring: present' : 'Docstring: MISSING';
  const kindLabel = cls.kind.charAt(0).toUpperCase() + cls.kind.slice(1);
  return `${kindLabel}: ${cls.name}
Status: ${cls.isNew ? 'NEW' : 'MODIFIED'}
${docStatus}

Code:
\`\`\`python
${buildClassDeclaration(cls)}
\`\`\``;
}

/**
 * @what Renders Python functions/methods and classes/dataclasses into the UNITS prompt section
 * @how Maps functions through formatPyFunctionUnit and classes (module-kind entries skipped — module metadata is rendered separately by the caller) through formatPyClassUnit, joining every entry with a "---" separator
 * @why Both Python prompt builders need this identical rendering of the proposed edit's units, so it's factored out once rather than duplicated between first-attempt and retry
 *
 * @param {ExtractedFunction[]} functions Proposed functions/methods to render
 * @param {ExtractedClass[]} classes Proposed classes/dataclasses (module-kind entries are skipped) to render
 * @returns {string} Multi-line rendered units, or a "(none)" placeholder when both arrays are empty
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain prompt-formatting, python-support
 * @tags formatting, prompt-helper, python, function, class, dataclass
 */
function formatPyUnits(functions: ExtractedFunction[], classes: ExtractedClass[]): string {
  const entries = [
    ...functions.map(formatPyFunctionUnit),
    ...classes.filter(cls => cls.kind !== 'module').map(formatPyClassUnit),
  ];

  return entries.length > 0 ? entries.join('\n\n---\n\n') : '(no units in this edit)';
}

/**
 * @what Renders a PatternContext into the "RELATED CODE IN THE INDEX" prompt section for the Python first-attempt builder
 * @how Delegates the per-field formatting to the shared formatPatternContextSections helper, then composes only the subsections the Python prompt cares about (README, siblings, similar-existing-functions DRY signal, callers/blast-radius, relevant docs, similar comments) — each included ONLY when its underlying PatternContext field is non-empty, so a sparse or empty index (e.g. before the first reindex) doesn't pad the prompt with placeholder text. Returns '' when every subsection is empty, so the caller can omit the whole section header
 * @why P3.5 replaces the Python path's ad-hoc filesystem exploration with the same pre-injected index context the TypeScript path uses — this is the Python-specific composition of that shared data, deliberately narrower than the TS section (no "called functions" or "directory patterns" subsections, since the Python path passes no calledFunctions today — see py-validate.ts's calledFunctions decision)
 *
 * @param {PatternContext} patternContext Aggregated code index context for the edit (may be empty when the index has no Python coverage yet)
 * @returns {string} The complete "== RELATED CODE IN THE INDEX ==" block, or '' when there is nothing to show
 *
 * @sideeffects None
 * @systemlayer Prompt Engineering
 * @domain prompt-building, python-support, context-assembly
 * @tags prompt-engineering, python, pattern-context, related-code, dry-enforcement
 */
function buildPythonRelatedCodeSection(patternContext: PatternContext): string {
  const {
    relevantDocsSection,
    similarSection,
    readmeSection,
    siblingSection,
    callersSection,
    similarCommentsSection,
  } = formatPatternContextSections(patternContext);

  const parts: string[] = [];
  if (patternContext.directoryReadme) {
    parts.push(`### Directory README\n${readmeSection}`);
  }
  if (patternContext.siblingFunctions.length > 0) {
    parts.push(`### Sibling Functions (same directory — established patterns)\n${siblingSection}`);
  }
  if (patternContext.similarExistingFunctions.size > 0) {
    parts.push(`### Similar Existing Functions (DRY check — most important)\n${similarSection}`);
  }
  if (patternContext.callerDetails.size > 0) {
    parts.push(`### Callers (blast radius)\n${callersSection}`);
  }
  if (patternContext.relevantDocs.length > 0) {
    parts.push(`### Relevant Documentation\n${relevantDocsSection}`);
  }
  if (patternContext.similarComments.length > 0) {
    parts.push(`### Similar Inline Comments (sub-function DRY check)\n${similarCommentsSection}`);
  }

  if (parts.length === 0) return '';
  return `\n== RELATED CODE IN THE INDEX ==\n\n${parts.join('\n\n')}\n`;
}

/**
 * @what Builds the full first-attempt validation prompt for a proposed Python edit
 * @how Assembles the pragmatic Python convention, the deterministic ruff/pydoclint findings, the local doc-completeness violations, the module metadata, the proposed functions/classes as UNITS, the pre-injected RELATED CODE IN THE INDEX section (via buildPythonRelatedCodeSection), an index-availability note, the WARN-NOT-DENY notice, an optional syntax-note, and the shared JSON-only response contract into one prompt string. The Python path runs under a neutral system prompt (PY_SYSTEM_PROMPT); everything substantive — convention, findings, criteria, injected context, and the response contract — lives in this single user-prompt string.
 * @why P3.5: the Python validation path now has code index coverage (P3.3 definitions + P3.4 call edges) and must bias toward allow-with-suggestion (pyright/ruff run in CI, not here) — this prompt carries both the injected cross-file context and that leniency constraint so headless Claude gets real DRY/pattern signal without re-deriving TypeScript's stricter decision logic
 *
 * @param {object} context Validation context for the proposed Python edit
 * @param {string} context.filePath File being edited
 * @param {ExtractedFunction[]} context.functions Proposed functions/methods
 * @param {ExtractedClass[]} context.classes Proposed classes/dataclasses
 * @param {{ docstring: string | null; domains: string[]; tags: string[]; layer: string | null }} context.module Module-level metadata
 * @param {Map<string, string[]>} context.docViolations Local doc-completeness violations from checkPythonDocCompleteness
 * @param {{ ruff: PyFinding[]; pydoclint: PyFinding[] }} context.toolFindings Deterministic findings from runPyTools
 * @param {boolean} context.isNewFile Whether this edit creates a new file
 * @param {PatternContext} context.patternContext Pre-injected code index context (siblings/similar/callers/docs/comments) built defensively by py-validate.ts — may be an empty context if the index is unavailable or has no Python coverage yet, in which case buildPythonRelatedCodeSection renders ''
 * @param {boolean} [context.syntaxNote] Whether the extractor reported an intermediate/partial parse state
 * @returns {string} Complete first-attempt validation prompt for the Python path
 *
 * @sideeffects None
 * @systemlayer Prompt Engineering
 * @domain prompt-building, python-support, code-quality
 * @tags prompt-engineering, python, first-attempt, pattern-context, warn-not-deny, validation-prompt
 */
export function buildPythonFirstAttemptPrompt(context: {
  filePath: string;
  functions: ExtractedFunction[];
  classes: ExtractedClass[];
  module: { docstring: string | null; domains: string[]; tags: string[]; layer: string | null };
  docViolations: Map<string, string[]>;
  toolFindings: { ruff: PyFinding[]; pydoclint: PyFinding[] };
  isNewFile: boolean;
  patternContext: PatternContext;
  syntaxNote?: boolean;
}): string {
  const { filePath, functions, classes, module, docViolations, toolFindings, isNewFile, patternContext, syntaxNote } = context;

  const conventionSection = `Every module and class/dataclass must carry a docstring with a one-line "what" and a \`Domain:\` line (classes may also add an optional \`Tags:\` line). Every PUBLIC function/method must carry a one-line docstring. Only demand \`Args:\`/\`Returns:\`/\`Raises:\` sections when the signature is non-trivial (multiple params, a non-obvious return, or raised exceptions) — do NOT require them on simple functions. Types live in annotations (PEP 604 syntax, e.g. \`int | None\`), NOT in docstring prose — never ask for types to be repeated in prose. DRY: prefer reusing existing helpers; watch for hand-rolled logic that a decorator, a \`functools\` utility, a context manager, or the data model (dataclass/Pydantic) already provides.`;

  const moduleSection = `Docstring: ${module.docstring ? 'present' : 'MISSING'}
Domains: ${module.domains.join(', ') || '(none)'}
Tags: ${module.tags.join(', ') || '(none)'}
Layer: ${module.layer ?? '(none)'}`;

  const syntaxSection = syntaxNote
    ? '\n== INTERMEDIATE SYNTAX STATE ==\n\nThis edit is a partial/intermediate state (parse incomplete) — treat structural gaps as in-progress and do not deny for them.\n'
    : '';

  const relatedCodeSection = buildPythonRelatedCodeSection(patternContext);

  return `You are validating a proposed edit to a PYTHON file (\`${filePath}\`)${isNewFile ? ' (NEW FILE)' : ''}. Decide allow or deny.

== CONVENTION ==

${conventionSection}
${syntaxSection}
== DETERMINISTIC TOOL FINDINGS (ruff + pydoclint — authoritative facts for style and docstring-signature mismatches) ==

${formatPyToolFindings(toolFindings)}

ruff and pyright style/type checks are ALSO enforced in CI — do not re-litigate style; treat the findings above as settled facts, not things to independently re-derive.

== LOCAL DOC-COMPLETENESS ==

${formatDocViolations(docViolations)}

== MODULE ==

${moduleSection}

== UNITS (functions, methods, classes, dataclasses being edited) ==

${formatPyUnits(functions, classes)}
${relatedCodeSection}
== INDEX & MCP TOOLS AVAILABLE (important) ==

A Python-aware semantic code index now covers this project, and the RELATED CODE IN THE INDEX section above (when present) was pre-injected for you — directory README, sibling functions, similar-existing-function DRY signal, callers/blast-radius, relevant docs, and similar inline comments. You also have bounded read-only code-index MCP tools (search, callers, callees, impact, search_comments, search_doc_sections, list_domains/tags/systemlayers, index_status) for targeted follow-up lookups beyond what was injected. Prefer the injected context and these MCP tools over guessing — you have NO filesystem tools, so you cannot read sibling files directly. If the RELATED CODE section above is empty, the index may not have Python coverage for this project yet (e.g. before the first reindex) — judge DRY and pattern-consistency from the code shown in that case, same as before.

== WARN-NOT-DENY (critical) ==

Python is dynamically typed and pyright runs in CI, not here. Bias STRONGLY toward allow-with-suggestion on any runtime/type/attribute/API concern. Deny ONLY for a clear in-this-code contradiction: a docstring that plainly lies about what the body does, a real DRY duplication visible in the shown code, or a missing required docstring/Domain per the convention above.

${PY_RESPONSE_CONTRACT}`;
}

/**
 * @what Builds the compact retry prompt for a resumed Python headless Claude session
 * @how Restates the still-open local doc-completeness violations, the deterministic tool findings, and the updated units — the resumed session already has the convention, the injected RELATED CODE IN THE INDEX context, and the WARN-NOT-DENY guidance from the first-attempt prompt. Mirrors the TypeScript path's buildRetryPrompt, which likewise does NOT rebuild pattern context on retry — the resumed headless session retains it from the first attempt
 * @why On resume, Claude already has the full Python convention, injected index context, and prior reasoning; resending it would waste tokens and latency, mirroring how buildRetryPrompt is a compact version of buildFirstAttemptPrompt for the TypeScript path
 *
 * @param {object} context Updated edit context for the retry
 * @param {string} context.filePath File being edited
 * @param {ExtractedFunction[]} context.functions Updated proposed functions/methods
 * @param {ExtractedClass[]} context.classes Updated proposed classes/dataclasses
 * @param {Map<string, string[]>} context.docViolations Updated local doc-completeness violations
 * @param {{ ruff: PyFinding[]; pydoclint: PyFinding[] }} context.toolFindings Updated deterministic findings from runPyTools
 * @returns {string} Compact retry prompt for the Python path
 *
 * @sideeffects None
 * @systemlayer Prompt Engineering
 * @domain prompt-building, python-support, retry-prompt, session-resume
 * @tags prompt-engineering, python, retry, compact-prompt, session-continuity
 */
export function buildPythonRetryPrompt(context: {
  filePath: string;
  functions: ExtractedFunction[];
  classes: ExtractedClass[];
  docViolations: Map<string, string[]>;
  toolFindings: { ruff: PyFinding[]; pydoclint: PyFinding[] };
}): string {
  const { filePath, functions, classes, docViolations, toolFindings } = context;

  return `UPDATED EDIT (retry) for ${filePath}:

The developer has revised the edit based on your previous feedback. Check whether your previous violations have been addressed, and check for any NEW issues introduced by the changes.

== DETERMINISTIC TOOL FINDINGS (ruff + pydoclint — authoritative) ==

${formatPyToolFindings(toolFindings)}

== LOCAL DOC-COMPLETENESS ==

${formatDocViolations(docViolations)}

== UPDATED UNITS ==

${formatPyUnits(functions, classes)}

${PY_RESPONSE_CONTRACT}

Re-validate and return the JSON result. Be explicit about which previous violations were addressed and which remain.`;
}
