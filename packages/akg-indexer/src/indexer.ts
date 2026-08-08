import * as fs from "node:fs";
import * as path from "node:path";
import type { AkgStorage } from "@astrivya/akg-core";
import { AdrParser } from "./adr-parser";
import { AgentParser } from "./agent-parser";
import { TodoParser } from "./todo-parser";

export class AkgIndexer {
  private adrParser: AdrParser;
  private agentParser: AgentParser;
  private todoParser: TodoParser;

  constructor(
    private storage: AkgStorage,
    private workspacePath: string,
  ) {
    this.adrParser = new AdrParser(storage, workspacePath);
    this.agentParser = new AgentParser(storage);
    this.todoParser = new TodoParser(storage);
  }

  indexAll(): void {
    this.agentParser.parseAgentActivity(this.workspacePath);
    this.todoParser.parseWorkspaceTodos(this.workspacePath);
  }

  async indexWorkspace(
    onProgress?: (msg: string) => void,
  ): Promise<{ filesIndexed: number; nodesCreated: number; edgesCreated: number; indexed: number; failed: number }> {
    let filesIndexed = 0;
    let nodesCreated = 0;
    let edgesCreated = 0;

    const statsBefore = this.storage.getStats();

    onProgress?.("Indexing agent activity...");
    this.agentParser.parseAgentActivity(this.workspacePath);

    onProgress?.("Indexing TODO files...");
    this.todoParser.parseWorkspaceTodos(this.workspacePath);

    const adrDir = path.join(this.workspacePath, "docs", "adr");
    if (fs.existsSync(adrDir)) {
      const files = fs.readdirSync(adrDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        onProgress?.(`Indexing ADR: ${file}`);
        try {
          const filePath = path.join(adrDir, file);
          const content = fs.readFileSync(filePath, "utf-8");
          await this.adrParser.parseAndIndexADR(filePath, content);
          filesIndexed++;
        } catch {
          // skip failed ADR
        }
      }
    }

    const statsAfter = this.storage.getStats();
    nodesCreated = statsAfter.nodes - statsBefore.nodes;
    edgesCreated = statsAfter.edges - statsBefore.edges;

    return {
      filesIndexed,
      nodesCreated,
      edgesCreated,
      indexed: filesIndexed,
      failed: 0,
    };
  }

  async indexFile(filePath: string): Promise<boolean> {
    if (!filePath.endsWith(".md")) return false;
    const content = fs.readFileSync(filePath, "utf-8");
    const isAdrDir = filePath.includes(path.join("docs", "adr"));
    if (isAdrDir) {
      return await this.adrParser.parseAndIndexADR(filePath, content);
    }
    return false;
  }
}
