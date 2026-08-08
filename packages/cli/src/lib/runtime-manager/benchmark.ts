import * as fs from "node:fs";
import * as path from "node:path";
import envPaths from "env-paths";
import { RuntimeManager } from "./runtime-manager";
import type { BenchmarkResult } from "./types";

const paths = envPaths("astrivya", { suffix: "" });

export function getBenchmarksPath(): string {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return path.join(process.cwd(), ".config-test", "benchmarks.json");
  }
  return path.join(paths.config, "benchmarks.json");
}

export function loadBenchmarks(): Record<string, BenchmarkResult> {
  try {
    const raw = fs.readFileSync(getBenchmarksPath(), "utf-8");
    return JSON.parse(raw) as Record<string, BenchmarkResult>;
  } catch {
    return {};
  }
}

export function saveBenchmarks(benchmarks: Record<string, BenchmarkResult>): void {
  try {
    const filePath = getBenchmarksPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(benchmarks, null, 2), "utf-8");
  } catch {
    // ignore save errors
  }
}

export async function runRuntimeBenchmark(runtimeId: string): Promise<BenchmarkResult> {
  const manager = RuntimeManager.getInstance();
  const runtime = manager.getRuntime(runtimeId);
  if (!runtime) {
    throw new Error(`Runtime ${runtimeId} not found`);
  }

  const available = await runtime.isAvailable();
  if (!available) {
    throw new Error(`Runtime ${runtimeId} is not available`);
  }

  const prompt = "Explain coding in one short sentence.";
  let firstTokenTime: number | null = null;
  const startTime = Date.now();
  let text = "";

  try {
    await runtime.loadModel("");

    text = await runtime.generate(prompt, {
      onToken() {
        if (firstTokenTime === null) {
          firstTokenTime = Date.now();
        }
      },
    });

    const endTime = Date.now();
    const tokenTime = firstTokenTime || endTime;
    const ttft = (tokenTime - startTime) / 1000;

    // Estimate tokens: standard approximation is 4 characters per token
    const tokenCount = Math.max(1, Math.round(text.length / 4));
    const generationDuration = (endTime - tokenTime) / 1000;
    const tps = generationDuration > 0 ? tokenCount / generationDuration : tokenCount;

    return {
      runtimeId,
      ttft: Number.parseFloat(ttft.toFixed(3)),
      tps: Number.parseFloat(tps.toFixed(2)),
      successRate: 100,
      timestamp: Date.now(),
    };
  } catch (_err: unknown) {
    return {
      runtimeId,
      ttft: 0,
      tps: 0,
      successRate: 0,
      timestamp: Date.now(),
    };
  }
}
