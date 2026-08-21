#!/usr/bin/env npx tsx
/**
 * Replay a validation hook invocation from the debug log.
 *
 * Usage:
 *   npx tsx scripts/replay-edit.ts <log-file> <timestamp>
 *   npx tsx scripts/replay-edit.ts <log-file> --last
 *   npx tsx scripts/replay-edit.ts <log-file> --last-deny
 *
 * Examples:
 *   npx tsx scripts/replay-edit.ts ~/.claude/plugins/data/codebase-guardian-codebase-guardian/logs/cac76e65de98/validation-debug.log 2026-03-30T18:11:29
 *   npx tsx scripts/replay-edit.ts ~/.claude/plugins/data/codebase-guardian-codebase-guardian/logs/cac76e65de98/validation-debug.log --last-deny
 *
 * This parses the log entry, reconstructs the hook input, runs it through
 * the validation pipeline, and shows detailed diagnostics at each step.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { analyzeChanges } from '../src/hooks/helpers/code-analyzer.js';
import { extractFunctionWithJSDoc, extractTypeWithJSDoc, getSyntaxErrors } from '../src/hooks/helpers/function-extractor.js';
import { validateJSDocCompleteness, validateTypeJSDocCompleteness } from '../src/hooks/helpers/jsdoc-parser.js';
import { resolveConfig } from '../src/config.js';

// ─── Parse CLI args ──────────────────────────────────────────────────────────

const logFile = process.argv[2];
const selector = process.argv[3]; // timestamp, --last, or --last-deny

if (!logFile || !selector) {
  console.error('Usage: npx tsx scripts/replay-edit.ts <log-file> <timestamp|--last|--last-deny>');
  process.exit(1);
}

if (!existsSync(logFile)) {
  console.error(`Log file not found: ${logFile}`);
  process.exit(1);
}

// ─── Parse log entry ─────────────────────────────────────────────────────────

interface LogEntry {
  timestamp: string;
  filePath: string;
  toolName: string;
  oldString: string;
  newString: string;
  decision: string;
  reasoning: string;
  violations: string[];
}

function parseLogEntries(logContent: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const blocks = logContent.split(/^=== /m).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split('\n');
    const timestamp = lines[0]?.replace(' ===', '').trim();
    if (!timestamp) continue;

    let filePath = '';
    let oldString = '';
    let newString = '';
    let decision = '';
    let reasoning = '';
    let toolName = 'Edit';
    const violations: string[] = [];

    // Extract file path
    const fileMatch = block.match(/File: (.+)/);
    if (fileMatch) filePath = fileMatch[1];

    // Extract old_string
    const oldMatch = block.match(/old_string \(\d+ chars\):\n([\s\S]*?)(?=\nnew_string )/);
    if (oldMatch) oldString = oldMatch[1];

    // Extract new_string
    const newMatch = block.match(/new_string \(\d+ chars\):\n([\s\S]*?)(?=\n\[TIMING\])/);
    if (newMatch) newString = newMatch[1];

    // Extract Write content
    const writeMatch = block.match(/Write content \(\d+ chars\)[^:]*:\n([\s\S]*?)(?=\n\[TIMING\])/);
    if (writeMatch) {
      newString = writeMatch[1];
      toolName = 'Write';
    }

    // Extract decision
    const decisionMatch = block.match(/Decision: (\w+)/);
    if (decisionMatch) decision = decisionMatch[1];

    // Extract reasoning
    const reasonMatch = block.match(/Reasoning: (.+)/);
    if (reasonMatch) reasoning = reasonMatch[1];

    // Extract violations
    const violMatch = block.match(/Violations: (\[.+?\])/);
    if (violMatch) {
      try {
        violations.push(...JSON.parse(violMatch[1]));
      } catch { /* ignore parse errors */ }
    }

    if (filePath) {
      entries.push({ timestamp, filePath, toolName, oldString, newString, decision, reasoning, violations });
    }
  }

  return entries;
}

// ─── Select entry ────────────────────────────────────────────────────────────

const logContent = readFileSync(logFile, 'utf-8');
const entries = parseLogEntries(logContent);

let entry: LogEntry | undefined;

if (selector === '--last') {
  entry = entries[entries.length - 1];
} else if (selector === '--last-deny') {
  entry = entries.filter(e => e.decision === 'deny').pop();
} else {
  entry = entries.find(e => e.timestamp.startsWith(selector));
}

if (!entry) {
  console.error(`No matching log entry found for: ${selector}`);
  console.error(`Available timestamps (last 10):`);
  for (const e of entries.slice(-10)) {
    console.error(`  ${e.timestamp} — ${e.filePath.split('/').pop()} — ${e.decision || 'unknown'}`);
  }
  process.exit(1);
}

// ─── Replay ──────────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  Codebase Guardian — Edit Replay                            ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');
console.log(`Timestamp:  ${entry.timestamp}`);
console.log(`File:       ${entry.filePath}`);
console.log(`Tool:       ${entry.toolName}`);
console.log(`old_string: ${entry.oldString.length} chars`);
console.log(`new_string: ${entry.newString.length} chars`);
if (entry.decision) {
  console.log(`Original decision: ${entry.decision}`);
  if (entry.violations.length > 0) {
    console.log(`Original violations:`);
    for (const v of entry.violations) {
      console.log(`  - ${v}`);
    }
  }
}
console.log('');
console.log('─── Replaying through validation pipeline ───');
console.log('');

// Step 1: Construct post-edit file content
let currentFileOnDisk = '';
let fullFileContent = '';

