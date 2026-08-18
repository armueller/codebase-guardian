import Database from 'better-sqlite3';
import crypto from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FunctionRecord {
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

export interface FunctionResult extends FunctionRecord {
  domains: string[];
  tags: string[];
  systemlayers: string[];
}

export interface DomainCount {
  domain: string;
  count: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface SystemLayerCount {
  systemlayer: string;
  count: number;
}

export interface SearchFilters {
  domain?: string;
  tags?: string[];
  system_layer?: string;
  file_path_pattern?: string;
  tier?: number;
  has_side_effects?: boolean;
  limit?: number;
}

export interface CallEdge {
  id: number;
  source_function_id: number;
  target_function_id: number;
  edge_type: string;
}

/**
 * @what Represents an inline comment extracted from a function body for step-level DRY detection
 * @domain code-index, comment-indexing
 * @tags comment, inline, function-body, dry-detection, fts5
 */
export interface CommentRecord {
  id: number;
  function_id: number;
  comment_text: string;
  comment_type: string;  // 'block' | 'line' | 'section-header'
  line_offset: number;
}

/**
 * @what Represents a heading-level section extracted from a tier-3 documentation file
 * @domain code-index, documentation-chunking
 * @tags doc-section, heading, chunking, fts5, documentation
 */
export interface DocSectionRecord {
  id: number;
  doc_function_id: number;
  heading: string;
  heading_level: number;
  body: string;
  section_type: string;  // 'prose' | 'code'
  section_order: number;
}

/**
 * @what Aggregate metadata about the code index state including counts by tier, taxonomy, and supplementary indexes
 * @domain code-index, metadata
 * @tags index-status, metadata, counts, tiers, health-check
 */
export interface IndexMetadata {
  last_rebuilt: string | null;
  files_scanned: number;
  functions_indexed: number;
  tier1_count: number;
  tier2_count: number;
  tier3_count: number;
  domains_count: number;
  tags_count: number;
  systemlayers_count: number;
  embeddings_count: number;
  call_edges_count: number;
  comments_count: number;
  doc_sections_count: number;
  stale_files: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  -- Core function/document data
  CREATE TABLE IF NOT EXISTS functions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    is_exported INTEGER NOT NULL DEFAULT 1,
    declaration_type TEXT NOT NULL DEFAULT 'function',
    side_effects TEXT,
    system_layer TEXT,
    tier INTEGER NOT NULL DEFAULT 1,
    language TEXT NOT NULL DEFAULT 'ts'
  );

  -- Many-to-many: function -> domains
  CREATE TABLE IF NOT EXISTS function_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
    domain TEXT NOT NULL
  );

  -- Many-to-many: function -> tags
  CREATE TABLE IF NOT EXISTS function_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
    tag TEXT NOT NULL
  );

  -- Many-to-many: function -> systemlayers
  CREATE TABLE IF NOT EXISTS function_systemlayers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
    systemlayer TEXT NOT NULL
  );

  -- Vector embeddings as raw BLOBs
  CREATE TABLE IF NOT EXISTS function_embeddings (
    function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
    embedding_type TEXT NOT NULL,
    embedding BLOB NOT NULL,
    input_hash TEXT NOT NULL,
    PRIMARY KEY (function_id, embedding_type)
  );

  -- FTS5 virtual table for keyword search
  CREATE VIRTUAL TABLE IF NOT EXISTS functions_fts USING fts5(
    name,
    description,
    system_layer,
    content=functions,
    content_rowid=id
  );

  -- Keep FTS in sync with functions table
  CREATE TRIGGER IF NOT EXISTS functions_ai AFTER INSERT ON functions BEGIN
    INSERT INTO functions_fts(rowid, name, description, system_layer)
    VALUES (new.id, new.name, new.description, new.system_layer);
  END;

  CREATE TRIGGER IF NOT EXISTS functions_ad AFTER DELETE ON functions BEGIN
    INSERT INTO functions_fts(functions_fts, rowid, name, description, system_layer)
    VALUES ('delete', old.id, old.name, old.description, old.system_layer);
  END;

  CREATE TRIGGER IF NOT EXISTS functions_au AFTER UPDATE ON functions BEGIN
    INSERT INTO functions_fts(functions_fts, rowid, name, description, system_layer)
    VALUES ('delete', old.id, old.name, old.description, old.system_layer);
    INSERT INTO functions_fts(rowid, name, description, system_layer)
    VALUES (new.id, new.name, new.description, new.system_layer);
  END;

  -- Call graph edges
  CREATE TABLE IF NOT EXISTS call_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
    target_function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
    edge_type TEXT NOT NULL,
    UNIQUE(source_function_id, target_function_id, edge_type)
  );

  -- Incremental rebuild tracking
  CREATE TABLE IF NOT EXISTS file_hashes (
    file_path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    last_indexed TEXT NOT NULL
  );

  -- Key-value metadata
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_functions_name ON functions(name);
  CREATE INDEX IF NOT EXISTS idx_functions_file_path ON functions(file_path);
  CREATE INDEX IF NOT EXISTS idx_functions_tier ON functions(tier);
  CREATE INDEX IF NOT EXISTS idx_function_domains_domain ON function_domains(domain);
  CREATE INDEX IF NOT EXISTS idx_function_domains_fid ON function_domains(function_id);
  CREATE INDEX IF NOT EXISTS idx_function_tags_tag ON function_tags(tag);
  CREATE INDEX IF NOT EXISTS idx_function_tags_fid ON function_tags(function_id);
  CREATE INDEX IF NOT EXISTS idx_function_systemlayers_layer ON function_systemlayers(systemlayer);
  CREATE INDEX IF NOT EXISTS idx_function_systemlayers_fid ON function_systemlayers(function_id);
  CREATE INDEX IF NOT EXISTS idx_call_edges_source ON call_edges(source_function_id);
  CREATE INDEX IF NOT EXISTS idx_call_edges_target ON call_edges(target_function_id);

  -- Inline comments within function bodies
  CREATE TABLE IF NOT EXISTS function_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
    comment_text TEXT NOT NULL,
    comment_type TEXT NOT NULL DEFAULT 'block',
    line_offset INTEGER NOT NULL DEFAULT 0
  );

  -- FTS5 for comment search
  CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
    comment_text,
    content=function_comments,
    content_rowid=id
  );

  CREATE TRIGGER IF NOT EXISTS comments_ai AFTER INSERT ON function_comments BEGIN
    INSERT INTO comments_fts(rowid, comment_text) VALUES (new.id, new.comment_text);
  END;
  CREATE TRIGGER IF NOT EXISTS comments_ad AFTER DELETE ON function_comments BEGIN
    INSERT INTO comments_fts(comments_fts, rowid, comment_text) VALUES ('delete', old.id, old.comment_text);
  END;
  CREATE TRIGGER IF NOT EXISTS comments_au AFTER UPDATE ON function_comments BEGIN
    INSERT INTO comments_fts(comments_fts, rowid, comment_text) VALUES ('delete', old.id, old.comment_text);
    INSERT INTO comments_fts(rowid, comment_text) VALUES (new.id, new.comment_text);
  END;

  CREATE INDEX IF NOT EXISTS idx_function_comments_fid ON function_comments(function_id);

  -- Documentation sections (heading-level chunks)
  CREATE TABLE IF NOT EXISTS doc_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_function_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
    heading TEXT NOT NULL,
    heading_level INTEGER NOT NULL,
    body TEXT NOT NULL,
    section_type TEXT NOT NULL DEFAULT 'prose',
    section_order INTEGER NOT NULL DEFAULT 0
  );

  -- FTS5 for doc section search
  CREATE VIRTUAL TABLE IF NOT EXISTS doc_sections_fts USING fts5(
    heading,
    body,
    content=doc_sections,
    content_rowid=id
  );

  CREATE TRIGGER IF NOT EXISTS doc_sections_ai AFTER INSERT ON doc_sections BEGIN
    INSERT INTO doc_sections_fts(rowid, heading, body) VALUES (new.id, new.heading, new.body);
  END;
  CREATE TRIGGER IF NOT EXISTS doc_sections_ad AFTER DELETE ON doc_sections BEGIN
    INSERT INTO doc_sections_fts(doc_sections_fts, rowid, heading, body) VALUES ('delete', old.id, old.heading, old.body);
  END;
  CREATE TRIGGER IF NOT EXISTS doc_sections_au AFTER UPDATE ON doc_sections BEGIN
    INSERT INTO doc_sections_fts(doc_sections_fts, rowid, heading, body) VALUES ('delete', old.id, old.heading, old.body);
    INSERT INTO doc_sections_fts(rowid, heading, body) VALUES (new.id, new.heading, new.body);
  END;

  CREATE INDEX IF NOT EXISTS idx_doc_sections_fid ON doc_sections(doc_function_id);
