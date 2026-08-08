import { loadConfig } from "../compat";
import type { InferenceRuntime, RuntimeCapabilities, RuntimeHealth } from "./types";

export class OllamaRuntime implements InferenceRuntime {
  id = "ollama";
  name = "Ollama Runtime";

  private getOllamaUrl(): string {
    const config = loadConfig();
    return config.ollamaUrl || "http://localhost:11434";
  }

  async isAvailable(): Promise<boolean> {
    try {
      const url = this.getOllamaUrl();
      const res = await fetch(`${url}/api/tags`, {
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async loadModel(_modelPath: string): Promise<void> {
    // Check if the server is available
    const available = await this.isAvailable();
    if (!available) {
      throw new Error(`Ollama server is not running at ${this.getOllamaUrl()}`);
    }

    // Check if qwen2.5 is loaded, or fallback if tags list doesn't contain it
    try {
      const url = this.getOllamaUrl();
      const res = await fetch(`${url}/api/tags`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        const data = (await res.json()) as { models?: { name: string }[] };
        const models = data.models || [];
        const hasModel = models.some((m: any) => m.name.includes("qwen2.5") || m.name.includes("qwen"));
        if (!hasModel) {
          console.warn(
            `  [Ollama] Warning: No 'qwen2.5' model detected in Ollama. Try running 'ollama pull qwen2.5' if queries fail.`,
          );
        }
      }
    } catch {
      // ignore check error
    }
  }

  async generate(prompt: string, options?: { onToken?: (token: string) => void }): Promise<string> {
    const url = this.getOllamaUrl();
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen2.5",
        messages: [{ role: "user", content: prompt }],
        stream: true,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      throw new Error(`Ollama server returned status ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response reader available from Ollama server");
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
    // Ollama manages its own unloading
  }

  async getHealth(): Promise<RuntimeHealth> {
    const available = await this.isAvailable();
    return available ? "healthy" : "unavailable";
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      streaming: true,
      embeddings: true,
      vision: false,
      tools: true,
      maxContext: 8192,
    };
  }
}
