import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { Project, SyntaxKind, ts, type Node } from 'ts-morph';
import {
  insertFunction,
  insertCallEdge,
  getFunctionByName,
} from './db.js';
import { generateEmbeddings } from './embeddings.js';
import { resolveConfig, type GuardianConfig } from '../config.js';
import { listIndexFiles, type IndexFileSet } from './file-walk.js';
import { parseJsonc } from '../tsconfig-resolution.js';
import { errorMessage, toPosixRelative } from '../shared/util.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DiscoveredExport {
  name: string;
  filePath: string;
  lineNumber: number;
  declarationType: string;
  body: string;
}

interface CallEdgeRaw {
  callerName: string;
  callerFile: string;
  calleeName: string;
  calleeFile: string;
  edgeType: 'calls' | 'imports';
}

/**
 * @what Outcome of the TypeScript call-graph phase
 * @domain call-graph, index-rebuild
 * @tags call-graph, tier-2, phase-status, degraded
 */
export interface CallGraphResult {
  /** Tier 2 rows inserted (exports not already indexed as Tier 1) */
  exportsDiscovered: number;
  /** call_edges rows inserted */
  edgesCreated: number;
  /** `degraded` when the graph was built without the project's full compiler settings (no tsconfig, one that loaded with errors, or a solution-style one), so calls through path aliases may have no edge */
  status: 'ok' | 'degraded';
  /** Why the status is degraded, or why nothing was built; null otherwise */
  note: string | null;
}

// ─── Project Loading ────────────────────────────────────────────────────────

/**
 * @what Picks the TypeScript files out of the index's file list
 * @how Keeps the code files ending in .ts or .tsx
 * @why The call graph must read exactly the files the indexer read. Globbing the source directories separately loaded node_modules and build output that the indexer skips, and ignored excludeDirectories.
 *
 * @param {IndexFileSet} files The file list the rebuild computed
 * @returns {string[]} Absolute paths of the TypeScript files in the index
 *
 * @sideeffects None
 * @systemlayer Utility
 * @domain call-graph, file-walk
 * @tags typescript, source-files, file-list, pure
 */
function typeScriptFilesOf(files: IndexFileSet): string[] {
  return files.codeFiles.filter(file => file.endsWith('.ts') || file.endsWith('.tsx'));
}

/**
 * @what Creates an empty ts-morph project with the project's compiler settings
 * @how Uses the resolved tsconfig's compiler options when there is one (so path aliases resolve) and compiler defaults when there is none. A tsconfig that ts-morph cannot load is rethrown with the file named, relative to the project root, keeping the original error as the cause.
 * @why The tsconfig may sit in a sub-folder or be absent; hard-coding <root>/tsconfig.json made ts-morph throw and aborted the whole rebuild. ts-morph's own message for a malformed tsconfig ("',' expected.") does not say which file is wrong.
 *
 * @param {GuardianConfig} config Resolved project config; config.tsconfig must not be `invalid` (callers reject that first)
 * @returns {Project} A project with no source files yet
 * @throws {Error} `could not load tsconfig "<path>": <reason>` when the tsconfig exists but cannot be loaded
 *
 * @sideeffects Reads the tsconfig (and anything it extends) from disk
 * @systemlayer Data Layer
 * @domain call-graph
 * @tags ts-morph, tsconfig, path-aliases, compiler-defaults, project-loading
 */
function createProject(config: GuardianConfig): Project {
  const shared = { skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true };
  if (config.tsconfig.kind !== 'file') return new Project(shared);
  try {
    return new Project({ tsConfigFilePath: config.tsconfig.path, ...shared });
  } catch (err) {
    const shown = toPosixRelative(config.projectRoot, config.tsconfig.path);
    throw new Error(`could not load tsconfig "${shown}": ${errorMessage(err)}`, { cause: err });
  }
}

/**
 * @what Says why the project's tsconfig cannot be loaded, or null when it can (or there is none)
 * @how Tries createProject and returns the message of what it throws
 * @why The rebuild checks this before clearing the old index: a tsconfig that cannot be loaded is a configuration error, and finding it out after the index is wiped would replace a good index with one that has no TypeScript call graph
 *
 * @param {GuardianConfig} config Resolved project config
 * @returns {string | null} `could not load tsconfig "<path>": <reason>`, or null
 *
 * @sideeffects Reads the tsconfig from disk
 * @systemlayer Data Layer
 * @domain call-graph, index-rebuild
 * @tags tsconfig, preflight, validation, ts-morph
 */