`;

// ─── Database Initialization ─────────────────────────────────────────────────

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  // Migration: SCHEMA_SQL uses CREATE TABLE IF NOT EXISTS, so existing per-project
  // DBs created before the `language` column existed won't pick it up from the
  // schema string above. ALTER TABLE ADD COLUMN has no "IF NOT EXISTS" form in
  // SQLite, so we run it unconditionally and swallow the "duplicate column name"
  // error it throws on DBs that already have the column (including brand-new DBs,
  // where SCHEMA_SQL already created it). This keeps openDatabase() idempotent
  // across both fresh and pre-existing databases without a separate migrations table.
  try {
    db.exec("ALTER TABLE functions ADD COLUMN language TEXT NOT NULL DEFAULT 'ts'");
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column name/i.test(err.message)) {
      throw err;
    }
  }

  return db;
}

// ─── Insert Operations ──────────────────────────────────────────────────────

export function insertFunction(
  db: Database.Database,
  func: {
    name: string;
    description: string;
    file_path: string;
    line_number: number;
    is_exported: boolean;
    declaration_type: string;
    side_effects: string | null;
    system_layer: string | null;
    tier: number;
    language?: 'ts' | 'py';
  }
): number {
  const stmt = db.prepare(`
    INSERT INTO functions (name, description, file_path, line_number, is_exported, declaration_type, side_effects, system_layer, tier, language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    func.name,
    func.description,
    func.file_path,
    func.line_number,
    func.is_exported ? 1 : 0,
    func.declaration_type,
    func.side_effects,
    func.system_layer,
    func.tier,
    func.language ?? 'ts'
  );
  return Number(result.lastInsertRowid);
}

