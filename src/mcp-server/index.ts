#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'path';
import { resolveConfig, ensureDirectories, registerProject } from '../config.js';
import {
  openDatabase,
  clearAllData,
  searchByFTS,
  searchCommentsByFTS,
  searchDocSectionsByFTS,
  listDomains,
  listTags,
  listSystemLayers,
  getCallers,
  getCallees,
  getImpact,
  getIndexMetadata,
  getFunctionsByIds,
  type FunctionResult,
  type SearchFilters,
} from './db.js';
import { semanticSearch, invalidateCache } from './embeddings.js';
import { clearValidationArtifacts } from './validation-artifacts.js';
import { buildIndex, readDirtyFiles, clearDirtyFiles } from './indexer.js';
import { buildCallGraph } from './call-graph.js';
import { buildPythonCallGraph } from './py-call-graph.js';
import { createIndexAPI } from '../shared/index-api.js';
import { executeInSandbox } from './execute-sandbox.js';
import { buildMetricsReport } from './metrics-query.js';
import { createRequire } from 'module';

// Single source of truth for the server version — read from package.json so it
// can never drift from the published plugin/package version (it did: was pinned
// at 0.3.0 through several releases).
const _require = createRequire(import.meta.url);
const PKG_VERSION: string = _require('../../package.json').version ?? '0.0.0';

// ─── Path Resolution ────────────────────────────────────────────────────────

const config = resolveConfig();
ensureDirectories(config);
registerProject(config);

const REPO_ROOT = config.projectRoot;
const DB_PATH = config.databasePath;
const DIRTY_FILES_PATH = path.resolve(path.dirname(config.databasePath), '.dirty-files');

// ─── Index API (for execute tool) ──────────────────────────────────────────

const executeDb = openDatabase(DB_PATH);
const indexApi = createIndexAPI(executeDb);

// ─── Tool Definitions ───────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: 'search',
    description: 'Hybrid keyword + semantic search over the codebase. Combines FTS5 keyword matching (40%) with vector similarity (60%) for best results. Use this to find functions, patterns, and documentation by description, domain, or concept.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (natural language or keywords)' },
        domain: { type: 'string', description: 'Filter by domain (e.g., "cash management", "options trading")' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
        system_layer: { type: 'string', description: 'Filter by system layer (e.g., "Business Logic", "UI Helper", "Model")' },
        file_path_pattern: { type: 'string', description: 'SQL LIKE pattern for file path (e.g., "app/store/%")' },
        tier: { type: 'number', description: 'Filter by tier: 1=JSDoc annotated, 2=auto-discovered exports, 3=documentation' },
        has_side_effects: { type: 'boolean', description: 'Filter functions with/without side effects' },
        limit: { type: 'number', description: 'Max results (default 15, max 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_domains',
    description: 'List all canonical domains in the codebase with function counts. Useful for discovering what business areas exist.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'list_tags',
    description: 'List tags with usage counts, optionally filtered by domain.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        domain: { type: 'string', description: 'Optional domain to filter tags by' },
        limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      },
    },
  },
  {
    name: 'list_systemlayers',
    description: 'List all system layers (architectural tiers) with function counts. System layers include Business Logic, UI Helper, Model, Controller, Validation, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'rebuild_index',
    description: 'Rebuild the code index by re-scanning source and documentation files.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'callers',
    description: 'Find all direct callers of a function (reverse call graph). Shows which functions call the specified function.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        function_name: { type: 'string', description: 'Name of the function to find callers for' },
        file_path: { type: 'string', description: 'Optional file path to disambiguate functions with same name' },
        edge_type: { type: 'string', description: 'Optional filter: "calls" or "imports"' },
      },
      required: ['function_name'],
    },
  },
  {
    name: 'callees',
    description: 'Find all direct dependencies of a function (forward call graph). Shows what functions the specified function calls.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        function_name: { type: 'string', description: 'Name of the function to find callees for' },
        file_path: { type: 'string', description: 'Optional file path to disambiguate functions with same name' },
        edge_type: { type: 'string', description: 'Optional filter: "calls" or "imports"' },
      },
      required: ['function_name'],
    },
  },
  {
    name: 'impact',
    description: 'Analyze the blast radius of a function change. Uses BFS traversal up the caller graph to find all functions that would be affected by modifying the specified function.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        function_name: { type: 'string', description: 'Name of the function to analyze impact for' },
        file_path: { type: 'string', description: 'Optional file path to disambiguate' },
        depth: { type: 'number', description: 'Max traversal depth (default 3, max 10)' },
      },
      required: ['function_name'],
    },
  },
  {
    name: 'index_status',
    description: 'Get the current status of the code index: function counts by tier, domain/tag/systemlayer counts, last rebuild time, stale file count.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'search_comments',
    description: 'Search inline code comments within function bodies. Useful for finding sub-function-level logic patterns, step descriptions, and implementation details not captured by JSDoc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (natural language or keywords)' },
        limit: { type: 'number', description: 'Max results (default 10, max 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_doc_sections',
    description: 'Search documentation sections (headings and content from best-practices, patterns, and architecture docs). More granular than the main search which only indexes doc titles and descriptions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (natural language or keywords)' },
        limit: { type: 'number', description: 'Max results (default 10, max 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'execute',
    description: 'Execute JavaScript code against the codebase index API. Write code using the `api` object to compose complex queries in a single call. Available methods: api.search(query, filters?), api.semanticSearch(query, limit?) [async — use await], api.callers(name), api.callees(name), api.impact(name, depth?), api.lookup(name, filePath?), api.lookupByFile(filePath), api.functionsByDirectory(dirPath), api.searchComments(query, limit?), api.searchDocs(query, limit?), api.listDomains(), api.listTags(domain?), api.listSystemLayers(), api.indexStatus(). Return your result — it will be JSON-serialized.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute. Use the `api` object. Return your result.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'metrics',
    description: 'Report the guardian\'s durable decision metrics: allow/deny rates (overall and on genuine headless-validated judgments), outcome buckets, deny-reason categories, per-project rates, and headless-validation timing. Answers "is the guardian useful?" over time. Data is global across every project the hook has run on; use `project` to focus on one, and `since_days` to bound the window.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        since_days: { type: 'number', description: 'Only include decisions from the last N days (default: all time)' },
        project: { type: 'string', description: 'Filter to a project by name/root substring (default: all projects)' },
      },
    },
  },
];

