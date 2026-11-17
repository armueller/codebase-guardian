import path from 'path';
import type Database from 'better-sqlite3';
import { Project, SyntaxKind, type Node } from 'ts-morph';
import {
  insertFunction,
  insertCallEdge,
  getFunctionByName,
} from './db.js';
import { generateEmbeddings } from './embeddings.js';
import { resolveConfig, type GuardianConfig } from '../config.js';
import { listIndexFiles } from './file-walk.js';

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
 * @domain call-graph, rebuild
 * @tags call-graph, tier-2, phase-status, degraded
 */
export interface CallGraphResult {
  /** Tier 2 rows inserted (exports not already indexed as Tier 1) */
  exportsDiscovered: number;
  /** call_edges rows inserted */
  edgesCreated: number;
  /** `degraded` when the graph was built without a tsconfig, so calls through path aliases have no edge */
  status: 'ok' | 'degraded';
  /** Why the status is degraded, or why nothing was built; null otherwise */
  note: string | null;
}

// ─── Project Loading ────────────────────────────────────────────────────────

/**
 * @what Lists the TypeScript files of a project that belong in the call graph
 * @how Takes the code files from listIndexFiles(config) and keeps .ts and .tsx
 * @why The call graph must read exactly the files the indexer read. Globbing the source directories separately loaded node_modules and build output that the indexer skips, and ignored excludeDirectories.
 *
 * @param {GuardianConfig} config Resolved project config
 * @returns {string[]} Absolute paths of the TypeScript files in the index
 *
 * @sideeffects Reads the filesystem (directory walk)
 * @systemlayer Data Layer
 * @domain call-graph, file-walk
 * @tags typescript, source-files, exclude-directories, file-list
 */
function listTypeScriptFiles(config: GuardianConfig): string[] {
  return listIndexFiles(config).codeFiles.filter(file => file.endsWith('.ts') || file.endsWith('.tsx'));
}

/**
 * @what Creates the ts-morph project the call graph is extracted from
 * @how Uses the resolved tsconfig's compiler options when there is one (so path aliases resolve) and compiler defaults when there is none, then adds each listed file by exact path. Files are added one by one, not by glob, because route files are often named with glob characters such as [id].ts. A tsconfig that ts-morph cannot load is rethrown with the file named, relative to the project root.
 * @why The tsconfig may sit in a sub-folder or be absent; hard-coding <root>/tsconfig.json made ts-morph throw and aborted the whole rebuild. ts-morph's own message for a malformed tsconfig ("',' expected.") does not say which file is wrong.
 *
 * @param {GuardianConfig} config Resolved project config; config.tsconfig must not be `invalid` (the caller rejects that first)
 * @param {string[]} files Absolute paths of the TypeScript files to load
 * @returns {Project} A project holding exactly those files
 * @throws {Error} `could not load tsconfig "<path>": <reason>` when the tsconfig exists but cannot be loaded
 *
 * @sideeffects Reads the tsconfig and the source files from disk
 * @systemlayer Data Layer
 * @domain call-graph
 * @tags ts-morph, tsconfig, path-aliases, compiler-defaults, project-loading
 */
