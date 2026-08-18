/**
 * @what Standalone SQLite client for querying the code index database from hooks
 * @how Uses createRequire to load better-sqlite3 from code-index's node_modules, opens DB in readonly mode
 * @why Hooks run via tsx (CJS) and cannot import from code-index's ESM modules at runtime, but need index data for pattern alignment
 *
 * @sideeffects Opens SQLite database connection (readonly)
 * @systemlayer Data Layer
 * @domain code-index, pattern-alignment, validation
 * @tags sqlite, code-index, readonly, pattern-context, validation-helper
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolveConfig } from '../../config.js';
import type { FunctionResult } from '../../mcp-server/db.js';

// Re-export for consumers
export type { FunctionResult };

// ─── Project Context ─────────────────────────────────────────────────────────

// Lazy-initialized from cwd on first access, but can be overridden via setProjectContext()
// to route to the correct per-project database based on the file being edited.
let _config: ReturnType<typeof resolveConfig> | null = null;

function getProjectConfig(): ReturnType<typeof resolveConfig> {
  if (!_config) _config = resolveConfig();
  return _config;
}

/**
 * Re-initializes the project context from a file path.
 * Called by the hook after reading stdin to route to the correct project database
 * (handles submodules, nested repos, and monorepos where the file's project root
 * differs from cwd).
 */
export function setProjectContext(filePath: string): void {
  const newConfig = resolveConfig(filePath);
  const currentRoot = _config?.projectRoot;

  if (currentRoot && currentRoot !== newConfig.projectRoot) {
    // File is in a different project than cwd — close stale db connection
    if (dbInstance) {
      try { dbInstance.close(); } catch { /* ignore */ }
      dbInstance = null;
    }
  }

  _config = newConfig;
}

// Accessors that use the lazy config
function getRepoRoot(): string { return getProjectConfig().projectRoot; }
function getDbPath(): string { return getProjectConfig().databasePath; }

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @what Aggregated pattern context gathered from the code index for a given edit
 * @how Built by querying the code index for directory README, siblings, callers, patterns, and similarity search
 * @why Provides headless Claude with full context to validate code quality — DRY enforcement, pattern alignment, blast radius
 */
/**
 * @what Represents a tier-3 documentation entry (best practice, pattern, architecture guide)
 * @how Contains doc name, path, description preview, and which domains/tags matched the current edit
 * @why Surfaces relevant project documentation to the validator beyond just directory READMEs
 */
/**
 * @what Represents a tier-3 documentation entry with optional section-level content
 * @domain documentation-surfacing, relevance-matching
 * @tags relevant-doc, sections, domain-matching, tag-matching, documentation
 */
export interface RelevantDoc {
  name: string;
  filePath: string;
  descriptionPreview: string;
  matchedDomains: string[];
  matchedTags: string[];
  matchScore: number;
  sections?: { heading: string; body: string }[];
}

/**
 * @what Represents a comment-level DRY match between the current edit and an existing function
 * @domain dry-detection, comment-search
 * @tags comment-match, dry, similarity, step-level, inline-comments
 */
export interface CommentMatch {
  editComment: string;
  matches: { functionName: string; filePath: string; commentText: string }[];
}

/**
 * @what Aggregated pattern context gathered from the code index for a given edit
 * @domain code-quality, pattern-alignment, context-assembly
 * @tags pattern-context, dry-enforcement, siblings, callers, similarity
 */
export interface PatternContext {
  directoryReadme: string | null;
  siblingFunctions: FunctionResult[];
  calledFunctionDetails: Map<string, FunctionResult>;
  unknownCalledFunctions: string[];
  callerDetails: Map<string, FunctionResult[]>;
  similarExistingFunctions: Map<string, FunctionResult[]>;
  relevantDocs: RelevantDoc[];
  similarComments: CommentMatch[];
  directoryPatterns: {
    commonDomains: string[];
    commonSystemLayers: string[];
    commonTags: string[];
    hasSideEffects: boolean;
    namingExamples: string[];
  };
}

// ─── Database Singleton ──────────────────────────────────────────────────────

let dbInstance: any = null;

