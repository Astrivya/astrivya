import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import envPaths from "env-paths";
import { loadConfig } from "../compat";
import type { InferenceRuntime, RuntimeCapabilities, RuntimeHealth } from "./types";

export class NativeRuntime implements InferenceRuntime {
  id = "native";
  name = "Native Runtime (node-llama-cpp)";

  private process: ChildProcess | null = null;
  private port = 11435;
  private health: RuntimeHealth = "healthy";
  private lastError: string | null = null;

  async isAvailable(): Promise<boolean> {
    const config = loadConfig();
    const modelPath = config.customModelPath;
    if (!modelPath) return false;
    return fs.existsSync(modelPath);
  }

  async loadModel(modelPath: string): Promise<void> {
    if (this.process && this.process.exitCode === null) {
      return; // Already running
    }

    const config = loadConfig();
    const resolvedModelPath = modelPath || config.customModelPath;
    if (!resolvedModelPath || !fs.existsSync(resolvedModelPath)) {
      throw new Error(`Model path does not exist: ${resolvedModelPath}`);
    }

    const serverScript = path.join(__dirname, "commands", "local-server.js");
    const paths = envPaths("astrivya", { suffix: "" });
    const logPath = path.join(paths.config, "local-server.log");

    // Ensure config directory exists
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
    } catch {
      // ignore directory creation errors
    }

    let logFd: any = "ignore";
    try {
      logFd = fs.openSync(logPath, "a");
    } catch {
      // fallback to ignore
    }

    this.health = "healthy";
    this.lastError = null;

    this.process = spawn("node", [serverScript, resolvedModelPath, String(this.port), process.cwd()], {
      detached: false,
      stdio: ["ignore", logFd, logFd],
    });

    this.process.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        this.health = "failed";
        this.lastError = `Process exited with code ${code} (Signal: ${signal})`;
      } else {
        this.health = "unavailable";
      }
      this.process = null;
    });

    this.process.unref();

    // Poll the server port until it responds
    const maxAttempts = 50; // up to 5 seconds
    for (let i = 0; i < maxAttempts; i++) {
      if ((this.health as RuntimeHealth) === "failed") {
        throw new Error(this.lastError || "Native server exited unexpectedly during startup");
      }
      try {
        await fetch(`http://localhost:${this.port}`, {
          method: "GET",
          signal: AbortSignal.timeout(100),
        });
        return; // Success
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    throw new Error("Timeout waiting for local native server to respond");
  }

  async generate(prompt: string, options?: { onToken?: (token: string) => void }): Promise<string> {
    if (!this.process || this.process.exitCode !== null) {
      await this.loadModel("");
    }

    const response = await fetch(`http://localhost:${this.port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        stream: true,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      throw new Error(`Native server returned status ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response reader available from native server");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    let fullText = "";

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.message?.content) {
              const chunk = parsed.message.content;
              fullText += chunk;
              if (options?.onToken) {
                options.onToken(chunk);
              }
            }
          } catch {
            // ignore malformed line
          }
        }
      }
    }

    return fullText;
  }

  async unload(): Promise<void> {
    if (this.process) {
      try {
        this.process.kill("SIGKILL");
      } catch {}
      this.process = null;
    }
    this.health = "unavailable";
  }

  async getHealth(): Promise<RuntimeHealth> {
    if (!this.process || this.process.exitCode !== null) {
      return "unavailable";
    }
    try {
      const res = await fetch(`http://localhost:${this.port}`, {
        method: "GET",
        signal: AbortSignal.timeout(500),
      });
      if (res.ok || res.status === 404) {
        return "healthy";
      }
    } catch {
      return "failed";
    }
    return this.health;
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      streaming: true,
      embeddings: false,
      vision: false,
      tools: false,
      maxContext: 4096,
    };
  }
}
