/**
 * Central configuration resolver for Codebase Guardian.
 *
 * All paths are derived at runtime — zero hardcoded paths.
 * Resolution order:
 *   1. Environment variable overrides (GUARDIAN_PROJECT_ROOT, etc.)
 *   2. guardian.config.json at project root (optional per-project overrides)
 *   3. Auto-detection (git root, tsconfig.json, package.json)
 *   4. Sensible defaults
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { resolveTsconfig, detectSourceDirectories, type TsconfigResolution } from './tsconfig-resolution.js';
import { errorMessage } from './shared/util.js';
import {
  stringListField, objectField, countField, flagField, usableExcludes, dottedExtensions,
} from './config-validation.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @what Fully resolved Guardian configuration for one project: paths, scan settings, the tsconfig resolution, and what was wrong with guardian.config.json if anything (configFileError, configWarnings)
 * @domain config
 * @tags guardian-config, resolved-config, settings, tsconfig
 */
export interface GuardianConfig {
  /** Absolute path to the project root (git root or cwd) */
  projectRoot: string;
  /** Project name (from package.json or directory name) */
  projectName: string;
  /** Directories containing source files to index */
  sourceDirectories: string[];
  /** Directories containing documentation to index */
  docsDirectories: string[];
  /** Directories to exclude from scanning */
  excludeDirectories: string[];
  /** File extensions to scan (e.g., ['.ts', '.tsx']) */
  fileExtensions: string[];
  /** Absolute path to the SQLite database for this project */
  databasePath: string;
  /** Absolute path to the guardian install directory */
  installPath: string;
  /** Absolute path to the validation debug log */
  logPath: string;
  /** Absolute path to the suggestion log */
  suggestionsPath: string;
  /** JSDoc validation settings */
  jsdoc: {
    requiredTags: string[];
    minTags: number;
    minCommentLength: number;
  };
  /** Search-hint hook settings (nudge toward semantic search) */
  searchHint: {
    enabled: boolean;
    rearmAfter: number;
    stalenessThreshold: number;
  };
  /** Which tsconfig the TypeScript call graph and source-directory detection use */
  tsconfig: TsconfigResolution;
  /** Why a guardian.config.json that exists was not used at all (not JSON, or not a JSON object), else null */
  configFileError: string | null;
  /** One sentence per config field that was ignored because its value has the wrong shape */
  configWarnings: string[];
}

// Tsconfig resolution and source-directory detection live in ./tsconfig-resolution.ts.
export type { TsconfigResolution } from './tsconfig-resolution.js';

/**
 * @what Shape of guardian.config.json as read from disk: every field is optional and typed unknown, because the file is user-written and each value is validated before use
 * @domain config
 * @tags guardian-config, config-file, json, user-settings
 */
