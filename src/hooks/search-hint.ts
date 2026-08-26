#!/usr/bin/env node
/**
 * @fileoverview PreToolUse hook that nudges Claude toward the semantic `search` MCP tool when it
 * searches the codebase with grep-family tools (the Grep/Glob tools and rg/grep/find/etc. via Bash).
 * It never blocks: it emits a non-blocking `additionalContext` reminder via hookSpecificOutput
 * (permissionDecision "allow"), throttled per session (nudge once, re-arm after N unheeded greps,
 * reset when the semantic tool is used). It also watches the semantic-search MCP tools to reset that
 * counter, and appends a rebuild-index suggestion when the index is stale. Fail-open by construction:
 * any error, or a project with no index, produces no output so the search proceeds untouched.
 */
import { existsSync } from 'fs';
import { classifySearch } from './helpers/search-detection.js';
import { recordSearchEvent } from './helpers/search-hint-state.js';
import { countChangesSinceBuild } from './helpers/index-staleness.js';
import { resolveConfig } from '../config.js';

const REMINDER =
  "💡 Codebase Guardian: to find code by concept rather than exact strings, `mcp__codebase-guardian__search` " +
  "runs hybrid keyword + semantic search over this project's index — worth a look before writing new code " +
  "(helps avoid duplicates). grep/rg stay best for exact matches.";

/**
 * @what Reads all of stdin into a string
 * @how Collects stdin data chunks and resolves with the concatenation on end
 * @why The PreToolUse payload arrives on stdin as JSON
 *
 * @returns {Promise<string>} The full stdin contents
 *
 * @sideeffects Consumes the process stdin stream
 * @systemlayer Hook Entry
 * @domain search-hint, hook-io
 * @tags stdin, read-input, hook
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/**
 * @what Emits a non-blocking PreToolUse reminder that the model will read
 * @how Writes a hookSpecificOutput JSON with permissionDecision "allow" and the given additionalContext to stdout
 * @why additionalContext is injected into Claude's context while the tool proceeds normally — the right channel for an informational nudge
 *
 * @param {string} additionalContext The reminder text to surface to the model
 * @returns {void}
 *
 * @sideeffects Writes JSON to stdout
 * @systemlayer Hook Entry
 * @domain search-hint, hook-output
 * @tags additional-context, non-blocking, hook-output
 */
function emit(additionalContext: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext },
  }));
}

/**
 * @what Search-hint hook entry point: classify the tool call, throttle, and maybe nudge
 * @how Classifies the tool as semantic/grep-search/none; a semantic call resets the counter; a grep-search consults the per-session throttle and, when it fires, gates on the project having an index and emits the reminder (plus a rebuild suggestion if the index is stale); everything is wrapped so any failure produces no output
 * @why Surfaces the semantic search tool at the moment Claude reaches for grep, without ever blocking or slowing the common (non-search) path
 *
 * @returns {Promise<void>} Resolves once any reminder has been written (or the call was ignored)
 *
 * @sideeffects Reads stdin; on grep-search events resolves project config, reads/writes throttle state, may spawn a git subprocess, and may write JSON to stdout
 * @systemlayer Hook Entry
 * @domain search-hint, hook-execution, fail-open
 * @tags hook-main, entry-point, throttle, nudge, fail-open
 */
async function main(): Promise<void> {
  try {
    const input = JSON.parse(await readStdin());
    const kind = classifySearch(input.tool_name, input.tool_input);
    if (kind === 'none') return;

    const sessionId: string = input.session_id || '';

    if (kind === 'semantic') {
      // The agent is already using semantic search — reset the counter, never nudge.
      // rearmAfter is irrelevant for a semantic event, so a constant is fine (no config load needed).
      recordSearchEvent(sessionId, 'semantic', 1);
      return;
    }

    // grep-search: resolve the cwd project's config (index path + searchHint knobs).
    const cwd: string = input.cwd || process.cwd();
    const config = resolveConfig(cwd);
    if (!config.searchHint.enabled) return;

    if (!recordSearchEvent(sessionId, 'grep', config.searchHint.rearmAfter)) return;

    // Only nudge toward `search` when the project actually has an index for it to query.
    if (!existsSync(config.databasePath)) return;

    let context = REMINDER;
    const changed = countChangesSinceBuild(config.projectRoot, config.databasePath);
    if (changed >= config.searchHint.stalenessThreshold) {
      context += ` · ${changed} files have changed since the index was last built — run \`rebuild_index\` first for accurate results.`;
    }
    emit(context);
  } catch {
    // Fail-open: never block a search, never emit malformed output.
  }
}

main();
