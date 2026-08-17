#!/usr/bin/env node
/**
 * @fileoverview CLI report over the guardian's durable decision metrics
 * (`<guardianHome>/metrics.db`). Answers "how useful is the guardian?" — allow/deny rates
 * (overall and on genuine code-quality judgments), outcome and violation-category breakdowns,
 * per-project rates, and headless-validation timing — over any window.
 *
 * Usage:
 *   npm run metrics                       # all-time, all projects
 *   npm run metrics -- --since=7          # last 7 days
 *   npm run metrics -- --project=harmony  # one project (name substring)
 */
import Database from 'better-sqlite3';
import path from 'path';
import { existsSync } from 'fs';
import { getGuardianHome } from '../config.js';

interface DecisionCount { decision: string; n: number; }

/**
 * @what Returns the p-th percentile of a numeric array
 * @how Sorts ascending and picks the nearest-rank element; returns 0 for an empty array
 * @why Summarizes headless-validation latency without a stats dependency (and avoids spreading the array into Math.max)
 *
 * @param {number[]} values Numeric samples
 * @param {number} p Percentile in [0,100]
 * @returns {number} The percentile value (0 if no samples)
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain metrics, statistics
 * @tags percentile, statistics, timing, report
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * @what Looks up the count for a given decision in a grouped result set
 * @how Finds the row whose `decision` matches and returns its `n`, or 0 if absent
 * @why Turns a GROUP BY decision result into simple allow/deny scalars for rate math
 *
 * @param {DecisionCount[]} rows Rows of { decision, n } from a GROUP BY decision query
 * @param {string} decision The decision to look up ('allow' or 'deny')
 * @returns {number} The count, or 0 when that decision has no rows
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain metrics, aggregation
 * @tags count-by-decision, aggregation, metrics, report
 */
function countByDecision(rows: DecisionCount[], decision: string): number {
  return rows.find(r => r.decision === decision)?.n ?? 0;
}

/**
 * @what Formats a numerator/denominator as a one-decimal percentage string
 * @how Returns "N.N%" for a non-zero denominator, or an em-dash when the denominator is zero
 * @why Keeps rate formatting consistent and avoids divide-by-zero output across the report
 *
 * @param {number} num Numerator
 * @param {number} den Denominator
 * @returns {string} A percentage string, or '—' when the denominator is zero
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain metrics, formatting
 * @tags percentage, formatting, metrics, report
 */
function formatPct(num: number, den: number): string {
  return den ? `${(100 * num / den).toFixed(1)}%` : '—';
}

/**
 * @what Runs the metrics report: parses args, queries the store, and prints the summary
 * @how Validates --since, builds a whitelisted WHERE from --since/--project (named params only, no user text interpolated), aggregates decisions, and prints rates, outcomes, deny categories, per-project rates, and timing
 * @why Provides the durable "is the guardian useful over time?" view that the rotating debug log cannot
 *
 * @returns {void}
 *
 * @sideeffects Reads the metrics SQLite database and writes a report to stdout; may exit the process
 * @systemlayer CLI
 * @domain metrics, reporting
 * @tags metrics-report, cli, aggregation, sqlite
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

  const dbPath = path.join(getGuardianHome(), 'metrics.db');
  if (!existsSync(dbPath)) {
    console.log(`No metrics database yet at ${dbPath}. The store is created on the first validated edit.`);
    return;
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    // WHERE is assembled only from this fixed clause whitelist with named params —
    // no user-supplied text is ever interpolated into SQL.
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (sinceDays) {
      where.push('ts >= @cutoff');
      params.cutoff = new Date(Date.now() - sinceDays * 86400_000).toISOString();
    }
    if (projectFilter) {
      where.push('(project_name LIKE @pf OR project_root LIKE @pf)');
      params.pf = `%${projectFilter}%`;
    }
    const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const AND = W ? `${W} AND` : 'WHERE';

    const total = db.prepare(`SELECT COUNT(*) n, MIN(ts) lo, MAX(ts) hi FROM decisions ${W}`).get(params) as { n: number; lo: string; hi: string };
    if (!total.n) { console.log('No decisions match that filter.'); return; }

    const overall = db.prepare(`SELECT decision, COUNT(*) n FROM decisions ${W} GROUP BY decision`).all(params) as DecisionCount[];
    const genuine = db.prepare(`SELECT decision, COUNT(*) n FROM decisions ${AND} headless_ran = 1 GROUP BY decision`).all(params) as DecisionCount[];
    const outcomes = db.prepare(`SELECT outcome, COUNT(*) n FROM decisions ${W} GROUP BY outcome ORDER BY n DESC`).all(params) as Array<{ outcome: string; n: number }>;
    const projects = db.prepare(`SELECT project_name p, COUNT(*) n, SUM(decision='deny') d FROM decisions ${W} GROUP BY project_name ORDER BY n DESC LIMIT 12`).all(params) as Array<{ p: string; n: number; d: number }>;
    const timings = (db.prepare(`SELECT headless_ms m FROM decisions ${AND} headless_ms IS NOT NULL`).all(params) as Array<{ m: number }>).map(r => r.m);
    const denyCats = db.prepare(`SELECT violation_categories c FROM decisions ${AND} decision='deny' AND violation_categories IS NOT NULL`).all(params) as Array<{ c: string }>;

    const oAllow = countByDecision(overall, 'allow'), oDeny = countByDecision(overall, 'deny'), oTot = oAllow + oDeny;
    const gAllow = countByDecision(genuine, 'allow'), gDeny = countByDecision(genuine, 'deny'), gTot = gAllow + gDeny;

    const catCounts = new Map<string, number>();
    let skipped = 0;
    for (const row of denyCats) {
      try { for (const c of JSON.parse(row.c) as string[]) catCounts.set(c, (catCounts.get(c) ?? 0) + 1); }
      catch { skipped++; } // row's JSON is corrupt; count it so the deny-reasons section isn't silently under-reported
    }

    console.log(`\n=== Codebase Guardian — Decision Metrics ===`);
    console.log(`Window: ${total.lo} → ${total.hi}   (${total.n} decisions${sinceDays ? `, last ${sinceDays}d` : ''}${projectFilter ? `, project~"${projectFilter}"` : ''})\n`);
    console.log(`Overall:            allow ${formatPct(oAllow, oTot)}   deny ${formatPct(oDeny, oTot)}   (${oTot})`);
    console.log(`Genuine judgments:  allow ${formatPct(gAllow, gTot)}   deny ${formatPct(gDeny, gTot)}   (${gTot} headless-validated edits)\n`);

    console.log(`Outcomes:`);
    for (const o of outcomes) console.log(`  ${String(o.n).padStart(6)}  ${o.outcome}`);

    console.log(`\nDeny reasons (categories, a deny can span several):`);
    for (const [c, n] of [...catCounts.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(6)}  ${c}`);
    if (skipped) console.log(`  (skipped ${skipped} deny row(s) with unparseable category data)`);

    console.log(`\nBy project:`);
    for (const p of projects) console.log(`  ${(p.p || '(unknown)').padEnd(24)} ${String(p.n).padStart(5)} edits   deny ${formatPct(p.d, p.n)}`);

    if (timings.length) {
      console.log(`\nHeadless validation time (ms): p50 ${percentile(timings, 50)}  p90 ${percentile(timings, 90)}  p99 ${percentile(timings, 99)}  max ${percentile(timings, 100)}`);
    }
    console.log('');
  } finally {
    db.close();
  }
}

main();
