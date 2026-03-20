/**
 * Shared FTS5 utilities — CommonJS module importable from both ESM and CJS consumers.
 * Single source of truth: eliminates the duplicated sanitizeFTSQuery in db.ts and code-index-client.ts.
 */

/**
 * Converts natural language queries into FTS5 OR-joined token queries.
 * Splits on whitespace, filters tokens >= 3 chars, wraps each in quotes, joins with OR.
 * FTS5 defaults to AND for multi-word queries which fails on short comments; OR gives partial matches.
 *
 * @param {string} query Raw search query from user
 * @returns {string} FTS5-safe query with OR between tokens
 */
function sanitizeFTSQuery(query) {
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

module.exports = { sanitizeFTSQuery };