function loadProject(config: GuardianConfig, files: string[]): Project {
  const shared = { skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true };
  let project: Project;
  if (config.tsconfig.kind === 'file') {
    try {
      project = new Project({ tsConfigFilePath: config.tsconfig.path, ...shared });
    } catch (err) {
      const shown = path.relative(config.projectRoot, config.tsconfig.path).split(path.sep).join('/');
      throw new Error(`could not load tsconfig "${shown}": ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    project = new Project(shared);
  }

  for (const file of files) {
    project.addSourceFileAtPathIfExists(file);
  }

  return project;
}

// ─── Export Discovery (Tier 2) ──────────────────────────────────────────────

function discoverExports(project: Project, repoRoot: string): DiscoveredExport[] {
  const exports: DiscoveredExport[] = [];
  const seen = new Set<string>();

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = path.relative(repoRoot, sourceFile.getFilePath());

    // Skip test files, node_modules, etc.
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
 * @how Rejects an invalid tsconfig outright, returns early when the index holds no TypeScript files, otherwise loads the indexed files into a ts-morph project (with the resolved tsconfig, or compiler defaults when there is none), inserts each exported function not already indexed as Tier 2 with an embedding, then resolves every call and JSX usage to an indexed function and inserts the edge. Built without a tsconfig, the result is marked degraded: imports through path aliases cannot be resolved, so calls to those functions get no edge.
 * @why Phase 2 of the rebuild. callers/callees/impact and the hook's caller context read these rows.
 *
 * @param {Database.Database} db Open index database, already populated by buildIndex
 * @param {string} repoRoot Absolute project root; stored file paths are relative to it
 * @param {{config?: GuardianConfig}} [opts] An already-resolved (fresh) project config, defaulting to resolveConfig(repoRoot)
 * @returns {Promise<CallGraphResult>} Counts plus a status and note for the rebuild report
 * @throws {Error} When the configured tsconfig is invalid (the reason is the message); there is no fallback to another file
 *
 * @sideeffects Reads the tsconfig and source files; inserts functions, embeddings and call_edges rows; loads the embedding model; logs progress to stderr
 * @systemlayer Data Layer
 * @domain call-graph, code-index
 * @tags call-graph, tier-2, ts-morph, tsconfig, exports, call-edges, rebuild
 */
export async function buildCallGraph(
  db: Database.Database,
  repoRoot: string,
  opts?: { config?: GuardianConfig },
): Promise<CallGraphResult> {
  let exportsDiscovered = 0;
  let edgesCreated = 0;

  const config = opts?.config ?? resolveConfig(repoRoot);
  if (config.tsconfig.kind === 'invalid') {
    throw new Error(config.tsconfig.reason);
  }

  const files = listTypeScriptFiles(config);
  if (files.length === 0) {
    console.error('  No TypeScript files in the source directories, skipping TypeScript call graph');
    return { exportsDiscovered, edgesCreated, status: 'ok', note: 'no TypeScript files in the source directories' };
  }

  console.error('  Loading TypeScript project...');
  const project = loadProject(config, files);
  console.error(`  Loaded ${project.getSourceFiles().length} source files`);

  // Discover Tier 2 exports
  console.error('  Discovering exported functions...');
  const exports = discoverExports(project, repoRoot);
  console.error(`  Found ${exports.length} exported functions`);

  // Insert Tier 2 functions (only those not already indexed as Tier 1)
  for (const exp of exports) {
    const existing = getFunctionByName(db, exp.name, exp.filePath);
    if (existing) continue; // Already indexed (probably Tier 1)

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

    exportsDiscovered++;

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

  // Extract and insert call edges
  console.error('  Extracting call graph edges...');
  const rawEdges = extractCallEdges(project, repoRoot);
  console.error(`  Found ${rawEdges.length} raw call edges`);

  for (const edge of rawEdges) {
    const source = getFunctionByName(db, edge.callerName, edge.callerFile);
    const target = getFunctionByName(db, edge.calleeName, edge.calleeFile || undefined);

    if (source && target) {
      insertCallEdge(db, source.id, target.id, edge.edgeType);
      edgesCreated++;
    }
  }

  console.error(`  Inserted ${edgesCreated} call edges`);

  if (config.tsconfig.kind === 'none') {
    // Without the tsconfig's `paths`, an alias import cannot be resolved. Its definition then
    // comes back as the import specifier in the calling file, so the callee lookup finds no row
    // and no edge is created. The edges are missing, not guessed from the function name.
    const note =
      `no tsconfig found at ${path.join(config.projectRoot, 'tsconfig.json')} and none configured; ` +
      'built with compiler defaults, so calls through path aliases are not linked (those call edges are missing). ' +
      'Set "tsconfig" in guardian.config.json.';
    console.error(`  WARNING: ${note}`);
    return { exportsDiscovered, edgesCreated, status: 'degraded', note };
  }

  return { exportsDiscovered, edgesCreated, status: 'ok', note: null };
}
