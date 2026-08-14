import * as fs from "node:fs";
import * as path from "node:path";
import { getErrorMessage } from "@astrivya/akg-core";
import type { AkgStorage } from "@astrivya/akg-core";

export type EmbedderStrategy = "local" | "llm" | "none";

export interface AkgEmbedderOptions {
  /** BYOK provider. Only `openai` has a native embedding API (Anthropic falls back). */
  provider?: "openai" | "anthropic";
  /** Provider API key (defaults to ASTRIVYA_OPENAI_KEY / ASTRIVYA_ANTHROPIC_KEY). */
  apiKey?: string;
  /** Embedding model id (default text-embedding-3-small / ASTRIVYA_EMBED_MODEL). */
  model?: string;
  /** Prefer the LLM embedder even when the local ONNX model is present. */
  prefer?: "local" | "llm";
}

const DEFAULT_MODEL = "text-embedding-3-small";
const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";

function normalize(vector: number[]): number[] {
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) return new Array(vector.length).fill(0);
  return vector.map((v) => v / norm);
}

/** BYOK OpenAI embeddings via the public API. No SDK dependency — a raw POST. */
class LlmEmbedder {
  constructor(
    private readonly key: string,
    private readonly model: string,
  ) {}

  async embed(text: string): Promise<number[]> {
    const res = await fetch(OPENAI_EMBED_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const vec = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) throw new Error("OpenAI embeddings returned no vector");
    return normalize(vec);
  }
}

/**
 * Embedding strategy chain. A single strategy is resolved **once** at `init`
 * and used for both indexing and querying, so query vectors always share the
 * dimension of the indexed vectors (local ONNX = 384, BYOK = 1536) — mixing
 * dims would make cosine similarity meaningless.
 *
 * Priority (offline/local first by default):
 *   1. BYOK (openai) when `ASTRIVYA_EMBED_BYOK=1` (or `prefer: "llm"`) and a key exists.
 *   2. Local ONNX when the model is present.
 *   3. BYOK (openai) as a fallback when the local model is missing.
 *   4. Disabled.
 * Anthropic has no native embedding API, so an anthropic BYOK key never yields
 * an llm strategy — it falls through to local/off.
 */
export class AkgEmbedder {
  private pipelineInstance: any = null;
  private llm: LlmEmbedder | null = null;
  private strategy: EmbedderStrategy = "none";

  async init(modelsDir: string, options: AkgEmbedderOptions = {}): Promise<void> {
    const openaiKey = options.apiKey || process.env.ASTRIVYA_OPENAI_KEY;
    const provider =
      options.provider ||
      (process.env.ASTRIVYA_OPENAI_KEY
        ? "openai"
        : process.env.ASTRIVYA_ANTHROPIC_KEY
          ? "anthropic"
          : undefined);
    const model = options.model || process.env.ASTRIVYA_EMBED_MODEL || DEFAULT_MODEL;
    const prefer = options.prefer || (process.env.ASTRIVYA_EMBED_BYOK === "1" ? "llm" : "local");

    // Only OpenAI has a native embedding API — an anthropic key is stored but
    // never yields an llm strategy (falls through to local/off).
    const llmCapable = provider === "openai" && !!openaiKey;
    const localAvailable = fs.existsSync(path.join(modelsDir, "onnx", "model.onnx"));

    const setLlm = () => {
      this.strategy = "llm";
      this.llm = new LlmEmbedder(openaiKey!, model);
    };

    if (prefer === "llm") {
      if (llmCapable) {
        setLlm();
        return;
      }
      // Preferred llm but no openai key → local, only when the model exists.
      if (localAvailable && (await this.tryLocal(modelsDir))) return;
      return;
    }

    // Offline/local first by default. Never attempt local without the model
    // file — avoids loading transformers.js for nothing.
    if (localAvailable && (await this.tryLocal(modelsDir))) return;
    if (llmCapable) setLlm();
  }

  /** Load the local ONNX pipeline; returns false (and never throws) on failure. */
  private async tryLocal(modelsDir: string): Promise<boolean> {
    try {
      // Dynamic import so tests can mock the module; tsup emits `require` in
      // the CJS bundle, keeping the peer dep lazy in production.
      const { pipeline, env } = await import("@xenova/transformers");
      env.localModelPath = path.join(modelsDir, "..") + path.sep;
      env.allowRemoteModels = false;
      this.pipelineInstance = await pipeline("feature-extraction", path.basename(modelsDir), {
        model_file_name: "model",
        quantized: false,
        local_files_only: true,
      });
      this.strategy = "local";
      return true;
    } catch {
      return false;
    }
  }

  get activeStrategy(): EmbedderStrategy {
    return this.strategy;
  }

  /** Whether any strategy is usable right now. */
  available(): boolean {
    return this.strategy !== "none";
  }

  async embed(text: string): Promise<number[]> {
    if (this.strategy === "llm" && this.llm) {
      return this.llm.embed(text);
    }
    if (this.strategy === "local" && this.pipelineInstance) {
      const output = await this.pipelineInstance(text, { pooling: "mean", normalize: true });
      return Array.from(output.data);
    }
    throw new Error(
      "No embedder available (no local ONNX model and no BYOK openai key). Install the local model with `astrivya local setup`, or set ASTRIVYA_OPENAI_KEY (+ ASTRIVYA_EMBED_BYOK=1).",
    );
  }

  async embedAllChunks(
    storage: AkgStorage,
    modelsDir: string,
    onProgress?: (done: number, total: number) => void,
    options: AkgEmbedderOptions = {},
  ): Promise<{ total: number; embedded: number; failed: number }> {
    await this.init(modelsDir, options);
    if (this.strategy === "none") {
      return { total: 0, embedded: 0, failed: 0 };
    }

    const unindexedChunks = storage.runQuery(`
      SELECT c.id, c.content FROM chunks c
      LEFT JOIN embeddings e ON c.id = e.chunk_id
      WHERE e.chunk_id IS NULL;
    `);

    if (unindexedChunks.length === 0) {
      return { total: 0, embedded: 0, failed: 0 };
    }

    let embedded = 0;
    let failed = 0;

    for (let i = 0; i < unindexedChunks.length; i++) {
      const chunk = unindexedChunks[i];
      if (onProgress) onProgress(i, unindexedChunks.length);
      try {
        const vector = await this.embed(chunk.content);
        const floatArray = new Float32Array(vector);
        const vectorBuffer = Buffer.from(floatArray.buffer);

        storage.run("INSERT OR REPLACE INTO embeddings (chunk_id, vector, dimension) VALUES (?, ?, ?);", [
          chunk.id,
          vectorBuffer,
          vector.length,
        ]);
        embedded++;
      } catch (err: unknown) {
        console.warn(`Failed to embed chunk ${chunk.id}: ${getErrorMessage(err)}`);
        failed++;
      }
    }

    if (embedded > 0) {
      storage.saveToDisk();
    }

    return {
      total: unindexedChunks.length,
      embedded,
      failed,
    };
  }
}