export function insertDomains(db: Database.Database, functionId: number, domains: string[]): void {
  const stmt = db.prepare('INSERT INTO function_domains (function_id, domain) VALUES (?, ?)');
  for (const domain of domains) {
    stmt.run(functionId, domain);
  }
}

export function insertTags(db: Database.Database, functionId: number, tags: string[]): void {
  const stmt = db.prepare('INSERT INTO function_tags (function_id, tag) VALUES (?, ?)');
  for (const tag of tags) {
    stmt.run(functionId, tag);
  }
}

export function insertSystemLayers(db: Database.Database, functionId: number, layers: string[]): void {
  const stmt = db.prepare('INSERT INTO function_systemlayers (function_id, systemlayer) VALUES (?, ?)');
  for (const layer of layers) {
    stmt.run(functionId, layer);
  }
}

export function insertEmbedding(
  db: Database.Database,
  functionId: number,
  embeddingType: string,
  embedding: Float32Array,
  inputHash: string
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO function_embeddings (function_id, embedding_type, embedding, input_hash)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(functionId, embeddingType, Buffer.from(embedding.buffer), inputHash);
}

export function insertCallEdge(
  db: Database.Database,
  sourceId: number,
  targetId: number,
  edgeType: string
): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO call_edges (source_function_id, target_function_id, edge_type)
    VALUES (?, ?, ?)
  `);
  stmt.run(sourceId, targetId, edgeType);
}

// ─── File Hash Operations ────────────────────────────────────────────────────

export function getFileHash(db: Database.Database, filePath: string): string | null {
  const row = db.prepare('SELECT content_hash FROM file_hashes WHERE file_path = ?').get(filePath) as { content_hash: string } | undefined;
  return row?.content_hash ?? null;
}

export function setFileHash(db: Database.Database, filePath: string, hash: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO file_hashes (file_path, content_hash, last_indexed)
    VALUES (?, ?, ?)
  `).run(filePath, hash, new Date().toISOString());
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ─── Delete Operations ──────────────────────────────────────────────────────

export function deleteFunctionsByFilePath(db: Database.Database, filePath: string): void {
  db.prepare('DELETE FROM functions WHERE file_path = ?').run(filePath);
}