interface GuardianConfigFile {
  /** Path to the tsconfig, relative to the project root */
  tsconfig?: unknown;
  /** Each must be a list of strings (stringListField) */
  sourceDirectories?: unknown;
  docsDirectories?: unknown;
  excludeDirectories?: unknown;
  fileExtensions?: unknown;
  /** An object with requiredTags (list of strings), minTags and minCommentLength (numbers) */
  jsdoc?: unknown;
  /** An object with enabled (boolean), rearmAfter and stalenessThreshold (numbers) */
  searchHint?: unknown;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

// Folders always left out of the index: common non-source folders plus Python virtualenvs and
// caches. excludeDirectories in guardian.config.json adds to this list; it cannot remove from it.
export const DEFAULT_EXCLUDE = [
  'node_modules', 'dist', '.claude', 'cdk.out', 'build', '__snapshots__', '.next', '.turbo', 'coverage',
  '.venv', '__pycache__', '.pytest_cache', 'site-packages', '.mypy_cache', '.ruff_cache',
];

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.py'];

const DEFAULT_JSDOC = {
  requiredTags: ['what', 'how', 'why', 'sideeffects', 'systemlayer', 'domain', 'tags'],
  minTags: 3,
  minCommentLength: 5,
};

// Search-hint hook defaults: nudge once, re-arm after 10 unheeded grep searches, and flag the
// index as stale once 15+ files have changed since the last build.
const DEFAULT_SEARCH_HINT = {
  enabled: true,
  rearmAfter: 10,
  stalenessThreshold: 15,
};

// ─── Guardian Home ───────────────────────────────────────────────────────────

/**
 * Returns the guardian install directory (~/.codebase-guardian/).
 * Creates it if it doesn't exist.
 */
export function getGuardianHome(): string {
  // Explicit override wins; then the plugin's persistent data dir when running
  // as a Claude Code plugin (indexes/logs live there, cleaned up on uninstall);
  // else the legacy standalone location.
  const home = process.env.GUARDIAN_HOME
    || process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.codebase-guardian');
  return home;
}

// ─── Project Root Detection ──────────────────────────────────────────────────

/**
 * Detects the project root directory.
 * Priority: GUARDIAN_PROJECT_ROOT env var > git root > cwd
 */
export function detectProjectRoot(fromPath?: string): string {
  // 1. Explicit override
  if (process.env.GUARDIAN_PROJECT_ROOT) {
    return process.env.GUARDIAN_PROJECT_ROOT;
  }

  // 2. Git root detection
  try {
    const cwd = fromPath || process.cwd();
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (gitRoot) return gitRoot;
  } catch {
    // Not a git repo — fall through
  }

  // 3. Fallback to cwd
  return fromPath || process.cwd();
}

/**
 * Derives the project root from a file path by walking up to find .git/.
 * Used by hooks that receive an absolute file path from tool_input.
 */
export function detectProjectRootFromFile(filePath: string): string {
  let dir = path.dirname(filePath);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return detectProjectRoot();
}

// ─── Project Hash ────────────────────────────────────────────────────────────

/**
 * Creates a stable, short hash of the project root for use as a directory name.
 * Example: /Users/austin/Git/my-project → "a3f2b1c8"
 */
export function hashProjectRoot(projectRoot: string): string {
  return crypto.createHash('sha256').update(projectRoot).digest('hex').slice(0, 12);
}

// ─── Source Directory Detection ──────────────────────────────────────────────

// (resolveTsconfig and detectSourceDirectories: see ./tsconfig-resolution.ts)

/**
 * Auto-detects documentation directories.
 */
function detectDocsDirectories(projectRoot: string): string[] {
  const candidates = ['docs', 'doc', 'documentation'];
  const found = candidates.filter(dir =>
    fs.existsSync(path.join(projectRoot, dir))
  );
  return found;
}

/**
 * Reads the project name from package.json, falling back to directory name.
 */
function detectProjectName(projectRoot: string): string {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.name) {
        // Strip scope prefix (@org/name → name)
        return pkg.name.replace(/^@[^/]+\//, '');
      }
    } catch {
      // Invalid package.json
    }
  }
  return path.basename(projectRoot);
}

// ─── Config File Loading ─────────────────────────────────────────────────────

/**
 * @what Loads guardian.config.json from the project root, keeping the reason when it cannot be used
 * @how Returns `{ file: null, error: null }` when the file is absent, the parsed object when it is a JSON object, and `{ file: null, error }` when reading or parsing throws or the JSON is not an object (a list, null, a string, a number)
 * @why A config file that exists but is ignored must be reportable. Returning only null made a broken file indistinguishable from a missing one.
 *
 * @param {string} projectRoot Absolute project root
 * @returns {{ file: GuardianConfigFile | null; error: string | null }} Parsed config and the reason it was not used, if any
 *
 * @sideeffects Reads guardian.config.json from disk
 * @systemlayer Configuration
 * @domain config
 * @tags guardian-config, json, parse-error, fail-open
 */
function loadConfigFile(projectRoot: string): { file: GuardianConfigFile | null; error: string | null } {
  const configPath = path.join(projectRoot, 'guardian.config.json');
  if (!fs.existsSync(configPath)) return { file: null, error: null };

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { file: null, error: 'the file must contain a JSON object' };
    }
    return { file: parsed as GuardianConfigFile, error: null };
  } catch (err) {
    return { file: null, error: errorMessage(err) };
  }
}

// Field validators (stringListField, objectField, countField, flagField, usableExcludes,
// dottedExtensions) live in ./config-validation.ts.

// ─── Config Cache ────────────────────────────────────────────────────────────

// Cache resolved configs by project root to avoid repeated git rev-parse calls.
// A single hook invocation imports multiple modules that each call resolveConfig()
// at module load time — without caching, each call spawns a subprocess.
const configCache = new Map<string, GuardianConfig>();

// ─── Main Resolver ───────────────────────────────────────────────────────────

