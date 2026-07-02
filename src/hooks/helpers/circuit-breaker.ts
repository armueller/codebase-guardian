/**
 * @what Decides when the validation hook must stop blocking a repeatedly-denied edit
 * @how Compares the session's consecutive-denial count against a fixed threshold
 * @why Now that denials actually block the tool call, an imperfect/strict validator — or a legitimate multi-step refactor passing through messy intermediate states — can trap the agent in an endless deny→revise→deny loop. Releasing after a bounded number of denials upholds the hook's core invariant: it must NEVER permanently block work.
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain circuit-breaker, retry-limiting, fail-open
 * @tags circuit-breaker, retry-cap, never-block, safety-valve, doom-loop
 */

/**
 * @what Maximum consecutive denials of the same file in a session before the hook stands down
 * @domain circuit-breaker, retry-limiting
 * @tags threshold, retry-cap, circuit-breaker
 */
export const MAX_CONSECUTIVE_DENIALS = 3;

/**
 * @what Returns true when a session has been denied enough times that the hook must stand down and allow the edit
 * @how True once the stored consecutive-denial count reaches the threshold (blocks attempts 1..N, releases on attempt N+1)
 * @why Guarantees forward progress — the agent can never be trapped in an unresolvable deny loop
 *
 * @param {number} attemptCount Consecutive denials recorded for this session (0 on a first attempt)
 * @param {number} maxDenials Threshold to trip the breaker (defaults to MAX_CONSECUTIVE_DENIALS)
 * @returns {boolean} True if the edit should be allowed through despite unresolved concerns
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain circuit-breaker, retry-limiting
 * @tags circuit-breaker, retry-cap, predicate, safety-valve
 */
export function shouldStandDown(attemptCount: number, maxDenials: number = MAX_CONSECUTIVE_DENIALS): boolean {
  return attemptCount >= maxDenials;
}
