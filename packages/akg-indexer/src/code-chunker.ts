import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AkgChunk, AkgStorage } from "@astrivya/akg-core";

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".cache",
  ".venv",
  "venv",
  ".tox",
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  ".parcel-cache",
  ".turbo",
  "target",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".astrivya",
  ".config-test",
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
]);

const SKIP_EXTENSIONS = new Set([
  ".min.js",
  ".min.css",
  ".map",
  ".d.ts",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".onnx",
  ".gguf",
  ".bin",
  ".wasm",
  ".tgz",
  ".zip",
  ".model",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".markdown",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".kts",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".css",
  ".scss",
  ".html",
  ".sql",
  ".prisma",
  ".graphql",
  ".gql",
  ".vue",
  ".svelte",
]);

const TS_FAMILY = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];

/** Per-language symbol extraction rules. The capture group is the symbol name. */
const SYMBOL_RULES: Array<{ extensions: string[]; type: "function" | "class" | "interface"; patterns: RegExp[] }> = [
  {
    extensions: TS_FAMILY,
    type: "function",
    patterns: [/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/],
  },
  {
    extensions: TS_FAMILY,
    type: "class",
    patterns: [/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/],
  },
  {
    extensions: TS_FAMILY,
    type: "interface",
    patterns: [/^(?:export\s+)?interface\s+(\w+)/],
  },
  {
    extensions: [".py"],
    type: "function",
    patterns: [/^(?:async\s+)?def\s+(\w+)/],
  },
  {
    extensions: [".py"],
    type: "class",
    patterns: [/^class\s+(\w+)/],
  },
  {
    extensions: [".go"],
    type: "function",
    patterns: [/^func\s+(\w+)/],
  },
  {
    extensions: [".go"],
    type: "interface",
    patterns: [/^type\s+(\w+)\s+interface/, /^type\s+(\w+)\s+struct/],
  },
];

function sha1(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

/** Normalize a relative path to forward slashes for stable ids. */
function normRel(rel: string): string {
  return rel.replace(/\\/g, "/");
}

function findSymbolEnd(lines: string[], start: number): number {
  const openIndent = /^\s*/.exec(lines[start])?.[0].length ?? 0;
  for (let j = start + 1; j < Math.min(lines.length, start + 120); j++) {
    const line = lines[j];
    if (/^\s*[)}]\s*[;,]?\s*$/.test(line) && (/^\s*/.exec(line)?.[0].length ?? 0) <= openIndent) {
      return j;
    }
    if (line.trim() === "") continue;
  }
  return Math.min(lines.length - 1, start + 60);
}

/**
 * Walk a workspace and index eligible code + doc files into the AKG:
 * one `file::` node per file, line-ranged chunks (FTS + vector-searchable),
 * folder nodes, and lightweight function/class/interface/heading nodes with
 * `contains` edges. Files whose content didn't change since the last run are
 * skipped, so repeated runs only (re)index what changed.
 */
export class CodeChunker {
  constructor(
    private storage: AkgStorage,
    private workspacePath: string,
  ) {}

