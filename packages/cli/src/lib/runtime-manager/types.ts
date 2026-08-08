export type RuntimeHealth = "healthy" | "degraded" | "failed" | "unavailable";

export interface RuntimeCapabilities {
  streaming: boolean;
  embeddings: boolean;
  vision: boolean;
  tools: boolean;
  maxContext: number;
}

export interface InferenceRuntime {
  id: string;
  name: string;
  isAvailable(): Promise<boolean>;
  loadModel(modelPath: string): Promise<void>;
  generate(prompt: string, options?: { onToken?: (token: string) => void }): Promise<string>;
  unload(): Promise<void>;
  getHealth(): Promise<RuntimeHealth>;
  getCapabilities(): Promise<RuntimeCapabilities>;
}

export interface BenchmarkResult {
  runtimeId: string;
  ttft: number; // Time to first token in seconds
  tps: number; // Tokens per second
  successRate: number; // Success rate percentage (0 - 100)
  timestamp: number;
}

export interface RuntimeStatus {
  id: string;
  name: string;
  available: boolean;
  status: RuntimeHealth;
  error?: string;
  capabilities?: RuntimeCapabilities;
}
