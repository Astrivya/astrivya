import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type UpdateCache,
  checkForUpdates,
  evaluateUpdate,
  formatBanner,
  semverCompare,
  shouldCheck,
} from "../lib/update-notifier";

describe("mcp-server update-notifier — semverCompare", () => {
  it("orders versions correctly", () => {
    expect(semverCompare("0.1.0", "0.1.0")).toBe(0);
    expect(semverCompare("0.1.0", "0.1.1")).toBe(-1);
    expect(semverCompare("0.2.0", "0.1.9")).toBe(1);
    expect(semverCompare("1.0.0", "0.9.9")).toBe(1);
  });
});

describe("mcp-server update-notifier — cache/throttle logic", () => {
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
});

describe("mcp-server update-notifier — evaluateUpdate", () => {
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

describe("mcp-server update-notifier — checkForUpdates persistence", () => {
  it("persists notifiedVersion so the banner shows once per version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astrivya-mcp-update-"));
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
    const dir = mkdtempSync(join(tmpdir(), "astrivya-mcp-update-"));
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

describe("mcp-server update-notifier — banner", () => {
  it("includes version progression and an install hint on stderr", () => {
    const banner = formatBanner("0.1.0", "0.2.0");
    expect(banner).toContain("0.1.0");
    expect(banner).toContain("0.2.0");
    expect(banner).toContain("@astrivya/mcp-server");
  });
});
