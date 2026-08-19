/**
 * @what Python validation prompt builders — the neutral system prompt, the shared JSON response contract, and the first-attempt/retry user-prompt assembly for the Python headless Claude path
 * @how Formats deterministic ruff/pydoclint findings, local doc-completeness violations, module metadata, proposed functions/classes (UNITS), and pre-injected code index context (via the shared formatPatternContextSections/PatternContext helpers imported from claude-headless.ts) into the self-contained user prompts buildPythonFirstAttemptPrompt and buildPythonRetryPrompt consume
 * @why Extracted (DC-1) from claude-headless.ts, which mixed headless-CLI plumbing, the TypeScript prompt builders, and the Python prompt builders in one 1400+ line file. Isolating the Python prompt code here mirrors how the rest of the Python path is already factored into dedicated modules (py-tools.ts, py-doc-check.ts, py-validate.ts) — a pure mechanical move with no logic/behavior change
 *
 * @sideeffects None
 * @systemlayer Prompt Engineering
 * @domain prompt-building, python-support, code-quality
 * @tags prompt-engineering, python, first-attempt, retry, pattern-context, warn-not-deny, validation-prompt
 */

import { ExtractedClass, ExtractedFunction } from './types.js';
import type { PatternContext } from './code-index-client.js';
import type { PyFinding } from './py-tools.js';
import { formatPatternContextSections } from './claude-headless.js';

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
