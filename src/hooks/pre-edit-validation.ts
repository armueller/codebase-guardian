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
import { extractFunctionWithJSDoc, extractTypeWithJSDoc } from './helpers/function-extractor.js';
import {
  extractCalledFunctions,
  extractPropertyAccesses,
  analyzeFunctionUsage,
  analyzeTypeUsage,
  extractDeclaredTypes,
  findEnclosingFunctions
} from './helpers/code-analyzer.js';
import { validateJSDocCompleteness, validateTypeJSDocCompleteness } from './helpers/jsdoc-parser.js';
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
  generateCacheKey
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
      allowAndExit(result.message || 'Validation passed');
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
  if (filePath && existsSync(filePath)) {
    try {
      const currentContent = readFileSync(filePath, 'utf-8');
      if (oldString) {
        fullFileContent = replaceAll
          ? currentContent.split(oldString).join(newString)
          : currentContent.replace(oldString, newString);
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

  // ── Step 2: Analyze function usage ──

  const t2 = Date.now();
  const usage = analyzeFunctionUsage(oldString, newString);
  log(`[TIMING] Analyze usage: ${Date.now() - t2}ms`);
  log(`Functions - Called: ${usage.called.length}, Modified: ${usage.modified.length}, Created: ${usage.created.length}`);

  // ── Step 2b: Analyze type/interface/enum usage ──

  const t2b = Date.now();
  const typeUsage = analyzeTypeUsage(oldString, newString);
  log(`[TIMING] Analyze type usage: ${Date.now() - t2b}ms`);
  log(`Types - Modified: ${typeUsage.modified.length}, Created: ${typeUsage.created.length}`);

  // Detect new file creation (Write to non-existent file)
  const isNewFile = input.tool_name === 'Write' && !existsSync(filePath);

  // If no functions or types modified/created, check if the edit falls inside a function body
  if (usage.modified.length === 0 && usage.created.length === 0 &&
      typeUsage.modified.length === 0 && typeUsage.created.length === 0) {
    if (isNewFile) {
      // New file creation — always validate the full file content.
      // Regex-based extraction can't catch every framework pattern (wrapped functions,
      // HOCs, middleware wrappers, etc.), but headless Claude can evaluate any code.
      log('New file creation detected — validating full file');
    } else {
      // Existing file edit — detect body-only edits by finding the enclosing function
      const enclosing = findEnclosingFunctions(fullFileContent, oldString, newString);
      if (enclosing.length > 0) {
        log(`Body-only edit detected inside: ${enclosing.join(', ')} — treating as modified`);
        usage.modified.push(...enclosing);
      } else {
        log('No functions or types modified/created and no enclosing function found — skipping validation');
        return { action: 'allow', message: 'No function or type declarations changed — no validation needed' };
      }
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

  // Get the declared types from newString to know their kind
  const declaredTypes = extractDeclaredTypes(newString);
  const typeKindMap = new Map(declaredTypes.map(t => [t.name, t.kind]));

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
    if (!func.hasJSDoc) {
      jsdocViolations.set(func.name, [`Function '${func.name}' is missing JSDoc entirely`]);
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
  const calledFunctions = extractCalledFunctions(newString);
  const propertyAccesses = extractPropertyAccesses(newString);
  log(`[TIMING] Extract calls/properties: ${Date.now() - t6}ms (${calledFunctions.length} calls, ${propertyAccesses.length} properties)`);

  // ── Step 7: Determine if this is a first attempt or retry ──

  const sessionKey = `${sessionId}:${filePath}`;
  let existingSession = getSession(sessionKey);

  // If the file has been modified since the last denial (e.g., by another edit that added JSDoc),
  // the resumed session would have stale context. Clear it and force a fresh first-attempt.
  if (existingSession && existingSession.lastDeniedContentHash) {
    const currentFileHash = crypto.createHash('sha256').update(fullFileContent).digest('hex').slice(0, 16);
    if (currentFileHash !== existingSession.lastDeniedContentHash) {
      log(`[SESSION] File content changed since last denial — clearing stale session for fresh validation`);
      clearSessionEntry(sessionKey);
      existingSession = null;
    }
  }

  const isRetry = existingSession !== null;
  log(`[SESSION] ${isRetry ? `Retry attempt #${existingSession!.attemptCount + 1} (session: ${existingSession!.headlessSessionId})` : 'First attempt'}`);

  // Check for identical resubmission on retry — return cached denial without invoking headless Claude
  if (isRetry && existingSession!.lastDeniedContentHash) {
    const currentFileHash = crypto.createHash('sha256').update(fullFileContent).digest('hex').slice(0, 16);
    if (currentFileHash === existingSession!.lastDeniedContentHash) {
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
    const patternContext = buildPatternContext(
      filePath,
      usage.modified,
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

    // Cache the result
    setCachedValidation(cacheKey, validationResult);

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
    // Uses fullFileContent hash so we can detect when other edits changed the file between retries
    if (validationResult.decision !== 'allow') {
      const fileHash = crypto.createHash('sha256').update(fullFileContent).digest('hex').slice(0, 16);
      setDenialInfo(sessionKey, fileHash, validationResult.reasoning);
    }

    return {
      action: validationResult.decision === 'allow' ? 'allow' : 'deny',
      message: validationResult.decision === 'allow'
        ? `Code Quality Passed: ${validationResult.reasoning}`
        : `BLOCKED: ${validationResult.reasoning}`,
      violations: validationResult.violations
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    if (errorMsg.includes('timed out')) {
      log(`Validation timed out — allowing edit (fail-open)`);
      return { action: 'allow', message: 'Validation timed out (allowing edit)' };
    }

    log(`Validation error: ${errorMsg}`);
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
function allowAndExit(message?: string): never {
  log(`ALLOW: ${message || 'Edit allowed'}`);
  console.log(JSON.stringify({ action: 'allow', message }));
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
