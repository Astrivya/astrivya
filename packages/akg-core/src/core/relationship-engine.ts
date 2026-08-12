import { execSync } from "node:child_process";
import * as path from "node:path";
import * as ts from "typescript";
import type { AkgStorage } from "../akg-storage";
import { getErrorMessage } from "../errors";

export interface AstRelation {
  classes: {
    name: string;
    extends?: string;
    implements?: string[];
    line: number;
  }[];
  calls: {
    caller: string;
    callee: string;
    line: number;
  }[];
  uses: {
    caller: string;
    target: string;
    line: number;
  }[];
}

export function parseTypeScriptAST(filePath: string, content: string): AstRelation {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const result: AstRelation = {
    classes: [],
    calls: [],
    uses: [],
  };

  let currentScope = "";

  function walk(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

      let extendsName: string | undefined;
      const implementsNames: string[] = [];

      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
            const firstType = clause.types[0];
            if (firstType && ts.isIdentifier(firstType.expression)) {
              extendsName = firstType.expression.text;
            }
          } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
            for (const typeNode of clause.types) {
              if (ts.isIdentifier(typeNode.expression)) {
                implementsNames.push(typeNode.expression.text);
              }
            }
          }
        }
      }

      result.classes.push({
        name: className,
        extends: extendsName,
        implements: implementsNames,
        line,
      });

      const oldScope = currentScope;
      currentScope = `class::${className}`;
      ts.forEachChild(node, walk);
      currentScope = oldScope;
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      const funcName = node.name.text;
      const oldScope = currentScope;
      currentScope = `function::${funcName}`;
      ts.forEachChild(node, walk);
      currentScope = oldScope;
      return;
    }

    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      const methodName = node.name.text;
      const oldScope = currentScope;
      currentScope = `${currentScope || "class"}::method::${methodName}`;
      ts.forEachChild(node, walk);
      currentScope = oldScope;
      return;
    }

    if (ts.isCallExpression(node)) {
      let calleeName = "";
      if (ts.isIdentifier(node.expression)) {
        calleeName = node.expression.text;
      } else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
        calleeName = node.expression.name.text;
      }

      if (calleeName && currentScope) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        result.calls.push({
          caller: currentScope,
          callee: calleeName,
          line,
        });
      }
    }

    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      if (currentScope) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        result.uses.push({
          caller: currentScope,
          target: node.typeName.text,
          line,
        });
      }
    }

    ts.forEachChild(node, walk);
  }

  walk(sourceFile);
  return result;
}

/**
 * Extract relative import/require specifiers from code content. Handles
 * ES module `import ... from "./x"`, bare `import "./x"`, `export ... from`,
 * `require("./x")` and dynamic `import("./x")`. Returns only relative
 * specifiers (./ or ../) that can be resolved against the file's directory.
 */
export function extractRelativeSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /(?:from|import)\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
    /from\s+["'](\.[^"']+)["']/g,
    /import\s*["'](\.[^"']+)["']/g,
    /require\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of content.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith("./") || spec.startsWith("../")) specifiers.add(spec);
    }
  }
  return Array.from(specifiers);
}

export interface GitMetrics {
  ageDays: number;
  lastModifiedEpoch: number;
  contributorCount: number;
  churnRate: number;
  authors: { name: string; email: string; linesOwned: number }[];
  primaryOwner?: { name: string; email: string };
  creator?: { name: string; email: string };
}