/**
 * @what Resolves the GuardianConfig for the project containing fromPath, cached per project root
 * @how Detects the project root (file-path walk-up, or GUARDIAN_PROJECT_ROOT / git / cwd), returns the cached config for that root, or builds it with reloadConfig on a cache miss
 * @why The hook calls this from many module-level initializers; caching avoids a git subprocess per call. Long-lived callers that must see config changes use reloadConfig instead.
 *
 * @param {string} [fromPath] Optional path to resolve from (file path or directory).
 *   If a file path, walks up to find the project root.
 *   If omitted, uses GUARDIAN_PROJECT_ROOT or git root or cwd.
 * @returns {GuardianConfig} Resolved config, including the tsconfig resolution, configFileError and configWarnings
 *
 * @sideeffects Spawns git rev-parse during root detection; on a cache miss reads config files and fills the module-level config cache (via reloadConfig)
 * @systemlayer Configuration
 * @domain config
 * @tags guardian-config, cache, project-root, resolution, auto-detection
 */
export function resolveConfig(fromPath?: string): GuardianConfig {
  // Detect project root.
  // Use detectProjectRootFromFile when the path looks like a file (has an extension).
  // The file itself doesn't need to exist — the function walks up parent directories
  // looking for .git/. This handles new files being created by Write operations.
  let projectRoot: string;
  if (fromPath && path.extname(fromPath) !== '') {
    projectRoot = detectProjectRootFromFile(fromPath);
  } else if (fromPath && fs.existsSync(fromPath) && fs.statSync(fromPath).isFile()) {
    projectRoot = detectProjectRootFromFile(fromPath);
  } else {
    projectRoot = detectProjectRoot(fromPath);
  }

  // Return cached config if available for this project root
  const cached = configCache.get(projectRoot);
  if (cached) return cached;

  return reloadConfig(projectRoot);
}

/**
 * @what Rebuilds the GuardianConfig for a known project root from disk and replaces its cache entry
 * @how Re-reads guardian.config.json (recording on the config why the file was unusable, if it was), resolves the tsconfig (recording an invalid one with its reason), and validates every other field: the four list fields, each exclude entry, each file extension, and the jsdoc and searchHint groups. A value with the wrong shape is never used: its default (or auto-detection) applies and a warning sentence is recorded on the config. It never throws on bad input, because the hook builds its config through this function. Auto-detection runs for unset or ignored fields without re-detecting the root itself, and the cached config is overwritten so later resolveConfig calls for that root see the fresh one. excludeDirectories is the one list field that does not replace its default: the config's entries are added to DEFAULT_EXCLUDE (duplicates dropped), so the defaults always apply.
 * @why resolveConfig caches for the life of the process, which is right for the short-lived hook but wrong for the long-lived MCP server: a config file written after startup was ignored until the server restarted. Excludes are additive because nothing on the default list is something a project wants indexed, and a config that listed only its own folders would otherwise start indexing virtualenvs and Claude worktrees.
 *
 * @param {string} projectRoot Absolute project root, as previously detected
 * @returns {GuardianConfig} The freshly built config, carrying configFileError, configWarnings and the tsconfig resolution
 *
 * @sideeffects Reads guardian.config.json, tsconfig.json and package.json; checks folder existence; mutates the module-level config cache
 * @systemlayer Configuration
 * @domain config, mcp-server
 * @tags guardian-config, cache, reload, staleness, validation, mcp-server
 */
