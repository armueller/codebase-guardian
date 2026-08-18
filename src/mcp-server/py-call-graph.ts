/**
 * @what Indexes cross-file Python call edges by invoking the guardian_py callgraph helper and resolving edges against indexed `functions` rows
 * @how Resolves the guardian pyenv binary + guardian_py helper source the same way py-index.ts does, then runs `python -m guardian_py callgraph <repoRoot>` and parses the raw JSON edge list from stdout. Each edge's ABSOLUTE caller_file/callee_file are converted to the repo-relative form functions.file_path uses (path.relative(repoRoot, absPath), same as indexer.ts and call-graph.ts), then resolved to functions rows: def-line FIRST via getFunctionByFileAndLine (unique per unit — required because Python method names collide across classes in one file and the index stores names unqualified), falling back to getFunctionByName only when a def-line is null or unmatched. Matched (source, target) pairs become call_edges rows via insertCallEdge, mirroring buildCallGraph's resolve+insert pattern for TypeScript.
 * @why Makes callers/callees/impact and the validator's caller-context work for Python the same way they already do for TypeScript (buildCallGraph), without which Python call edges would simply not exist in the index
 *
 * @sideeffects Spawns a Python subprocess via execFileSync; writes rows to the call_edges table
 * @systemlayer External Integration
 * @domain code-index, python-support
 * @tags python, callgraph, subprocess, fail-open, indexer, def-line-resolution
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';
import { getGuardianHome } from '../config.js';
import { getFunctionByFileAndLine, getFunctionByName, insertCallEdge } from './db.js';

// ─── guardian_py callgraph JSON contract (see python/guardian_py/callgraph.py) ──

interface PyCallGraphEdge {
  caller_name: string;
  caller_file: string;
  caller_line: number | null;
  callee_name: string;
  callee_file: string | null;
  callee_def_line: number | null;
  line: number;
  edge_type: string;
}

interface PyCallGraphPayload {
  language: 'py';
  root: string;
  error?: string;
  edges?: PyCallGraphEdge[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @what Invokes guardian_py callgraph against repoRoot and resolves its edges into call_edges rows
 * @how Resolves <GUARDIAN_HOME>/pyenv/bin/python (same resolution as py-index.ts's extractPythonFile,
 *   no fallback interpreter); if missing, fails open. Otherwise runs `python -m guardian_py callgraph
 *   <repoRoot>` with PYTHONPATH pointed at the bundled helper source, parses stdout as JSON, and for
 *   each edge with a non-null callee_file: converts both caller_file/callee_file from absolute to the
 *   repo-relative form (path.relative(repoRoot, absPath)) that functions.file_path uses, then resolves
 *   source (from caller_file/caller_line, falling back to caller_name) and target (from
 *   callee_file/callee_def_line, falling back to callee_name) via getFunctionByFileAndLine first and
 *   getFunctionByName as a fallback. When both resolve, inserts a 'calls' call_edges row. Any failure
 *   (missing interpreter, subprocess error, non-zero/malformed output, JSON parse failure, or a
 *   guardian_py-reported error) returns {edgesCreated: 0} instead of throwing.
 * @why Makes callers/callees/impact and the validator's caller-context work for Python by populating the
 *   same call_edges table buildCallGraph populates for TypeScript
 *
 * @param {Database.Database} db The database instance
 * @param {string} repoRoot Absolute path to the repository root (the package root guardian_py walks)
 * @param {{timeoutMs?: number}} [opts] Optional subprocess timeout override (default 60000ms — a
 *   repo-wide Jedi walk is much slower than the single-file extract call in py-index.ts)
 * @returns {Promise<{edgesCreated: number}>} Count of call_edges rows inserted (0 on any failure — fail-open)
 *
 * @sideeffects Spawns a Python subprocess via execFileSync; writes rows to the call_edges table
 * @systemlayer External Integration
 * @domain code-index, python-support
 * @tags python, callgraph, subprocess, fail-open, indexer, def-line-resolution, execFileSync
 */
export async function buildPythonCallGraph(
  db: Database.Database,
  repoRoot: string,
  opts?: { timeoutMs?: number }
): Promise<{ edgesCreated: number }> {
  const guardianHome = getGuardianHome();
  const pyBin = path.join(guardianHome, 'pyenv', 'bin', 'python');
  // Same resolution as py-index.ts's extractPythonFile: the guardian_py helper source ships
  // next to the compiled code, not under the data dir — resolve it relative to this module.
  const pyPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../python');

  if (!existsSync(pyBin)) {
    console.error('  Python interpreter not found, skipping Python call graph');
    return { edgesCreated: 0 };
  }

  let stdout: string;
  try {
    stdout = execFileSync(pyBin, ['-m', 'guardian_py', 'callgraph', repoRoot], {
      timeout: opts?.timeoutMs ?? 60000,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PYTHONPATH: pyPath },
    });
  } catch (err) {
    console.error(`  Python call graph subprocess failed, skipping: ${err instanceof Error ? err.message : String(err)}`);
    return { edgesCreated: 0 };
  }

  let payload: PyCallGraphPayload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    console.error('  Python call graph produced non-JSON output, skipping');
    return { edgesCreated: 0 };
  }

  if (payload.error) {
    console.error(`  Python call graph reported an error, skipping: ${payload.error}`);
    return { edgesCreated: 0 };
  }

  const edges = payload.edges ?? [];
  let edgesCreated = 0;

  for (const edge of edges) {
    // Unresolved/external callees (stdlib/third-party) are dropped, same as the TS call-graph path.
    if (!edge.callee_file) continue;

    const relCallerFile = path.relative(repoRoot, edge.caller_file);
    const relCalleeFile = path.relative(repoRoot, edge.callee_file);

    let source = edge.caller_line != null
      ? getFunctionByFileAndLine(db, relCallerFile, edge.caller_line)
      : null;
    if (!source) {
      source = getFunctionByName(db, edge.caller_name, relCallerFile);
    }

    let target = edge.callee_def_line != null
      ? getFunctionByFileAndLine(db, relCalleeFile, edge.callee_def_line)
      : null;
    if (!target) {
      target = getFunctionByName(db, edge.callee_name, relCalleeFile);
    }

    if (source && target) {
      insertCallEdge(db, source.id, target.id, 'calls');
      edgesCreated++;
    }
  }

  console.error(`  Inserted ${edgesCreated} Python call edges`);
  return { edgesCreated };
}
