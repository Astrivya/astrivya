import { color, getErrorMessage } from "../output";
import { RuntimeManager } from "./runtime-manager";
import { RuntimeSelector } from "./runtime-selector";
import type { RuntimeCapabilities } from "./types";

export class RuntimeExecutor {
  static async generate(
    prompt: string,
    options?: {
      onToken?: (token: string) => void;
      requiredCapabilities?: Partial<RuntimeCapabilities>;
    },
  ): Promise<string> {
    const manager = RuntimeManager.getInstance();

    // Select the best candidate
    let activeRuntime = await RuntimeSelector.selectRuntime(options?.requiredCapabilities);

    const maxRetries = 2;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        await activeRuntime.loadModel("");
        const result = await activeRuntime.generate(prompt, { onToken: options?.onToken });
        return result;
      } catch (err: unknown) {
        attempt++;

        // Mark the active runtime as failed
        manager.setHealthOverride(activeRuntime.id, "failed");

        console.warn(
          `\n  ${color.yellow("!")} Local runtime ${activeRuntime.name} unavailable (${getErrorMessage(err)}).`,
        );

        if (attempt < maxRetries) {
          try {
            await activeRuntime.unload();
          } catch {
            // ignore unload errors
          }

          // Select the next best candidate
          const nextRuntime = await RuntimeSelector.selectRuntime(options?.requiredCapabilities);
          if (nextRuntime.id === activeRuntime.id) {
            throw new Error("No alternative healthy local AI runtime available.");
          }

          activeRuntime = nextRuntime;
          console.warn(`  ${color.green("â†’")} Switched to ${activeRuntime.name} automatically.\n`);
        } else {
          throw new Error(`Local AI query failed after fallback attempts. Original error: ${getErrorMessage(err)}`);
        }
      }
    }

    throw new Error("Local AI query failed to execute");
  }
}