export function checkTsconfigLoads(config: GuardianConfig): string | null {
  try {
    createProject(config);
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

/**
 * @what Creates the ts-morph project the call graph is extracted from
 * @how createProject for the compiler settings, then adds each listed file by exact path. Files are added one by one, not by glob, because route files are often named with glob characters such as [id].ts.
 * @why One project holds every indexed TypeScript file, so definitions resolve across files
 *
 * @param {GuardianConfig} config Resolved project config; config.tsconfig must not be `invalid` (the caller rejects that first)
 * @param {string[]} files Absolute paths of the TypeScript files to load
 * @returns {Project} A project holding exactly those files
 * @throws {Error} `could not load tsconfig "<path>": <reason>` when the tsconfig exists but cannot be loaded
 *
 * @sideeffects Reads the tsconfig and the source files from disk
 * @systemlayer Data Layer
 * @domain call-graph
 * @tags ts-morph, tsconfig, source-files, project-loading
 */
function loadProject(config: GuardianConfig, files: string[]): Project {
  const project = createProject(config);
  for (const file of files) {
    project.addSourceFileAtPathIfExists(file);
  }
  return project;
}

/**
 * @what Lists the ways the call graph was built from less than the project's full compiler settings
 * @how Three checks. No tsconfig at all: compiler defaults were used. A tsconfig that loaded with errors (for example an `extends` target that is missing): the first error is quoted. A solution-style tsconfig, one with `references` and no `paths` of its own: the settings in the referenced files were not loaded. Each returns one sentence; an empty list means the settings are complete as far as can be told.
 * @why In all three cases imports through path aliases may not resolve. An unresolvable alias import comes back as its own import specifier in the calling file, so the callee lookup finds no row and the edge is missing, not guessed from the function name. The graph still gets built, so the phase must say it is incomplete instead of reading ok.
 *
 * @param {Project} project The loaded project
 * @param {GuardianConfig} config Resolved project config
 * @returns {string[]} One sentence per limitation; empty when there are none
 *
 * @sideeffects Reads the tsconfig file again (to look for `references`)
 * @systemlayer Business Logic
 * @domain call-graph, index-rebuild
 * @tags tsconfig, degraded, path-aliases, solution-style, diagnostics
 */
function tsconfigLimitations(project: Project, config: GuardianConfig): string[] {
  if (config.tsconfig.kind !== 'file') {
    return [
      `no tsconfig found at ${path.join(config.projectRoot, 'tsconfig.json')} and none configured; ` +
      'built with compiler defaults, so calls through path aliases are not linked (those call edges are missing). ' +
      'Set "tsconfig" in guardian.config.json.',
    ];
  }

  const shown = toPosixRelative(config.projectRoot, config.tsconfig.path);
  const limitations: string[] = [];

  const firstError = project.getConfigFileParsingDiagnostics()
    .find(diagnostic => diagnostic.getCategory() === ts.DiagnosticCategory.Error);
  if (firstError) {
    const message = ts.flattenDiagnosticMessageText(firstError.compilerObject.messageText, ' ');
    limitations.push(`tsconfig "${shown}" was loaded with errors, so settings from it may be missing: ${message}`);
  }

  let references: unknown;
  try {
    references = (parseJsonc(fs.readFileSync(config.tsconfig.path, 'utf-8')) as { references?: unknown } | null)?.references;
  } catch {
    references = undefined; // The compiler already loaded the file; an unreadable copy here changes nothing.
  }
  if (Array.isArray(references) && references.length > 0 && project.getCompilerOptions().paths === undefined) {
    limitations.push(
      `tsconfig "${shown}" is solution-style (it has "references" and no "paths" of its own); settings in the files it ` +
      'references are not loaded, so calls through path aliases may have no edge. ' +
      'Point "tsconfig" at the referenced file that holds them (for example tsconfig.app.json).',
    );
  }

  return limitations;
}

// ─── Export Discovery (Tier 2) ──────────────────────────────────────────────

/**
 * @what Finds the exported functions in the loaded project: function declarations and const arrow / function expressions
 * @how For each source file (except those the path filter below drops) collects exported function declarations and exported variable declarations whose initializer is an arrow function, a function expression or a createAsyncThunk call, once per (file, name), with the first 1000 characters of the declaration as body text
 * @why These become Tier 2 rows: exports with no documentation block of their own that still need to be searchable and to serve as call-graph endpoints
 *
 * @param {Project} project The loaded ts-morph project
 * @param {string} repoRoot Absolute project root; returned file paths are relative to it
 * @returns {DiscoveredExport[]} One entry per exported function found
 *
 * @sideeffects None (reads the already-loaded syntax trees)
 * @systemlayer Business Logic
 * @domain call-graph, code-index
 * @tags tier-2, exports, ts-morph, discovery
 */
function discoverExports(project: Project, repoRoot: string): DiscoveredExport[] {
  const exports: DiscoveredExport[] = [];
  const seen = new Set<string>();

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = path.relative(repoRoot, sourceFile.getFilePath());

    // Skip test files, node_modules, etc. This filter predates the shared file list, which already
    // leaves out node_modules and *.test.ts(x). It is kept on purpose: it also drops any path
    // containing "__" (__mocks__, __tests__, …) from Tier 2 only, and removing it would add Tier 2
    // rows to every existing index that has such folders. To leave a folder out of the whole
    // index, name it in excludeDirectories.
    if (filePath.includes('node_modules') || filePath.includes('.test.') || filePath.includes('__')) {
      continue;
    }

    // Find exported function declarations
    for (const funcDecl of sourceFile.getFunctions()) {
      if (!funcDecl.isExported()) continue;
      const name = funcDecl.getName();
      if (!name) continue;

      const key = `${filePath}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      exports.push({
        name,
        filePath,
        lineNumber: funcDecl.getStartLineNumber(),
        declarationType: 'function',
        body: funcDecl.getText().slice(0, 1000),
      });
    }

    // Find exported const/let arrow functions
    for (const varStatement of sourceFile.getVariableStatements()) {
      if (!varStatement.isExported()) continue;

      for (const decl of varStatement.getDeclarations()) {
        const name = decl.getName();
        const initializer = decl.getInitializer();
        if (!initializer) continue;

        // Check if it's an arrow function or function expression
        const isArrowOrFunc =
          initializer.getKind() === SyntaxKind.ArrowFunction ||
          initializer.getKind() === SyntaxKind.FunctionExpression ||
          (initializer.getKind() === SyntaxKind.CallExpression &&
           initializer.getText().includes('createAsyncThunk'));

        if (!isArrowOrFunc) continue;

        const key = `${filePath}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);

        exports.push({
          name,
          filePath,
          lineNumber: decl.getStartLineNumber(),
          declarationType: 'const',
          body: decl.getText().slice(0, 1000),
        });
      }
    }
  }

  return exports;
}

