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
}

/** Shape of guardian.config.json (all fields optional) */
interface GuardianConfigFile {
  sourceDirectories?: string[];
  docsDirectories?: string[];
  excludeDirectories?: string[];
  fileExtensions?: string[];
  jsdoc?: {
    requiredTags?: string[];
    minTags?: number;
    minCommentLength?: number;
  };
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_EXCLUDE = [
  'node_modules', 'dist', '.claude', 'cdk.out', 'build',
  '__snapshots__', '.next', '.turbo', 'coverage',
];

const DEFAULT_EXTENSIONS = ['.ts', '.tsx'];

const DEFAULT_JSDOC = {
  requiredTags: ['what', 'how', 'why', 'sideeffects', 'systemlayer', 'domain', 'tags'],
  minTags: 3,
  minCommentLength: 5,
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
 * Auto-detects source directories for a project.
 * Checks tsconfig.json includes, then falls back to common patterns.
 */
function detectSourceDirectories(projectRoot: string): string[] {
  // Try tsconfig.json includes
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  if (fs.existsSync(tsconfigPath)) {
    try {
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
      if (tsconfig.include && Array.isArray(tsconfig.include)) {
        // Extract directory prefixes from include patterns like "src/**/*", "app/**/*"
        const dirs = tsconfig.include
          .map((pattern: string) => pattern.split('/')[0])
          .filter((dir: string) => !dir.startsWith('.') && dir !== '*' && dir !== '**')
          .filter((dir: string, i: number, arr: string[]) => arr.indexOf(dir) === i);

        if (dirs.length > 0) {
          // Verify directories actually exist
          const existing = dirs.filter((dir: string) =>
            fs.existsSync(path.join(projectRoot, dir))
          );
          if (existing.length > 0) return existing;
        }
      }
    } catch {
      // Invalid tsconfig — fall through
    }
  }

  // Fall back to common directory patterns
  const candidates = ['src', 'app', 'lib', 'packages'];
  const found = candidates.filter(dir =>
    fs.existsSync(path.join(projectRoot, dir))
  );

  return found.length > 0 ? found : ['.'];
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
 * Loads guardian.config.json from the project root if it exists.
 */
function loadConfigFile(projectRoot: string): GuardianConfigFile | null {
  const configPath = path.join(projectRoot, 'guardian.config.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ─── Config Cache ────────────────────────────────────────────────────────────

// Cache resolved configs by project root to avoid repeated git rev-parse calls.
// A single hook invocation imports multiple modules that each call resolveConfig()
// at module load time — without caching, each call spawns a subprocess.
const configCache = new Map<string, GuardianConfig>();

// ─── Main Resolver ───────────────────────────────────────────────────────────

/**
 * Resolves the full GuardianConfig for a project.
 *
 * Results are cached by resolved project root, so repeated calls
 * (e.g., from multiple module-level initializations) are free after the first.
 *
 * @param fromPath Optional path to resolve from (file path or directory).
 *   If a file path, walks up to find the project root.
 *   If omitted, uses GUARDIAN_PROJECT_ROOT or git root or cwd.
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

  // Load optional config file
  const configFile = loadConfigFile(projectRoot);

  // Detect project name
  const projectName = detectProjectName(projectRoot);

  // Resolve paths
  const guardianHome = getGuardianHome();
  const projectHash = hashProjectRoot(projectRoot);

  // Per-project paths under guardian home (index + logs)
  const indexDir = path.join(guardianHome, 'indexes', projectHash);
  const logDir = path.join(guardianHome, 'logs', projectHash);

  const config: GuardianConfig = {
    projectRoot,
    projectName,

    sourceDirectories: configFile?.sourceDirectories ?? detectSourceDirectories(projectRoot),
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
