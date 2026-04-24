#!/usr/bin/env tsx

/**
 * @what PreToolUse hook that enforces code quality using headless Claude + semantic code index
 * @how Extracts functions, gathers code index context, validates via headless Claude with session resume
 * @why Prevents code duplication (DRY), ensures JSDoc completeness, enforces pattern consistency and README compliance
 *
 * @sideeffects Executes headless Claude, reads code index DB, reads/writes session store and cache
 * @systemlayer Validation Hook
 * @domain code-quality, dry-enforcement, pattern-alignment, jsdoc-validation
 * @tags validation-hook, claude-headless, code-index, dry-enforcement, session-resume
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync, statSync, renameSync } from 'fs';
import path from 'path';
import { HookInput, HookResponse, ExtractedFunction, ExtractedType } from './helpers/types.js';
import { extractFunctionWithJSDoc, extractTypeWithJSDoc, getSyntaxErrors } from './helpers/function-extractor.js';
import {
  extractPropertyAccesses,
  analyzeChanges
} from './helpers/code-analyzer.js';
import { validateJSDocCompleteness, validateTypeJSDocCompleteness } from './helpers/jsdoc-parser.js';
import { enhanceViolationWithQueryHint } from './helpers/denial-hints.js';
import {
  executeClaudeHeadless,
  buildFirstAttemptPrompt,
  buildRetryPrompt
} from './helpers/claude-headless.js';
import {
  buildPatternContext,
  isIndexAvailable,
  extractInlineComments,
  setProjectContext
} from './helpers/code-index-client.js';
import {
  getCachedValidation,
  setCachedValidation,
  generateCacheKey,
  clearCacheForFile
} from './helpers/validation-cache.js';
import { getSession, setDenialInfo, clearSession as clearSessionEntry } from './helpers/validation-sessions.js';
import crypto from 'crypto';
import { resolveConfig, ensureDirectories } from '../config.js';

// Logging
const hookConfig = resolveConfig();
ensureDirectories(hookConfig);
const LOG_PATH = hookConfig.logPath;

/**
 * @what Main entry point for the pre-edit validation hook
 * @how Reads stdin, validates edit against code index and headless Claude, returns allow/deny decision
 * @why Claude Code executes this hook before Edit/Write operations to enforce code quality
 *
 * @sideeffects Reads stdin, executes validation, writes logs, exits with 0 or 2
 * @systemlayer Hook Entry
 * @domain hook-execution, validation-orchestration
 * @tags hook-main, entry-point, validation-flow, orchestration, stdin-processing
 */
