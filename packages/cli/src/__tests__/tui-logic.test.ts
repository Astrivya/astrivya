import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it } from "vitest";
import { setGlobalProgram } from "../lib/command-registry";
import {
  type SidebarData,
  autoCompleteSlash,
  buildSidebarLines,
  buildWrapped,
  chatVersion,
  countStaleFiles,
  formatBytes,
  formatRelativeTime,
  formatUptime,
  getFilteredCommands,
  getLayoutBudget,
  makeSidebarBar,
} from "../lib/tui-logic";

/** Populate the commander program with the same shape the real CLI uses. */
function setupProgram(): void {
  const program = new Command().name("astrivya");
  program.command("init").description("Guided first-run setup wizard");
  const akg = program.command("akg").description("Manage local repository knowledge graph (AKG)");
  akg.command("init [workspacePath]").description("Initialize and index workspace files");
  akg.command("query <question>").description("Run the hybrid retrieval pipeline against the AKG");
  akg.command("status").description("Show database stats and counts");
  akg.command("reindex").description("Incremental index updates");
  program.command("status").description("Quick overview of your Astrivya status");
  program.command("doctor").description("Run health checks");
  program.command("mcp-server").description("Run the Astrivya MCP server");
  program.command("setup").description("Auto-configure Astrivya MCP");
  program.command("atlas").description("Start the local Atlas visual explorer");
  program.command("auth").description("Authentication commands");
  setGlobalProgram(program);
}

function baseSidebarData(): SidebarData {
  return {
    batteryPct: null,
    batteryCharging: false,
    memoryUsedGb: "8.0",
    memoryTotalGb: "16.0",
    memoryPct: 50,
    diskUsed: "120.5 GB",
    diskTotal: "500.0 GB",
    diskPct: 24,
    cpuModel: "Test CPU",
    cpuCores: 8,
    cpuLoad: "1.0, 0.8, 0.5",
    ollamaStatus: "Offline",
    ollamaModels: [],
    dbSize: "1.2 MB",
    dbNodes: 10,
    dbEdges: 5,
    dbChunks: 20,
    gitBranch: "main",
    gitDirtyFiles: 0,
    uptime: "2h 5m",
    akgReady: true,
    akgLastIndexed: "5m ago",
    akgFilesIndexed: 42,
    akgStaleFiles: 0,
    akgNodes: 10,
    akgEdges: 5,
    unreadCount: 0,
    teamMembers: 0,
    teamDecisions: 0,
    teamStandups: 0,
    teamHandoffs: 0,
    memberActivity: [],
  };
}

describe("getFilteredCommands (slash autocomplete)", () => {
  beforeEach(() => setupProgram());

  it("filters top-level commands by prefix", () => {
    const names = getFilteredCommands("a").map((c) => c.name);
    expect(names).toContain("akg");
    expect(names).toContain("atlas");
    expect(names).toContain("auth");
  });

  it("filters by description text", () => {
    const names = getFilteredCommands("health").map((c) => c.name);
    expect(names).toContain("doctor");
  });

  it("filters subcommands after a space", () => {
    const names = getFilteredCommands("akg q").map((c) => c.name);
    expect(names).toEqual(["query"]);
  });

  it("returns all subcommands for a bare parent", () => {
    const names = getFilteredCommands("akg ").map((c) => c.name);
    expect(names).toContain("init");
    expect(names).toContain("query");
    expect(names).toContain("status");
    expect(names).toContain("reindex");
  });

  it("returns an empty list for garbage", () => {
    expect(getFilteredCommands("zzz_not_a_command")).toEqual([]);
  });
});

describe("autoCompleteSlash", () => {
  beforeEach(() => setupProgram());

  it("completes a command with subcommands to a trailing-space prefix", () => {
    expect(autoCompleteSlash("/akg")).toBe("/akg ");
  });

  it("returns null when input does not start with a slash", () => {
    expect(autoCompleteSlash("akg")).toBeNull();
  });

  it("returns null when the query already contains a space", () => {
    expect(autoCompleteSlash("/akg q")).toBeNull();
  });

  it("returns null for an unknown command", () => {
    expect(autoCompleteSlash("/zzz")).toBeNull();
  });
});

describe("getLayoutBudget", () => {
  it("gives a chat area on a 24-row terminal", () => {
    const b = getLayoutBudget(24, false);
    expect(b.headerHeight).toBe(4);
    expect(b.inputRow).toBe(4);
    expect(b.footerHeight).toBe(2);
    expect(b.chatHeight).toBeGreaterThan(0);
    expect(b.dropdownSize).toBe(0);
  });

  it("sizes the dropdown when the slash menu is open", () => {
    const b = getLayoutBudget(24, true);
    expect(b.dropdownSize).toBeGreaterThanOrEqual(1);
    expect(b.dropdownSize).toBeLessThanOrEqual(8);
    expect(b.sepRow).toBeGreaterThan(b.inputRow);
  });

  it("keeps the dropdown small on short terminals", () => {
    const b = getLayoutBudget(10, true);
    expect(b.dropdownSize).toBeGreaterThanOrEqual(1);
    expect(b.dropdownSize).toBeLessThanOrEqual(8);
  });

  it("hides the header on tiny terminals", () => {
    expect(getLayoutBudget(8, false).headerHeight).toBe(0);
    expect(getLayoutBudget(15, false).headerHeight).toBe(2);
  });
});