export function reloadConfig(projectRoot: string): GuardianConfig {
  const { file: configFile, error: configFileError } = loadConfigFile(projectRoot);

  const projectName = detectProjectName(projectRoot);

  const tsconfig: TsconfigResolution = resolveTsconfig(projectRoot, configFile?.tsconfig);
  const tsconfigFile = tsconfig.kind === 'file' ? tsconfig.path : null;

  const configWarnings: string[] = [];
  const sourceDirectories = stringListField(configFile?.sourceDirectories, 'sourceDirectories', configWarnings);
  const docsDirectories = stringListField(configFile?.docsDirectories, 'docsDirectories', configWarnings);
  const excludeList = stringListField(configFile?.excludeDirectories, 'excludeDirectories', configWarnings);
  const extraExcludes = excludeList ? usableExcludes(excludeList, configWarnings) : [];
  const extensionList = stringListField(configFile?.fileExtensions, 'fileExtensions', configWarnings);
  const fileExtensions = extensionList ? dottedExtensions(extensionList, configWarnings) : undefined;

  const jsdoc = objectField(configFile?.jsdoc, 'jsdoc', configWarnings);
  const requiredTags = stringListField(jsdoc?.requiredTags, 'jsdoc.requiredTags', configWarnings);
  const minTags = countField(jsdoc?.minTags, 'jsdoc.minTags', configWarnings);
  const minCommentLength = countField(jsdoc?.minCommentLength, 'jsdoc.minCommentLength', configWarnings);

  const searchHint = objectField(configFile?.searchHint, 'searchHint', configWarnings);
  const hintEnabled = flagField(searchHint?.enabled, 'searchHint.enabled', configWarnings);
  const rearmAfter = countField(searchHint?.rearmAfter, 'searchHint.rearmAfter', configWarnings);
  const stalenessThreshold = countField(searchHint?.stalenessThreshold, 'searchHint.stalenessThreshold', configWarnings);

  // Resolve paths
  const guardianHome = getGuardianHome();
  const projectHash = hashProjectRoot(projectRoot);

  // Per-project paths under guardian home (index + logs)
  const indexDir = path.join(guardianHome, 'indexes', projectHash);
  const logDir = path.join(guardianHome, 'logs', projectHash);

  const config: GuardianConfig = {
    projectRoot,
    projectName,

    sourceDirectories: sourceDirectories ?? detectSourceDirectories(projectRoot, tsconfigFile),
    docsDirectories: docsDirectories ?? detectDocsDirectories(projectRoot),
    // Added to the defaults, never replacing them (a Set keeps first occurrences, in order).
    excludeDirectories: [...new Set([...DEFAULT_EXCLUDE, ...extraExcludes])],
    fileExtensions: fileExtensions ?? DEFAULT_EXTENSIONS,

    databasePath: path.join(indexDir, 'code-quality.db'),
    installPath: guardianHome,
    logPath: path.join(logDir, 'validation-debug.log'),
    suggestionsPath: path.join(projectRoot, '.guardian', 'suggestions.md'),

    jsdoc: {
      requiredTags: requiredTags ?? DEFAULT_JSDOC.requiredTags,
      minTags: minTags ?? DEFAULT_JSDOC.minTags,
      minCommentLength: minCommentLength ?? DEFAULT_JSDOC.minCommentLength,
    },
    searchHint: {
      enabled: hintEnabled ?? DEFAULT_SEARCH_HINT.enabled,
      rearmAfter: rearmAfter ?? DEFAULT_SEARCH_HINT.rearmAfter,
      stalenessThreshold: stalenessThreshold ?? DEFAULT_SEARCH_HINT.stalenessThreshold,
    },
    tsconfig,
    configFileError,
    configWarnings,
  };

  configCache.set(projectRoot, config);
  return config;
}

/**
 * @what Lists the definite errors in a project's configuration, as sentences for a report
 * @how In order: guardian.config.json being unusable (not JSON, or not an object), each field that was ignored for having the wrong shape, and a configured tsconfig that is invalid. An empty list means the configuration is sound.
 * @why A rebuild must not start from a configuration it knows is broken: it would clear a good index and replace it with one built from defaults nobody asked for. The rebuild pipeline checks this list before touching anything. The hook does not use it; it keeps working from the defaults that reloadConfig substituted.
 *
 * @param {GuardianConfig} config A resolved config
 * @returns {string[]} One sentence per problem; empty when there are none
 *
 * @sideeffects None
 * @systemlayer Configuration
 * @domain config, index-rebuild
 * @tags guardian-config, validation, config-problems, preflight, pure
 */
export function configProblems(config: GuardianConfig): string[] {
  const problems: string[] = [];
  if (config.configFileError) {
    problems.push(`guardian.config.json could not be used: ${config.configFileError}`);
  }
  problems.push(...config.configWarnings);
  if (config.tsconfig.kind === 'invalid') {
    problems.push(config.tsconfig.reason);
  }
  return problems;
}

/**
 * Ensures all required directories exist for a resolved config.
 * Call this during install or first-time setup.
 */
export function ensureDirectories(config: GuardianConfig): void {
  const dirs = [
    path.dirname(config.databasePath),
    path.dirname(config.logPath),
    path.dirname(config.suggestionsPath),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Registers this project in the global projects.json manifest.
 * Used for discoverability — lists all projects Guardian has indexed.
 */
export function registerProject(config: GuardianConfig): void {
  const manifestPath = path.join(getGuardianHome(), 'projects.json');
  let manifest: Record<string, { name: string; root: string; lastSeen: string }> = {};

  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      manifest = {};
    }
  }

  const projectHash = hashProjectRoot(config.projectRoot);
  manifest[projectHash] = {
    name: config.projectName,
    root: config.projectRoot,
    lastSeen: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}