/**
 * @what Gets or creates a readonly SQLite database connection
 * @how Uses createRequire to load better-sqlite3, opens DB with readonly flag, caches as singleton
 * @why Singleton avoids repeated file opens; readonly prevents accidental writes from hooks
 *
 * @returns {object | null} Database instance or null if unavailable
 *
 * @sideeffects Opens database connection on first call
 * @systemlayer Data Layer
 * @domain database, connection-management
 * @tags sqlite, singleton, readonly, connection, lazy-init
 */
function getDb(): any {
  if (dbInstance) return dbInstance;

  if (!existsSync(getDbPath())) return null;

  try {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    dbInstance = new Database(getDbPath(), { readonly: true });
    dbInstance.pragma('journal_mode = WAL');
    return dbInstance;
  } catch {
    return null;
  }
}

// ─── Hydration Helper ────────────────────────────────────────────────────────

interface FunctionRow {
  id: number;
  name: string;
  description: string;
  file_path: string;
  line_number: number;
  is_exported: number;
  declaration_type: string;
  side_effects: string | null;
  system_layer: string | null;
  tier: number;
  language: 'ts' | 'py';
}

/**
 * @what Hydrates a raw function row with its domains, tags, and systemlayers
 * @how Runs three additional queries to join related tables
 * @why Function rows don't include many-to-many relationships inline
 *
 * @param {object} db Database instance
 * @param {FunctionRow} row Raw function row from SQLite
 * @returns {FunctionResult} Fully hydrated function with domains, tags, systemlayers
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain query-hydration, data-assembly
 * @tags hydration, join, domains, tags, systemlayers
 */
function hydrateFunction(db: any, row: FunctionRow): FunctionResult {
  const domains = db.prepare('SELECT domain FROM function_domains WHERE function_id = ? ORDER BY domain')
    .all(row.id) as { domain: string }[];
  const tags = db.prepare('SELECT tag FROM function_tags WHERE function_id = ? ORDER BY tag')
    .all(row.id) as { tag: string }[];
  const systemlayers = db.prepare('SELECT systemlayer FROM function_systemlayers WHERE function_id = ? ORDER BY systemlayer')
    .all(row.id) as { systemlayer: string }[];

  return {
    ...row,
    domains: domains.map(d => d.domain),
    tags: tags.map(t => t.tag),
    systemlayers: systemlayers.map(s => s.systemlayer),
  };
}

/**
 * @what Batch-hydrates multiple function rows with taxonomy data in 3 queries total instead of 3*N
 * @how Builds WHERE IN clauses for domains, tags, and systemlayers tables, groups results by function_id
 * @why Eliminates N+1 query pattern in getDirectoryFunctions, searchFTS, and getCallers where many functions are hydrated
 *
 * @param {any} db The database instance
 * @param {FunctionRow[]} rows Function rows to hydrate
 * @returns {FunctionResult[]} Hydrated functions with taxonomy arrays
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain query-optimization, batch-hydration
 * @tags batch, hydration, n-plus-one, performance, junction-tables
 */
function hydrateFunctions(db: any, rows: FunctionRow[]): FunctionResult[] {
  if (rows.length === 0) return [];

  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const allDomains = db.prepare(
    `SELECT function_id, domain FROM function_domains WHERE function_id IN (${placeholders}) ORDER BY domain`
  ).all(...ids) as { function_id: number; domain: string }[];

  const allTags = db.prepare(
    `SELECT function_id, tag FROM function_tags WHERE function_id IN (${placeholders}) ORDER BY tag`
  ).all(...ids) as { function_id: number; tag: string }[];

  const allLayers = db.prepare(
    `SELECT function_id, systemlayer FROM function_systemlayers WHERE function_id IN (${placeholders}) ORDER BY systemlayer`
  ).all(...ids) as { function_id: number; systemlayer: string }[];

  const domainMap = new Map<number, string[]>();
  for (const d of allDomains) {
    const list = domainMap.get(d.function_id) || [];
    list.push(d.domain);
    domainMap.set(d.function_id, list);
  }

  const tagMap = new Map<number, string[]>();
  for (const t of allTags) {
    const list = tagMap.get(t.function_id) || [];
    list.push(t.tag);
    tagMap.set(t.function_id, list);
  }

  const layerMap = new Map<number, string[]>();
  for (const s of allLayers) {
    const list = layerMap.get(s.function_id) || [];
    list.push(s.systemlayer);
    layerMap.set(s.function_id, list);
  }

  return rows.map(row => ({
    ...row,
    domains: domainMap.get(row.id) || [],
    tags: tagMap.get(row.id) || [],
    systemlayers: layerMap.get(row.id) || [],
  }));
}

