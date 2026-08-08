import { execFileSync } from "node:child_process";

export async function openBrowser(target: string): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      execFileSync("open", [target], { stdio: "ignore" });
    } else if (platform === "win32") {
      execFileSync("cmd.exe", ["/c", "start", '""', target], { stdio: "ignore" });
    } else {
      execFileSync("xdg-open", [target], { stdio: "ignore" });
    }
  } catch {
    console.log(`\nOpen this URL in your browser:\n  ${target}\n`);
  }
}