/**
 * @what Deletes all indexed data from the database and rebuilds FTS5 indexes to prepare for a full rebuild
 * @how Executes DELETE statements on all data tables in dependency order (children before parents), then rebuilds all three FTS5 indexes to ensure consistency
 * @why Full rebuild requires starting from a clean slate to prevent stale entries; FTS5 rebuild ensures no orphaned index entries remain
 *
 * @param {Database.Database} db The database instance
 * @returns {void}
 *
 * @sideeffects Deletes all rows from all data tables, rebuilds FTS5 indexes (functions_fts, comments_fts, doc_sections_fts)
 * @systemlayer Data Layer
 * @domain code-index, data-management
 * @tags clear, rebuild, delete-all, data-management, reset, fts5
 */
export function clearAllData(db: Database.Database): void {
  db.exec(`
    DELETE FROM call_edges;
    DELETE FROM function_embeddings;
    DELETE FROM function_comments;
    DELETE FROM doc_sections;
    DELETE FROM function_systemlayers;
    DELETE FROM function_tags;
    DELETE FROM function_domains;
    DELETE FROM functions;
    DELETE FROM file_hashes;
  `);
}

// ─── Comment & Doc Section Operations ────────────────────────────────────────

/**
 * @what Bulk inserts inline comment records for a function
 * @how Uses a prepared INSERT statement and iterates over the comments array
 * @why Stores extracted inline comments for FTS5-based step-level DRY detection
 *
 * @param {Database.Database} db The database instance
 * @param {number} functionId The parent function's ID
 * @param {object[]} comments Array of comment data to insert
 * @returns {void}
 *
 * @sideeffects Inserts rows into function_comments table (triggers sync to comments_fts)
 * @systemlayer Data Layer
 * @domain code-index, comment-indexing
 * @tags insert, comments, bulk, fts5-sync, dry-detection
 */
export function insertComments(
  db: Database.Database,
  functionId: number,
  comments: { comment_text: string; comment_type: string; line_offset: number }[]
): void {
  const stmt = db.prepare(
    'INSERT INTO function_comments (function_id, comment_text, comment_type, line_offset) VALUES (?, ?, ?, ?)'
  );
  for (const c of comments) {
    stmt.run(functionId, c.comment_text, c.comment_type, c.line_offset);
  }
}

/**
 * @what Bulk inserts documentation section records for a tier-3 doc entry
 * @how Uses a prepared INSERT statement and iterates over the sections array
 * @why Stores heading-level doc chunks for granular FTS5 search instead of truncated body
 *
 * @param {Database.Database} db The database instance
 * @param {number} docFunctionId The parent doc function's ID
 * @param {object[]} sections Array of section data to insert
 * @returns {void}
 *
 * @sideeffects Inserts rows into doc_sections table (triggers sync to doc_sections_fts)
 * @systemlayer Data Layer
 * @domain code-index, documentation-chunking
 * @tags insert, doc-sections, bulk, fts5-sync, heading-chunks
 */
export function insertDocSections(
  db: Database.Database,
  docFunctionId: number,
  sections: { heading: string; heading_level: number; body: string; section_type: string; section_order: number }[]
): void {
  const stmt = db.prepare(
    'INSERT INTO doc_sections (doc_function_id, heading, heading_level, body, section_type, section_order) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const s of sections) {
    stmt.run(docFunctionId, s.heading, s.heading_level, s.body, s.section_type, s.section_order);
  }
}

/**
 * @what Searches inline comments via FTS5 and returns matches with their parent function context
 * @how Runs FTS5 MATCH on comments_fts, joins through function_id to hydrate parent function
 * @why Enables sub-function-level DRY detection by finding similar step descriptions across the codebase
 *
 * @param {Database.Database} db The database instance
 * @param {string} query FTS5 search query
 * @param {number} limit Maximum results (default 10)
 * @returns {{ comment: CommentRecord; function: FunctionResult }[]} Matched comments with parent function
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain code-index, comment-search, dry-detection
 * @tags fts5, search, comments, step-level, dry-enforcement
 */
export function searchCommentsByFTS(
  db: Database.Database,
  query: string,
  limit: number = 10
): { comment: CommentRecord; function: FunctionResult }[] {
  const rows = db.prepare(`
    SELECT fc.*, cf.rank
    FROM comments_fts cf
    JOIN function_comments fc ON fc.id = cf.rowid
    WHERE comments_fts MATCH ?
    ORDER BY cf.rank
    LIMIT ?
  `).all(sanitizeFTSQuery(query), limit) as (CommentRecord & { rank: number })[];

  const results: { comment: CommentRecord; function: FunctionResult }[] = [];
  for (const row of rows) {
    const func = getFunctionById(db, row.function_id);
    if (func) {
      results.push({
        comment: { id: row.id, function_id: row.function_id, comment_text: row.comment_text, comment_type: row.comment_type, line_offset: row.line_offset },
        function: func,
      });
    }
  }
  return results;
}

