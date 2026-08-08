import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type UpdateCache,
  buildInstallCommand,
  checkForUpdates,
  detectInstallManager,
  evaluateUpdate,
  formatBanner,
  semverCompare,
  shouldCheck,
  shouldNotify,
} from "../lib/update-notifier";

describe("update-notifier — semverCompare", () => {
  it("orders versions correctly", () => {
    expect(semverCompare("0.1.0", "0.1.0")).toBe(0);
    expect(semverCompare("0.1.0", "0.1.1")).toBe(-1);
    expect(semverCompare("0.2.0", "0.1.9")).toBe(1);
    expect(semverCompare("1.0.0", "0.9.9")).toBe(1);
  });
});

describe("update-notifier — cache/throttle logic", () => {
  const now = 1_000_000;
  const day = 24 * 60 * 60 * 1000;

  it("checks when never checked before", () => {
    expect(shouldCheck({}, now)).toBe(true);
  });

  it("skips when checked within the interval", () => {
    expect(shouldCheck({ lastChecked: now - 1000 }, now)).toBe(false);
  });

  it("checks again after the interval elapses", () => {
    expect(shouldCheck({ lastChecked: now - day - 1000 }, now)).toBe(true);
  });

  it("skips when disabled", () => {
    expect(shouldCheck({ lastChecked: now - 10 * day, disabled: true }, now)).toBe(false);
  });

  it("notifies once per version, but surfaces newer versions again", () => {
    expect(shouldNotify({}, now)).toBe(true);
    expect(shouldNotify({ notifiedVersion: "0.2.0", lastChecked: now }, now)).toBe(false);
    // Notified for 0.2.0, but a day later we re-check; a newer 0.3.0 then surfaces.
    expect(shouldNotify({ notifiedVersion: "0.2.0", lastChecked: now }, now + day)).toBe(true);
  });
});

describe("update-notifier — evaluateUpdate", () => {
  it("stores the latest version and returns it when newer", () => {
    const cache: UpdateCache = {};
    const result = evaluateUpdate(cache, "0.2.0", "0.1.0", 123);
    expect(result).toBe("0.2.0");
    expect(cache.notifiedVersion).toBe("0.2.0");
    expect(cache.lastChecked).toBe(123);
  });

  it("returns null when already latest", () => {
    const cache: UpdateCache = {};
    expect(evaluateUpdate(cache, "0.1.0", "0.1.0", 123)).toBeNull();
    expect(cache.notifiedVersion).toBeUndefined();
    expect(cache.lastChecked).toBe(123);
  });

  it("does not re-notify the same version", () => {
    const cache: UpdateCache = { notifiedVersion: "0.2.0" };
    expect(evaluateUpdate(cache, "0.2.0", "0.1.0", 123)).toBeNull();
  });
});

describe("update-notifier — checkForUpdates persistence", () => {
  it("persists notifiedVersion so the banner shows once per version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astrivya-update-"));
    const file = join(dir, "update.json");
    try {
      const first = await checkForUpdates(file, async () => "0.2.0");
      expect(first).toBe("0.2.0");

      const persisted = JSON.parse(readFileSync(file, "utf8")) as UpdateCache;
      expect(persisted.notifiedVersion).toBe("0.2.0");
      expect(typeof persisted.lastChecked).toBe("number");

      const second = await checkForUpdates(file, async () => "0.2.0");
      expect(second).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still records lastChecked when no update is published", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astrivya-update-"));
    const file = join(dir, "update.json");
    try {
      const result = await checkForUpdates(file, async () => "0.1.0");
      expect(result).toBeNull();
      const persisted = JSON.parse(readFileSync(file, "utf8")) as UpdateCache;
      expect(typeof persisted.lastChecked).toBe("number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("update-notifier — install manager detection", () => {
  it("detects npm global installs", () => {
    expect(detectInstallManager("/usr/local/lib/node_modules/@astrivya/cli/dist/index.js")).toBe("npm");
    expect(detectInstallManager("C:/Users/x/AppData/Roaming/npm/node_modules/@astrivya/cli/dist/index.js")).toBe("npm");
  });

  it("detects pnpm/yarn/bun global installs", () => {
    expect(detectInstallManager("C:/Users/x/.pnpm/global/5/node_modules/@astrivya/cli/dist/index.js")).toBe("pnpm");
    expect(detectInstallManager("/Users/x/.yarn/bin/astrivya")).toBe("yarn");
    expect(detectInstallManager("/Users/x/.bun/bin/astrivya")).toBe("bun");
  });

  it("detects local project installs", () => {
    expect(detectInstallManager("/project/node_modules/@astrivya/cli/dist/index.js")).toBe("local");
  });

  it("falls back to npm for unknown paths", () => {
    expect(detectInstallManager("/opt/weird/bin/astrivya")).toBe("unknown");
  });

  it("builds the right install command per manager", () => {
    expect(buildInstallCommand("npm")).toBe("npm install -g @astrivya/cli");
    expect(buildInstallCommand("pnpm")).toBe("pnpm add -g @astrivya/cli");
    expect(buildInstallCommand("yarn")).toBe("yarn global add @astrivya/cli");
    expect(buildInstallCommand("bun")).toBe("bun add -g @astrivya/cli");
    expect(buildInstallCommand("local")).toBe("npm install @astrivya/cli@latest");
    expect(buildInstallCommand("unknown")).toBe("npm install -g @astrivya/cli");
  });
});

describe("update-notifier — banner", () => {
  it("includes version progression and install hint", () => {
    const banner = formatBanner("0.1.0", "0.2.0", true);
    expect(banner).toContain("0.1.0");
    expect(banner).toContain("0.2.0");
    expect(banner).toContain("astrivya update");
  });
});