// ─── Auto-sync ──────────────────────────────────────────────────────────────

async function autoSync(db: ReturnType<typeof openDatabase>): Promise<void> {
  const dirtyFiles = readDirtyFiles(DIRTY_FILES_PATH);
  if (dirtyFiles.length === 0) return;

  console.error(`[auto-sync] Rebuilding ${dirtyFiles.length} dirty files...`);
  const absoluteFiles = dirtyFiles.map(f => path.resolve(REPO_ROOT, f));
  await buildIndex(db, REPO_ROOT, {
    incremental: true,
    dirtyFiles: absoluteFiles,
  });
  clearDirtyFiles(DIRTY_FILES_PATH);
  invalidateCache();
  console.error('[auto-sync] Done');
}

// ─── Hybrid Search ──────────────────────────────────────────────────────────

/**
 * @what Performs hybrid search combining FTS5 keyword matching (40%) with vector semantic similarity (60%)
 * @how Runs FTS5 and semantic search in parallel, normalizes scores via sigmoid (FTS) and raw cosine (semantic), fuses with weighted sum, then applies post-retrieval filters
 * @why Hybrid search handles both exact term matches (FTS5) and conceptual similarity (vectors), providing better DRY detection than either alone
 *
 * @param {ReturnType<typeof openDatabase>} db The database instance
 * @param {string} query Natural language or keyword search query
 * @param {SearchFilters} filters Optional filters for domain, tags, system_layer, file_path_pattern, tier, has_side_effects, limit
 * @returns {Promise<{ result: FunctionResult; score: number }[]>} Ranked results with hybrid scores
 *
 * @sideeffects Reads from database, may trigger lazy embedding model load on first semantic search
 * @systemlayer Business Logic
 * @domain code-index, search, hybrid-search, dry-detection
 * @tags hybrid-search, fts5, semantic, vector-similarity, scoring, filtering
 */
