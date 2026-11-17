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

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @what Fully resolved Guardian configuration for one project: paths, scan settings, the tsconfig resolution and any guardian.config.json parse error
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
  /** Parse error for a guardian.config.json that exists but could not be read as JSON, else null */
  configFileError: string | null;
}

/**
 * @what Outcome of deciding which tsconfig applies to a project
 *
 * - `file`: an existing file, either the configured one or `<root>/tsconfig.json`
 * - `none`: nothing configured and no `<root>/tsconfig.json`
 * - `invalid`: configured but unusable; consumers must report the reason and never fall back to another file
 *
 * @domain config, call-graph
 * @tags tsconfig, guardian-config, discriminated-union, resolution
 */
export type TsconfigResolution =
  | { kind: 'file'; path: string }
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string };

/**
 * @what Shape of guardian.config.json as read from disk (all fields optional; `tsconfig` is typed unknown until validated)
 * @domain config
 * @tags guardian-config, config-file, json, user-settings
 */
interface GuardianConfigFile {
  /** Path to the tsconfig, relative to the project root. Typed unknown: it is validated, not trusted. */
  tsconfig?: unknown;
  sourceDirectories?: string[];
  docsDirectories?: string[];
  excludeDirectories?: string[];
  fileExtensions?: string[];
  jsdoc?: {
    requiredTags?: string[];
    minTags?: number;
    minCommentLength?: number;
  };
  searchHint?: {
    enabled?: boolean;
    rearmAfter?: number;
    stalenessThreshold?: number;
  };
}

// ─── Defaults ────────────────────────────────────────────────────────────────

// Folders left out of the index unless guardian.config.json sets its own excludeDirectories
// (which replaces this list). Common non-source folders plus Python virtualenvs and caches.
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

/**
 * @what Decides which tsconfig applies to a project: the configured one, the root one, none, or invalid
 * @how A `tsconfig` value in guardian.config.json must be a non-empty string naming an existing file (resolved against the project root); anything else configured is `invalid` with a reason. With nothing configured, `<root>/tsconfig.json` is used when it exists, else `none`.
 * @why The TypeScript app may live in a sub-folder with no tsconfig at the git root. A configured path that is wrong must be reported, never silently replaced by another file.
 *
 * @param {string} projectRoot Absolute project root
 * @param {unknown} configured The raw `tsconfig` value from guardian.config.json (undefined when absent)
 * @returns {TsconfigResolution} `file` with an absolute path, `none`, or `invalid` with a reason
 *
 * @sideeffects Reads the filesystem (existence checks only)
 * @systemlayer Configuration
 * @domain config, call-graph
 * @tags tsconfig, guardian-config, resolution, monorepo, validation
 */
function resolveTsconfig(projectRoot: string, configured: unknown): TsconfigResolution {
  if (configured !== undefined) {
    if (typeof configured !== 'string' || configured.trim() === '') {
      return {
        kind: 'invalid',
        reason: `"tsconfig" in guardian.config.json must be a non-empty string (got ${JSON.stringify(configured)})`,
      };
    }
    const configuredPath = path.resolve(projectRoot, configured);
    if (!fs.existsSync(configuredPath)) {
      return { kind: 'invalid', reason: `tsconfig "${configured}" from guardian.config.json does not exist` };
    }
    return { kind: 'file', path: configuredPath };
  }

  const rootPath = path.join(projectRoot, 'tsconfig.json');
  if (fs.existsSync(rootPath)) return { kind: 'file', path: rootPath };
  return { kind: 'none' };
}

/**
 * @what Auto-detects the source directories of a project, relative to the project root
 * @how Takes the first path segment of each `include` pattern in the given tsconfig, placed under that tsconfig's folder, and keeps those that exist. If that yields nothing, tries src/app/lib/packages under the same folder. If that also yields nothing, returns the tsconfig's folder itself, or '.' when the tsconfig is at the root or absent.
 * @why Only runs when guardian.config.json does not set sourceDirectories. Following the resolved tsconfig keeps one notion of "the project's tsconfig" shared with the call graph.
 *
 * @param {string} projectRoot Absolute project root
 * @param {string | null} tsconfigFile Absolute path of the resolved tsconfig, or null when there is none
 * @returns {string[]} Source directories relative to the project root ('/'-separated)
 *
 * @sideeffects Reads the tsconfig file and checks folder existence
 * @systemlayer Configuration
 * @domain config, code-index
 * @tags tsconfig, source-directories, auto-detection, monorepo
 */
