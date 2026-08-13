import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn<() => { autoUpdate?: "on" | "prompt" | "off" }>(() => ({})),
  getPremiumAuth: vi.fn<() => string | undefined>(() => undefined),
  getBaseUrl: vi.fn<() => string>(() => "https://api.astrivya.ai"),
}));

vi.mock("../lib/compat", () => ({
  loadConfig: mocks.loadConfig,
  saveConfig: vi.fn(),
  getPremiumAuth: mocks.getPremiumAuth,
  getBaseUrl: mocks.getBaseUrl,
}));

vi.mock("@astrivya/plugin-runtime", () => {
  return {
    PluginManager: class {
      syncCalls = 0;
      async sync() {
        this.syncCalls++;
        return { synced: [], updated: ["cloud-cli"], failed: [], removed: [] };
      }
    },
  };
});

import {
  markUpdateFailed,
  markUpdateSucceeded,
  maybeAutoUpdate,
  maybeSyncPlugins,
  readPluginSyncCache,
  sameMajor,
  shouldAutoInstall,
  shouldSyncPlugins,
} from "../lib/auto-update";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "astrivya-auto-update-"));
}

describe("auto-update — sameMajor", () => {
  it("accepts same-major updates", () => {
    expect(sameMajor("0.1.0", "0.2.0")).toBe(true);
    expect(sameMajor("1.4.2", "1.5.0")).toBe(true);
  });

  it("rejects major jumps", () => {
    expect(sameMajor("0.9.9", "1.0.0")).toBe(false);
    expect(sameMajor("1.9.0", "2.0.0")).toBe(false);
  });
});

describe("auto-update — shouldAutoInstall", () => {
  const now = 1_000_000;
  const day = 24 * 60 * 60 * 1000;

  it("installs a newer same-major version for global installs", () => {
    expect(shouldAutoInstall({}, "0.2.0", "0.1.0", "npm", now)).toBe(true);
    expect(shouldAutoInstall({}, "0.2.0", "0.1.0", "pnpm", now)).toBe(true);
    expect(shouldAutoInstall({}, "0.2.0", "0.1.0", "bun", now)).toBe(true);
  });

  it("never auto-installs local or unknown installs", () => {
    expect(shouldAutoInstall({}, "0.2.0", "0.1.0", "local", now)).toBe(false);
    expect(shouldAutoInstall({}, "0.2.0", "0.1.0", "unknown", now)).toBe(false);
  });

  it("never auto-installs across major versions", () => {
    expect(shouldAutoInstall({}, "1.0.0", "0.9.9", "npm", now)).toBe(false);
  });

  it("backs off for 24h after a failed install", () => {
    expect(shouldAutoInstall({ lastFailedAt: now - 1000 }, "0.2.0", "0.1.0", "npm", now)).toBe(false);
    expect(shouldAutoInstall({ lastFailedAt: now - day - 1000 }, "0.2.0", "0.1.0", "npm", now)).toBe(true);
  });
});