// ─── Query Functions ─────────────────────────────────────────────────────────

/**
 * @what Looks up a function by name, optionally filtered by file path
 * @how Queries functions table by name, returns first match or null
 * @why Core lookup for checking if a called function exists in the index
 *
 * @param {string} name Function name
 * @param {string} filePath Optional file path filter
 * @returns {FunctionResult | null} Function data or null if not found
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain function-lookup, code-index
 * @tags lookup, function-name, query, code-index, validation
 */
export function lookupFunction(name: string, filePath?: string): FunctionResult | null {
  const db = getDb();
  if (!db) return null;

  try {
    let row: FunctionRow | undefined;
    if (filePath) {
      row = db.prepare('SELECT * FROM functions WHERE name = ? AND file_path = ?').get(name, filePath) as FunctionRow | undefined;
    } else {
      row = db.prepare('SELECT * FROM functions WHERE name = ? LIMIT 1').get(name) as FunctionRow | undefined;
    }
    if (!row) return null;
    return hydrateFunction(db, row);
  } catch {
    return null;
  }
}

/**
 * @what Looks up all functions in a specific file
 * @how Queries functions table filtered by file_path
 * @why Used to find sibling functions for pattern analysis
 *
 * @param {string} filePath Absolute file path
 * @returns {FunctionResult[]} All functions in the file
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain file-lookup, code-index
 * @tags file-functions, query, siblings, pattern-analysis, code-index
 */
export function lookupFunctionsByFile(filePath: string): FunctionResult[] {
  const db = getDb();
  if (!db) return [];

  try {
    const rows = db.prepare('SELECT * FROM functions WHERE file_path = ? ORDER BY line_number')
      .all(filePath) as FunctionRow[];
    return hydrateFunctions(db, rows);
  } catch {
    return [];
  }
}

/**
 * @what Batch looks up multiple functions by name
 * @how Iterates names and queries each, collecting found results into a Map
 * @why Efficient batch lookup for all called functions in an edit
 *
 * @param {string[]} names Array of function names to look up
 * @returns {Map<string, FunctionResult>} Map of name -> function data (only found ones)
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain batch-lookup, code-index
 * @tags batch, lookup, function-names, efficiency, code-index
 */
export function batchLookupFunctions(names: string[]): Map<string, FunctionResult> {
  const results = new Map<string, FunctionResult>();
  const db = getDb();
  if (!db) return results;

  try {
    const stmt = db.prepare('SELECT * FROM functions WHERE name = ? LIMIT 1');
    for (const name of names) {
      const row = stmt.get(name) as FunctionRow | undefined;
      if (row) {
        results.set(name, hydrateFunction(db, row));
      }
    }
  } catch {
    // Return whatever we found
  }

  return results;
}

/**
 * @what Gets all functions that call the specified function
 * @how Joins call_edges with functions table on source_function_id
 * @why Identifies blast radius — who would be affected by changes to this function
 *
 * @param {string} functionName Name of the target function
 * @returns {FunctionResult[]} Functions that call the target
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain call-graph, callers
 * @tags callers, call-graph, blast-radius, impact, code-index
 */
export function getCallers(functionName: string): FunctionResult[] {
  const db = getDb();
  if (!db) return [];

  try {
    const target = db.prepare('SELECT id FROM functions WHERE name = ? LIMIT 1').get(functionName) as { id: number } | undefined;
    if (!target) return [];

    const rows = db.prepare(`
      SELECT f.* FROM functions f
      JOIN call_edges ce ON f.id = ce.source_function_id
      WHERE ce.target_function_id = ?
    `).all(target.id) as FunctionRow[];

    return hydrateFunctions(db, rows);
  } catch {
    return [];
  }
}

/**
 * @what Gets the README document for the directory containing a file
 * @how Extracts directory path from file, queries for tier=3 entries matching that directory
 * @why READMEs contain pattern documentation that edits should comply with
 *
 * @param {string} filePath Absolute path to the file being edited
 * @returns {{ name: string; description: string; file_path: string } | null} README data or null
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain readme-lookup, pattern-documentation
 * @tags readme, directory, tier3, pattern-docs, code-index
 */
