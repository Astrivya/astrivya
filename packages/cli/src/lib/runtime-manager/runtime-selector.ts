import { loadConfig } from "../compat";
import { loadBenchmarks } from "./benchmark";
import { RuntimeManager } from "./runtime-manager";
import type { InferenceRuntime, RuntimeCapabilities } from "./types";

export class RuntimeSelector {
  static async selectRuntime(requiredCapabilities?: Partial<RuntimeCapabilities>): Promise<InferenceRuntime> {
    const manager = RuntimeManager.getInstance();
    const config = loadConfig();

    // Check manual override config first
    const manualChoice = config.localAiRuntime;
    if (manualChoice && manualChoice !== "auto") {
      const runtime = manager.getRuntime(manualChoice);
      if (runtime) {
        const available = await runtime.isAvailable();
        const health = await manager.getHealth(runtime.id);
        if (available && health !== "failed" && health !== "unavailable") {
          return runtime;
        }
      }
    }

    // scoring-based candidate matching
    const candidates = manager.getAllRuntimes();
    const scores = new Map<string, number>();

    // Load benchmarks
    const benchmarks = loadBenchmarks();

    // Find benchmark winner (fastest TTFT or highest TPS)
    let bestRuntimeId: string | null = null;
    let maxTps = 0;
    for (const rid of Object.keys(benchmarks)) {
      const b = benchmarks[rid];
      if (b.successRate > 50 && b.tps > maxTps) {
        maxTps = b.tps;
        bestRuntimeId = rid;
      }
    }

    for (const runtime of candidates) {
      let score = 0;

      // 1. Availability (+50)
      const available = await runtime.isAvailable();
      if (available) {
        score += 50;
      }

      // 2. Health (+30)
      const health = await manager.getHealth(runtime.id);
      if (health === "healthy") {
        score += 30;
      } else if (health === "degraded") {
        score += 15;
      }

      // 3. Benchmark Winner (+20)
      if (bestRuntimeId && runtime.id === bestRuntimeId) {
        score += 20;
      }

      // 4. Capability Match (+10)
      if (requiredCapabilities) {
        const capabilities = await runtime.getCapabilities();
        let matchesAll = true;
        for (const key of Object.keys(requiredCapabilities) as Array<keyof RuntimeCapabilities>) {
          const reqVal = requiredCapabilities[key];
          const actualVal = capabilities[key];
          if (typeof reqVal === "boolean" && reqVal && !actualVal) {
            matchesAll = false;
            break;
          }
          if (typeof reqVal === "number" && typeof actualVal === "number" && actualVal < reqVal) {
            matchesAll = false;
            break;
          }
        }
        if (matchesAll) {
          score += 10;
        }
      }

      scores.set(runtime.id, score);
    }

    // Rank candidate runtimes filtering out unavailable/failed ones
    const activeCandidates: InferenceRuntime[] = [];
    for (const r of candidates) {
      const health = await manager.getHealth(r.id);
      const available = await r.isAvailable();
      if (available && health !== "failed" && health !== "unavailable") {
        activeCandidates.push(r);
      }
    }

    const ranked = activeCandidates.sort((a, b) => {
      const scoreA = scores.get(a.id) || 0;
      const scoreB = scores.get(b.id) || 0;
      return scoreB - scoreA;
    });

    const fallbacks = config.localAiFallbacks || ["native", "ollama"];

    if (ranked.length > 0) {
      // In case of a tie, use fallback order
      const bestScore = scores.get(ranked[0].id) || 0;
      const topTied = ranked.filter((r) => (scores.get(r.id) || 0) === bestScore);
      if (topTied.length > 1) {
        for (const fid of fallbacks) {
          const matched = topTied.find((r) => r.id === fid);
          if (matched) return matched;
        }
      }
      return ranked[0];
    }

    // Default fallback to first registered runtime that is available
    for (const r of candidates) {
      if (await r.isAvailable()) {
        return r;
      }
    }

    // Absolute fallback: return NativeRuntime
    const native = manager.getRuntime("native");
    if (native) return native;

    throw new Error("No local AI runtime registered or available");
  }
}