export function analyzeGitHistory(workspacePath: string, relativeFilePath: string): GitMetrics | null {
  try {
    const absolutePath = path.join(workspacePath, relativeFilePath);

    // Check if git is available and file is tracked
    const isTracked = execSync(`git ls-files --error-unmatch "${absolutePath}"`, {
      cwd: workspacePath,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (!isTracked) return null;

    // 1. Get commits log
    const logOutput = execSync(`git log --follow --format="%an|%ae|%aI" -- "${absolutePath}"`, {
      cwd: workspacePath,
    })
      .toString()
      .trim();

    if (!logOutput) return null;

    const commitLines = logOutput.split("\n");
    const commitCount = commitLines.length;

    // Authors and timestamps
    const contributors = new Set<string>();
    const emailsMap = new Map<string, string>(); // name -> email
    let creator: { name: string; email: string } | undefined;
    let firstCommitDate = Date.now();
    let lastCommitDate = 0;

    for (let idx = 0; idx < commitLines.length; idx++) {
      const line = commitLines[idx];
      const [name, email, dateStr] = line.split("|");
      if (!name) continue;

      contributors.add(name);
      emailsMap.set(name, email || "");

      const epoch = Date.parse(dateStr || "");
      if (!Number.isNaN(epoch)) {
        if (epoch < firstCommitDate) {
          firstCommitDate = epoch;
        }
        if (epoch > lastCommitDate) {
          lastCommitDate = epoch;
        }
      }

      // Creator is the first commit chronologically (which is at the very bottom of logs output)
      if (idx === commitLines.length - 1) {
        creator = { name, email: email || "" };
      }
    }

    const ageDays = Math.max(1, Math.round((Date.now() - firstCommitDate) / (1000 * 60 * 60 * 24)));
    const churnRate = commitCount / Math.max(1, ageDays / 30); // commits per month

    // 2. Git Blame to count line ownership
    const blameOutput = execSync(`git blame --line-porcelain -- "${absolutePath}"`, {
      cwd: workspacePath,
    })
      .toString()
      .trim();

    const authorLinesCount = new Map<string, number>();
    const lines = blameOutput.split("\n");

    for (const line of lines) {
      if (line.startsWith("author ")) {
        const authorName = line.slice(7).trim();
        authorLinesCount.set(authorName, (authorLinesCount.get(authorName) || 0) + 1);
      }
    }

    // Compile authors list
    const authorsList: { name: string; email: string; linesOwned: number }[] = [];
    let primaryOwner: { name: string; email: string } | undefined;
    let maxLines = -1;

    for (const [name, count] of authorLinesCount.entries()) {
      const email = emailsMap.get(name) || "";
      authorsList.push({ name, email, linesOwned: count });
      if (count > maxLines) {
        maxLines = count;
        primaryOwner = { name, email };
      }
    }

    return {
      ageDays,
      lastModifiedEpoch: lastCommitDate,
      contributorCount: contributors.size,
      churnRate,
      authors: authorsList,
      primaryOwner,
      creator,
    };
  } catch {
    return null;
  }
}

/** Code file extensions that participate in relationship analysis. */
export const RELATION_CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Extension candidates tried when resolving a relative import specifier. */
const IMPORT_CANDIDATE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

/** Safety cap on imports edges emitted per file (pathological files). */
const MAX_IMPORT_EDGES_PER_FILE = 200;

/**
 * Extract relative import specifiers (e.g. `./foo`, `../bar`) from a JS/TS
 * file using lightweight regex scanning. Covers ES `import ... from`, side
 * effect `import "./x"`, re-export `export ... from "./x"`, and CJS
 * `require("./x")`. Non-relative (bare package) specifiers are ignored.
 */
export function extractImportSpecifiers(content: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:import\s+[\s\S]*?from\s+|export\s+[\s\S]*?from\s+|import\s+|require\s*\()\s*['"](\.{1,2}\/[^'"\s]+)['"]/g;
  for (const m of content.matchAll(re)) {
    specs.push(m[1]);
  }
  return [...new Set(specs)];
}

export class RelationshipEngine {
  constructor(
    private storage: AkgStorage,
    private workspacePath: string,
  ) {}

  /**
   * Resolve a symbol name to a real indexed node id in the given file.
   * Prefers the given type (e.g. "class" for extends targets), falls back
   * to any symbol with a matching label. Returns undefined when no node
   * exists — callers must skip the edge instead of fabricating stubs.
   */
  private resolveSymbolId(filePath: string, label: string, preferredType?: string): string | undefined {
    const rows = this.storage.runQuery(
      "SELECT id, type FROM nodes WHERE source_file = ? AND label = ? AND type IN ('class', 'interface', 'function');",
      [filePath, label],
    );
    if (preferredType) {
      const preferred = rows.find((r) => r.type === preferredType);
      if (preferred) return preferred.id;
    }
    const any = rows[0];
    return any?.id;
  }

  async analyzeCodeRelationships(filePath: string, fileNodeId: string, content: string): Promise<void> {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== ".ts" && ext !== ".tsx") return;

    try {
      const ast = parseTypeScriptAST(filePath, content);

      // Class inheritances — target ids must resolve to real symbol nodes
      for (const cls of ast.classes) {
        const classNodeId = this.resolveSymbolId(filePath, cls.name, "class");
        if (!classNodeId) continue;
        if (cls.extends) {
          const targetId = this.resolveSymbolId(filePath, cls.extends, "class");
          if (targetId) {
            this.storage.addEdge({
              source: classNodeId,
              target: targetId,
              relation: "extends",
              confidence: 0.8,
              extractionMethod: "ast",
            });
          }
        }
        if (cls.implements) {
          for (const impl of cls.implements) {
            const implNodeId = this.resolveSymbolId(filePath, impl, "interface");
            if (implNodeId) {
              this.storage.addEdge({
                source: classNodeId,
                target: implNodeId,
                relation: "implements",
                confidence: 0.8,
                extractionMethod: "ast",
              });
            }
          }
        }
      }

      // Calls and Type usages (lexical matching against real symbols)
      for (const call of ast.calls) {
        const callerParts = call.caller.split("::");
        const callerName = callerParts[callerParts.length - 1];
        const callerId = this.resolveSymbolId(filePath, callerName) ?? fileNodeId;

        const calleeId = this.resolveSymbolId(filePath, call.callee);
        if (calleeId) {
          this.storage.addEdge({
            source: callerId,
            target: calleeId,
            relation: "calls",
            confidence: 0.7,
            extractionMethod: "ast",
          });
        }
      }

      for (const use of ast.uses) {
        const callerParts = use.caller.split("::");
        const callerName = callerParts[callerParts.length - 1];
        const callerId = this.resolveSymbolId(filePath, callerName) ?? fileNodeId;

        const targetId = this.resolveSymbolId(filePath, use.target);
        if (targetId) {
          this.storage.addEdge({
            source: callerId,
            target: targetId,
            relation: "uses",
            confidence: 0.7,
            extractionMethod: "ast",
          });
        }
      }
    } catch (err: unknown) {
      console.warn(`AST analysis failed for ${filePath}: ${getErrorMessage(err)}`);
    }
  }

  /**
   * Extract relative import/require specifiers from a code file and create
   * `imports` edges between the current file node and the resolved target
   * file nodes (when both exist in the graph). Powers topological sort and
   * impact analysis. Returns the number of edges created.
   */
  async analyzeImports(filePath: string, fileNodeId: string, content: string): Promise<number> {
    const specifiers = extractRelativeSpecifiers(content);
    if (specifiers.length === 0) return 0;

    const fileDir = path.posix.dirname(filePath);
    const candidates = (spec: string): string[] => {
      const base = spec.startsWith("./") ? spec : spec.startsWith("../") ? spec : null;
      if (!base) return [];
      const resolved = path.posix.normalize(path.posix.join(fileDir, base));
      if (resolved.startsWith("..") || resolved.startsWith("/")) return [];
      return [
        resolved,
        `${resolved}.ts`,
        `${resolved}.tsx`,
        `${resolved}.js`,
        `${resolved}.jsx`,
        `${resolved}.mjs`,
        `${resolved}/index.ts`,
        `${resolved}/index.tsx`,
        `${resolved}/index.js`,
      ];
    };

    let created = 0;
    for (const spec of specifiers.slice(0, 200)) {
      let targetId: string | undefined;
      for (const candidate of candidates(spec)) {
        const id = `file::${candidate}`;
        const exists = this.storage.runQuery("SELECT 1 FROM nodes WHERE id = ? LIMIT 1;", [id]).length > 0;
        if (exists) {
          targetId = id;
          break;
        }
      }
      if (!targetId || targetId === fileNodeId) continue;
      this.storage.addEdge({
        source: fileNodeId,
        target: targetId,
        relation: "imports",
        weight: 1,
        confidence: 0.8,
        extractionMethod: "regex",
      });
      created++;
    }
    return created;
  }

  async analyzeAuthorship(filePath: string, fileNodeId: string): Promise<void> {
    const gitInfo = analyzeGitHistory(this.workspacePath, filePath);
    if (!gitInfo) return;

    try {
      // Update the file node with git metadata
      const fileNode = this.storage.getNode(fileNodeId);
      if (fileNode) {
        fileNode.churnRate = gitInfo.churnRate;
        fileNode.lastModified = gitInfo.lastModifiedEpoch;
        fileNode.contributorCount = gitInfo.contributorCount;
        this.storage.upsertNode(fileNode);
      }

      // Add authors and edges
      for (const author of gitInfo.authors) {
        const authorId = `person::${author.email || author.name}`;
        this.storage.addPerson({
          id: authorId,
          name: author.name,
          email: author.email,
        });

        // Add "owns" edge from author to file
        const weight = author.linesOwned; // count lines as weight
        this.storage.addEdge({
          source: authorId,
          target: fileNodeId,
          relation: "owns",
          weight,
          confidence: 0.9,
          extractionMethod: "git-blame",
        });
      }

      // Add creator edge
      if (gitInfo.creator) {
        const creatorId = `person::${gitInfo.creator.email || gitInfo.creator.name}`;
        this.storage.addEdge({
          source: creatorId,
          target: fileNodeId,
          relation: "created_by",
          confidence: 1.0,
          extractionMethod: "git-log",
        });
      }
    } catch (err: unknown) {
      console.warn(`Git analysis failed for ${filePath}: ${getErrorMessage(err)}`);
    }
  }
}
