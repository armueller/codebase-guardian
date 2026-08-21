/**
 * @fileoverview Shared query + formatting for the guardian's durable decision metrics
 * (`<guardianHome>/metrics.db`). Produces the "is the guardian useful over time?" report —
 * allow/deny rates (overall and on genuine headless judgments), outcome and violation-category
 * breakdowns, per-project rates, and headless timing — as a plain string, so both the CLI
 * (`npm run metrics`) and the MCP `metrics` tool render identical output from one code path.
 * Strictly read-only: opens the store `readonly` and never mutates it.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { existsSync } from 'fs';
import { getGuardianHome } from '../config.js';

interface DecisionCount { decision: string; n: number; }

/**
 * @what A validated, already-parsed filter for the metrics report
 * @domain metrics, reporting
 * @tags metrics-query, filter, schema
 */
export interface MetricsQuery {
  /** Only include decisions from the last N days, or null for all time. */
  sinceDays: number | null;
  /** Restrict to a project by name/root substring, or null for all projects. */
  projectFilter: string | null;
}

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
 * @what Builds the guardian's decision-metrics report as a plain string over an optional window/project
 * @how Opens `<guardianHome>/metrics.db` read-only, assembles a WHERE from a fixed clause whitelist with named params (no user text interpolated), aggregates decisions, and renders rates, outcomes, deny categories, per-project rates, and timing into a joined string; returns an explanatory string instead when the store is missing or empty
 * @why One shared code path lets the CLI and the MCP `metrics` tool answer "is the guardian useful over time?" identically, which the rotating debug log cannot
 *
 * @param {MetricsQuery} q Already-parsed, validated filter (sinceDays, projectFilter)
 * @returns {string} The formatted report, or a message explaining why there is nothing to show
 *
 * @sideeffects Opens and reads the metrics SQLite database read-only (closes it before returning); no writes
 * @systemlayer Business Logic
 * @domain metrics, reporting
 * @tags metrics-report, aggregation, sqlite, readonly
 */
export function buildMetricsReport(q: MetricsQuery): string {
  const { sinceDays, projectFilter } = q;
  const dbPath = path.join(getGuardianHome(), 'metrics.db');
  if (!existsSync(dbPath)) {
    return `No metrics database yet at ${dbPath}. The store is created on the first validated edit.`;
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
    if (!total.n) return 'No decisions match that filter.';

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

    const out: string[] = [];
    out.push(`=== Codebase Guardian — Decision Metrics ===`);
    out.push(`Window: ${total.lo} → ${total.hi}   (${total.n} decisions${sinceDays ? `, last ${sinceDays}d` : ''}${projectFilter ? `, project~"${projectFilter}"` : ''})`);
    out.push('');
    out.push(`Overall:            allow ${formatPct(oAllow, oTot)}   deny ${formatPct(oDeny, oTot)}   (${oTot})`);
    out.push(`Genuine judgments:  allow ${formatPct(gAllow, gTot)}   deny ${formatPct(gDeny, gTot)}   (${gTot} headless-validated edits)`);
    out.push('');
    out.push(`Outcomes:`);
    for (const o of outcomes) out.push(`  ${String(o.n).padStart(6)}  ${o.outcome}`);

    out.push('');
    out.push(`Deny reasons (categories, a deny can span several):`);
    for (const [c, n] of [...catCounts.entries()].sort((x, y) => y[1] - x[1])) out.push(`  ${String(n).padStart(6)}  ${c}`);
    if (skipped) out.push(`  (skipped ${skipped} deny row(s) with unparseable category data)`);

    out.push('');
    out.push(`By project:`);
    for (const p of projects) out.push(`  ${(p.p || '(unknown)').padEnd(24)} ${String(p.n).padStart(5)} edits   deny ${formatPct(p.d, p.n)}`);

    if (timings.length) {
      out.push('');
      out.push(`Headless validation time (ms): p50 ${percentile(timings, 50)}  p90 ${percentile(timings, 90)}  p99 ${percentile(timings, 99)}  max ${percentile(timings, 100)}`);
    }
    return out.join('\n');
  } finally {
    db.close();
  }
}
