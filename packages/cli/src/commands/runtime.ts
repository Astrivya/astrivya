import type { Command } from "commander";
import { loadConfig, saveConfig } from "../lib/compat";
import { color, error, getErrorMessage, info, startSpinner, success, table, warn } from "../lib/output";
import { loadBenchmarks, runRuntimeBenchmark, saveBenchmarks } from "../lib/runtime-manager/benchmark";
import { RuntimeManager } from "../lib/runtime-manager/runtime-manager";
import { RuntimeSelector } from "../lib/runtime-manager/runtime-selector";

export function registerRuntime(program: Command): void {
  const rt = program.command("runtime").description("Manage local AI inference runtimes");

  rt.command("status")
    .description("Show the status and health of all registered local AI runtimes")
    .action(async () => {
      const manager = RuntimeManager.getInstance();
      const config = loadConfig();
      const activeRuntimeMode = config.localAiRuntime || "auto";

      console.log(`\n${color.bold("Local AI Runtimes Status")}\n`);

      const statuses = await manager.getRuntimeStatuses();
      const rows: string[][] = [];

      for (const s of statuses) {
        const checkIcon =
          s.available && s.status === "healthy"
            ? color.green("\u2713")
            : s.status === "degraded"
              ? color.yellow("!")
              : color.red("\u2717");

        rows.push([checkIcon, s.id, s.name, s.status.toUpperCase(), s.available ? "Yes" : "No", s.error || "None"]);
      }

      table(["", "ID", "Name", "Health", "Available", "Error"], rows);

      console.log(`\n${color.bold("Current Configuration:")}`);
      console.log(`  Mode: ${color.cyan(activeRuntimeMode)}`);

      try {
        const activeRuntime = await RuntimeSelector.selectRuntime();
        console.log(`  Active Engine: ${color.green(activeRuntime.name)} (${activeRuntime.id})`);
      } catch (err: unknown) {
        console.log(`  Active Engine: ${color.red("None available")} (${getErrorMessage(err)})`);
      }
      console.log();
    });

  rt.command("use <runtime>")
    .description("Manually switch the active local AI inference runtime")
    .action(async (runtimeId) => {
      const manager = RuntimeManager.getInstance();
      const validRuntimes = ["auto", "native", "ollama"];

      if (!validRuntimes.includes(runtimeId)) {
        error(`Invalid runtime: ${runtimeId}. Supported values: ${validRuntimes.join(", ")}`);
        process.exit(1);
      }

      if (runtimeId !== "auto") {
        const rtObj = manager.getRuntime(runtimeId);
        if (!rtObj) {
          error(`Runtime '${runtimeId}' is not registered`);
          process.exit(1);
        }
      }

      const config = loadConfig();
      saveConfig({
        ...config,
        localAiRuntime: runtimeId as any,
      });

      success(`Successfully configured local AI runtime mode to '${runtimeId}'.`);
      if (runtimeId === "auto") {
        info("Astrivya will automatically select the best available runtime on launch.");
      } else {
        info(`Astrivya is locked to use the '${runtimeId}' runtime.`);
      }
    });

  rt.command("benchmark")
    .description("Run Time-To-First-Token (TTFT) and Tokens-Per-Second (TPS) benchmarks on available runtimes")
    .action(async () => {
      const manager = RuntimeManager.getInstance();
      const runtimes = manager.getAllRuntimes();
      const benchmarks = loadBenchmarks();

      console.log(`\n${color.bold("Running Local AI Runtimes Benchmark...")}\n`);

      const rows: string[][] = [];

      for (const runtime of runtimes) {
        const available = await runtime.isAvailable();
        if (!available) {
          warn(`Skipping runtime ${runtime.name} (not available).`);
          continue;
        }

        const spinner = startSpinner(`Testing performance of ${runtime.name}...`);
        try {
          const res = await runRuntimeBenchmark(runtime.id);
          spinner.stop();

          if (res.successRate > 0) {
            benchmarks[runtime.id] = res;
            rows.push([runtime.name, `${res.ttft}s`, `${res.tps} tokens/s`, `${res.successRate}%`]);
            success(`Finished benchmarking ${runtime.name} successfully.`);
          } else {
            rows.push([runtime.name, "N/A", "N/A", "0% (Failed)"]);
            error(`Failed to benchmark ${runtime.name}.`);
          }
        } catch (err: unknown) {
          spinner.stop();
          error(`Failed to benchmark ${runtime.name}: ${getErrorMessage(err)}`);
        }
      }

      saveBenchmarks(benchmarks);

      if (rows.length > 0) {
        console.log(`\n${color.bold("Benchmark Results:")}\n`);
        table(["Runtime Name", "TTFT (First Token)", "TPS (Tokens/Sec)", "Success Rate"], rows);
        success("Persisted benchmark stats to local configuration registry.");
      } else {
        warn("No active runtimes were successfully benchmarked.");
      }
      console.log();
    });
}