// ─── Call Graph Extraction ──────────────────────────────────────────────────

function extractCallEdges(project: Project, repoRoot: string): CallEdgeRaw[] {
  const edges: CallEdgeRaw[] = [];
  const seen = new Set<string>();

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = path.relative(repoRoot, sourceFile.getFilePath());

    if (filePath.includes('node_modules') || filePath.includes('.test.')) continue;

    // Process call expressions
    sourceFile.forEachDescendant((node: Node) => {
      if (node.getKind() === SyntaxKind.CallExpression) {
        const callExpr = node.asKind(SyntaxKind.CallExpression);
        if (!callExpr) return;

        const callerFunc = findEnclosingFunction(node);
        if (!callerFunc) return;

        const callerName = callerFunc.name;
        const callerFile = filePath;

        // Try to resolve the called function
        const expression = callExpr.getExpression();
        let calleeName: string | undefined;
        let calleeFile: string | undefined;

        if (expression.getKind() === SyntaxKind.Identifier) {
          const identifier = expression.asKind(SyntaxKind.Identifier);
          if (identifier) {
            calleeName = identifier.getText();
            // Try to resolve to source
            try {
              const defs = identifier.getDefinitionNodes();
              if (defs.length > 0) {
                const defFile = defs[0].getSourceFile().getFilePath();
                const relDefFile = path.relative(repoRoot, defFile);
                if (!relDefFile.startsWith('node_modules')) {
                  calleeFile = relDefFile;
                }
              }
            } catch {
              // Symbol resolution can fail; skip
            }
          }
        } else if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
          const propAccess = expression.asKind(SyntaxKind.PropertyAccessExpression);
          if (propAccess) {
            calleeName = propAccess.getName();
          }
        }

        if (calleeName && callerName) {
          const edgeKey = `${callerFile}:${callerName}->${calleeFile || '?'}:${calleeName}`;
          if (!seen.has(edgeKey)) {
            seen.add(edgeKey);
            edges.push({
              callerName,
              callerFile,
              calleeName,
              calleeFile: calleeFile || '',
              edgeType: 'calls',
            });
          }
        }
      }

      // JSX elements as component usage
      if (node.getKind() === SyntaxKind.JsxOpeningElement || node.getKind() === SyntaxKind.JsxSelfClosingElement) {
        const callerFunc = findEnclosingFunction(node);
        if (!callerFunc) return;

        const tagName = node.getKind() === SyntaxKind.JsxOpeningElement
          ? node.asKind(SyntaxKind.JsxOpeningElement)?.getTagNameNode().getText()
          : node.asKind(SyntaxKind.JsxSelfClosingElement)?.getTagNameNode().getText();

        if (tagName && /^[A-Z]/.test(tagName)) {
          const edgeKey = `${filePath}:${callerFunc.name}->jsx:${tagName}`;
          if (!seen.has(edgeKey)) {
            seen.add(edgeKey);
            edges.push({
              callerName: callerFunc.name,
              callerFile: filePath,
              calleeName: tagName,
              calleeFile: '',
              edgeType: 'calls',
            });
          }
        }
      }
    });
  }

  return edges;
}

