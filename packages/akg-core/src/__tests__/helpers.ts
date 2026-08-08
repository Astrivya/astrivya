import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function createTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akg-e2e-"));
}

export function cleanupTempWorkspace(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
