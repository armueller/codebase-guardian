/**
 * @what Manages validation session mappings between outer Claude sessions and headless Claude sessions
 * @how Reads/writes a JSON file mapping {outerSessionId}:{filePath} to headless session IDs
 * @why Enables --resume for headless Claude so retry validations keep full context from previous attempts
 *
 * @sideeffects Reads and writes .validation-sessions.json file
 * @systemlayer Data Layer
 * @domain session-management, validation-continuity, persistence
 * @tags session-store, json-persistence, resume-support, session-mapping, cleanup
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { resolveConfig } from '../../config.js';

const SESSIONS_FILE = path.join(path.dirname(resolveConfig().databasePath), '.validation-sessions.json');

// Sessions expire after 1 hour (sessions don't last forever)
const SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * @what Represents a stored validation session entry
 * @how Maps an outer session + file to a headless Claude session ID with metadata
 * @why Stores enough info to resume the headless session and track attempt count
 */
interface SessionEntry {
  headlessSessionId: string;
  attemptCount: number;
  lastAttempt: string;
  createdAt: string;
  lastDeniedContentHash?: string;
  lastDeniedReason?: string;
}

type SessionStore = Record<string, SessionEntry>;

/**
 * @what Reads the session store from disk
 * @how Parses .validation-sessions.json, returns empty object if missing or corrupt
 * @why Centralized read logic with error handling for all session operations
 *
 * @returns {SessionStore} Current session store contents
 *
 * @sideeffects Reads from filesystem
 * @systemlayer Data Layer
 * @domain session-persistence, file-read
 * @tags file-read, json-parse, error-handling, session-store, persistence
 */
function readStore(): SessionStore {
  try {
    if (!existsSync(SESSIONS_FILE)) return {};
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * @what Writes the session store to disk
 * @how Serializes to JSON and writes atomically
 * @why Centralized write logic for all session operations
 *
 * @param {SessionStore} store Session store to persist
 * @returns {void}
 *
 * @sideeffects Writes to filesystem
 * @systemlayer Data Layer
 * @domain session-persistence, file-write
 * @tags file-write, json-serialize, atomic-write, session-store, persistence
 */
function writeStore(store: SessionStore): void {
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch {
    // Non-fatal — validation will work without session continuity
  }
}

/**
 * @what Gets an existing session entry by key
 * @how Reads store, looks up key, returns entry if found and not expired
 * @why Called by claude-headless.ts to check if a headless session can be resumed
 *
 * @param {string} sessionKey Key in format {outerSessionId}:{filePath}
 * @returns {SessionEntry | null} Session entry if found and valid, null otherwise
 *
 * @sideeffects Reads from filesystem
 * @systemlayer Data Layer
 * @domain session-lookup, expiry-check
 * @tags session-lookup, ttl-check, resume-check, session-store, validation
 */
export function getSession(sessionKey: string): SessionEntry | null {
  const store = readStore();
  const entry = store[sessionKey];

  if (!entry) return null;

  // Check if expired
  const age = Date.now() - new Date(entry.createdAt).getTime();
  if (age > SESSION_TTL_MS) {
    // Clean up expired entry
    delete store[sessionKey];
    writeStore(store);
    return null;
  }

  return entry;
}

/**
 * @what Stores or updates a session entry
 * @how Reads store, sets/updates the entry, writes back
 * @why Called after first headless Claude invocation to store session ID for future resume
 *
 * @param {string} sessionKey Key in format {outerSessionId}:{filePath}
 * @param {string} headlessSessionId The headless Claude session ID to store
 * @param {number} attemptCount Current attempt number
 * @returns {void}
 *
 * @sideeffects Reads and writes session store file
 * @systemlayer Data Layer
 * @domain session-creation, session-update
 * @tags session-store, create-update, persistence, session-mapping, write
 */
export function setSession(sessionKey: string, headlessSessionId: string, attemptCount: number): void {
  const store = readStore();
  const now = new Date().toISOString();

  store[sessionKey] = {
    headlessSessionId,
    attemptCount,
    lastAttempt: now,
    createdAt: store[sessionKey]?.createdAt || now
  };

  writeStore(store);
}

/**
 * @what Stores the content hash and reason from a denied validation for duplicate resubmission detection
 * @how Reads the session store, updates the entry with the content hash and reason, writes back
 * @why When a developer resubmits identical code after a denial, we can return the cached denial immediately without invoking headless Claude (~10s savings per duplicate)
 *
 * @param {string} sessionKey Key in format {outerSessionId}:{filePath}
 * @param {string} contentHash SHA-256 hash of the denied code content
 * @param {string} reason The denial reason to return on duplicate resubmission
 * @returns {void}
 *
 * @sideeffects Reads and writes session store file
 * @systemlayer Data Layer
 * @domain session-management, denial-tracking
 * @tags denial-cache, duplicate-detection, content-hash, optimization
 */
export function setDenialInfo(sessionKey: string, contentHash: string, reason: string): void {
  const store = readStore();
  if (store[sessionKey]) {
    store[sessionKey].lastDeniedContentHash = contentHash;
    store[sessionKey].lastDeniedReason = reason;
    writeStore(store);
  }
}

/**
 * @what Removes a session entry (called on successful validation or invalid session)
 * @how Reads store, deletes the entry, writes back
 * @why Clean up after successful validation (no more retries needed) or when session is invalid
 *
 * @param {string} sessionKey Key in format {outerSessionId}:{filePath}
 * @returns {void}
 *
 * @sideeffects Reads and writes session store file
 * @systemlayer Data Layer
 * @domain session-cleanup, entry-removal
 * @tags session-store, delete, cleanup, post-success, persistence
 */
export function clearSession(sessionKey: string): void {
  const store = readStore();

  if (store[sessionKey]) {
    delete store[sessionKey];
    writeStore(store);
  }
}

/**
 * @what Removes all expired session entries from the store
 * @how Reads store, filters out entries older than SESSION_TTL_MS, writes back
 * @why Prevents unbounded growth of session store from abandoned sessions
 *
 * @returns {void}
 *
 * @sideeffects Reads and writes session store file
 * @systemlayer Data Layer
 * @domain session-cleanup, garbage-collection
 * @tags cleanup, expired-sessions, ttl-enforcement, garbage-collection, maintenance
 */
export function cleanExpiredSessions(): void {
  const store = readStore();
  const now = Date.now();
  let changed = false;

  for (const [key, entry] of Object.entries(store)) {
    const age = now - new Date(entry.createdAt).getTime();
    if (age > SESSION_TTL_MS) {
      delete store[key];
      changed = true;
    }
  }

  if (changed) {
    writeStore(store);
  }
}
