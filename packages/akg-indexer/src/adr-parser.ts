import * as path from "node:path";
import type { AkgNode, AkgStorage } from "@astrivya/akg-core";

export interface AdrRecord {
  title: string;
  status: "proposed" | "accepted" | "deprecated" | "superseded";
  date?: string;
  context: string;
  decision: string;
  consequences: string[];
  supersedes?: string; // Links to another ADR filename
}

export function parseMarkdownADR(content: string): AdrRecord | null {
  const lines = content.split("\n");

  // Basic heuristic: must have Title heading and typical ADR sections
  const firstHeaderIdx = lines.findIndex((l) => l.trim().startsWith("# "));
  if (firstHeaderIdx === -1) return null;

  const title = lines[firstHeaderIdx].replace("#", "").trim();

  // Look for sections
  let status: "proposed" | "accepted" | "deprecated" | "superseded" = "proposed";
  let date: string | undefined;
  let context = "";
  let decision = "";
  const consequences: string[] = [];
  let supersedes: string | undefined;

  let currentSection = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      currentSection = trimmed.replace("##", "").trim().toLowerCase();
      continue;
    }

    if (currentSection === "status") {
      const lowerLine = trimmed.toLowerCase();
      if (lowerLine.includes("accepted")) {
        status = "accepted";
      } else if (lowerLine.includes("deprecated")) {
        status = "deprecated";
      } else if (lowerLine.includes("superseded")) {
        status = "superseded";
        // Try to capture superseded target from text, e.g. "Supersedes [ADR 001](001-use-supabase.md)"
        const match = trimmed.match(/supersedes\s+\[(.*?)\]\((.*?)\)/i) || trimmed.match(/supersedes\s+(.*?md)/i);
        if (match) {
          supersedes = match[2] || match[1];
        }
      } else if (lowerLine.includes("proposed")) {
        status = "proposed";
      }

      // Parse date if present
      const dateMatch = trimmed.match(/date:\s*([0-9\-/]+)/i) || trimmed.match(/^[0-9]{4}-[0-9]{2}-[0-9]{2}/);
      if (dateMatch) {
        date = dateMatch[1] || dateMatch[0];
      }
    } else if (currentSection === "context") {
      if (trimmed) context += `${trimmed}\n`;
    } else if (currentSection === "decision" || currentSection === "decisions") {
      if (trimmed) decision += `${trimmed}\n`;
    } else if (currentSection === "consequences") {
      if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
        consequences.push(trimmed.slice(1).trim());
      } else if (trimmed) {
        consequences.push(trimmed);
      }
    }
  }

  // If we couldn't parse decision or context, it might not be a standard ADR
  if (!context && !decision) return null;

  return {
    title,
    status,
    date,
    context: context.trim(),
    decision: decision.trim(),
    consequences,
    supersedes,
  };
}

export class AdrParser {
  constructor(
    private storage: AkgStorage,
    private workspacePath: string,
  ) {}

  async parseAndIndexADR(filePath: string, content: string): Promise<boolean> {
    const relativePath = path.relative(this.workspacePath, filePath).replace(/\\/g, "/");
    const record = parseMarkdownADR(content);
    if (!record) return false;

    const adrNodeId = `adr::${relativePath}`;
    const metadata = JSON.stringify({
      status: record.status,
      date: record.date,
      consequences: record.consequences,
      supersedes: record.supersedes,
    });

    // Create ADR node
    const node: AkgNode = {
      id: adrNodeId,
      label: record.title,
      type: "adr",
      sourceFile: relativePath,
      content: `Title: ${record.title}\nStatus: ${record.status}\n\nContext:\n${record.context}\n\nDecision:\n${record.decision}`,
      metadata,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.storage.upsertNode(node);

    // Link file to workspace root
    this.storage.addEdge({
      source: "workspace::root",
      target: adrNodeId,
      relation: "contains",
    });

    // Scan for code files references in text to link decides relationship
    const workspaceFiles = this.storage.runQuery("SELECT id, source_file FROM nodes WHERE type = 'file';");
    for (const file of workspaceFiles) {
      if (!file.source_file) continue;
      const baseName = path.basename(file.source_file);
      // If ADR references this file name or path
      if (content.includes(baseName) || content.includes(file.source_file)) {
        this.storage.addEdge({
          source: adrNodeId,
          target: file.id,
          relation: "decides",
          confidence: 0.8,
          extractionMethod: "adr-linkage",
        });
        this.storage.addAdrLink(adrNodeId, file.id);
      }
    }

    // Link to superseded ADR if parsed
    if (record.supersedes) {
      const adrDir = path.dirname(relativePath);
      const targetRelPath = path.join(adrDir, record.supersedes).replace(/\\/g, "/");
      const targetNodeId = `adr::${targetRelPath}`;
      this.storage.addEdge({
        source: adrNodeId,
        target: targetNodeId,
        relation: "supersedes",
        confidence: 1.0,
        extractionMethod: "adr-supersedes",
      });
    }

    return true;
  }
}
