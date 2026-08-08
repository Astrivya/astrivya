import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AkgStorage } from "@astrivya/akg-core";

function regexEscape(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class TodoParser {
  constructor(private storage: AkgStorage) {}

  parseWorkspaceTodos(workspacePath: string): void {
    const todoFiles = ["todo.md", "TODO.md", "tasks.md", "TASKS.md"];
    const uniqueFiles = new Map<string, { fullPath: string; f: string }>(); // realpath (lower) -> info

    for (const f of todoFiles) {
      const fullPath = path.join(workspacePath, f);
      if (fs.existsSync(fullPath)) {
        try {
          const realPath = fs.realpathSync(fullPath);
          const realPathLower = realPath.toLowerCase();
          if (!uniqueFiles.has(realPathLower)) {
            uniqueFiles.set(realPathLower, { fullPath, f });
          }
        } catch {
          // ignore link errors
        }
      }
    }

    // Collect real file nodes only (actual indexed files, not graph-imported artifacts)
    const fileNodes = this.storage.runQuery("SELECT id, label FROM nodes WHERE type = 'file' AND id LIKE 'file::%';");
    const fileMapping = fileNodes.map((fn: any) => ({
      id: fn.id,
      relPath: fn.id.replace("file::", ""),
      basename: fn.label,
    }));

    for (const { fullPath, f } of uniqueFiles.values()) {
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/^\s*-\s*\[([ xX/])\]\s+(.+)$/);
        if (match) {
          const statusChar = match[1];
          const text = match[2].trim();
          const completed = statusChar === "x" || statusChar === "X";

          // Unique ID based on file name and text content
          const hash = crypto.createHash("md5").update(`${f}:${text}`).digest("hex");
          const taskId = `task::${hash}`;

          // Upsert task node
          this.storage.upsertNode({
            id: taskId,
            label: text.length > 50 ? `${text.slice(0, 50)}...` : text,
            type: "task",
            sourceFile: f,
            sourceLocation: `L${i + 1}`,
            metadata: JSON.stringify({ completed, originalText: text }),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });

          // Scan text for code references
          const lowerText = text.toLowerCase();
          for (const fm of fileMapping) {
            const relPathLower = fm.relPath.toLowerCase();
            const baseLower = fm.basename.toLowerCase();

            // Match if the relative path or basename is explicitly referenced in the task
            const matchRel = lowerText.includes(relPathLower);
            const matchBase =
              fm.basename.length > 3 && new RegExp(`\\b${regexEscape(baseLower)}\\b`, "i").test(lowerText);

            if (matchRel || matchBase) {
              // Link: file --tracked_by--> task
              this.storage.addEdge({
                source: fm.id,
                target: taskId,
                relation: "tracked_by",
                weight: 1.0,
                extractionMethod: "todo-parser",
              });
            }
          }
        }
      }
    }
  }
}