async function main() {
  try {
    const input = await readStdin();
    log(`\n\n=== ${new Date().toISOString()} ===`);
    log(`Hook input: ${input.substring(0, 200)}...`);

    const hookInput: HookInput = JSON.parse(input);

    // Log the full edit details so we can debug what the hook is actually validating
    const ti = hookInput.tool_input;
    log(`File: ${ti.file_path || '(none)'}`);
    if (ti.old_string !== undefined) {
      log(`old_string (${ti.old_string.length} chars):\n${ti.old_string}`);
      log(`new_string (${ti.new_string?.length ?? 0} chars):\n${ti.new_string ?? ''}`);
    } else if (ti.content !== undefined) {
      log(`Write content (${ti.content.length} chars) — first 500:\n${ti.content.substring(0, 500)}`);
    }

    // Only validate Edit/Write operations
    if (!['Edit', 'Write'].includes(hookInput.tool_name)) {
      allowAndExit('Not an Edit/Write operation');
    }

    const filePath = hookInput.tool_input.file_path || '';

    // Set project context from the file being edited (handles submodules/monorepos
    // where the file's project root may differ from cwd)
    if (filePath) {
      setProjectContext(filePath);
    }

    // Skip validation for certain file types
    if (shouldSkipValidation(filePath)) {
      allowAndExit(`Skipping validation for ${filePath}`);
    }

    // Check if code index is available — fail open if not
    if (!isIndexAvailable()) {
      log('Code index database not available — allowing edit (fail-open)');
      allowAndExit('Code index unavailable (fail-open)');
    }

    // Perform validation
    const result = await validateEdit(hookInput);

    if (result.action === 'allow') {
      allowAndExit(result.message || 'Validation passed', result.suggestions);
    } else {
      denyAndExit(result.message || 'Validation failed', result.violations);
    }
  } catch (error) {
    // On error, fail open (allow edit) but log the error
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMsg}`);
    if (error instanceof Error && error.stack) {
      log(`Stack: ${error.stack}`);
    }

    console.log(
      JSON.stringify({
        action: 'allow',
        message: `Hook validation error (allowing edit): ${errorMsg}`
      })
    );
    process.exit(0);
  }
}

/**
 * @what Validates an edit operation against the code index and headless Claude
 * @how Extracts functions, runs local JSDoc checks, checks cache, gathers code index context, executes headless Claude with session resume
 * @why Main validation logic — coordinates extraction, local checks, code index queries, and AI validation
 *
 * @param {HookInput} input Edit operation to validate
 * @returns {Promise<HookResponse>} Validation decision (allow/deny with violations)
 *
 * @sideeffects Executes headless Claude, reads code index DB, reads/writes cache and session store, logs
 * @systemlayer Validation Logic
 * @domain validation-orchestration, code-quality-workflow
 * @tags validation-flow, function-extraction, code-index, ai-validation, session-resume
 */
async function validateEdit(input: HookInput): Promise<HookResponse> {
  const startTime = Date.now();
  const sessionId = input.session_id;
  const filePath = input.tool_input.file_path || '';
  const oldString = input.tool_input.old_string || '';
  const newString = input.tool_input.new_string || input.tool_input.content || '';
  const replaceAll = input.tool_input.replace_all === true;

  // ── Step 1: Construct post-edit file content ──

  const t1 = Date.now();
  let fullFileContent = '';
  let currentFileOnDisk = '';
  if (filePath && existsSync(filePath)) {
    try {
      currentFileOnDisk = readFileSync(filePath, 'utf-8');
      if (oldString) {
        fullFileContent = replaceAll
          ? currentFileOnDisk.split(oldString).join(newString)
          : currentFileOnDisk.replace(oldString, newString);
      } else {
        fullFileContent = newString;
      }
    } catch {
      fullFileContent = newString;
    }
  } else {
    fullFileContent = newString;
  }
  log(`[TIMING] Read file: ${Date.now() - t1}ms (${fullFileContent.length} chars)`);

  // ── Step 1b: Check for syntax errors in post-edit file ──
  // If the edit creates invalid syntax (e.g., partial function deletion), allow it
  // rather than flagging issues on broken intermediate code
  const syntaxErrors = getSyntaxErrors(fullFileContent);
  if (syntaxErrors.length > 0) {
    log(`[SYNTAX] Post-edit file has ${syntaxErrors.length} syntax error(s) — allowing edit (intermediate state)`);
    for (const err of syntaxErrors) {
      log(`  ${err}`);
    }
    clearCacheForFile(filePath);
    return { action: 'allow', message: `Edit creates intermediate syntax — allowing (${syntaxErrors.length} syntax error(s) detected)` };
  }

  // ── Step 2: Analyze changes (AST-based comparison of pre-edit vs post-edit file) ──

  const t2 = Date.now();
  const { functionUsage: usage, typeUsage, typeKindMap } = analyzeChanges(currentFileOnDisk, fullFileContent, newString);
  log(`[TIMING] Analyze changes: ${Date.now() - t2}ms`);
  log(`Functions - Called: ${usage.called.length}, Modified: ${usage.modified.length}, Created: ${usage.created.length}, Deleted: ${usage.deleted.length}, Renamed: ${usage.renamed.length}`);
  log(`Types - Modified: ${typeUsage.modified.length}, Created: ${typeUsage.created.length}`);
  if (usage.deleted.length > 0) {
    log(`Deleted: ${usage.deleted.join(', ')}`);
  }
  if (usage.renamed.length > 0) {
    log(`Renames: ${usage.renamed.map(r => `${r.oldName} → ${r.newName}`).join(', ')}`);
  }

  // Detect new file creation (Write to non-existent file)
  const isNewFile = input.tool_name === 'Write' && !existsSync(filePath);

  // If no functions or types modified/created, skip validation
  if (usage.modified.length === 0 && usage.created.length === 0 &&
      typeUsage.modified.length === 0 && typeUsage.created.length === 0) {
    if (isNewFile) {
      log('New file creation detected — validating full file');
    } else {
      log('No functions or types modified/created — skipping validation');
      clearCacheForFile(filePath);
      return { action: 'allow', message: 'No function or type declarations changed — no validation needed' };
    }
  }

  // ── Step 3: Extract functions with JSDoc ──

  const t3 = Date.now();
  const functionsToValidate = [...usage.modified, ...usage.created];
  const extractedFunctions: ExtractedFunction[] = [];

  for (const funcName of functionsToValidate) {
    const extracted = extractFunctionWithJSDoc(fullFileContent, funcName);
    if (extracted) {
      extracted.isNew = usage.created.includes(funcName);
      extracted.isModified = usage.modified.includes(funcName);
      extractedFunctions.push(extracted);
    }
  }
  log(`[TIMING] Extract functions: ${Date.now() - t3}ms (${extractedFunctions.length} functions)`);

  // ── Step 3b: Extract types with JSDoc ──

  const t3b = Date.now();
  const typesToValidate = [...typeUsage.modified, ...typeUsage.created];
  const extractedTypes: ExtractedType[] = [];

  for (const typeName of typesToValidate) {
    const kind = typeKindMap.get(typeName);
    if (kind) {
      const extracted = extractTypeWithJSDoc(fullFileContent, typeName, kind);
      if (extracted) {
        extracted.isNew = typeUsage.created.includes(typeName);
        extracted.isModified = typeUsage.modified.includes(typeName);
        extractedTypes.push(extracted);
      }
    }
  }
  log(`[TIMING] Extract types: ${Date.now() - t3b}ms (${extractedTypes.length} types)`);

  // ── Step 4: Local JSDoc validation (fast, no AI) ──

  const t4 = Date.now();
  const jsdocViolations = new Map<string, string[]>();

  for (const func of extractedFunctions) {
    // Skip JSDoc validation for inline callbacks (.map, useMemo, etc.) — they're tracked
    // for change detection but don't require full JSDoc documentation
    if (!func.requiresJSDoc) continue;

    if (!func.hasJSDoc) {
      // Check if JSDoc exists in the file but got separated from the declaration
      // (e.g., the edit inserted code between the JSDoc and the function)
      const jsdocMentionsFunc = new RegExp(`@what[\\s\\S]{0,500}?${func.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      const jsdocExistsButDetached = jsdocMentionsFunc.test(fullFileContent);

      if (jsdocExistsButDetached) {
        jsdocViolations.set(func.name, [
          `Function '${func.name}' has JSDoc in the file, but the edit SEPARATED the JSDoc from the function declaration. ` +
          `The JSDoc comment block must be directly above the function — your edit inserted code between them. ` +
          `Fix: include the JSDoc comment in your old_string so it stays attached to the declaration, or move the insertion point above the JSDoc block.`
        ]);
      } else {
        jsdocViolations.set(func.name, [`Function '${func.name}' is missing JSDoc entirely`]);
      }
    } else if (func.jsdocTags) {
      const issues = validateJSDocCompleteness(func.jsdocTags);
      if (issues.length > 0) {
        jsdocViolations.set(func.name, issues.map(issue => `Function '${func.name}': ${issue}`));
      }
    }
  }
  log(`[TIMING] Local JSDoc validation: ${Date.now() - t4}ms`);
  log(`JSDoc violations: ${jsdocViolations.size > 0 ? Array.from(jsdocViolations.entries()).map(([name, issues]) => `${name}: ${issues.length}`).join(', ') : 'none'}`);

  // ── Step 4b: Local type JSDoc validation ──

  const t4b = Date.now();
  const typeJsdocViolations = new Map<string, string[]>();

  for (const type of extractedTypes) {
    if (!type.hasJSDoc) {
      typeJsdocViolations.set(type.name, [`${type.kind.charAt(0).toUpperCase() + type.kind.slice(1)} '${type.name}' is missing JSDoc entirely`]);
    } else if (type.jsdocTags) {
      const issues = validateTypeJSDocCompleteness(type.jsdocTags);
      if (issues.length > 0) {
        typeJsdocViolations.set(type.name, issues.map(issue => `${type.kind.charAt(0).toUpperCase() + type.kind.slice(1)} '${type.name}': ${issue}`));
      }
    }
  }
  log(`[TIMING] Local type JSDoc validation: ${Date.now() - t4b}ms`);
  log(`Type JSDoc violations: ${typeJsdocViolations.size > 0 ? Array.from(typeJsdocViolations.entries()).map(([name, issues]) => `${name}: ${issues.length}`).join(', ') : 'none'}`);

  // ── Step 5: Check validation cache (exact same edit = skip AI) ──

  const t5 = Date.now();
  const cacheKey = generateCacheKey(filePath, oldString, newString);
  const cachedResult = getCachedValidation(cacheKey);
  if (cachedResult) {
    log(`[TIMING] Cache hit: ${Date.now() - t5}ms`);
    log(`[CACHE] Returning cached result: ${cachedResult.decision}`);
    return {
      action: cachedResult.decision === 'allow' ? 'allow' : 'deny',
      message: cachedResult.decision === 'allow'
        ? `Validation Passed (cached): ${cachedResult.reasoning}`
        : `BLOCKED (cached): ${cachedResult.reasoning}`,
      violations: cachedResult.violations
    };
  }
  log(`[TIMING] Cache miss: ${Date.now() - t5}ms`);

  // ── Step 6: Extract called functions and property accesses ──

  const t6 = Date.now();
  const calledFunctions = usage.called;
  const propertyAccesses = extractPropertyAccesses(newString);
  log(`[TIMING] Extract calls/properties: ${Date.now() - t6}ms (${calledFunctions.length} calls, ${propertyAccesses.length} properties)`);

  // ── Step 7: Determine if this is a first attempt or retry ──

  const sessionKey = `${sessionId}:${filePath}`;
  let existingSession = getSession(sessionKey);

  // If the file on disk has been modified since the last denial (e.g., by another edit that was allowed),
  // the resumed session would have stale context. Clear it and force a fresh first-attempt.
  // We compare the actual file on disk — not the proposed edit — because denied edits don't land,
  // so different retry attempts should still resume the same session.
  if (existingSession && existingSession.lastDeniedContentHash) {
    const onDiskHash = crypto.createHash('sha256').update(currentFileOnDisk).digest('hex').slice(0, 16);
    if (onDiskHash !== existingSession.lastDeniedContentHash) {
      log(`[SESSION] File content changed since last denial — clearing stale session for fresh validation`);
      clearSessionEntry(sessionKey);
      existingSession = null;
    }
  }

  const isRetry = existingSession !== null;
  log(`[SESSION] ${isRetry ? `Retry attempt #${existingSession!.attemptCount + 1} (session: ${existingSession!.headlessSessionId})` : 'First attempt'}`);

  // Check for identical resubmission on retry — return cached denial without invoking headless Claude
  // Compares proposed content hash (what the edit would produce) against last denied proposed hash
  if (isRetry && existingSession!.lastDeniedProposedHash) {
    const proposedHash = crypto.createHash('sha256').update(fullFileContent).digest('hex').slice(0, 16);
    if (proposedHash === existingSession!.lastDeniedProposedHash) {
      log(`[SESSION] Identical resubmission detected — returning cached denial (saved ~10s headless call)`);
      return {
        action: 'deny',
        message: `BLOCKED (identical resubmission): ${existingSession!.lastDeniedReason || 'Same code as previously denied — please fix the violations before retrying'}`,
        violations: ['Code is identical to the previously denied submission. Fix the issues described above before retrying.']
      };
    }
  }

  // ── Step 8: Build prompt ──

  let prompt: string;

  if (isRetry) {
    // Retry: compact prompt — resumed session already has full context
    const t7 = Date.now();
    prompt = buildRetryPrompt({
      filePath,
      extractedFunctions,
      extractedTypes,
      jsdocViolations,
      typeJsdocViolations
    });
    log(`[TIMING] Build retry prompt: ${Date.now() - t7}ms (${prompt.length} chars)`);
  } else {
    // First attempt: gather full code index context
    const t7 = Date.now();
    const editComments = extractInlineComments(newString);
    // Include old names from renames in the modified list for blast radius (caller lookup)
    const modifiedForContext = [...usage.modified, ...usage.renamed.map(r => r.oldName)];
    const patternContext = await buildPatternContext(
      filePath,
      modifiedForContext,
      usage.created,
      calledFunctions,
      editComments
    );
    log(`[TIMING] Build pattern context: ${Date.now() - t7}ms`);
    log(`[CONTEXT] README: ${patternContext.directoryReadme ? 'found' : 'none'}, Siblings: ${patternContext.siblingFunctions.length}, Similar: ${patternContext.similarExistingFunctions.size}, Callers: ${patternContext.callerDetails.size}, RelevantDocs: ${patternContext.relevantDocs.length}, SimilarComments: ${patternContext.similarComments.length}`);

    const t8 = Date.now();
    prompt = buildFirstAttemptPrompt({
      filePath,
      extractedFunctions,
      extractedTypes,
      calledFunctions,
      propertyAccesses,
      patternContext,
      jsdocViolations,
      typeJsdocViolations,
      isNewFile,
      fullFileContent: isNewFile ? fullFileContent : undefined,
      deletedFunctions: usage.deleted.length > 0 ? usage.deleted : undefined,
    });
    log(`[TIMING] Build first-attempt prompt: ${Date.now() - t8}ms (${prompt.length} chars)`);
  }

  // ── Step 9: Execute headless Claude ──

  try {
    log('Executing headless Claude...');
    const t9 = Date.now();
    const validationResult = await executeClaudeHeadless({
      outerSessionId: sessionId,
      filePath,
      prompt,
      isRetry,
      timeoutMs: 120000
    });
    log(`[TIMING] Headless Claude execution: ${Date.now() - t9}ms`);
    log(`Decision: ${validationResult.decision}`);
    log(`Reasoning: ${validationResult.reasoning}`);
    log(`Violations: ${JSON.stringify(validationResult.violations)}`);
    log(`Suggestions: ${JSON.stringify(validationResult.suggestions)}`);
    log(`[TIMING] TOTAL VALIDATION TIME: ${Date.now() - startTime}ms`);

    // When an edit is allowed, clear all prior cached results for this file
    // so stale denials don't persist after the file state has changed
    if (validationResult.decision === 'allow') {
      clearCacheForFile(filePath);
    }

    // Cache the result
    setCachedValidation(cacheKey, validationResult, filePath);

    // Log non-blocking suggestions to the project's suggestion file
    if (validationResult.suggestions && validationResult.suggestions.length > 0) {
      try {
        const suggestionsPath = hookConfig.suggestionsPath;
        mkdirSync(path.dirname(suggestionsPath), { recursive: true });
        const timestamp = new Date().toISOString();
        const header = `\n## Session: ${sessionId} — ${timestamp}\n\n`;
        const entries = validationResult.suggestions
          .map(s => `- **File:** \`${filePath}\`\n  **Suggestion:** ${s}\n`)
          .join('\n');
        appendFileSync(suggestionsPath, header + entries, 'utf-8');
        log(`[SUGGESTIONS] Logged ${validationResult.suggestions.length} suggestions`);
      } catch {
        // Non-fatal — don't block the edit for suggestion logging failures
      }
    }

    // Store denial info for duplicate resubmission and stale-session detection
    // onDiskHash: detects when a different allowed edit changed the file (session staleness)
    // proposedHash: detects when the exact same edit is resubmitted (identical resubmission)
    if (validationResult.decision !== 'allow') {
      const onDiskHash = crypto.createHash('sha256').update(currentFileOnDisk).digest('hex').slice(0, 16);
      const proposedHash = crypto.createHash('sha256').update(fullFileContent).digest('hex').slice(0, 16);
      setDenialInfo(sessionKey, onDiskHash, validationResult.reasoning, proposedHash);
    }

    const enhancedViolations = validationResult.violations.map(enhanceViolationWithQueryHint);

    return {
      action: validationResult.decision === 'allow' ? 'allow' : 'deny',
      message: validationResult.decision === 'allow'
        ? `Code Quality Passed: ${validationResult.reasoning}`
        : `BLOCKED: ${validationResult.reasoning}`,
      violations: enhancedViolations,
      suggestions: validationResult.suggestions.length > 0 ? validationResult.suggestions : undefined
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    if (errorMsg.includes('timed out')) {
      log(`Validation timed out — allowing edit (fail-open)`);
      clearCacheForFile(filePath);
      return { action: 'allow', message: 'Validation timed out (allowing edit)' };
    }

    log(`Validation error: ${errorMsg}`);
    clearCacheForFile(filePath);
    return { action: 'allow', message: `Validation error (allowing edit): ${errorMsg}` };
  }
}

/**
 * @what Determines if a file should skip validation
 * @how Checks file path against patterns for docs, configs, tests, hooks, etc.
 * @why Some files don't need code quality validation (documentation, config, tests, infrastructure)
 *
 * @param {string} filePath Absolute path to file
 * @returns {boolean} True if validation should be skipped
 *
 * @sideeffects None
 * @systemlayer Filtering
 * @domain file-filtering, validation-exemption
 * @tags filtering, exemptions, skip-patterns, performance-optimization, smart-filtering
 */
function shouldSkipValidation(filePath: string): boolean {
  const skipPatterns = [
    /\.md$/,                    // Markdown files
    /\.txt$/,                   // Text files
    /\.json$/,                  // JSON files
    /\.gitignore$/,             // Git ignore
    /CLAUDE\.local/,            // Local Claude config
    /\.env/,                    // Environment files
    /package\.json$/,           // Package manifest
    /tsconfig\.json$/,          // TypeScript config
    /\.test\.(ts|js|tsx|jsx)$/, // Test files
    /\.spec\.(ts|js|tsx|jsx)$/, // Spec files
    /\.claude\/hooks\//         // Hook files (validation infrastructure)
  ];

  return skipPatterns.some(pattern => pattern.test(filePath));
}

/**
 * @what Reads input from stdin
 * @how Accumulates chunks from stdin stream until end
 * @why Hook receives input via stdin from Claude Code
 *
 * @returns {Promise<string>} Complete stdin content
 *
 * @sideeffects None
 * @systemlayer I/O
 * @domain stdin-handling, input-reading
 * @tags stdin, async-io, stream-processing, input-handling, promise-based
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', chunk => {
      data += chunk;
    });

    process.stdin.on('end', () => {
      resolve(data);
    });

    process.stdin.on('error', reject);
  });
}

/**
 * @what Logs message to debug log file
 * @how Appends message with newline to LOG_PATH
 * @why Debugging hook execution and validation decisions
 *
 * @param {string} message Message to log
 * @returns {void}
 *
 * @sideeffects Writes to log file
 * @systemlayer Logging
 * @domain debugging, logging
 * @tags logging, debugging, file-append, troubleshooting, observability
 */
const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2MB rotation threshold
let logRotationChecked = false;

function log(message: string): void {
  try {
    // Rotate log once per hook invocation if over 2MB
    if (!logRotationChecked) {
      logRotationChecked = true;
      if (existsSync(LOG_PATH)) {
        const size = statSync(LOG_PATH).size;
        if (size > MAX_LOG_SIZE) {
          renameSync(LOG_PATH, LOG_PATH + '.old');
        }
      }
    }
    appendFileSync(LOG_PATH, message + '\n');
  } catch {
    // Ignore logging errors
  }
}

/**
 * @what Exits with allow decision and optional message
 * @how Outputs JSON to stdout and exits with code 0
 * @why Cleanly allows edit and exits hook process
 *
 * @param {string} message Optional success message
 * @returns {never}
 *
 * @sideeffects Outputs to stdout, exits process
 * @systemlayer Exit Handler
 * @domain hook-response, process-exit
 * @tags exit-handler, allow-decision, stdout-output, process-termination, success-path
 */
function allowAndExit(message?: string, suggestions?: string[]): never {
  log(`ALLOW: ${message || 'Edit allowed'}`);
  const response: Record<string, unknown> = { action: 'allow', message };
  if (suggestions && suggestions.length > 0) {
    response.suggestions = suggestions;
    log(`  Suggestions returned to caller: ${suggestions.length}`);
  }
  console.log(JSON.stringify(response));
  process.exit(0);
}

/**
 * @what Exits with deny decision, message, and violations
 * @how Outputs JSON to stderr and exits with code 2
 * @why Blocks edit and provides detailed feedback about code quality violations
 *
 * @param {string} message Error message
 * @param {string[]} violations Specific violation list
 * @returns {never}
 *
 * @sideeffects Outputs to stderr, exits process with code 2
 * @systemlayer Exit Handler
 * @domain hook-response, process-exit
 * @tags exit-handler, deny-decision, stderr-output, process-termination, block-edit
 */
function denyAndExit(message: string, violations?: string[]): never {
  log(`DENY: ${message}`);
  if (violations) {
    log(`Violations:\n${violations.join('\n')}`);
  }

  const reason = violations ? `${message}\n\n${violations.join('\n')}` : message;
  // Output deny decision on stderr with exit code 2 (Claude Code hook protocol)
  console.error(JSON.stringify({ permissionDecision: 'deny' as const, reason }));
  process.exit(2);
}

// Run the hook
main().catch(error => {
  log(`Fatal error: ${error}`);
  // Fail open on fatal errors
  console.log(JSON.stringify({ action: 'allow', message: 'Hook fatal error (allowing edit)' }));
  process.exit(0);
});