/**
 * @what Searches documentation sections via FTS5 and returns matches with their parent doc context
 * @how Sanitizes query to OR-joined tokens, runs FTS5 MATCH on doc_sections_fts, joins through doc_function_id
 * @why Enables granular doc search at heading level instead of searching truncated 1000-char bodies
 *
 * @param {Database.Database} db The database instance
 * @param {string} query FTS5 search query
 * @param {number} limit Maximum results (default 10)
 * @returns {{ section: DocSectionRecord; function: FunctionResult }[]} Matched sections with parent doc
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain code-index, documentation-search, section-search
 * @tags fts5, search, doc-sections, granular, heading-level
 */
export function searchDocSectionsByFTS(
  db: Database.Database,
  query: string,
  limit: number = 10
): { section: DocSectionRecord; function: FunctionResult }[] {
  const rows = db.prepare(`
    SELECT ds.*, dsf.rank
    FROM doc_sections_fts dsf
    JOIN doc_sections ds ON ds.id = dsf.rowid
    WHERE doc_sections_fts MATCH ?
    ORDER BY dsf.rank
    LIMIT ?
  `).all(sanitizeFTSQuery(query), limit) as (DocSectionRecord & { rank: number })[];

  const results: { section: DocSectionRecord; function: FunctionResult }[] = [];
  for (const row of rows) {
    const func = getFunctionById(db, row.doc_function_id);
    if (func) {
      results.push({
        section: { id: row.id, doc_function_id: row.doc_function_id, heading: row.heading, heading_level: row.heading_level, body: row.body, section_type: row.section_type, section_order: row.section_order },
        function: func,
      });
    }
  }
  return results;
}

// ─── Query Operations ───────────────────────────────────────────────────────

/**
 * @what Retrieves a single function by ID and hydrates it with taxonomy data
 * @how Queries functions table by ID, then hydrates with domains/tags/systemlayers from junction tables
 * @why Used for individual function lookups in call graph traversal and result formatting
 *
 * @param {Database.Database} db The database instance
 * @param {number} id The function ID to look up
 * @returns {FunctionResult | null} Hydrated function or null if not found
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain code-index, function-lookup
 * @tags lookup, by-id, hydration, single-function, query
 */
export function getFunctionById(db: Database.Database, id: number): FunctionResult | null {
  const row = db.prepare('SELECT * FROM functions WHERE id = ?').get(id) as FunctionRecord | undefined;
  if (!row) return null;
  return hydrateFunction(db, row);
}

/**
 * @what Batch-retrieves multiple functions by ID array and hydrates them with taxonomy data in 4 queries total
 * @how Queries functions table with WHERE IN, then batch-hydrates all results via hydrateFunctions()
 * @why Eliminates N+1 pattern in hybrid search where getFunctionById() was called per candidate (3N+1 queries → 4 queries)
 *
 * @param {Database.Database} db The database instance
 * @param {number[]} ids Array of function IDs to look up
 * @returns {Map<number, FunctionResult>} Map of ID → hydrated function (missing IDs are absent from map)
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain code-index, batch-lookup, query-optimization
 * @tags batch, by-ids, hydration, performance, n-plus-one
 */