async function hybridSearch(
  db: ReturnType<typeof openDatabase>,
  query: string,
  filters: SearchFilters
): Promise<{ result: FunctionResult; score: number }[]> {
  const limit = Math.min(filters.limit ?? 15, 50);
  // Fetch more candidates when filters are active to avoid post-filter starvation
  const hasFilters = filters.domain || filters.tags?.length || filters.system_layer ||
    filters.file_path_pattern || filters.tier !== undefined || filters.has_side_effects !== undefined;
  const fetchLimit = hasFilters ? limit * 10 : limit * 3;

  // FTS5 full-text keyword search with BM25 ranking against function descriptions
  let ftsResults: { id: number; rank: number }[] = [];
  try {
    ftsResults = searchByFTS(db, query, fetchLimit);
  } catch {
    // FTS can fail on certain query syntax; fall back to semantic only
  }

  // Semantic vector similarity search using embedded query against function signature embeddings
  const semanticResults = await semanticSearch(db, query, fetchLimit);

  // Normalize FTS BM25 ranks to 0-1 using sigmoid (avoids degenerate min-max with few results)
  const ftsScores = new Map<number, number>();
  if (ftsResults.length > 0) {
    for (const r of ftsResults) {
      // Sigmoid normalization: map negative BM25 rank to 0-1 (rank typically -20 to 0)
      const normalized = 1 / (1 + Math.exp(r.rank + 5));
      ftsScores.set(r.id, normalized);
    }
  }

  // Build semantic cosine similarity scores map (already 0-1 from L2-normalized dot product)
  const semScores = new Map<number, number>();
  for (const r of semanticResults) {
    semScores.set(r.functionId, r.similarity);
  }

  // Merge candidate IDs from both search backends for score fusion
  const allIds = new Set([...ftsScores.keys(), ...semScores.keys()]);

  // Combined scoring: 40% keyword + 60% semantic
  const scored: { id: number; score: number }[] = [];
  for (const id of allIds) {
    const ftsScore = ftsScores.get(id) ?? 0;
    const semScore = semScores.get(id) ?? 0;
    scored.push({ id, score: 0.4 * ftsScore + 0.6 * semScore });
  }

  scored.sort((a, b) => b.score - a.score);

  // Batch-hydrate all candidates in 4 queries instead of 3*N individual lookups
  const candidateIds = scored.map(s => s.id);
  const hydratedMap = getFunctionsByIds(db, candidateIds);

  // Apply post-retrieval filters (domain, tags, system layer, file path, tier, side effects)
  const results: { result: FunctionResult; score: number }[] = [];
  for (const { id, score } of scored) {
    if (results.length >= limit) break;

    const func = hydratedMap.get(id);
    if (!func) continue;

    if (filters.domain && !func.domains.includes(filters.domain.toLowerCase())) continue;
    if (filters.tags && filters.tags.length > 0) {
      const hasAllTags = filters.tags.every(t => func.tags.includes(t.toLowerCase()));
      if (!hasAllTags) continue;
    }
    // Case-insensitive system layer matching (consistent with domain/tag normalization)
    if (filters.system_layer && !func.systemlayers.some(
      sl => sl.toLowerCase() === filters.system_layer!.toLowerCase()
    )) continue;
    if (filters.file_path_pattern) {
      // Escape regex metacharacters, then convert SQL LIKE wildcards (% → .*, _ → .)
      const escaped = filters.file_path_pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = escaped.replace(/%/g, '.*').replace(/_/g, '.');
      if (!new RegExp(pattern).test(func.file_path)) continue;
    }
    if (filters.tier !== undefined && func.tier !== filters.tier) continue;
    if (filters.has_side_effects !== undefined) {
      const hasSE = func.side_effects !== null && func.side_effects !== '' && func.side_effects.toLowerCase() !== 'none';
      if (filters.has_side_effects !== hasSE) continue;
    }

    results.push({ result: func, score });
  }

  return results;
}

// ─── Result Formatting ──────────────────────────────────────────────────────

