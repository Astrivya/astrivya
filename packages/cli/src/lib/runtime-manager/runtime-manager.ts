import { getErrorMessage } from "../../lib/output";
import { NativeRuntime } from "./native-runtime";
import { OllamaRuntime } from "./ollama-runtime";
import type { InferenceRuntime, RuntimeHealth, RuntimeStatus } from "./types";

export class RuntimeManager {
  private static instance: RuntimeManager | null = null;
  private runtimes = new Map<string, InferenceRuntime>();
  private healthOverrides = new Map<string, RuntimeHealth>();

  private constructor() {
    this.register(new NativeRuntime());
    this.register(new OllamaRuntime());
  }

  static getInstance(): RuntimeManager {
    if (!RuntimeManager.instance) {
      RuntimeManager.instance = new RuntimeManager();
    }
    return RuntimeManager.instance;
  }

  register(runtime: InferenceRuntime): void {
    this.runtimes.set(runtime.id, runtime);
  }

  getRuntime(id: string): InferenceRuntime | undefined {
    return this.runtimes.get(id);
  }

  getAllRuntimes(): InferenceRuntime[] {
    return Array.from(this.runtimes.values());
  }

  setHealthOverride(id: string, health: RuntimeHealth): void {
    this.healthOverrides.set(id, health);
  }

  clearHealthOverride(id: string): void {
    this.healthOverrides.delete(id);
  }

  async getHealth(id: string): Promise<RuntimeHealth> {
    const override = this.healthOverrides.get(id);
    if (override) return override;

    const runtime = this.getRuntime(id);
    if (!runtime) return "unavailable";

    try {
      return await runtime.getHealth();
    } catch {
      return "failed";
    }
  }

  async getRuntimeStatuses(): Promise<RuntimeStatus[]> {
    const statuses: RuntimeStatus[] = [];
    for (const runtime of this.getAllRuntimes()) {
      let available = false;
      let status: RuntimeHealth = "unavailable";
      let error: string | undefined;

      try {
        available = await runtime.isAvailable();
        status = await this.getHealth(runtime.id);
      } catch (err: unknown) {
        status = "failed";
        error = getErrorMessage(err);
      }

      let capabilities;
      try {
        capabilities = await runtime.getCapabilities();
      } catch {
        // ignore
      }

      statuses.push({
        id: runtime.id,
        name: runtime.name,
        available,
        status,
        error,
        capabilities,
      });
    }
    return statuses;
  }
}
