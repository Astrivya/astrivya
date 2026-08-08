import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AkgStorage } from "@astrivya/akg-core";

export class AgentParser {
  constructor(private storage: AkgStorage) {}

  parseAgentActivity(workspacePath: string): void {
    const homedir = os.homedir();
    const brainDir = path.join(homedir, ".gemini", "antigravity-ide", "brain");

    if (!fs.existsSync(brainDir)) return;

    // Seed default agent node
    this.storage.upsertNode({
      id: "agent::antigravity",
      label: "Antigravity Agent",
      type: "agent",
      metadata: JSON.stringify({ name: "Antigravity", developer: "Google DeepMind" }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    try {
      const convFolders = fs.readdirSync(brainDir);
      for (const folder of convFolders) {
        const logPath = path.join(brainDir, folder, ".system_generated", "logs", "transcript.jsonl");
        if (fs.existsSync(logPath)) {
          const content = fs.readFileSync(logPath, "utf-8");
          const lines = content.split("\n");

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const step = JSON.parse(line);

              if (step.tool_calls && Array.isArray(step.tool_calls)) {
                for (let tcIdx = 0; tcIdx < step.tool_calls.length; tcIdx++) {
                  const call = step.tool_calls[tcIdx];
                  const name = call.name || "";
                  const args = call.args || {};

                  // Check for file modifications
                  const isWrite = name.includes("write_to_file");
                  const isReplace =
                    name.includes("replace_file_content") || name.includes("multi_replace_file_content");

                  if (isWrite || isReplace) {
                    const targetFile = args.TargetFile || args.TargetFile;
                    if (targetFile && typeof targetFile === "string") {
                      // Normalize path relative to workspace
                      const relPath = path.relative(workspacePath, targetFile).replace(/\\/g, "/");
                      const fileNodeId = `file::${relPath}`;

                      // Check if the file node exists in database
                      const fileExists =
                        this.storage.runQuery("SELECT 1 FROM nodes WHERE id = ? LIMIT 1;", [fileNodeId]).length > 0;
                      if (!fileExists) continue;

                      const stepIndex = step.step_index !== undefined ? step.step_index : 0;
                      const actionId = `agent_action::${folder.slice(0, 8)}_${stepIndex}_${tcIdx}`;
                      const actionLabel = `${isWrite ? "Created" : "Modified"} ${path.basename(targetFile)}`;

                      // Upsert action node
                      this.storage.upsertNode({
                        id: actionId,
                        label: actionLabel,
                        type: "agent_action",
                        sourceFile: relPath,
                        metadata: JSON.stringify({
                          tool: name.split(":").pop(),
                          stepIndex,
                          conversationId: folder,
                          timestamp: Date.now(),
                        }),
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                      });

                      // Link agent --executed--> action
                      this.storage.addEdge({
                        source: "agent::antigravity",
                        target: actionId,
                        relation: "executed",
                        weight: 1.0,
                        extractionMethod: "agent-parser",
                      });

                      // Link action --modified/generated--> file
                      this.storage.addEdge({
                        source: actionId,
                        target: fileNodeId,
                        relation: isWrite ? "generated" : "modified",
                        weight: 1.0,
                        extractionMethod: "agent-parser",
                      });
                    }
                  }
                }
              }
            } catch {
              // Skip individual invalid JSON lines
            }
          }
        }
      }
    } catch (err) {
      console.warn("Failed to walk agent logs folder:", err);
    }
  }
}