export function getDirectoryReadme(filePath: string): { name: string; description: string; file_path: string } | null {
  const db = getDb();
  if (!db) return null;

  try {
    // Extract directory from file path
    const dirPath = filePath.replace(/\/[^/]+$/, '');

    // Look for README in this directory (tier 3 = documentation)
    const row = db.prepare(`
      SELECT name, description, file_path FROM functions
      WHERE tier = 3 AND file_path LIKE ?
      LIMIT 1
    `).get(`${dirPath}/%README%`) as { name: string; description: string; file_path: string } | undefined;

    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * @what Gets all functions in the same directory as the edited file
 * @how Queries functions by file_path LIKE directory pattern, excludes tier 3 docs
 * @why Sibling functions establish the naming/domain/style patterns for a directory
 *
 * @param {string} filePath Absolute path to the file being edited
 * @returns {FunctionResult[]} Functions in the same directory (excluding the edited file)
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain directory-analysis, sibling-functions
 * @tags siblings, directory, pattern-analysis, naming, code-index
 */
export function getDirectoryFunctions(filePath: string): FunctionResult[] {
  const db = getDb();
  if (!db) return [];

  try {
    const dirPath = filePath.replace(/\/[^/]+$/, '');

    const rows = db.prepare(`
      SELECT * FROM functions
      WHERE file_path LIKE ? AND file_path != ? AND tier != 3
      ORDER BY name
      LIMIT 50
    `).all(`${dirPath}/%`, filePath) as FunctionRow[];

    return hydrateFunctions(db, rows);
  } catch {
    return [];
  }
}

const _require = createRequire(import.meta.url);
const { sanitizeFTSQuery } = _require('../../shared/fts-utils.cjs');

/**
 * @what Searches the FTS5 index for functions matching a query
 * @how Sanitizes query to OR-joined tokens, runs FTS5 MATCH, hydrates results
 * @why Used to find similar functions that might be reusable instead of writing new code
 *
 * @param {string} query FTS5 search query
 * @param {number} limit Maximum results (default 10)
 * @returns {FunctionResult[]} Matching functions sorted by relevance
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain full-text-search, code-index
 * @tags fts5, search, similarity, reuse-detection, code-index
 */
export function searchFTS(query: string, limit: number = 10): FunctionResult[] {
  const db = getDb();
  if (!db) return [];

  try {
    const ftsRows = db.prepare(`
      SELECT rowid as id, rank
      FROM functions_fts
      WHERE functions_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(sanitizeFTSQuery(query), limit) as { id: number; rank: number }[];

    const results: FunctionResult[] = [];
    for (const ftsRow of ftsRows) {
      const row = db.prepare('SELECT * FROM functions WHERE id = ?').get(ftsRow.id) as FunctionRow | undefined;
      if (row) {
        results.push(hydrateFunction(db, row));
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ─── Inline Comment Search ───────────────────────────────────────────────────

/**
 * @what Extracts inline comments from code text, merging consecutive single-line comments
 * @how Iterates lines detecting // comments, merges consecutive // lines into single entries
 * @why Lightweight hook-side extraction to generate search queries for step-level DRY detection
 *
 * @param {string} code The code text (typically newString from an edit)
 * @returns {string[]} Array of comment strings with consecutive // lines merged
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain comment-extraction, dry-detection
 * @tags comments, extraction, hook-side, merge-consecutive, lightweight
 */
export function extractInlineComments(code: string): string[] {
  const comments: string[] = [];
  const lines = code.split('\n');
  let accumulated: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^\/\/\s?(.*)/);
    if (match) {
      accumulated.push(match[1]);
    } else {
      if (accumulated.length > 0) {
        const text = accumulated.join(' ').trim();
        if (text.length >= 5) {
          comments.push(text);
        }
        accumulated = [];
      }
    }
  }

  // Flush remaining
  if (accumulated.length > 0) {
    const text = accumulated.join(' ').trim();
    if (text.length >= 5) {
      comments.push(text);
    }
  }

  return comments;
}

/**
 * @what Searches the comments FTS5 index for step-level logic matches against edit comments
 * @how For each edit comment, runs FTS5 MATCH on comments_fts and returns matching comments from other functions
 * @why Detects sub-function logic duplication by finding existing functions with similar step descriptions
 *
 * @param {string[]} editComments Comments extracted from the code being edited
 * @returns {CommentMatch[]} Matches grouped by edit comment, each with matching function details
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain comment-search, dry-detection
 * @tags fts5, comment-search, step-level, dry-enforcement, similarity
 */
export function searchCommentsForDRY(editComments: string[]): CommentMatch[] {
  const db = getDb();
  if (!db) return [];
  if (editComments.length === 0) return [];

  const results: CommentMatch[] = [];

  try {
    for (const comment of editComments) {
      // Build a sanitized FTS query from the comment words
      const words = comment.split(/\s+/)
        .map(w => w.replace(/[^a-zA-Z0-9_-]/g, ''))
        .filter(w => w.length >= 3)
        .slice(0, 8);
      if (words.length < 2) continue;

      const query = words.map(w => `"${w}"`).join(' OR ');

      const rows = db.prepare(`
        SELECT fc.comment_text, f.name as function_name, f.file_path
        FROM comments_fts cf
        JOIN function_comments fc ON fc.id = cf.rowid
        JOIN functions f ON f.id = fc.function_id
        WHERE comments_fts MATCH ?
        ORDER BY cf.rank
        LIMIT 5
      `).all(query) as { comment_text: string; function_name: string; file_path: string }[];

      if (rows.length > 0) {
        results.push({
          editComment: comment,
          matches: rows.map(r => ({
            functionName: r.function_name,
            filePath: r.file_path,
            commentText: r.comment_text,
          })),
        });
      }
    }
  } catch {
    // FTS query failures are non-fatal
  }

  return results;
}

// ─── Relevant Documentation ─────────────────────────────────────────────────

/**
 * @what Finds tier-3 documentation (best practices, patterns, architecture) relevant to the current edit by domain/tag overlap
 * @how Queries junction tables for tier-3 non-README docs that share domains or tags with the edit context, scores by match count, enriches with doc sections
 * @why Directory READMEs alone miss 22 project-wide docs (financial patterns, error handling, etc.) that are directly relevant to code being written
 *
 * @param {string[]} domains Domains collected from the edit context (siblings, called functions, edited functions)
 * @param {string[]} tags Tags collected from the edit context
 * @returns {RelevantDoc[]} Top 5 most relevant docs sorted by match score
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain documentation-surfacing, relevance-matching
 * @tags tier3-docs, domain-matching, tag-matching, relevance-scoring, documentation
 */
export function getRelevantDocs(domains: string[], tags: string[]): RelevantDoc[] {
  const db = getDb();
  if (!db) return [];
  if (domains.length === 0 && tags.length === 0) return [];

  try {
    // Get all tier-3 non-README docs
    const docs = db.prepare(`
      SELECT id, name, file_path, substr(description, 1, 300) as description_preview
      FROM functions
      WHERE tier = 3 AND file_path NOT LIKE '%README%'
    `).all() as { id: number; name: string; file_path: string; description_preview: string }[];

    if (docs.length === 0) return [];

    // For each doc, check domain and tag overlap
    const domainSet = new Set(domains.map(d => d.toLowerCase()));
    const tagSet = new Set(tags.map(t => t.toLowerCase()));

    const scored: RelevantDoc[] = [];

    for (const doc of docs) {
      const docDomains = db.prepare('SELECT domain FROM function_domains WHERE function_id = ?')
        .all(doc.id) as { domain: string }[];
      const docTags = db.prepare('SELECT tag FROM function_tags WHERE function_id = ?')
        .all(doc.id) as { tag: string }[];

      const matchedDomains = docDomains
        .filter(d => domainSet.has(d.domain.toLowerCase()))
        .map(d => d.domain);
      const matchedTags = docTags
        .filter(t => tagSet.has(t.tag.toLowerCase()))
        .map(t => t.tag);

      const matchScore = matchedDomains.length * 2 + matchedTags.length; // Domains weighted 2x

      if (matchScore > 0) {
        // Enrich with up to 2 most relevant doc sections
        let sections: { heading: string; body: string }[] | undefined;
        try {
          const sectionRows = db.prepare(`
            SELECT heading, body FROM doc_sections
            WHERE doc_function_id = ? AND section_type = 'prose'
            ORDER BY section_order
            LIMIT 2
          `).all(doc.id) as { heading: string; body: string }[];
          if (sectionRows.length > 0) {
            sections = sectionRows.map(s => ({
              heading: s.heading,
              body: s.body.length > 500 ? s.body.slice(0, 500) + '...' : s.body,
            }));
          }
        } catch {
          // doc_sections table may not exist yet
        }

        scored.push({
          name: doc.name,
          filePath: doc.file_path,
          descriptionPreview: doc.description_preview,
          matchedDomains,
          matchedTags,
          matchScore,
          sections,
        });
      }
    }

    // Sort by score descending, take top 5
    return scored.sort((a, b) => b.matchScore - a.matchScore).slice(0, 5);
  } catch {
    return [];
  }
}

// ─── Pattern Context Builder ─────────────────────────────────────────────────

/**
 * Runs semantic search from the hook context.
 * Wraps the embeddings pipeline with the hook's readonly DB connection.
 * Returns hydrated FunctionResult[] in similarity order.
 */
async function semanticSearchFromHook(hookDb: any, query: string, limit: number): Promise<FunctionResult[]> {
  // Dynamic import — embeddings.ts is ESM with heavy dependencies
  const { semanticSearch } = await import('../../mcp-server/embeddings.js');
  const results = await semanticSearch(hookDb, query, limit);
  if (results.length === 0) return [];

  const funcResults: FunctionResult[] = [];
  for (const r of results) {
    const row = hookDb.prepare('SELECT * FROM functions WHERE id = ?').get(r.functionId) as FunctionRow | undefined;
    if (row) {
      funcResults.push(hydrateFunction(hookDb, row));
    }
  }
  return funcResults;
}

/**
 * @what Builds complete pattern context from the code index for a given edit
 * @how Queries directory README, siblings, called functions, callers, directory patterns, runs semantic similarity search (with FTS fallback), and searches inline comments for DRY enforcement
 * @why Assembles all code index data needed to validate code quality — DRY enforcement is the primary purpose of the semantic index
 *
 * @param {string} filePath File being edited
 * @param {string[]} modifiedFunctions Names of functions being modified in this edit
 * @param {string[]} createdFunctions Names of functions being created in this edit
 * @param {string[]} calledFunctions Names of functions called in the new code
 * @param {string[]} editComments Optional inline comments extracted from the edit for step-level DRY detection
 * @returns {PatternContext} Full context for code quality validation
 *
 * @sideeffects Reads from database
 * @systemlayer Business Logic
 * @domain code-quality, dry-enforcement, pattern-alignment, context-assembly
 * @tags pattern-context, context-builder, dry-enforcement, similarity-search, code-index
 */
export async function buildPatternContext(
  filePath: string,
  modifiedFunctions: string[],
  createdFunctions: string[],
  calledFunctions: string[],
  editComments: string[] = []
): Promise<PatternContext> {
  // Normalize to relative path — the code index stores relative paths (e.g., "app/controllers/...")
  // but hooks receive absolute paths from tool input (e.g., "/Users/.../app/controllers/...")
  const repoRoot = getRepoRoot();
  const relativePath = filePath.startsWith(repoRoot + '/')
    ? filePath.slice(repoRoot.length + 1)
    : filePath;

  // 1. Get directory README
  const readme = getDirectoryReadme(relativePath);
  const directoryReadme = readme?.description ?? null;

  // 2. Get sibling functions in same directory
  const siblingFunctions = getDirectoryFunctions(relativePath);

  // 3. Batch lookup called functions
  const calledFunctionDetails = batchLookupFunctions(calledFunctions);
  const unknownCalledFunctions = calledFunctions.filter(name => !calledFunctionDetails.has(name));

  // 4. Get callers for modified functions (blast radius)
  const callerDetails = new Map<string, FunctionResult[]>();
  for (const funcName of modifiedFunctions) {
    const callers = getCallers(funcName);
    if (callers.length > 0) {
      callerDetails.set(funcName, callers);
    }
  }

  // 5. Analyze directory patterns from siblings
  const directoryPatterns = analyzeDirectoryPatterns(siblingFunctions);

  // 6. DRY enforcement: Search for similar existing functions for ALL new and modified functions
  //    This is the primary value of the semantic code index — finding existing utilities
  //    that already do what the developer is trying to write
  const similarExistingFunctions = new Map<string, FunctionResult[]>();
  const functionsToSearch = [...createdFunctions, ...modifiedFunctions];

  for (const funcName of functionsToSearch) {
    // Convert camelCase/PascalCase to space-separated words for search
    const searchTerms = funcName
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
      .toLowerCase();

    // Try semantic search first for better conceptual matching,
    // fall back to FTS if embeddings are unavailable
    let similar: FunctionResult[] = [];
    try {
      similar = await semanticSearchFromHook(getDb(), searchTerms, 5);
    } catch {
      // Embedding model unavailable — fall back to FTS
    }
    if (similar.length === 0) {
      similar = searchFTS(searchTerms, 5);
    }

    // Filter out the function itself (don't flag a function as similar to itself)
    const filtered = similar.filter(f => f.name !== funcName);

    if (filtered.length > 0) {
      similarExistingFunctions.set(funcName, filtered);
    }
  }

  // 7. Surface relevant tier-3 documentation (best practices, patterns, architecture)
  //    Collect domains/tags from all context sources to find matching docs
  const contextDomains = new Set<string>();
  const contextTags = new Set<string>();

  for (const func of siblingFunctions) {
    for (const d of func.domains) contextDomains.add(d);
    for (const t of func.tags) contextTags.add(t);
  }
  for (const [, func] of calledFunctionDetails) {
    for (const d of func.domains) contextDomains.add(d);
    for (const t of func.tags) contextTags.add(t);
  }
  // Also check if edited functions already exist in the index (for modified functions)
  for (const funcName of modifiedFunctions) {
    const existing = lookupFunction(funcName);
    if (existing) {
      for (const d of existing.domains) contextDomains.add(d);
      for (const t of existing.tags) contextTags.add(t);
    }
  }

  const relevantDocs = getRelevantDocs([...contextDomains], [...contextTags]);

  // 8. Step-level DRY: Search inline comments for similar logic in other functions
  const similarComments = searchCommentsForDRY(editComments);

  return {
    directoryReadme,
    siblingFunctions,
    calledFunctionDetails,
    unknownCalledFunctions,
    callerDetails,
    similarExistingFunctions,
    relevantDocs,
    similarComments,
    directoryPatterns,
  };
}

/**
 * @what Analyzes sibling functions to extract common directory patterns
 * @how Aggregates domains, systemlayers, tags, side effects, and naming patterns from siblings
 * @why Establishes what patterns are conventional in this directory for alignment checking
 *
 * @param {FunctionResult[]} siblings Functions in the same directory
 * @returns {object} Aggregated patterns including domains, layers, tags, side effects, naming
 *
 * @sideeffects None
 * @systemlayer Business Logic
 * @domain pattern-analysis, aggregation
 * @tags pattern-analysis, aggregation, naming-conventions, domain-analysis, statistics
 */
function analyzeDirectoryPatterns(siblings: FunctionResult[]): PatternContext['directoryPatterns'] {
  const domainCounts = new Map<string, number>();
  const layerCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  let hasSideEffects = false;

  for (const func of siblings) {
    for (const d of func.domains) {
      domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
    }
    for (const l of func.systemlayers) {
      layerCounts.set(l, (layerCounts.get(l) ?? 0) + 1);
    }
    for (const t of func.tags) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    if (func.side_effects && func.side_effects.toLowerCase() !== 'none' && func.side_effects.trim() !== '') {
      hasSideEffects = true;
    }
  }

  // Sort by frequency, take top entries
  const sortByCount = (map: Map<string, number>) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);

  const commonDomains = sortByCount(domainCounts).slice(0, 5);
  const commonSystemLayers = sortByCount(layerCounts).slice(0, 3);
  const commonTags = sortByCount(tagCounts).slice(0, 10);

  // Extract naming patterns (first word of camelCase function names)
  const namingExamples = siblings
    .map(f => f.name)
    .slice(0, 15);

  return {
    commonDomains,
    commonSystemLayers,
    commonTags,
    hasSideEffects,
    namingExamples,
  };
}

/**
 * @what Checks if the code index database is available
 * @how Attempts to open database connection
 * @why Allows callers to gracefully handle missing database (fail-open)
 *
 * @returns {boolean} True if database is available and queryable
 *
 * @sideeffects May open database connection
 * @systemlayer Utility
 * @domain availability-check, health
 * @tags health-check, availability, database, fail-open, guard
 */
export function isIndexAvailable(): boolean {
  return getDb() !== null;
}