function formatFunctionResult(func: FunctionResult, score?: number): string {
  const tierLabel = func.tier === 1 ? 'JSDoc' : func.tier === 2 ? 'Export' : 'Doc';
  let header = `## ${func.name}`;
  if (score !== undefined) {
    header += ` (${(score * 100).toFixed(1)}% relevance)`;
  }
  header += ` [${tierLabel}]`;

  const lines = [header];
  lines.push(`**File:** ${func.file_path}:${func.line_number}`);

  if (func.domains.length > 0) {
    lines.push(`**Domains:** ${func.domains.join(', ')}`);
  }
  if (func.systemlayers.length > 0) {
    lines.push(`**System Layers:** ${func.systemlayers.join(', ')}`);
  }
  if (func.tags.length > 0) {
    lines.push(`**Tags:** ${func.tags.join(', ')}`);
  }
  if (func.side_effects) {
    lines.push(`**Side Effects:** ${func.side_effects}`);
  }
  lines.push(`**Description:** ${func.description}`);

  return lines.join('\n');
}

// ─── MCP Server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'codebase-guardian', version: PKG_VERSION },
  { capabilities: { tools: {} } }
);

let db: ReturnType<typeof openDatabase>;

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Lazy-open database
  if (!db) {
    db = openDatabase(DB_PATH);
  }

  // Helper to validate required string parameters
  const requireString = (paramName: string): string | null => {
    const val = (args as Record<string, unknown>)?.[paramName];
    if (typeof val !== 'string' || val.trim().length === 0) return null;
    return val;
  };

  try {
    switch (name) {
      case 'search': {
        await autoSync(db);

        const query = requireString('query');
        if (!query) return { content: [{ type: 'text', text: 'Error: "query" parameter is required and must be a non-empty string.' }], isError: true };
        const filters: SearchFilters = {
          domain: (args as Record<string, unknown>).domain as string | undefined,
          tags: (args as Record<string, unknown>).tags as string[] | undefined,
          system_layer: (args as Record<string, unknown>).system_layer as string | undefined,
          file_path_pattern: (args as Record<string, unknown>).file_path_pattern as string | undefined,
          tier: (args as Record<string, unknown>).tier as number | undefined,
          has_side_effects: (args as Record<string, unknown>).has_side_effects as boolean | undefined,
          limit: (args as Record<string, unknown>).limit as number | undefined,
        };

        const results = await hybridSearch(db, query, filters);

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No results found.' }] };
        }

        const formatted = results
          .map(r => formatFunctionResult(r.result, r.score))
          .join('\n\n---\n\n');

        return {
          content: [{ type: 'text', text: `Found ${results.length} results:\n\n${formatted}` }],
        };
      }

      case 'list_domains': {
        const domains = listDomains(db);
        const formatted = domains
          .map(d => `- **${d.domain}** (${d.count} functions)`)
          .join('\n');
        return {
          content: [{ type: 'text', text: `## Domains (${domains.length} total)\n\n${formatted}` }],
        };
      }

      case 'list_tags': {
        const domain = (args as Record<string, unknown>).domain as string | undefined;
        const limit = Math.min((args as Record<string, unknown>).limit as number || 50, 200);
        const tags = listTags(db, domain, limit);
        const header = domain ? `Tags in domain "${domain}"` : 'All tags';
        const formatted = tags
          .map(t => `- **${t.tag}** (${t.count})`)
          .join('\n');
        return {
          content: [{ type: 'text', text: `## ${header} (${tags.length} shown)\n\n${formatted}` }],
        };
      }

      case 'list_systemlayers': {
        const layers = listSystemLayers(db);
        const formatted = layers
          .map(l => `- **${l.systemlayer}** (${l.count} functions)`)
          .join('\n');
        return {
          content: [{ type: 'text', text: `## System Layers (${layers.length} total)\n\n${formatted}` }],
        };
      }

      case 'rebuild_index': {
        console.error('Starting full index rebuild...');

        // Clear all existing data to prevent stale Tier 2 entries and call edges
        clearAllData(db);

        const indexStats = await buildIndex(db, REPO_ROOT);
        console.error('Building call graph...');
        const graphStats = await buildCallGraph(db, REPO_ROOT);
        console.error('Building Python call graph...');
        const pyGraphStats = await buildPythonCallGraph(db, REPO_ROOT);
        invalidateCache();

        // Bust the hook's validation cache + session store so stale verdicts
        // from the pre-rebuild index (e.g. a phantom DRY duplicate) aren't
        // re-served after the rebuild that was meant to fix them.
        const clearedArtifacts = clearValidationArtifacts(DB_PATH);

        return {
          content: [{
            type: 'text',
            text: [
              '## Index Rebuild Complete',
              '',
              `**Files scanned:** ${indexStats.filesScanned}`,
              `**Files skipped (unchanged):** ${indexStats.filesSkipped}`,
              `**Tier 1 (JSDoc):** ${indexStats.tier1Added}`,
              `**Tier 2 (exports):** ${graphStats.exportsDiscovered}`,
              `**Tier 3 (docs):** ${indexStats.tier3Added}`,
              `**Embeddings generated:** ${indexStats.embeddingsGenerated}`,
              `**Call edges:** ${graphStats.edgesCreated}`,
              `**Python call edges:** ${pyGraphStats.edgesCreated}`,
              `**Inline comments:** ${indexStats.commentsExtracted}`,
              `**Doc sections:** ${indexStats.docSectionsCreated}`,
              `**Validation cache:** ${clearedArtifacts.length > 0 ? `cleared (${clearedArtifacts.join(', ')})` : 'already clear'}`,
            ].join('\n'),
          }],
        };
      }

      case 'callers': {
        const funcName = requireString('function_name');
        if (!funcName) return { content: [{ type: 'text', text: 'Error: "function_name" parameter is required.' }], isError: true };
        const filePath = (args as Record<string, unknown>).file_path as string | undefined;
        const edgeType = (args as Record<string, unknown>).edge_type as string | undefined;
        const callers = getCallers(db, funcName, filePath, edgeType);

        if (callers.length === 0) {
          return { content: [{ type: 'text', text: `No callers found for "${funcName}".` }] };
        }

        const formatted = callers.map(c => formatFunctionResult(c)).join('\n\n---\n\n');
        return {
          content: [{ type: 'text', text: `## Callers of ${funcName} (${callers.length})\n\n${formatted}` }],
        };
      }

      case 'callees': {
        const funcName = requireString('function_name');
        if (!funcName) return { content: [{ type: 'text', text: 'Error: "function_name" parameter is required.' }], isError: true };
        const filePath = (args as Record<string, unknown>).file_path as string | undefined;
        const edgeType = (args as Record<string, unknown>).edge_type as string | undefined;
        const callees = getCallees(db, funcName, filePath, edgeType);

        if (callees.length === 0) {
          return { content: [{ type: 'text', text: `No callees found for "${funcName}".` }] };
        }

        const formatted = callees.map(c => formatFunctionResult(c)).join('\n\n---\n\n');
        return {
          content: [{ type: 'text', text: `## Callees of ${funcName} (${callees.length})\n\n${formatted}` }],
        };
      }

      case 'impact': {
        const funcName = requireString('function_name');
        if (!funcName) return { content: [{ type: 'text', text: 'Error: "function_name" parameter is required.' }], isError: true };
        const filePath = (args as Record<string, unknown>).file_path as string | undefined;
        const depth = Math.min((args as Record<string, unknown>).depth as number || 3, 10);
        const impacted = getImpact(db, funcName, filePath, depth);

        if (impacted.length === 0) {
          return { content: [{ type: 'text', text: `No impact found for "${funcName}" (no callers in graph).` }] };
        }

        const formatted = impacted
          .map(i => `### Depth ${i.depth}\n${formatFunctionResult(i.function)}`)
          .join('\n\n');
        return {
          content: [{
            type: 'text',
            text: `## Impact Analysis: ${funcName} (${impacted.length} affected, max depth ${depth})\n\n${formatted}`,
          }],
        };
      }

      case 'index_status': {
        const dirtyFiles = readDirtyFiles(DIRTY_FILES_PATH);
        const meta = getIndexMetadata(db, dirtyFiles.length);

        return {
          content: [{
            type: 'text',
            text: [
              '## Code Index Status',
              '',
              `**Last rebuilt:** ${meta.last_rebuilt || 'Never'}`,
              `**Files scanned:** ${meta.files_scanned}`,
              '',
              '### Function Counts',
              `- **Tier 1 (JSDoc annotated):** ${meta.tier1_count}`,
              `- **Tier 2 (auto-discovered exports):** ${meta.tier2_count}`,
              `- **Tier 3 (documentation):** ${meta.tier3_count}`,
              `- **Total:** ${meta.functions_indexed}`,
              '',
              '### Metadata',
              `- **Domains:** ${meta.domains_count}`,
              `- **Tags:** ${meta.tags_count}`,
              `- **System Layers:** ${meta.systemlayers_count}`,
              `- **Embeddings:** ${meta.embeddings_count}`,
              `- **Call edges:** ${meta.call_edges_count}`,
              `- **Inline comments:** ${meta.comments_count}`,
              `- **Doc sections:** ${meta.doc_sections_count}`,
              `- **Stale files:** ${meta.stale_files}`,
            ].join('\n'),
          }],
        };
      }

      case 'search_comments': {
        await autoSync(db);

        const query = requireString('query');
        if (!query) return { content: [{ type: 'text', text: 'Error: "query" parameter is required and must be a non-empty string.' }], isError: true };
        const limit = Math.min((args as Record<string, unknown>).limit as number || 10, 30);

        let results: ReturnType<typeof searchCommentsByFTS>;
        try {
          results = searchCommentsByFTS(db, query, limit);
        } catch {
          results = [];
        }

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No matching comments found.' }] };
        }

        const formatted = results
          .map(r => `**${r.function.name}** (${r.function.file_path}:${r.function.line_number})\n> ${r.comment.comment_text}\n_Type: ${r.comment.comment_type}, Line offset: ${r.comment.line_offset}_`)
          .join('\n\n---\n\n');

        return {
          content: [{ type: 'text', text: `Found ${results.length} matching comments:\n\n${formatted}` }],
        };
      }

      case 'search_doc_sections': {
        await autoSync(db);

        const query = requireString('query');
        if (!query) return { content: [{ type: 'text', text: 'Error: "query" parameter is required and must be a non-empty string.' }], isError: true };
        const limit = Math.min((args as Record<string, unknown>).limit as number || 10, 30);

        let results: ReturnType<typeof searchDocSectionsByFTS>;
        try {
          results = searchDocSectionsByFTS(db, query, limit);
        } catch {
          results = [];
        }

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No matching documentation sections found.' }] };
        }

        const formatted = results
          .map(r => {
            const bodyPreview = r.section.body.length > 500 ? r.section.body.slice(0, 500) + '...' : r.section.body;
            return `### ${r.section.heading} [${r.section.section_type}]\n**From:** ${r.function.name} (${r.function.file_path})\n\n${bodyPreview}`;
          })
          .join('\n\n---\n\n');

        return {
          content: [{ type: 'text', text: `Found ${results.length} matching sections:\n\n${formatted}` }],
        };
      }

      case 'execute': {
        await autoSync(db);
        invalidateCache();
        const code = (args as Record<string, unknown>)?.code;
        if (!code || typeof code !== 'string') {
          return { content: [{ type: 'text', text: 'Error: code parameter is required and must be a string' }] };
        }
        try {
          const result = await executeInSandbox(indexApi, code);
          const serialized = JSON.stringify(result === undefined ? null : result, null, 2);
          return {
            content: [{
              type: 'text',
              text: serialized,
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Execution error: ${error instanceof Error ? error.message : String(error)}`,
            }],
          };
        }
      }

      case 'metrics': {
        const rawSince = (args as Record<string, unknown>).since_days;
        let sinceDays: number | null = null;
        if (rawSince !== undefined && rawSince !== null) {
          const n = Number(rawSince);
          if (!Number.isFinite(n) || n <= 0) {
            return { content: [{ type: 'text', text: 'Error: "since_days" must be a positive number of days.' }], isError: true };
          }
          sinceDays = n;
        }
        const rawProject = (args as Record<string, unknown>).project;
        const projectFilter = typeof rawProject === 'string' && rawProject.trim() ? rawProject.trim() : null;

        return { content: [{ type: 'text', text: buildMetricsReport({ sinceDays, projectFilter }) }] };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ─── Start Server ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Codebase Guardian MCP server running (project: ${config.projectName})`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
