import * as fs from "node:fs";
import * as path from "node:path";
import { getErrorMessage } from "@astrivya/akg-core";
import type { AkgStorage } from "@astrivya/akg-core";

export class AkgEmbedder {
  private pipelineInstance: any = null;

  async init(modelsDir: string): Promise<void> {
    try {
      // Lazy load peer dependency
      const { pipeline, env } = require("@xenova/transformers");
      const modelFile = path.join(modelsDir, "onnx", "model.onnx");
      if (!fs.existsSync(modelFile)) {
        throw new Error(`Model file not found at ${modelFile}. Run "astrivya local setup" to download it.`);
      }

      // Point the transformers.js local-model root at the parent of modelsDir,
      // then load by folder name. Passing the absolute dir as the model id
      // makes transformers.js nest it under its own localModelPath.
      env.localModelPath = path.join(modelsDir, "..") + path.sep;
      env.allowRemoteModels = false;

      this.pipelineInstance = await pipeline("feature-extraction", path.basename(modelsDir), {
        model_file_name: "model",
        quantized: false,
        local_files_only: true,
      });
    } catch (err: unknown) {
      throw new Error(
        `Failed to initialize local ONNX embedder: ${getErrorMessage(err)}. Ensure "@xenova/transformers" and "onnxruntime-node" are installed.`,
      );
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.pipelineInstance) {
      throw new Error("Embedder not initialized");
    }
    const output = await this.pipelineInstance(text, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  }

  async embedAllChunks(
    storage: AkgStorage,
    modelsDir: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ total: number; embedded: number; failed: number }> {
    await this.init(modelsDir);

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
