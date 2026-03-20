/**
 * @what Manages caching of validation results with 5-minute TTL
 * @how Stores validation results in JSON file with timestamps, checks TTL on retrieval
 * @why Avoids expensive headless Claude calls for repeated edits to same code
 *
 * @sideeffects Reads and writes cache file to disk
 * @systemlayer Caching
 * @domain performance-optimization, caching, validation
 * @tags cache, ttl, performance, optimization, validation-helper
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { ValidationResult, CacheEntry } from './types.js';
import { resolveConfig } from '../../config.js';

// Cache file location
const CACHE_FILE = path.join(path.dirname(resolveConfig().databasePath), '.validation-cache.json');

// TTL in milliseconds (5 minutes)
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * @what Retrieves cached validation result if still valid (within TTL)
 * @how Reads cache file, checks timestamp against TTL, returns result if valid
 * @why Avoid repeating expensive validations for unchanged code
 *
 * @param {string} cacheKey Hash of file path and edit content
 * @returns {ValidationResult | null} Cached result or null if expired/missing
 *
 * @sideeffects Reads cache file from disk
 * @systemlayer Cache Retrieval
 * @domain cache-lookup, ttl-validation
 * @tags cache-read, ttl-check, performance, optimization, validation-bypass
 */
export function getCachedValidation(cacheKey: string): ValidationResult | null {
  try {
    if (!existsSync(CACHE_FILE)) {
      return null; // No cache file exists yet
    }

    const cacheData = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    const entry: CacheEntry | undefined = cacheData[cacheKey];

    if (!entry) {
      return null; // No cached result for this key
    }

    // Check if cache entry is still valid (within TTL)
    const now = Date.now();
    const age = now - entry.timestamp;

    if (age > CACHE_TTL_MS) {
      return null; // Cache expired
    }

    return entry.result;
  } catch (_error) {
    // If cache read fails, just return null (no cached result)
    return null;
  }
}

/**
 * @what Stores validation result in cache with current timestamp
 * @how Reads existing cache, adds/updates entry, writes back to disk
 * @why Persist validation result for future use within TTL window
 *
 * @param {string} cacheKey Hash of file path and edit content
 * @param {ValidationResult} result Validation result to cache
 *
 * @sideeffects Reads and writes cache file to disk
 * @systemlayer Cache Storage
 * @domain cache-write, persistence
 * @tags cache-write, persistence, performance, optimization, storage
 */
export function setCachedValidation(cacheKey: string, result: ValidationResult): void {
  try {
    // Read existing cache (or create empty object)
    let cacheData: Record<string, CacheEntry> = {};

    if (existsSync(CACHE_FILE)) {
      try {
        cacheData = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
      } catch {
        // If cache file is corrupted, start fresh
        cacheData = {};
      }
    }

    // Add new entry
    cacheData[cacheKey] = {
      result,
      timestamp: Date.now()
    };

    // Clean up expired entries to keep cache file size reasonable
    cacheData = cleanExpiredEntries(cacheData);

    // Write back to disk
    writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2), 'utf-8');
  } catch (_error) {
    // If cache write fails, just continue (non-fatal)
    // This ensures validation failures don't block edits
  }
}

/**
 * @what Generates cache key from file path and edit content
 * @how Creates SHA-256 hash of concatenated file path, old_string, and new_string
 * @why Unique cache key ensures different edits don't collide
 *
 * @param {string} filePath Absolute path to file being edited
 * @param {string} oldString Code before edit
 * @param {string} newString Code after edit
 * @returns {string} SHA-256 hash to use as cache key
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain hashing, cache-key-generation
 * @tags hashing, sha256, cache-key, uniqueness, collision-prevention
 */
export function generateCacheKey(
  filePath: string,
  oldString: string,
  newString: string
): string {
  // Concatenate all inputs
  const content = `${filePath}|${oldString}|${newString}`;

  // Generate SHA-256 hash
  return createHash('sha256').update(content).digest('hex');
}

/**
 * @what Removes expired entries from cache to prevent unbounded growth
 * @how Filters cache entries, keeping only those within TTL
 * @why Keep cache file size reasonable and remove stale data
 *
 * @param {Record<string, CacheEntry>} cacheData Current cache data
 * @returns {Record<string, CacheEntry>} Cleaned cache data with only valid entries
 *
 * @sideeffects None
 * @systemlayer Cache Maintenance
 * @domain cache-cleanup, garbage-collection
 * @tags cleanup, garbage-collection, ttl-enforcement, maintenance, optimization
 */
function cleanExpiredEntries(
  cacheData: Record<string, CacheEntry>
): Record<string, CacheEntry> {
  const now = Date.now();
  const cleaned: Record<string, CacheEntry> = {};

  for (const [key, entry] of Object.entries(cacheData)) {
    const age = now - entry.timestamp;

    // Keep entries that are still valid
    if (age <= CACHE_TTL_MS) {
      cleaned[key] = entry;
    }
  }

  return cleaned;
}

/**
 * @what Clears all cached validation results
 * @how Deletes the cache file from disk
 * @why Useful for testing or forcing fresh validation
 *
 * @sideeffects Deletes cache file from disk
 * @systemlayer Cache Management
 * @domain cache-invalidation, testing
 * @tags cache-clear, invalidation, testing-helper, maintenance, file-deletion
 */
export function clearCache(): void {
  try {
    if (existsSync(CACHE_FILE)) {
      unlinkSync(CACHE_FILE);
    }
  } catch (_error) {
    // Ignore errors (non-fatal)
  }
}

/**
 * @what Gets cache statistics for monitoring and debugging
 * @how Reads cache file and analyzes entry count and ages
 * @why Useful for understanding cache hit rates and effectiveness
 *
 * @returns {object} Statistics about cache (entries, oldest, newest, size)
 *
 * @sideeffects Reads cache file from disk
 * @systemlayer Monitoring
 * @domain cache-statistics, monitoring
 * @tags monitoring, statistics, debugging, cache-analysis, metrics
 */
export function getCacheStats(): {
  totalEntries: number;
  validEntries: number;
  expiredEntries: number;
  oldestEntry: number;
  newestEntry: number;
} {
  try {
    if (!existsSync(CACHE_FILE)) {
      return {
        totalEntries: 0,
        validEntries: 0,
        expiredEntries: 0,
        oldestEntry: 0,
        newestEntry: 0
      };
    }

    const cacheData = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    const now = Date.now();
    let validCount = 0;
    let expiredCount = 0;
    let oldestTimestamp = Infinity;
    let newestTimestamp = 0;

    for (const entry of Object.values(cacheData) as CacheEntry[]) {
      const age = now - entry.timestamp;

      if (age <= CACHE_TTL_MS) {
        validCount++;
      } else {
        expiredCount++;
      }

      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
      }
      if (entry.timestamp > newestTimestamp) {
        newestTimestamp = entry.timestamp;
      }
    }

    return {
      totalEntries: validCount + expiredCount,
      validEntries: validCount,
      expiredEntries: expiredCount,
      oldestEntry: oldestTimestamp === Infinity ? 0 : oldestTimestamp,
      newestEntry: newestTimestamp
    };
  } catch {
    return {
      totalEntries: 0,
      validEntries: 0,
      expiredEntries: 0,
      oldestEntry: 0,
      newestEntry: 0
    };
  }
}
