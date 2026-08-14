import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AkgEmbedder } from "../embedder";

vi.mock("@xenova/transformers", () => ({
  pipeline: vi.fn(async () => {
    // 0.5 / -0.25 / 1 / 0 are exactly representable as float32 — no precision drift.
    const output = { data: new Float32Array([0.5, -0.25, 1, 0]) };
    return async () => output;
  }),
  env: {},
}));

const tmpDirs: string[] = [];

function makeModelsDir(withModel: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "akg-emb-"));
  tmpDirs.push(dir);
  if (withModel) {
    mkdirSync(join(dir, "onnx"), { recursive: true });
    writeFileSync(join(dir, "onnx", "model.onnx"), "fake");
  }
  return dir;
}

const envKeys = ["ASTRIVYA_OPENAI_KEY", "ASTRIVYA_ANTHROPIC_KEY", "ASTRIVYA_EMBED_BYOK"] as const;

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of envKeys) {
    delete process.env[key];
  }
});

describe("AkgEmbedder strategy chain", () => {
  it("resolves local when the model exists and no BYOK preference is set", async () => {
    const emb = new AkgEmbedder();
    await emb.init(makeModelsDir(true));
    expect(emb.activeStrategy).toBe("local");
    expect(emb.available()).toBe(true);
    const v = await emb.embed("hello");
    expect(v).toEqual([0.5, -0.25, 1, 0]);
  });

  it("resolves llm when BYOK is preferred (ASTRIVYA_EMBED_BYOK=1 + openai key)", async () => {
    process.env.ASTRIVYA_OPENAI_KEY = "sk-test";
    process.env.ASTRIVYA_EMBED_BYOK = "1";
    const emb = new AkgEmbedder();
    await emb.init(makeModelsDir(true));
    expect(emb.activeStrategy).toBe("llm");
  });

  it("falls back to llm when the local model is missing and an openai key exists", async () => {
    process.env.ASTRIVYA_OPENAI_KEY = "sk-test";
    const emb = new AkgEmbedder();
    await emb.init(makeModelsDir(false));
    expect(emb.activeStrategy).toBe("llm");
  });

  it("resolves none when there is no model and no openai key", async () => {
    const emb = new AkgEmbedder();
    await emb.init(makeModelsDir(false));
    expect(emb.activeStrategy).toBe("none");
    expect(emb.available()).toBe(false);
    await expect(emb.embed("x")).rejects.toThrow(/No embedder available/);
  });

  it("never uses an anthropic key for embeddings (no native embedding API)", async () => {
    process.env.ASTRIVYA_ANTHROPIC_KEY = "sk-ant-test";
    process.env.ASTRIVYA_EMBED_BYOK = "1";
    const emb = new AkgEmbedder();
    await emb.init(makeModelsDir(false));
    expect(emb.activeStrategy).toBe("none");
  });

  it("falls back to llm when local init fails and a key exists", async () => {
    process.env.ASTRIVYA_OPENAI_KEY = "sk-test";
    const emb = new AkgEmbedder();
    // model file present, but the mocked pipeline throws → local fails → llm
    const mod = await import("@xenova/transformers");
    (mod.pipeline as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("load failed"));
    await emb.init(makeModelsDir(true));
    expect(emb.activeStrategy).toBe("llm");
    (mod.pipeline as ReturnType<typeof vi.fn>).mockReset();
    (mod.pipeline as ReturnType<typeof vi.fn>).mockResolvedValue(async () => ({ data: new Float32Array(4) }));
  });

  it("embedAllChunks with no strategy is a no-op, not a failure", async () => {
    const emb = new AkgEmbedder();
    const modelsDir = makeModelsDir(false);
    const storage = {
      runQuery: () => [],
      run: () => {},
      saveToDisk: () => {},
    } as any;
    const result = await emb.embedAllChunks(storage, modelsDir);
    expect(result).toEqual({ total: 0, embedded: 0, failed: 0 });
  });
});