  /** Index all eligible files. Returns total counts. */
  async indexWorkspace(
    onProgress?: (msg: string) => void,
  ): Promise<{ files: number; chunks: number; symbols: number }> {
    const out = { files: 0, chunks: 0, symbols: 0 };
    const seen = new Set<string>();

    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = normRel(path.relative(this.workspacePath, full));
        if (seen.has(rel)) continue;
        seen.add(rel);
        if (!this.isIndexable(entry.name)) continue;
        onProgress?.(`Indexing ${rel}`);
        try {
          const res = this.indexFile(full, rel);
          if (res.indexed) out.files += 1;
          out.chunks += res.chunks;
          out.symbols += res.symbols;
        } catch {
          // unreadable/binary/locked file - skip
        }
      }
    };

    walk(this.workspacePath);
    this.storage.saveToDisk();
    onProgress?.(`Indexed ${out.files} files, ${out.chunks} chunks, ${out.symbols} symbols`);
    return out;
  }

  /** Index a single file (used by hooks). Returns per-file counts. */
  indexFileSync(fullPath: string): { symbols: number; chunks: number; indexed: boolean } {
    const rel = normRel(path.relative(this.workspacePath, fullPath));
    if (!CODE_EXTENSIONS.has(path.extname(fullPath).toLowerCase())) {
      return { symbols: 0, chunks: 0, indexed: false };
    }
    return this.indexFile(fullPath, rel);
  }

  private isIndexable(name: string): boolean {
    const ext = path.extname(name).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) return false;
    if (SKIP_EXTENSIONS.has(ext) || name.endsWith(".d.ts")) return false;
    if (name.endsWith("-lock.json")) return false;
    return true;
  }

  private indexFile(fullPath: string, rel: string): { symbols: number; chunks: number; indexed: boolean } {
    const stat = fs.statSync(fullPath);
    const content = fs.readFileSync(fullPath, "utf-8");
    if (content.length === 0) return { symbols: 0, chunks: 0, indexed: false };

    const contentHash = sha1(content);
    const fileId = `file::${rel}`;
    const existing = this.storage.getNode(fileId);
    if (existing && existing.contentHash === contentHash) {
      return { symbols: 0, chunks: 0, indexed: false };
    }

    const now = Math.round(stat.mtimeMs);
    const lines = content.split(/\r?\n/);
    const maxChunkLines = 120;
    const overlapLines = 12;
    const step = maxChunkLines - overlapLines;

    this.storage.upsertNode({
      id: fileId,
      label: path.basename(fullPath),
      type: "file",
      sourceFile: rel,
      contentHash,
      createdAt: now,
      updatedAt: now,
    });

    let chunks = 0;
    for (let start = 0; start < lines.length; start += step) {
      const end = Math.min(lines.length - 1, start + step + overlapLines - 1);
      const chunkContent = lines.slice(start, end + 1).join("\n");
      if (chunkContent.trim().length === 0) continue;
      const chunk: AkgChunk = {
        id: `chunk::${rel}:${start + 1}-${end + 1}`,
        nodeId: fileId,
        filePath: rel,
        startLine: start + 1,
        endLine: end + 1,
        content: chunkContent,
        contentHash: sha1(chunkContent),
        createdAt: now,
        updatedAt: now,
      };
      this.storage.upsertChunk(chunk);
      chunks++;
      if (chunks >= 800) break;
    }

    const folderId = this.ensureFolderNodes(rel);
    if (folderId) {
      this.storage.addEdge({ source: folderId, target: fileId, relation: "contains", weight: 1 });
    }

    const symbols = this.indexSymbols(rel, fileId, lines, now);
    return { symbols, chunks, indexed: true };
  }

  private ensureFolderNodes(rel: string): string {
    const parts = rel.split("/");
    if (parts.length <= 1) return "";
    let parent = "";
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      const folderId = `folder::${acc}`;
      if (!this.storage.getNode(folderId)) {
        this.storage.upsertNode({
          id: folderId,
          label: parts[i],
          type: "folder",
          sourceFile: acc,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      if (parent) this.storage.addEdge({ source: parent, target: folderId, relation: "contains", weight: 1 });
      parent = folderId;
    }
    return parent;
  }

  private indexSymbols(rel: string, fileId: string, lines: string[], now: number): number {
    const ext = path.extname(rel).toLowerCase();
    let count = 0;
    const isMarkdown = [".md", ".mdx", ".markdown"].includes(ext);
    if (isMarkdown) {
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
        if (!m) continue;
        const heading = m[2].trim();
        const nodeId = `heading::${rel}:${sha1(heading).slice(0, 8)}`;
        this.storage.upsertNode({
          id: nodeId,
          label: heading,
          type: "document",
          sourceFile: rel,
          sourceLocation: String(i + 1),
          content: lines.slice(i, Math.min(lines.length, i + 30)).join("\n"),
          contentHash: sha1(heading),
          createdAt: now,
          updatedAt: now,
        });
        this.storage.addEdge({ source: fileId, target: nodeId, relation: "contains", weight: 1 });
        count++;
      }
      return count;
    }

    const rules = SYMBOL_RULES.filter((r) => r.extensions.includes(ext));
    if (rules.length === 0) return count;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let matched = false;
      for (const rule of rules) {
        for (const re of rule.patterns) {
          const m = line.match(re);
          if (!m) continue;
          const name = m[1];
          if (!name || /^[_0-9]/.test(name)) continue;
          const blockEnd = findSymbolEnd(lines, i);
          const nodeId = `symbol::${rel}:${sha1(`${name}:${i}`).slice(0, 8)}`;
          this.storage.upsertNode({
            id: nodeId,
            label: name,
            type: rule.type,
            sourceFile: rel,
            sourceLocation: `${i + 1}-${blockEnd + 1}`,
            content: lines
              .slice(i, blockEnd + 1)
              .join("\n")
              .slice(0, 4000),
            contentHash: sha1(line),
            createdAt: now,
            updatedAt: now,
          });
          this.storage.addEdge({ source: fileId, target: nodeId, relation: "contains", weight: 1 });
          count++;
          matched = true;
          break;
        }
        if (matched) break;
      }
    }
    return count;
  }
}