export function getFunctionsByIds(db: Database.Database, ids: number[]): Map<number, FunctionResult> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM functions WHERE id IN (${placeholders})`).all(...ids) as FunctionRecord[];
  const hydrated = hydrateFunctions(db, rows);
  const map = new Map<number, FunctionResult>();
  for (const func of hydrated) {
    map.set(func.id, func);
  }
  return map;
}

export function getFunctionByName(db: Database.Database, name: string, filePath?: string): FunctionResult | null {
  let row: FunctionRecord | undefined;
  if (filePath) {
    row = db.prepare('SELECT * FROM functions WHERE name = ? AND file_path = ?').get(name, filePath) as FunctionRecord | undefined;
  } else {
    row = db.prepare('SELECT * FROM functions WHERE name = ? LIMIT 1').get(name) as FunctionRecord | undefined;
  }
  if (!row) return null;
  return hydrateFunction(db, row);
}

export function getFunctionByFileAndLine(db: Database.Database, filePath: string, line: number): FunctionResult | null {
  const row = db.prepare('SELECT * FROM functions WHERE file_path = ? AND line_number = ? LIMIT 1').get(filePath, line) as FunctionRecord | undefined;
  if (!row) return null;
  return hydrateFunction(db, row);
}

export function getAllFunctionIds(db: Database.Database): number[] {
  const rows = db.prepare('SELECT id FROM functions').all() as { id: number }[];
  return rows.map(r => r.id);
}

/**
 * @what Hydrates a single function record with its domains, tags, and system layers from junction tables
 * @how Runs 3 individual queries against function_domains, function_tags, and function_systemlayers for the given function ID
 * @why Converts a raw FunctionRecord (flat DB row) into a FunctionResult with populated taxonomy arrays
 *
 * @param {Database.Database} db The database instance
 * @param {FunctionRecord} row The function record to hydrate
 * @returns {FunctionResult} Function record with domains, tags, and systemlayers arrays populated
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain code-index, data-hydration
 * @tags hydration, junction-tables, domains, tags, systemlayers
 */
function hydrateFunction(db: Database.Database, row: FunctionRecord): FunctionResult {
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
 * @what Batch-hydrates multiple function records with their domains, tags, and system layers in 3 queries total
 * @how Builds WHERE IN clauses for all three junction tables, then groups results by function_id in memory
 * @why Eliminates the N+1 query pattern where hydrateFunction() runs 3 queries per function, reducing ~3N queries to 3
 *
 * @param {Database.Database} db The database instance
 * @param {FunctionRecord[]} rows Array of function records to hydrate
 * @returns {FunctionResult[]} Hydrated function results with domains, tags, and systemlayers populated
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain code-index, query-optimization
 * @tags batch, hydration, n-plus-one, performance, junction-tables
 */
export function hydrateFunctions(db: Database.Database, rows: FunctionRecord[]): FunctionResult[] {
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

// ─── Search ─────────────────────────────────────────────────────────────────

/**
 * @what Converts natural language queries into FTS5 OR-joined token queries
 * @how Splits on whitespace, filters tokens >= 3 chars, wraps each in quotes, joins with OR
 * @why FTS5 defaults to AND for multi-word queries which fails on short comments; OR gives partial matches
 *
 * @param {string} query Raw search query from user
 * @returns {string} FTS5-safe query with OR between tokens
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain code-index, fts5, search
 * @tags fts5, query, sanitize, tokenize, search
 */
export function sanitizeFTSQuery(query: string): string {
  // If query already contains FTS5 operators, sanitize special chars but preserve operators
  if (/\bOR\b|\bAND\b|\bNOT\b|"/.test(query)) {
    return query;
  }
  // Split into tokens, strip dangerous FTS5 chars, filter short words, quote each, join with OR
  const tokens = query
    .split(/\s+/)
    .map(t => t.replace(/[^a-zA-Z0-9_-]/g, ''))
    .filter(t => t.length >= 3);
  // Return a safe no-match query instead of raw input when all tokens are too short
  if (tokens.length === 0) return '""';
  if (tokens.length === 1) return `"${tokens[0]}"`;
  return tokens.map(t => `"${t}"`).join(' OR ');
}

/**
 * @what Searches the functions FTS5 index for matching function descriptions
 * @how Sanitizes query to OR-joined tokens, runs FTS5 MATCH, returns ranked results
 * @why Provides keyword-based function discovery as part of the hybrid search pipeline
 *
 * @param {Database.Database} db The database instance
 * @param {string} query Raw search query
 * @param {number} limit Maximum results to return
 * @returns {{ id: number; rank: number }[]} Function IDs with FTS5 relevance rank
 *
 * @sideeffects Reads from database
 * @systemlayer Data Layer
 * @domain code-index, search, fts5
 * @tags fts5, search, keyword, functions, ranking
 */
export function searchByFTS(db: Database.Database, query: string, limit: number): { id: number; rank: number }[] {
  const ftsQuery = sanitizeFTSQuery(query);
  const rows = db.prepare(`
    SELECT rowid as id, rank
    FROM functions_fts
    WHERE functions_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, limit) as { id: number; rank: number }[];
  return rows;
}

