/**
 * @fileoverview Classifies a PreToolUse tool call as a semantic search, a grep-family codebase
 * search, or neither — so the search-hint hook can nudge Claude toward the semantic `search` MCP
 * tool without firing on unrelated commands. The interesting work is parsing `Bash` commands:
 * `rg`/`grep -r`/`git grep`/`find -name`/`fd` searching the tree count, but a piped filter
 * (`ps aux | grep node`), a single-file grep, or `find -delete` do not. Pure and dependency-free
 * (string parsing only) so it stays fast on every tool call and is trivially unit-testable.
 */
import path from 'path';

/**
 * @what The category of a tool call from the search-hint hook's perspective
 * @domain search-hint, classification
 * @tags search-kind, classification, hook
 */
export type SearchKind = 'semantic' | 'grep-search' | 'none';

// The guardian's own semantic-search MCP tools. Seeing one means Claude is already using
// semantic search, which resets the re-arm counter (no nudge).
const SEMANTIC_TOOLS = new Set([
  'mcp__codebase-guardian__search',
  'mcp__codebase-guardian__search_comments',
  'mcp__codebase-guardian__search_doc_sections',
]);

// Recursive-by-default searchers: given no path they still search the tree, so they count as a
// codebase search unless they are clearly filtering piped stdin.
const RECURSIVE_TOOLS = new Set(['rg', 'ripgrep', 'ag', 'ack', 'ack-grep', 'fd', 'fdfind', 'ug', 'ugrep', 'rga']);
// Plain greps only count when recursive or given a directory/glob (else they read stdin or one file).
const GREP_TOOLS = new Set(['grep', 'egrep', 'fgrep', 'zgrep']);
const FIND_TOOLS = new Set(['find', 'gfind']);
// `find` is a codebase search only when it searches by name/path.
const FIND_NAME_PREDICATES = new Set(['-name', '-iname', '-path', '-ipath', '-regex', '-iregex', '-wholename', '-lname']);
// …and only when it is not acting on the results (delete/exec/etc.), even if a name predicate is present.
const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir']);
// Leading words/assignments that wrap the real command; skipped when finding the executable.
const PREFIX_SKIP = new Set(['sudo', 'command', 'time', 'nice', 'env', 'builtin', 'exec']);

/**
 * @what Classifies a PreToolUse tool call as semantic search, grep-family search, or neither
 * @how Maps the guardian search MCP tools to 'semantic', the Grep/Glob tools to 'grep-search', and inspects a Bash command's pipeline stages for a real codebase search; everything else is 'none'
 * @why The search-hint hook only nudges on grep-family searches and must reset its counter on semantic searches, so it needs to tell the three apart from any other tool call
 *
 * @param {string} toolName The PreToolUse tool name (e.g. 'Grep', 'Bash', 'mcp__codebase-guardian__search')
 * @param {unknown} toolInput The tool input object (only `command` is read, for Bash)
 * @returns {SearchKind} 'semantic', 'grep-search', or 'none'
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain search-hint, classification, hook
 * @tags classify-search, grep-detection, semantic-search, bash-parsing
 */
export function classifySearch(toolName: string, toolInput: unknown): SearchKind {
  if (SEMANTIC_TOOLS.has(toolName)) return 'semantic';
  if (toolName === 'Grep' || toolName === 'Glob') return 'grep-search';
  if (toolName === 'Bash') {
    const command = typeof (toolInput as { command?: unknown })?.command === 'string'
      ? (toolInput as { command: string }).command
      : '';
    return detectBashSearch(command) ? 'grep-search' : 'none';
  }
  return 'none';
}

/**
 * @what Reports whether a Bash command line contains a codebase search (vs. a filter or unrelated command)
 * @how Splits the line into commands (on ; && || newline) then pipeline stages (on |), and asks stageIsSearch about each stage's leading executable, treating stages after a pipe as reading stdin
 * @why grep-family tools appear both as real searches and as stdin filters; only the former should nudge, and that distinction lives at the pipeline-stage level
 *
 * @param {string} command The raw Bash command string
 * @returns {boolean} True if any stage is a codebase search
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain search-hint, bash-parsing
 * @tags bash-search, pipeline-split, grep-detection
 */
function detectBashSearch(command: string): boolean {
  if (!command || !command.trim()) return false;
  // Split into separate commands, then pipeline stages. Quote-aware splitting is intentionally
  // skipped — a rare misclassification only means a spurious/missed nudge, never a broken command.
  for (const cmd of command.split(/;|&&|\|\||\n/)) {
    const stages = cmd.split('|');
    for (let i = 0; i < stages.length; i++) {
      const tokens = stripPrefixTokens(stages[i].trim().split(/\s+/).filter(Boolean));
      if (tokens.length === 0) continue;
      const exe = path.basename(tokens[0]);
      if (stageIsSearch(exe, tokens.slice(1), i > 0)) return true;
    }
  }
  return false;
}