function findEnclosingFunction(node: Node): { name: string; filePath: string } | null {
  let current: Node | undefined = node.getParent();

  while (current) {
    if (current.getKind() === SyntaxKind.FunctionDeclaration) {
      const funcDecl = current.asKind(SyntaxKind.FunctionDeclaration);
      const name = funcDecl?.getName();
      if (name) {
        return { name, filePath: current.getSourceFile().getFilePath() };
      }
    }

    if (current.getKind() === SyntaxKind.VariableDeclaration) {
      const varDecl = current.asKind(SyntaxKind.VariableDeclaration);
      if (varDecl) {
        const init = varDecl.getInitializer();
        if (init && (init.getKind() === SyntaxKind.ArrowFunction || init.getKind() === SyntaxKind.FunctionExpression)) {
          return { name: varDecl.getName(), filePath: current.getSourceFile().getFilePath() };
        }
      }
    }

    current = current.getParent();
  }

  return null;
}

// ─── Build Call Graph ───────────────────────────────────────────────────────

/**
 * @what Builds the TypeScript half of the index's call graph: Tier 2 rows for undocumented exports, and call edges
 * @how Refuses a config from another project root and an invalid tsconfig outright. Takes the TypeScript files from the file list it is given (opts.files), or computes the list, and returns early when there are none. Otherwise loads them into a ts-morph project (loadProject), inserts the Tier 2 rows (insertTier2Exports) and the call edges (insertCallEdges). The result is marked degraded, with every reason from tsconfigLimitations, when the graph was built without the project's full compiler settings: no tsconfig, a tsconfig that loaded with errors, or a solution-style one.
 * @why Phase 2 of the rebuild. callers/callees/impact and the hook's caller context read these rows.
 *
 * @param {Database.Database} db Open index database, already populated by buildIndex
 * @param {string} repoRoot Absolute project root; stored file paths are relative to it. Must equal the config's projectRoot.
 * @param {{config?: GuardianConfig, files?: IndexFileSet}} [opts] config: an already-resolved (fresh) project config, defaulting to resolveConfig(repoRoot). files: the file list the rebuild already computed, so this phase reads exactly what the index phase read.
 * @returns {Promise<CallGraphResult>} Counts plus a status and note for the rebuild report
 * @throws {Error} When repoRoot and the config's project root differ; when the configured tsconfig is invalid (the reason is the message; there is no fallback to another file); when the tsconfig cannot be loaded
 *
 * @sideeffects Reads the tsconfig and source files; inserts functions, embeddings and call_edges rows; loads the embedding model; logs progress to stderr
 * @systemlayer Data Layer
 * @domain call-graph, code-index
 * @tags call-graph, tier-2, ts-morph, tsconfig, exports, call-edges, index-rebuild
 */