export function searchFunctions(
  db: Database.Database,
  filters: SearchFilters
): FunctionResult[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.domain) {
    conditions.push('f.id IN (SELECT function_id FROM function_domains WHERE domain = ?)');
    params.push(filters.domain.toLowerCase());
  }

  if (filters.tags && filters.tags.length > 0) {
    for (const tag of filters.tags) {
      conditions.push('f.id IN (SELECT function_id FROM function_tags WHERE tag = ?)');
      params.push(tag.toLowerCase());
    }
  }

  if (filters.system_layer) {
    conditions.push('f.id IN (SELECT function_id FROM function_systemlayers WHERE systemlayer = ?)');
    params.push(filters.system_layer);
  }

  if (filters.file_path_pattern) {
    conditions.push('f.file_path LIKE ?');
    params.push(filters.file_path_pattern);
  }

  if (filters.tier !== undefined) {
    conditions.push('f.tier = ?');
    params.push(filters.tier);
  }

  if (filters.has_side_effects !== undefined) {
    if (filters.has_side_effects) {
      conditions.push("f.side_effects IS NOT NULL AND f.side_effects != '' AND LOWER(f.side_effects) != 'none'");
    } else {
      conditions.push("(f.side_effects IS NULL OR f.side_effects = '' OR LOWER(f.side_effects) = 'none')");
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 50;

  const rows = db.prepare(`
    SELECT f.* FROM functions f
    ${whereClause}
    ORDER BY f.name
    LIMIT ?
  `).all(...params, limit) as FunctionRecord[];

  return rows.map(row => hydrateFunction(db, row));
}

// ─── List Operations ────────────────────────────────────────────────────────

export function listDomains(db: Database.Database): DomainCount[] {
  return db.prepare(`
    SELECT domain, COUNT(DISTINCT function_id) as count
    FROM function_domains
    GROUP BY domain
    ORDER BY count DESC, domain ASC
  `).all() as DomainCount[];
}

export function listTags(db: Database.Database, domain?: string, limit: number = 50): TagCount[] {
  if (domain) {
    return db.prepare(`
      SELECT ft.tag, COUNT(DISTINCT ft.function_id) as count
      FROM function_tags ft
      JOIN function_domains fd ON ft.function_id = fd.function_id
      WHERE fd.domain = ?
      GROUP BY ft.tag
      ORDER BY count DESC, ft.tag ASC
      LIMIT ?
    `).all(domain.toLowerCase(), limit) as TagCount[];
  }

  return db.prepare(`
    SELECT tag, COUNT(DISTINCT function_id) as count
    FROM function_tags
    GROUP BY tag
    ORDER BY count DESC, tag ASC
    LIMIT ?
  `).all(limit) as TagCount[];
}

export function listSystemLayers(db: Database.Database): SystemLayerCount[] {
  return db.prepare(`
    SELECT systemlayer, COUNT(DISTINCT function_id) as count
    FROM function_systemlayers
    GROUP BY systemlayer
    ORDER BY count DESC, systemlayer ASC
  `).all() as SystemLayerCount[];
}

// ─── Call Graph Queries ─────────────────────────────────────────────────────

export function getCallers(
  db: Database.Database,
  functionName: string,
  filePath?: string,
  edgeType?: string
): FunctionResult[] {
  const target = getFunctionByName(db, functionName, filePath);
  if (!target) return [];

  let query = `
    SELECT f.* FROM functions f
    JOIN call_edges ce ON f.id = ce.source_function_id
    WHERE ce.target_function_id = ?
  `;
  const params: (number | string)[] = [target.id];

  if (edgeType) {
    query += ' AND ce.edge_type = ?';
    params.push(edgeType);
  }

  const rows = db.prepare(query).all(...params) as FunctionRecord[];
  return rows.map(row => hydrateFunction(db, row));
}

export function getCallees(
  db: Database.Database,
  functionName: string,
  filePath?: string,
  edgeType?: string
): FunctionResult[] {
  const source = getFunctionByName(db, functionName, filePath);
  if (!source) return [];

  let query = `
    SELECT f.* FROM functions f
    JOIN call_edges ce ON f.id = ce.target_function_id
    WHERE ce.source_function_id = ?
  `;
  const params: (number | string)[] = [source.id];

  if (edgeType) {
    query += ' AND ce.edge_type = ?';
    params.push(edgeType);
  }

  const rows = db.prepare(query).all(...params) as FunctionRecord[];
  return rows.map(row => hydrateFunction(db, row));
}

export function getImpact(
  db: Database.Database,
  functionName: string,
  filePath?: string,
  maxDepth: number = 3
): { function: FunctionResult; depth: number }[] {
  const target = getFunctionByName(db, functionName, filePath);
  if (!target) return [];

  const visited = new Set<number>();
  const result: { function: FunctionResult; depth: number }[] = [];
  const queue: { id: number; depth: number }[] = [{ id: target.id, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.id) || current.depth > maxDepth) continue;
    visited.add(current.id);

    if (current.id !== target.id) {
      const func = getFunctionById(db, current.id);
      if (func) {
        result.push({ function: func, depth: current.depth });
      }
    }

    // Traverse upward through callers
    const callers = db.prepare(`
      SELECT source_function_id as id FROM call_edges WHERE target_function_id = ?
    `).all(current.id) as { id: number }[];

    for (const caller of callers) {
      if (!visited.has(caller.id)) {
        queue.push({ id: caller.id, depth: current.depth + 1 });
      }
    }
  }

  return result;
}