describe("sidebar rendering", () => {
  it("renders the standard sections", () => {
    const lines = buildSidebarLines(baseSidebarData());
    expect(lines).toContain("SYSTEM TELEMETRY");
    expect(lines).toContain("OFFLINE AI & AKG");
    expect(lines).toContain("GIT CONTEXT");
    expect(lines.some((l) => l.startsWith("Memory:"))).toBe(true);
    expect(lines.some((l) => l.includes("█"))).toBe(true); // bar glyphs
  });

  it("shows AKG ready state with index age", () => {
    const lines = buildSidebarLines(baseSidebarData());
    expect(lines.some((l) => l.includes("✔ Ready") && l.includes("5m ago"))).toBe(true);
  });

  it("shows the not-initialized hint when AKG is missing", () => {
    const data = { ...baseSidebarData(), akgReady: false, akgFilesIndexed: 0 };
    const lines = buildSidebarLines(data);
    expect(lines.some((l) => l.includes("✗ Not init") && l.includes("/akg init"))).toBe(true);
  });

  it("shows TEAM KPIs only when team data exists", () => {
    expect(buildSidebarLines(baseSidebarData()).some((l) => l.includes("TEAM KPIs"))).toBe(false);
    const withTeam = { ...baseSidebarData(), teamMembers: 3, teamDecisions: 7 };
    const lines = buildSidebarLines(withTeam);
    expect(lines.some((l) => l.includes("TEAM KPIs"))).toBe(true);
    expect(lines.some((l) => l.includes("Members") && l.includes("3"))).toBe(true);
  });

  it("omits the battery line when there is no battery", () => {
    const lines = buildSidebarLines(baseSidebarData());
    expect(lines.some((l) => l.startsWith("Battery:"))).toBe(false);
    const withBattery = { ...baseSidebarData(), batteryPct: 82, batteryCharging: true };
    const lines2 = buildSidebarLines(withBattery);
    expect(lines2.some((l) => l.includes("Battery:") && l.includes("82%") && l.includes("⚡"))).toBe(true);
  });

  it("flags stale files", () => {
    const data = { ...baseSidebarData(), akgStaleFiles: 4 };
    const lines = buildSidebarLines(data);
    expect(lines.some((l) => l.includes("4 files changed since index"))).toBe(true);
  });
});

describe("makeSidebarBar", () => {
  it("renders empty, half and full bars", () => {
    expect(makeSidebarBar(0)).toBe("░".repeat(10));
    expect(makeSidebarBar(50)).toBe("█".repeat(5) + "░".repeat(5));
    expect(makeSidebarBar(100)).toBe("█".repeat(10));
  });

  it("clamps out-of-range percentages", () => {
    expect(makeSidebarBar(-10)).toBe("░".repeat(10));
    expect(makeSidebarBar(150)).toBe("█".repeat(10));
  });
});

describe("chat wrapping", () => {
  it("prefixes user lines and wraps to the column width", () => {
    const history = [{ role: "user" as const, content: "0123456789" }];
    const wrapped = buildWrapped(history, false, "", 12); // maxW = 12 - 6 = 6
    expect(wrapped[0]).toBe("❯ 012345");
    expect(wrapped[1]).toBe("❯ 6789");
  });

  it("shows the thinking placeholder while loading", () => {
    const wrapped = buildWrapped([], true, "", 80);
    expect(wrapped.some((l) => l.includes("Thinking"))).toBe(true);
  });

  it("streams partial tokens while loading", () => {
    const wrapped = buildWrapped([], true, "par", 80);
    expect(wrapped.some((l) => l.includes("par"))).toBe(true);
  });

  it("increments the cache version on new messages or loading", () => {
    expect(chatVersion(3, false)).toBe(6);
    expect(chatVersion(3, true)).toBe(7);
    expect(chatVersion(4, false)).toBe(8);
  });
});

describe("formatters", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(-1)).toBe("0 B");
  });

  it("formats uptime", () => {
    expect(formatUptime(30)).toBe("0m");
    expect(formatUptime(90)).toBe("1m");
    expect(formatUptime(3661)).toBe("1h 1m");
  });

  it("formats relative time", () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now - 5_000).toISOString())).toBe("just now");
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(formatRelativeTime(new Date(now - 3 * 3600_000).toISOString())).toBe("3h ago");
    expect(formatRelativeTime(new Date(now - 26 * 3600_000).toISOString())).toBe("Yesterday");
    expect(formatRelativeTime(new Date(now - 3 * 86_400_000).toISOString())).toBe("3d ago");
  });
});

describe("countStaleFiles", () => {
  it("counts only source files newer than the DB", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astrivya-stale-"));
    try {
      const dbPath = path.join(dir, ".astrivya", "akg.db");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, "db");
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(dbPath, past, past);

      fs.writeFileSync(path.join(dir, "newer.ts"), "x");
      fs.writeFileSync(path.join(dir, "older.ts"), "x");
      const older = new Date(Date.now() - 3_600_000);
      fs.utimesSync(path.join(dir, "older.ts"), older, older);

      // not in the stale extension set
      fs.writeFileSync(path.join(dir, "newer.json"), "{}");
      // skipped dirs
      fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", "pkg", "lib.ts"), "x");

      expect(countStaleFiles(dir, dbPath)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 when the db is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astrivya-stale-"));
    try {
      expect(countStaleFiles(dir, path.join(dir, "nope.db"))).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