function detectSourceDirectories(projectRoot: string, tsconfigFile: string | null): string[] {
  const base = tsconfigFile
    ? path.relative(projectRoot, path.dirname(tsconfigFile)).split(path.sep).join('/')
    : '';
  const underBase = (dir: string): string => (base ? `${base}/${dir}` : dir);
  const existsUnderBase = (dir: string): boolean => fs.existsSync(path.join(projectRoot, underBase(dir)));

  if (tsconfigFile) {
    try {
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigFile, 'utf-8'));
      if (tsconfig.include && Array.isArray(tsconfig.include)) {
        // Extract directory prefixes from include patterns like "src/**/*", "app/**/*"
        const dirs: string[] = tsconfig.include
          .map((pattern: string) => pattern.split('/')[0])
          .filter((dir: string) => !dir.startsWith('.') && dir !== '*' && dir !== '**')
          .filter((dir: string, i: number, arr: string[]) => arr.indexOf(dir) === i);

        const existing = dirs.filter(existsUnderBase).map(underBase);
        if (existing.length > 0) return existing;
      }
    } catch {
      // Invalid tsconfig — fall through
    }
  }

  // Fall back to common directory patterns
  const found = ['src', 'app', 'lib', 'packages'].filter(existsUnderBase).map(underBase);
  if (found.length > 0) return found;

  return [base || '.'];
}

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
 * @what Loads guardian.config.json from the project root, keeping the parse error when it cannot be read
 * @how Returns `{ file: null, error: null }` when the file is absent, the parsed object when it is valid JSON, and `{ file: null, error }` when reading or parsing throws
 * @why A config file that exists but is ignored must be reportable. Returning only null made a broken file indistinguishable from a missing one.
 *
 * @param {string} projectRoot Absolute project root
 * @returns {{ file: GuardianConfigFile | null; error: string | null }} Parsed config and the parse error, if any
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
    return { file: JSON.parse(fs.readFileSync(configPath, 'utf-8')), error: null };
  } catch (err) {
    return { file: null, error: err instanceof Error ? err.message : String(err) };
  }
}

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
 * @returns {GuardianConfig} Resolved config, including the tsconfig resolution and configFileError
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
 * @how Re-reads guardian.config.json (recording a parse error on the config), resolves the tsconfig (recording an invalid one with its reason), re-runs auto-detection for unset fields without re-detecting the root itself, then overwrites the cached config so later resolveConfig calls for that root see the fresh one
 * @why resolveConfig caches for the life of the process, which is right for the short-lived hook but wrong for the long-lived MCP server: a config file written after startup was ignored until the server restarted
 *
 * @param {string} projectRoot Absolute project root, as previously detected
 * @returns {GuardianConfig} The freshly built config
 *
 * @sideeffects Reads guardian.config.json, tsconfig.json and package.json; checks folder existence; mutates the module-level config cache
 * @systemlayer Configuration
 * @domain config, mcp-server
 * @tags guardian-config, cache, reload, staleness, mcp-server
 */
export function reloadConfig(projectRoot: string): GuardianConfig {
  const { file: configFile, error: configFileError } = loadConfigFile(projectRoot);

  const projectName = detectProjectName(projectRoot);

  const tsconfig = resolveTsconfig(projectRoot, configFile?.tsconfig);
  const tsconfigFile = tsconfig.kind === 'file' ? tsconfig.path : null;

  // Resolve paths
  const guardianHome = getGuardianHome();
  const projectHash = hashProjectRoot(projectRoot);

  // Per-project paths under guardian home (index + logs)
  const indexDir = path.join(guardianHome, 'indexes', projectHash);
  const logDir = path.join(guardianHome, 'logs', projectHash);

  const config: GuardianConfig = {
    projectRoot,
    projectName,

    sourceDirectories: configFile?.sourceDirectories ?? detectSourceDirectories(projectRoot, tsconfigFile),
    docsDirectories: configFile?.docsDirectories ?? detectDocsDirectories(projectRoot),
    excludeDirectories: configFile?.excludeDirectories ?? DEFAULT_EXCLUDE,
    fileExtensions: configFile?.fileExtensions ?? DEFAULT_EXTENSIONS,

    databasePath: path.join(indexDir, 'code-quality.db'),
    installPath: guardianHome,
    logPath: path.join(logDir, 'validation-debug.log'),
    suggestionsPath: path.join(projectRoot, '.guardian', 'suggestions.md'),

    jsdoc: {
      requiredTags: configFile?.jsdoc?.requiredTags ?? DEFAULT_JSDOC.requiredTags,
      minTags: configFile?.jsdoc?.minTags ?? DEFAULT_JSDOC.minTags,
      minCommentLength: configFile?.jsdoc?.minCommentLength ?? DEFAULT_JSDOC.minCommentLength,
    },
    searchHint: {
      enabled: configFile?.searchHint?.enabled ?? DEFAULT_SEARCH_HINT.enabled,
      rearmAfter: configFile?.searchHint?.rearmAfter ?? DEFAULT_SEARCH_HINT.rearmAfter,
      stalenessThreshold: configFile?.searchHint?.stalenessThreshold ?? DEFAULT_SEARCH_HINT.stalenessThreshold,
    },
    tsconfig,
    configFileError,
  };

  configCache.set(projectRoot, config);
  return config;
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