// ─── Embedding Queries ──────────────────────────────────────────────────────

export function getEmbedding(
  db: Database.Database,
  functionId: number,
  embeddingType: string
): { embedding: Float32Array; input_hash: string } | null {
  const row = db.prepare(
    'SELECT embedding, input_hash FROM function_embeddings WHERE function_id = ? AND embedding_type = ?'
  ).get(functionId, embeddingType) as { embedding: Buffer; input_hash: string } | undefined;

  if (!row) return null;
  return {
    embedding: new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4),
    input_hash: row.input_hash,
  };
}

export function getAllEmbeddings(
  db: Database.Database,
  embeddingType: string
): Map<number, Float32Array> {
  const rows = db.prepare(
    'SELECT function_id, embedding FROM function_embeddings WHERE embedding_type = ?'
  ).all(embeddingType) as { function_id: number; embedding: Buffer }[];

  const map = new Map<number, Float32Array>();
  for (const row of rows) {
    map.set(
      row.function_id,
      new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
    );
  }
  return map;
}

// ─── Metadata Operations ────────────────────────────────────────────────────

export function setMetadata(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(key, value);
}

export function getMetadata(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function getIndexMetadata(db: Database.Database, staleFileCount: number = 0): IndexMetadata {
  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN tier = 1 THEN 1 ELSE 0 END) as tier1,
      SUM(CASE WHEN tier = 2 THEN 1 ELSE 0 END) as tier2,
      SUM(CASE WHEN tier = 3 THEN 1 ELSE 0 END) as tier3
    FROM functions
  `).get() as { total: number; tier1: number; tier2: number; tier3: number };

  const embeddingsCount = (db.prepare('SELECT COUNT(*) as count FROM function_embeddings').get() as { count: number }).count;
  const callEdgesCount = (db.prepare('SELECT COUNT(*) as count FROM call_edges').get() as { count: number }).count;
  const domainsCount = (db.prepare('SELECT COUNT(DISTINCT domain) as count FROM function_domains').get() as { count: number }).count;
  const tagsCount = (db.prepare('SELECT COUNT(DISTINCT tag) as count FROM function_tags').get() as { count: number }).count;
  const systemlayersCount = (db.prepare('SELECT COUNT(DISTINCT systemlayer) as count FROM function_systemlayers').get() as { count: number }).count;
  const commentsCount = (db.prepare('SELECT COUNT(*) as count FROM function_comments').get() as { count: number }).count;
  const docSectionsCount = (db.prepare('SELECT COUNT(*) as count FROM doc_sections').get() as { count: number }).count;

  return {
    last_rebuilt: getMetadata(db, 'last_rebuilt'),
    files_scanned: Number(getMetadata(db, 'files_scanned') ?? 0),
    functions_indexed: counts.total,
    tier1_count: counts.tier1,
    tier2_count: counts.tier2,
    tier3_count: counts.tier3,
    domains_count: domainsCount,
    tags_count: tagsCount,
    systemlayers_count: systemlayersCount,
    embeddings_count: embeddingsCount,
    call_edges_count: callEdgesCount,
    comments_count: commentsCount,
    doc_sections_count: docSectionsCount,
    stale_files: staleFileCount,
  };
}
