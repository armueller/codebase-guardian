import type Database from 'better-sqlite3';
import {
  getFunctionByName,
  getFunctionsByIds,
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
  hydrateFunctions,
  type FunctionResult,
  type FunctionRecord,
  type SearchFilters,
  type DomainCount,
  type TagCount,
  type SystemLayerCount,
  type CommentRecord,
  type DocSectionRecord,
  type IndexMetadata,
} from '../mcp-server/db.js';
import { semanticSearch as runSemanticSearch } from '../mcp-server/embeddings.js';

// ─── Result Types ───────────────────────────────────────────────────────────

export interface CommentSearchResult {
  comment: CommentRecord;
  function: FunctionResult;
}

export interface DocSearchResult {
  section: DocSectionRecord;
  function: FunctionResult;
}

export interface ImpactResult {
  function: FunctionResult;
  depth: number;
}

// ─── API Interface ──────────────────────────────────────────────────────────

export interface IndexAPI {
  // Search
  search(query: string, filters?: SearchFilters): FunctionResult[];
  semanticSearch(query: string, limit?: number): Promise<FunctionResult[]>;

  // Call graph
  callers(functionName: string): FunctionResult[];
  callees(functionName: string): FunctionResult[];
  impact(functionName: string, depth?: number): ImpactResult[];

  // Lookup
  lookup(name: string, filePath?: string): FunctionResult | null;
  lookupByFile(filePath: string): FunctionResult[];
  functionsByDirectory(dirPath: string): FunctionResult[];

  // Content search
  searchComments(query: string, limit?: number): CommentSearchResult[];
  searchDocs(query: string, limit?: number): DocSearchResult[];

  // Taxonomy
  listDomains(): DomainCount[];
  listTags(domain?: string): TagCount[];
  listSystemLayers(): SystemLayerCount[];

  // Metadata
  indexStatus(): IndexMetadata;
}

// ─── Post-Retrieval Filtering ───────────────────────────────────────────────

function applyFilters(results: FunctionResult[], filters: SearchFilters, limit: number): FunctionResult[] {
  const filtered: FunctionResult[] = [];

  for (const func of results) {
    if (filtered.length >= limit) break;

    if (filters.domain && !func.domains.includes(filters.domain.toLowerCase())) continue;
    if (filters.tags && filters.tags.length > 0) {
      const hasAllTags = filters.tags.every(t => func.tags.includes(t.toLowerCase()));
      if (!hasAllTags) continue;
    }
    if (filters.system_layer && !func.systemlayers.some(
      sl => sl.toLowerCase() === filters.system_layer!.toLowerCase()
    )) continue;
    if (filters.file_path_pattern) {
      const escaped = filters.file_path_pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = escaped.replace(/%/g, '.*').replace(/_/g, '.');
      if (!new RegExp(pattern).test(func.file_path)) continue;
    }
    if (filters.tier !== undefined && func.tier !== filters.tier) continue;
    if (filters.has_side_effects !== undefined) {
      const hasSE = func.side_effects !== null && func.side_effects !== '' && func.side_effects.toLowerCase() !== 'none';
      if (filters.has_side_effects !== hasSE) continue;
    }

    filtered.push(func);
  }

  return filtered;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createIndexAPI(db: Database.Database): IndexAPI {
  return {
    search(query: string, filters?: SearchFilters): FunctionResult[] {
      const limit = filters?.limit ?? 15;
      const fetchLimit = filters && Object.keys(filters).filter(k => k !== 'limit').length > 0
        ? limit * 10
        : limit * 3;

      const ftsResults = searchByFTS(db, query, fetchLimit);
      const ids = ftsResults.map(r => r.id);
      if (ids.length === 0) return [];

      const funcMap = getFunctionsByIds(db, ids);
      const hydrated = ids.map(id => funcMap.get(id)).filter((f): f is FunctionResult => f !== undefined);

      if (filters && Object.keys(filters).filter(k => k !== 'limit').length > 0) {
        return applyFilters(hydrated, filters, limit);
      }

      return hydrated.slice(0, limit);
    },

    async semanticSearch(query: string, limit?: number): Promise<FunctionResult[]> {
      const effectiveLimit = limit ?? 10;
      const results = await runSemanticSearch(db, query, effectiveLimit);
      if (results.length === 0) return [];
      const ids = results.map(r => r.functionId);
      const funcMap = getFunctionsByIds(db, ids);
      // Preserve similarity ranking order
      return ids.map(id => funcMap.get(id)).filter((f): f is FunctionResult => f !== undefined);
    },

    callers(functionName: string): FunctionResult[] {
      return getCallers(db, functionName);
    },

    callees(functionName: string): FunctionResult[] {
      return getCallees(db, functionName);
    },

    impact(functionName: string, depth?: number): ImpactResult[] {
      return getImpact(db, functionName, undefined, depth);
    },

    lookup(name: string, filePath?: string): FunctionResult | null {
      return getFunctionByName(db, name, filePath);
    },

    lookupByFile(filePath: string): FunctionResult[] {
      const rows = db.prepare('SELECT * FROM functions WHERE file_path = ? ORDER BY line_number')
        .all(filePath) as FunctionRecord[];
      return hydrateFunctions(db, rows);
    },

    functionsByDirectory(dirPath: string): FunctionResult[] {
      const rows = db.prepare('SELECT * FROM functions WHERE file_path LIKE ? AND tier != 3 ORDER BY name')
        .all(`${dirPath}/%`) as FunctionRecord[];
      return hydrateFunctions(db, rows);
    },

    searchComments(query: string, limit?: number): CommentSearchResult[] {
      return searchCommentsByFTS(db, query, limit);
    },

    searchDocs(query: string, limit?: number): DocSearchResult[] {
      return searchDocSectionsByFTS(db, query, limit);
    },

    listDomains(): DomainCount[] {
      return listDomains(db);
    },

    listTags(domain?: string): TagCount[] {
      return listTags(db, domain);
    },

    listSystemLayers(): SystemLayerCount[] {
      return listSystemLayers(db);
    },

    indexStatus(): IndexMetadata {
      return getIndexMetadata(db);
    },
  };
}
