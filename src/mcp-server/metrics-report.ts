#!/usr/bin/env node
/**
 * @fileoverview CLI wrapper over the guardian's durable decision metrics. Parses args and
 * prints the shared report from `metrics-query.ts` (the same output the MCP `metrics` tool
 * returns). Answers "how useful is the guardian?" — allow/deny rates (overall and on genuine
 * code-quality judgments), outcome and violation-category breakdowns, per-project rates, and
 * headless-validation timing — over any window.
 *
 * Usage:
 *   npm run metrics                       # all-time, all projects
 *   npm run metrics -- --since=7          # last 7 days
 *   npm run metrics -- --project=harmony  # one project (name substring)
 */
import { buildMetricsReport } from './metrics-query.js';

/**
 * @what Runs the metrics CLI: parses --since/--project, then prints the shared report
 * @how Validates --since (positive number of days; exits non-zero on bad input), extracts the --project substring, and delegates the query + formatting to buildMetricsReport
 * @why Keeps the CLI a thin front-end so the report logic stays shared with the MCP `metrics` tool (one source of truth)
 *
 * @returns {void}
 *
 * @sideeffects Reads the metrics SQLite database via buildMetricsReport, writes a report to stdout, and may exit the process on invalid input
 * @systemlayer CLI
 * @domain metrics, reporting
 * @tags metrics-report, cli, arg-parsing
 */
function main(): void {
  const args = process.argv.slice(2);
  const sinceArg = args.find(a => a.startsWith('--since='));
  const projectArg = args.find(a => a.startsWith('--project='));

  let sinceDays: number | null = null;
  if (sinceArg) {
    sinceDays = Number(sinceArg.split('=')[1]);
    if (!Number.isFinite(sinceDays) || sinceDays <= 0) {
      console.error(`Invalid --since value "${sinceArg.split('=')[1]}". Use a positive number of days, e.g. --since=7.`);
      process.exit(1);
    }
  }
  const projectFilter = projectArg ? projectArg.split('=')[1] : null;

  console.log(`\n${buildMetricsReport({ sinceDays, projectFilter })}\n`);
}

main();