/**
 * @what Drops leading command wrappers and environment assignments to reach the real executable
 * @how Skips tokens that are `VAR=value` assignments or in the PREFIX_SKIP set (sudo/time/env/…)
 * @why `sudo rg foo` and `FOO=bar grep -r x src` should be recognized by their real command, not the wrapper
 *
 * @param {string[]} tokens The whitespace-split tokens of one pipeline stage
 * @returns {string[]} The tokens starting at the real executable (possibly empty)
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain search-hint, bash-parsing
 * @tags strip-prefix, tokenization, bash
 */
function stripPrefixTokens(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || PREFIX_SKIP.has(tokens[i]))) {
    i++;
  }
  return tokens.slice(i);
}

/**
 * @what Decides whether one pipeline stage is a codebase search
 * @how Recognizes `git grep`, recursive tools (rg/ag/fd/…), `grep` with -r or a dir/glob path, and `find` with a name predicate — while rejecting stdin filters (piped grep with no path) and non-search finds
 * @why Encodes the include/exclude rules that separate "searching the codebase" from "filtering output" or "reading one file"
 *
 * @param {string} exe The stage's executable basename
 * @param {string[]} args The stage's arguments after the executable
 * @param {boolean} pipedIntoThis True when this stage receives another command's stdout (stage index > 0)
 * @returns {boolean} True if the stage is a codebase search
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain search-hint, bash-parsing
 * @tags stage-search, grep-detection, filter-exclusion
 */
function stageIsSearch(exe: string, args: string[], pipedIntoThis: boolean): boolean {
  if (exe === 'git') return args[0] === 'grep';

  if (RECURSIVE_TOOLS.has(exe)) {
    // rg/ag/fd/… search the tree by default. The only non-search case is filtering piped stdin
    // with no path given (e.g. `… | rg foo`); with a path or as the first stage it's a real search.
    if (pipedIntoThis && nonFlagArgs(args).length <= 1) return false;
    return true;
  }

  if (GREP_TOOLS.has(exe)) {
    if (hasGrepRecursiveFlag(args)) return true;
    // A directory/glob path (not piped) means a codebase search; a lone pattern or single file does not.
    if (!pipedIntoThis && nonFlagArgs(args).slice(1).some(looksLikeDirOrGlob)) return true;
    return false;
  }

  if (FIND_TOOLS.has(exe)) {
    // A find that deletes/execs is acting on results, not searching — skip it even with a name predicate.
    if (args.some(a => FIND_ACTIONS.has(a))) return false;
    return args.some(a => FIND_NAME_PREDICATES.has(a));
  }

  return false;
}

/**
 * @what Returns the arguments that are not option flags
 * @how Filters out tokens beginning with '-'
 * @why Distinguishes a search's pattern and path operands from its flags without a full option parser
 *
 * @param {string[]} args The stage arguments
 * @returns {string[]} The non-flag arguments in order
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain search-hint, bash-parsing
 * @tags non-flag-args, argument-parsing
 */
function nonFlagArgs(args: string[]): string[] {
  return args.filter(a => !a.startsWith('-'));
}

/**
 * @what Reports whether grep's arguments request recursive search
 * @how Matches `--recursive` or a short-flag bundle containing r/R (e.g. -r, -rn, -Rn)
 * @why grep only searches a directory tree when told to recurse, so recursion implies a codebase search
 *
 * @param {string[]} args The grep arguments
 * @returns {boolean} True if a recursive flag is present
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain search-hint, bash-parsing
 * @tags grep-recursive, flag-detection
 */
function hasGrepRecursiveFlag(args: string[]): boolean {
  return args.some(a => a === '--recursive' || (/^-[a-zA-Z]*[rR]/.test(a) && !a.startsWith('--')));
}

/**
 * @what Reports whether a path operand looks like a directory or glob rather than a single file
 * @how True for '.', '..', trailing-slash paths, glob chars (* ?), or basenames with no extension
 * @why Grepping a directory/glob is a codebase search; grepping one named file is just reading it
 *
 * @param {string} p A candidate path argument
 * @returns {boolean} True if it looks like a directory or glob
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain search-hint, bash-parsing
 * @tags path-heuristic, dir-or-glob
 */
function looksLikeDirOrGlob(p: string): boolean {
  if (p === '.' || p === '..' || p.endsWith('/')) return true;
  if (p.includes('*') || p.includes('?')) return true;
  return !path.basename(p).includes('.');
}
