import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { confirm, select } from "@inquirer/prompts";
import type { Command } from "commander";
import envPaths from "env-paths";
import { loadConfig, saveConfig } from "../lib/compat";
import { color, error, getErrorMessage, info, startSpinner, success, warn } from "../lib/output";

const paths = envPaths("astrivya", { suffix: "" });

function getModelsDir(): string {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return path.join(process.cwd(), ".config-test", "models");
  }
  return path.join(paths.config, "models");
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkOllamaRunning(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function downloadFile(url: string, destPath: string, displayName: string): Promise<void> {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // If already exists and has size > 1MB, skip
  if (fs.existsSync(destPath)) {
    const stats = fs.statSync(destPath);
    if (stats.size > 1024 * 1024) {
      console.log(`  ${color.green("\u2713")} ${displayName} already downloaded.`);
      return;
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength ? Number.parseInt(contentLength, 10) : 0;

  const fileStream = fs.createWriteStream(destPath);
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response reader available");
  }

  let downloadedBytes = 0;
  let lastProgress = 0;

  const spinner = startSpinner(`Downloading ${displayName}...`);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (value) {
      fileStream.write(Buffer.from(value));
      downloadedBytes += value.length;

      if (totalBytes > 0) {
        const pct = Math.round((downloadedBytes / totalBytes) * 100);
        if (pct !== lastProgress && pct % 5 === 0) {
          lastProgress = pct;
          (spinner as any).text = `Downloading ${displayName} (${pct}%)...`;
        }
      }
    }
  }

  fileStream.end();
  spinner.succeed(`Downloaded ${displayName} successfully.`);
}

export function registerLocal(program: Command): void {
  const local = program.command("local").description("Manage local AI resource pack and offline mode");

  local
    .command("setup")
    .description("Guided interactive setup for Local AI offline execution")
    .action(async () => {
      try {
        console.log(`\n${color.bold("Astrivya Local AI Setup Wizard")}\n`);

        // 1. Resource Assessment
        const totalRamGb = Math.round(os.totalmem() / (1024 * 1024 * 1024));
        const arch = os.arch();
        const platform = os.platform();
        const cpus = os.cpus().length;

        console.log("  Checking system resources...");
        let osName: string = platform;
        if (platform === "darwin") osName = "macOS";
        else if (platform === "win32") osName = "Windows";
        else if (platform === "linux") osName = "Linux";

        console.log(`  Detected: ${color.bold(osName)} (${arch} CPU, ${cpus} cores, ${totalRamGb}GB RAM)`);

        // Recommendation logic
        let recommendation: "lite" | "smart" = "lite";
        let recReason = "optimized for standard CPU execution and minimal RAM usage";

        if (totalRamGb >= 16) {
          recommendation = "smart";
          recReason = "highly recommended for your system specs; leverages GPU acceleration";
        }

        console.log(`  Recommended Profile: ${color.green(recommendation.toUpperCase())} (${recReason})\n`);

        // 2. Select profile
        const profile = await select<"lite" | "smart">({
          message: "Select your performance profile:",
          choices: [
            {
              name: "Lite (Fast, optimized for standard CPU, ~350MB data package)",
              value: "lite",
              description: "Uses Qwen2.5-0.5B + Snowflake Arctic XS embeddings",
            },
            {
              name: "Smart (Highly capable, GPU-accelerated, ~900MB data package)",
              value: "smart",
              description: "Uses Qwen2.5-1.5B + Snowflake Arctic XS embeddings",
            },
          ],
          default: recommendation,
        });

        // 3. Confirm download
        const start = await confirm({
          message: `Start downloading ${profile.toUpperCase()} profile resource package?`,
          default: true,
        });

        if (!start) {
          console.log(color.dim("\nSetup cancelled."));
          return;
        }

        console.log();

        // 4. Real Downloads
        const modelsDir = getModelsDir();
        const embedUrl = "https://huggingface.co/Snowflake/snowflake-arctic-embed-xs/resolve/main/onnx/model.onnx";
        const onnxDir = path.join(modelsDir, "onnx");
        fs.mkdirSync(onnxDir, { recursive: true });
        const embedDest = path.join(onnxDir, "model.onnx");
        await downloadFile(embedUrl, embedDest, "Snowflake Arctic Embeddings (ONNX, ~45MB)");

        // The @xenova/transformers pipeline (local_files_only) also needs the
        // tokenizer + config files (repo root), not just the onnx/ model.
        for (const component of [
          "config.json",
          "tokenizer.json",
          "tokenizer_config.json",
          "special_tokens_map.json",
          "vocab.txt",
        ]) {
          const url = `https://huggingface.co/Snowflake/snowflake-arctic-embed-xs/resolve/main/${component}`;
          await downloadFile(url, path.join(modelsDir, component), `Snowflake Arctic Embeddings (${component})`);
        }

        const modelUrl =
          profile === "lite"
            ? "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"
            : "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf";
        const modelName =
          profile === "lite" ? "Qwen 0.5B Instruct (GGUF, ~398MB)" : "Qwen 1.5B Instruct (GGUF, ~1.2GB)";
        const modelDest = path.join(
          modelsDir,
          profile === "lite" ? "qwen2.5-0.5b-instruct-q4_k_m.gguf" : "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        );

        await downloadFile(modelUrl, modelDest, modelName);

        // 5. Detect Ollama
        const ollamaUrl = "http://localhost:11434";
        const spinOllama = startSpinner("Detecting running local Ollama service...");
        await delay(1000);
        const ollamaRunning = await checkOllamaRunning(ollamaUrl);

        if (ollamaRunning) {
          spinOllama.succeed(`Ollama running server detected successfully at ${ollamaUrl}.`);
        } else {
          spinOllama.stop();
          warn("No running Ollama server detected. Will use native WebAssembly fallback runtime.");
        }

        // 6. Save Configuration
        const config = loadConfig();
        saveConfig({
          ...config,
          offlineMode: true,
          localAiProfile: profile,
          ollamaUrl: ollamaUrl,
          customModelPath: modelDest,
        });

        console.log();
        success("Local AI setup completed successfully!");
        info("Offline Mode has been enabled (100% offline, zero network requests).");
        console.log(`  To toggle offline execution run: ${color.cyan("astrivya local toggle")}\n`);
      } catch (err: unknown) {
        error(`Local setup failed: ${getErrorMessage(err)}`);
        process.exitCode = 1;
        return;
      }
    });

  local
    .command("toggle")
    .description("Toggle offline execution mode")
    .action(() => {
      try {
        const config = loadConfig();
        const currentMode = !!config.offlineMode;
        const nextMode = !currentMode;

        saveConfig({
          ...config,
          offlineMode: nextMode,
        });

        if (nextMode) {
          success("Offline mode enabled (100% offline, zero network requests).");
        } else {
          success("Offline mode disabled (smart routing active).");
        }
      } catch (err: unknown) {
        error(`Failed to toggle offline mode: ${getErrorMessage(err)}`);
        process.exitCode = 1;
        return;
      }
    });
}