describe("auto-update — failure markers", () => {
  it("round-trips lastFailedAt and clears on success", () => {
    const dir = tempDir();
    const file = join(dir, "update.json");
    try {
      markUpdateFailed(file, 123);
      expect(JSON.parse(readFileSync(file, "utf8")).lastFailedAt).toBe(123);

      markUpdateSucceeded(file);
      const cache = JSON.parse(readFileSync(file, "utf8"));
      expect(cache.lastFailedAt).toBeUndefined();
      expect(cache.notifiedVersion).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("auto-update — maybeAutoUpdate", () => {
  const day = 24 * 60 * 60 * 1000;

  afterEach(() => {
    mocks.loadConfig.mockReturnValue({});
    mocks.getPremiumAuth.mockReturnValue(undefined);
  });

  it("skips when --no-update-check is passed", async () => {
    const dir = tempDir();
    const file = join(dir, "update.json");
    const installer = vi.fn<(cmd: string) => boolean>(() => true);
    try {
      await maybeAutoUpdate({ noUpdateCheck: true, fetcher: async () => "0.2.0", installer }, file);
      expect(installer).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs silently in autoUpdate=on mode", async () => {
    mocks.loadConfig.mockReturnValue({ autoUpdate: "on" });
    const dir = tempDir();
    const file = join(dir, "update.json");
    const installer = vi.fn<(cmd: string) => boolean>(() => true);
    const prevArgv = process.argv[1];
    process.argv[1] = "/usr/lib/node_modules/@astrivya/cli/dist/index.js";
    try {
      await maybeAutoUpdate({ fetcher: async () => "0.2.0", installer }, file);
      expect(installer).toHaveBeenCalledTimes(1);
      expect(installer.mock.calls[0][0]).toContain("npm");
    } finally {
      process.argv[1] = prevArgv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never auto-installs local installs (banner only)", async () => {
    mocks.loadConfig.mockReturnValue({ autoUpdate: "on" });
    const dir = tempDir();
    const file = join(dir, "update.json");
    const installer = vi.fn<(cmd: string) => boolean>(() => true);
    const prevArgv = process.argv[1];
    process.argv[1] = "/project/node_modules/@astrivya/cli/dist/index.js";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await maybeAutoUpdate({ fetcher: async () => "0.2.0", installer }, file);
      expect(installer).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
      process.argv[1] = prevArgv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips major jumps (banner only)", async () => {
    mocks.loadConfig.mockReturnValue({ autoUpdate: "on" });
    const dir = tempDir();
    const file = join(dir, "update.json");
    const installer = vi.fn<(cmd: string) => boolean>(() => true);
    try {
      await maybeAutoUpdate({ fetcher: async () => "1.0.0", installer }, file);
      expect(installer).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backs off after a recent failed install", async () => {
    mocks.loadConfig.mockReturnValue({ autoUpdate: "on" });
    const dir = tempDir();
    const file = join(dir, "update.json");
    const installer = vi.fn<(cmd: string) => boolean>(() => true);
    const prevArgv = process.argv[1];
    process.argv[1] = "/usr/lib/node_modules/@astrivya/cli/dist/index.js";
    try {
      markUpdateFailed(file, Date.now());
      await maybeAutoUpdate({ fetcher: async () => "0.2.0", installer }, file);
      expect(installer).not.toHaveBeenCalled();
    } finally {
      process.argv[1] = prevArgv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not prompt or install when stdin is not a TTY", async () => {
    mocks.loadConfig.mockReturnValue({ autoUpdate: "prompt" });
    const dir = tempDir();
    const file = join(dir, "update.json");
    const installer = vi.fn<(cmd: string) => boolean>(() => true);
    const prevArgv = process.argv[1];
    process.argv[1] = "/usr/lib/node_modules/@astrivya/cli/dist/index.js";
    try {
      await maybeAutoUpdate({ fetcher: async () => "0.2.0", installer }, file);
      expect(installer).not.toHaveBeenCalled();
    } finally {
      process.argv[1] = prevArgv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is throttled to one registry check per 24h", async () => {
    mocks.loadConfig.mockReturnValue({ autoUpdate: "on" });
    const dir = tempDir();
    const file = join(dir, "update.json");
    const installer = vi.fn<(cmd: string) => boolean>(() => true);
    const fetcher = vi.fn(async () => "0.2.0");
    const prevArgv = process.argv[1];
    process.argv[1] = "/usr/lib/node_modules/@astrivya/cli/dist/index.js";
    try {
      await maybeAutoUpdate({ fetcher, installer }, file);
      await maybeAutoUpdate({ fetcher, installer }, file);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      process.argv[1] = prevArgv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing when already on the latest version", async () => {
    const dir = tempDir();
    const file = join(dir, "update.json");
    const installer = vi.fn<(cmd: string) => boolean>(() => true);
    try {
      await maybeAutoUpdate({ fetcher: async () => "0.1.0", installer }, file);
      expect(installer).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("auto-update — plugin auto-sync", () => {
  it("syncs when never synced and authenticated", async () => {
    mocks.getPremiumAuth.mockReturnValue("astr_token");
    const dir = tempDir();
    const file = join(dir, "plugin-sync.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await maybeSyncPlugins({}, file);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("cloud-cli"));
      const cache = readPluginSyncCache(file);
      expect(cache.lastSync).toBeGreaterThan(0);
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips when not authenticated", async () => {
    mocks.getPremiumAuth.mockReturnValue(undefined);
    const dir = tempDir();
    const file = join(dir, "plugin-sync.json");
    try {
      await maybeSyncPlugins({}, file);
      expect(readPluginSyncCache(file).lastSync).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips in --local mode", async () => {
    mocks.getPremiumAuth.mockReturnValue("astr_token");
    const dir = tempDir();
    const file = join(dir, "plugin-sync.json");
    try {
      await maybeSyncPlugins({ local: true }, file);
      expect(readPluginSyncCache(file).lastSync).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is throttled to once per day", () => {
    const now = 1_000_000;
    const day = 24 * 60 * 60 * 1000;
    expect(shouldSyncPlugins({}, now)).toBe(true);
    expect(shouldSyncPlugins({ lastSync: now - 1000 }, now)).toBe(false);
    expect(shouldSyncPlugins({ lastSync: now - day - 1000 }, now)).toBe(true);
  });
});