if (existsSync(entry.filePath)) {
  currentFileOnDisk = readFileSync(entry.filePath, 'utf-8');
  if (entry.oldString) {
    fullFileContent = currentFileOnDisk.replace(entry.oldString, entry.newString);
  } else {
    fullFileContent = entry.newString;
  }
} else {
  fullFileContent = entry.newString;
  console.log(`⚠ File not on disk (${entry.filePath}) — using newString as full content`);
}

const isNewFile = entry.toolName === 'Write' && !existsSync(entry.filePath);

console.log(`File on disk: ${currentFileOnDisk.length} chars`);
console.log(`Post-edit:    ${fullFileContent.length} chars`);
console.log(`New file:     ${isNewFile}`);

// Check if old_string was found
if (entry.oldString && !currentFileOnDisk.includes(entry.oldString)) {
  console.log(`⚠ old_string NOT FOUND in current file — file may have changed since the log entry`);
  console.log(`  Trying to proceed with current file content anyway...`);
  // Use current file as-is for pre-edit
}

console.log('');

// Step 2: Syntax check
const syntaxErrors = getSyntaxErrors(fullFileContent);
if (syntaxErrors.length > 0) {
  console.log(`🔴 SYNTAX ERRORS (${syntaxErrors.length}):`);
  for (const err of syntaxErrors) {
    console.log(`  - ${err}`);
  }
  console.log('  → Hook would allow (fail-open for intermediate syntax)');
  console.log('');
} else {
  console.log('✅ No syntax errors');
  console.log('');
}

// Step 3: Analyze changes
const { functionUsage, typeUsage, typeKindMap } = analyzeChanges(currentFileOnDisk, fullFileContent, entry.newString);

console.log('─── Change Analysis ───');
console.log(`Functions — Created: ${functionUsage.created.join(', ') || '(none)'}`);
console.log(`Functions — Modified: ${functionUsage.modified.join(', ') || '(none)'}`);
console.log(`Functions — Deleted: ${functionUsage.deleted.join(', ') || '(none)'}`);
if (functionUsage.renamed.length > 0) {
  console.log(`Functions — Renamed: ${functionUsage.renamed.map(r => `${r.oldName} → ${r.newName}`).join(', ')}`);
}
console.log(`Types — Created: ${typeUsage.created.join(', ') || '(none)'}`);
console.log(`Types — Modified: ${typeUsage.modified.join(', ') || '(none)'}`);
console.log('');

// Step 4: Extract and validate each function
const functionsToValidate = [...functionUsage.modified, ...functionUsage.created];

if (functionsToValidate.length === 0 && !isNewFile) {
  console.log('No functions to validate — hook would skip');
} else {
  console.log('─── Function Extraction & JSDoc Validation ───');
  console.log('');

  for (const funcName of functionsToValidate) {
    const extracted = extractFunctionWithJSDoc(fullFileContent, funcName);
    if (!extracted) {
      console.log(`🔴 ${funcName}: NOT FOUND by extractor`);
      continue;
    }

    console.log(`📄 ${funcName} (line ${extracted.lineInFile}):`);
    console.log(`   hasJSDoc: ${extracted.hasJSDoc}`);

    if (!extracted.hasJSDoc) {
      // Check if JSDoc exists elsewhere in the file for this function
      const jsdocPattern = new RegExp(`@what[\\s\\S]*?${funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      if (jsdocPattern.test(fullFileContent)) {
        console.log(`   ⚠ JSDoc with @what mentioning '${funcName}' EXISTS in file but is NOT attached to the declaration`);
        console.log(`   → The edit may have separated the JSDoc from the function declaration`);

        // Find what's immediately above the function declaration
        const declPos = fullFileContent.indexOf(extracted.fullCode);
        if (declPos > 0) {
          const before = fullFileContent.substring(Math.max(0, declPos - 200), declPos).trim();
          const lastLines = before.split('\n').slice(-3).join('\n');
          console.log(`   → Text above declaration: ...${lastLines}`);
        }
      }
    }

    if (extracted.hasJSDoc && extracted.jsdocTags) {
      const issues = validateJSDocCompleteness(extracted.jsdocTags);
      if (issues.length > 0) {
        console.log(`   JSDoc issues: ${issues.join('; ')}`);
      } else {
        console.log(`   JSDoc: complete ✅`);
      }
    }

    console.log(`   Code preview: ${extracted.fullCode.substring(0, 120).replace(/\n/g, '\\n')}...`);
    console.log('');
  }
}

// Step 5: Type validation
const typesToValidate = [...typeUsage.modified, ...typeUsage.created];
if (typesToValidate.length > 0) {
  console.log('─── Type Extraction & JSDoc Validation ───');
  console.log('');

  for (const typeName of typesToValidate) {
    const kind = typeKindMap.get(typeName);
    if (!kind) continue;
    const extracted = extractTypeWithJSDoc(fullFileContent, typeName, kind);
    if (!extracted) {
      console.log(`🔴 ${typeName}: NOT FOUND`);
      continue;
    }
    console.log(`📄 ${typeName} (${kind}, line ${extracted.lineInFile}): hasJSDoc=${extracted.hasJSDoc}`);
    if (extracted.hasJSDoc && extracted.jsdocTags) {
      const issues = validateTypeJSDocCompleteness(extracted.jsdocTags);
      console.log(`   Issues: ${issues.length === 0 ? 'none ✅' : issues.join('; ')}`);
    }
  }
  console.log('');
}

console.log('─── Summary ───');
console.log(`Would validate ${functionsToValidate.length} function(s), ${typesToValidate.length} type(s)`);
if (isNewFile) {
  console.log('New file — full content would be sent to headless Claude');
}
