import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";

export interface DownloaderOptions {
  fetchFn?: typeof fetch;
}

export class PluginDownloader {
  private fetchFn: typeof fetch;

  constructor(opts?: DownloaderOptions) {
    this.fetchFn = opts?.fetchFn ?? globalThis.fetch;
  }

  async download(url: string, destDir: string, expectedSha256: string, authToken?: string): Promise<void> {
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }

    const tmpFile = join(tmpdir(), `astrivya-plugin-${Date.now()}.tgz`);

    const headers: Record<string, string> = {};
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    try {
      const res = await this.fetchFn(url, { headers });
      if (!res.ok) {
        throw new Error(`Download failed: ${res.status} ${res.statusText}`);
      }

      const buf = Buffer.from(await res.arrayBuffer());

      const actualHash = createHash("sha256").update(buf).digest("hex");
      if (actualHash !== expectedSha256) {
        throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actualHash}`);
      }

      await writeFile(tmpFile, buf);

      await tar.extract({
        file: tmpFile,
        cwd: destDir,
        strip: 1,
      });
    } finally {
      try {
        await rmSafe(tmpFile);
      } catch {}
    }
  }

  /**
   * Hash the extracted file tree (paths + contents).
   *
   * NOTE: this is a POST-INSTALL integrity hash of the extracted files, NOT
   * the hash of the .tgz blob returned by the server manifest. It is stored
   * locally after install so that `verify()` can detect later file
   * corruption/tampering on disk. It must never be compared against a remote
   * manifest hash.
   */
  async computeTreeHash(dir: string): Promise<string> {
    const files = await collectFiles(dir);
    const hash = createHash("sha256");
    for (const file of files.sort()) {
      const content = await readFile(join(dir, file));
      hash.update(file);
      hash.update(content);
    }
    return hash.digest("hex");
  }

  async verifyHash(dir: string, expectedSha256: string): Promise<boolean> {
    const actual = await this.computeTreeHash(dir);
    return actual === expectedSha256;
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const results: string[] = [];
  async function walk(relativePath: string) {
    const entries = await readdir(join(dir, relativePath));
    for (const entry of entries) {
      const full = relativePath ? `${relativePath}/${entry}` : entry;
      const s = await stat(join(dir, full));
      if (s.isDirectory()) {
        await walk(full);
      } else {
        results.push(full);
      }
    }
  }
  await walk("");
  return results;
}

async function rmSafe(path: string): Promise<void> {
  try {
    const { rm } = await import("node:fs/promises");
    await rm(path);
  } catch {}
}