export async function buildCallGraph(
  db: Database.Database,
  repoRoot: string,
  opts?: { config?: GuardianConfig; files?: IndexFileSet },
): Promise<CallGraphResult> {
  const config = opts?.config ?? resolveConfig(repoRoot);
  // Files are listed from the config's root and stored relative to repoRoot; they must be the same place.
  if (path.resolve(repoRoot) !== path.resolve(config.projectRoot)) {
    throw new Error(
      `buildCallGraph: repoRoot (${repoRoot}) does not match the config's project root (${config.projectRoot})`,
    );
  }
  if (config.tsconfig.kind === 'invalid') {
    throw new Error(config.tsconfig.reason);
  }

  const files = typeScriptFilesOf(opts?.files ?? listIndexFiles(config));
  if (files.length === 0) {
    console.error('  No TypeScript files in the source directories, skipping TypeScript call graph');
    return { exportsDiscovered: 0, edgesCreated: 0, status: 'ok', note: 'no TypeScript files in the source directories' };
  }

  console.error('  Loading TypeScript project...');
  const project = loadProject(config, files);
  console.error(`  Loaded ${project.getSourceFiles().length} source files`);

  console.error('  Discovering exported functions...');
  const exports = discoverExports(project, repoRoot);
  console.error(`  Found ${exports.length} exported functions`);
  const exportsDiscovered = await insertTier2Exports(db, exports);

  console.error('  Extracting call graph edges...');
  const rawEdges = extractCallEdges(project, repoRoot);
  console.error(`  Found ${rawEdges.length} raw call edges`);
  const edgesCreated = insertCallEdges(db, rawEdges);
  console.error(`  Inserted ${edgesCreated} call edges`);

  const limitations = tsconfigLimitations(project, config);
  if (limitations.length > 0) {
    const note = limitations.join('; ');
    console.error(`  WARNING: ${note}`);
    return { exportsDiscovered, edgesCreated, status: 'degraded', note };
  }

  return { exportsDiscovered, edgesCreated, status: 'ok', note: null };
}

/**
 * @what Inserts a Tier 2 row, with an embedding, for each discovered export that is not indexed yet
 * @how Skips an export whose (name, file) already has a row (the index phase wrote it as Tier 1); otherwise inserts a minimal row whose description is the name, then generates its embeddings from the name and the start of the body
 * @why Undocumented exports must still be findable by search and usable as call-graph endpoints
 *
 * @param {Database.Database} db Open index database
 * @param {DiscoveredExport[]} exports The exports found in the project
 * @returns {Promise<number>} How many Tier 2 rows were inserted
 *
 * @sideeffects Inserts functions and embedding rows; loads the embedding model
 * @systemlayer Data Layer
 * @domain call-graph, code-index
 * @tags tier-2, exports, embeddings, insert
 */
async function insertTier2Exports(db: Database.Database, exports: DiscoveredExport[]): Promise<number> {
  let inserted = 0;
  for (const exp of exports) {
    if (getFunctionByName(db, exp.name, exp.filePath)) continue; // Already indexed (probably Tier 1)

    const funcId = insertFunction(db, {
      name: exp.name,
      description: exp.name, // Minimal description for Tier 2
      file_path: exp.filePath,
      line_number: exp.lineNumber,
      is_exported: true,
      declaration_type: exp.declarationType,
      side_effects: null,
      system_layer: null,
      tier: 2,
    });
    inserted++;

    await generateEmbeddings(db, {
      functionId: funcId,
      name: exp.name,
      description: exp.name,
      domains: [],
      systemlayers: [],
      tags: [],
      body: exp.body,
    });
  }
  return inserted;
}

/**
 * @what Inserts a call_edges row for each raw edge whose caller and callee are both indexed
 * @how Looks the caller up by (name, file) and the callee by (name, file), or by name alone when the extractor could not tell which file defines it; inserts the edge only when both rows exist
 * @why Edges to functions that are not in the index (libraries, unresolved imports) are dropped, so callers/callees only ever name indexed functions
 *
 * @param {Database.Database} db Open index database
 * @param {CallEdgeRaw[]} rawEdges The edges extracted from the project
 * @returns {number} How many edges were inserted
 *
 * @sideeffects Inserts call_edges rows
 * @systemlayer Data Layer
 * @domain call-graph, code-index
 * @tags call-edges, insert, resolution
 */
function insertCallEdges(db: Database.Database, rawEdges: CallEdgeRaw[]): number {
  let inserted = 0;
  for (const edge of rawEdges) {
    const source = getFunctionByName(db, edge.callerName, edge.callerFile);
    const target = getFunctionByName(db, edge.calleeName, edge.calleeFile || undefined);
    if (source && target) {
      insertCallEdge(db, source.id, target.id, edge.edgeType);
      inserted++;
    }
  }
  return inserted;
}
