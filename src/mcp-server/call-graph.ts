import path from 'path';
import type Database from 'better-sqlite3';
import { Project, SyntaxKind, type Node } from 'ts-morph';
import {
  insertFunction,
  insertCallEdge,
  getFunctionByName,
} from './db.js';
import { generateEmbeddings } from './embeddings.js';
import { resolveConfig } from '../config.js';

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

// ─── Project Loading ────────────────────────────────────────────────────────

function loadProject(repoRoot: string): Project {
  const tsConfigPath = path.join(repoRoot, 'tsconfig.json');

  const project = new Project({
    tsConfigFilePath: tsConfigPath,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });

  // Add source files from configured source directories
  const config = resolveConfig(repoRoot);
  for (const dir of config.sourceDirectories) {
    const absDir = path.join(repoRoot, dir);
    project.addSourceFilesAtPaths([
      `${absDir}/**/*.ts`,
      `${absDir}/**/*.tsx`,
    ]);
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

export async function buildCallGraph(
  db: Database.Database,
  repoRoot: string,
): Promise<{ exportsDiscovered: number; edgesCreated: number }> {
  let exportsDiscovered = 0;
  let edgesCreated = 0;

  console.error('  Loading TypeScript project...');
  const project = loadProject(repoRoot);
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

  return { exportsDiscovered, edgesCreated };
}
