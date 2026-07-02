/**
 * @what Builds the PreToolUse decision envelope that Claude Code actually honors for allow/deny/ask
 * @how Wraps the decision in the `hookSpecificOutput` shape (printed to stdout, exit 0) — the schema Claude Code 2.1.x enforces
 * @why The legacy exit-2 + stderr `{permissionDecision}` convention is classified as a non-blocking error, so denies never blocked; this envelope makes a deny actually block the edit
 *
 * @sideeffects None
 * @systemlayer Hook Protocol
 * @domain hook-response, permission-decision, pretooluse-protocol
 * @tags hook-output, permission-decision, pretooluse, deny-block, schema
 */

/**
 * @what Shape of the decision object Claude Code reads from a PreToolUse hook's stdout
 * @domain hook-response, pretooluse-protocol
 * @tags hook-output, pretooluse, permission-decision, schema
 */
export interface PreToolUseDecisionOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
}

/**
 * @what Constructs the PreToolUse permission-decision object for a hook to print to stdout
 * @how Nests the decision under `hookSpecificOutput` with the exact field names Claude Code parses, attaching a reason when provided
 * @why A deny is only enforced when returned via this envelope on stdout with exit 0 — the older exit-2 + stderr JSON is downgraded to a non-blocking error and the edit proceeds anyway
 *
 * @param {'allow' | 'deny' | 'ask'} decision Permission decision for the pending tool call
 * @param {string} [reason] Human-readable reason (surfaced to Claude on deny, to the user on ask)
 * @returns {PreToolUseDecisionOutput} Object to `JSON.stringify` to stdout before exiting 0
 *
 * @sideeffects None
 * @systemlayer Hook Protocol
 * @domain hook-response, permission-decision, pretooluse-protocol
 * @tags hook-output, permission-decision, pretooluse, deny-block, schema
 */
export function buildPreToolUseDecision(
  decision: 'allow' | 'deny' | 'ask',
  reason?: string
): PreToolUseDecisionOutput {
  const hookSpecificOutput: PreToolUseDecisionOutput['hookSpecificOutput'] = {
    hookEventName: 'PreToolUse',
    permissionDecision: decision
  };
  if (reason !== undefined) {
    hookSpecificOutput.permissionDecisionReason = reason;
  }
  return { hookSpecificOutput };
}
