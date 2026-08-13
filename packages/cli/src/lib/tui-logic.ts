/**
 * Pure logic for the Astrivya TUI — extracted from `commands/tui.ts` so the
 * slash-command autocomplete, layout budget, sidebar rendering and chat
 * wrapping can be unit-tested without a terminal or a running TUI.
 *
 * Nothing in this module touches the process, stdin/stdout, or network.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getFlatCommandList, getSubCommandMap, hasSubCommands } from "./command-registry";

// ── Sidebar data shape ────────────────────────────────────────────

export interface SidebarData {
  batteryPct: number | null;
  batteryCharging: boolean;
  memoryUsedGb: string;
  memoryTotalGb: string;
  memoryPct: number;
  diskUsed: string;
  diskTotal: string;
  diskPct: number;
  cpuModel: string;
  cpuCores: number;
  cpuLoad: string;
  ollamaStatus: "Online" | "Offline" | "Checking";
  ollamaModels: string[];
  dbSize: string;
  dbNodes: number;
  dbEdges: number;
  dbChunks: number;
  gitBranch: string;
  gitDirtyFiles: number;
  uptime: string;
  akgReady: boolean;
  akgLastIndexed: string;
  akgFilesIndexed: number;
  akgStaleFiles: number;
  akgNodes: number;
  akgEdges: number;
  unreadCount: number;
  teamMembers: number;
  teamDecisions: number;
  teamStandups: number;
  teamHandoffs: number;
  memberActivity: { name: string; activityCount: number }[];
}

// ── Formatters ────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  const b = Number(bytes);
  if (Number.isNaN(b) || b <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  if (i < 0 || i >= units.length) return `${b} B`;
  return `${(b / 1024 ** i).toFixed(1)} ${units[i]}`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(" ");
}

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "Yesterday";
  return `${day}d ago`;
}

// ── Layout budget ─────────────────────────────────────────────────

export interface LayoutBudget {
  headerHeight: number;
  inputRow: number;
  footerHeight: number;
  sepRow: number;
  chatStartRow: number;
  chatHeight: number;
  dropdownSize: number;
}

export function getLayoutBudget(rows: number, slashActive: boolean): LayoutBudget {
  let headerHeight = 4;
  if (rows < 12) {
    headerHeight = 0;
  } else if (rows < 18) {
    headerHeight = 2;
  }

  const inputRow = headerHeight;

  let footerHeight = 2;
  if (rows < 3) {
    footerHeight = 0;
  } else if (rows < 6) {
    footerHeight = 1;
  }

  let sepRow = inputRow + 1;
  let dropdownSize = 0;

  if (slashActive) {
    const hasDropdownGap = rows >= 8;
    const contentStart = inputRow + (hasDropdownGap ? 2 : 1);
    const contentEnd = rows - footerHeight - 1;
    const totalContentRows = contentEnd - contentStart + 1;

    const maxPossibleItems = totalContentRows - 0;
    dropdownSize = Math.max(1, Math.min(8, maxPossibleItems));
    sepRow = contentStart + 0 + dropdownSize;
  } else {
    sepRow = inputRow + 1;
  }

  const chatStartRow = sepRow + 1;
  const chatEndRow = rows - footerHeight - 1;
  const chatHeight = Math.max(0, chatEndRow - chatStartRow + 1);

  return {
    headerHeight,
    inputRow,
    footerHeight,
    sepRow,
    chatStartRow,
    chatHeight,
    dropdownSize,
  };
}

// ── Slash-command autocomplete ────────────────────────────────────

export interface CommandEntry {
  name: string;
  description: string;
}

/**
 * Filter the registered commander commands for the slash dropdown.
 * `/akg q` filters subcommands of `akg`; any other query filters the flat
 * command list by name or description (case-insensitive substring).
 */
export function getFilteredCommands(slashQuery: string): CommandEntry[] {
  const subCmdMap = getSubCommandMap();
  const spaceIdx = slashQuery.indexOf(" ");
  if (spaceIdx > 0) {
    const parentCmd = slashQuery.slice(0, spaceIdx);
    const subQuery = slashQuery.slice(spaceIdx + 1);
    const subs = subCmdMap[parentCmd];
    if (subs) {
      const lowerQ = subQuery.toLowerCase();
      return subs.filter((c: CommandEntry) => c.name.includes(lowerQ) || c.description.toLowerCase().includes(lowerQ));
    }
  }
  const lowerQ = slashQuery.toLowerCase();
  return getFlatCommandList().filter((c) => c.name.includes(lowerQ) || c.description.toLowerCase().includes(lowerQ));
}

/**
 * Complete a partial `/cmd` to `/cmd ` (trailing space) when the matched
 * command has subcommands, so the user can immediately type a subcommand.
 */
export function autoCompleteSlash(input: string): string | null {
  if (!input.startsWith("/")) return null;
  const q = input.slice(1);
  if (q.includes(" ")) return null;
  const filtered = getFilteredCommands(q);
  if (filtered.length === 0) return null;
  const selected = filtered[0];
  return `/${selected.name} `;
}

// ── Chat wrapping ─────────────────────────────────────────────────

export function chatVersion(historyLength: number, loading: boolean): number {
  return historyLength * 2 + (loading ? 1 : 0);
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function buildWrapped(history: ChatMessage[], loading: boolean, streamingText: string, cols: number): string[] {
  const result: string[] = [];
  const maxW = Math.max(1, cols - 6);
  const push = (prefix: string, text: string) => {
    for (const line of text.split("\n")) {
      let rem = line;
      while (rem.length > 0) {
        result.push(`${prefix}${rem.slice(0, maxW)}`);
        rem = rem.slice(maxW);
      }
    }
  };
  for (const msg of history) {
    if (msg.role === "user") {
      push("❯ ", msg.content);
    } else {
      push("", msg.content);
    }
  }
  if (loading) {
    push("", streamingText || "Thinking...");
  }
  return result;
}

// ── Sidebar ───────────────────────────────────────────────────────

export function makeSidebarBar(pct: number, length = 10): string {
  const p = Math.min(100, Math.max(0, pct));
  const filled = Math.round((p / 100) * length);
  return "█".repeat(filled) + "░".repeat(length - filled);
}

/**
 * Build the sidebar's rendered lines (labels + values, before colorization).
 * Kept separate from the raw terminal writes so tests can assert on the
 * content — TEAM KPIs, SYSTEM TELEMETRY, OFFLINE AI & AKG, GIT CONTEXT.
 */
export function buildSidebarLines(data: SidebarData): string[] {
  const memBar = makeSidebarBar(data.memoryPct);
  const diskBar = makeSidebarBar(data.diskPct);
  const batteryBar = data.batteryPct !== null ? makeSidebarBar(data.batteryPct) : "";

  const teamSection =
    data.teamMembers > 0 || data.teamDecisions > 0
      ? [
          "TEAM KPIs",
          "─".repeat(28),
          `👥 Members  ${data.teamMembers}`,
          `📋 Decisions ${data.teamDecisions}`,
          `📊 Standups  ${data.teamStandups}`,
          `🔄 Handoffs ${data.teamHandoffs}`,
          "",
        ]
      : [];

  return [
    ...teamSection,
    "SYSTEM TELEMETRY",
    "─".repeat(28),
    `Uptime:   ${data.uptime}`,
    `CPU:      ${data.cpuCores} cores`,
    `            Load: ${data.cpuLoad}`,
    `Memory:   [${memBar}] ${data.memoryPct}%`,
    `            ${data.memoryUsedGb}/${data.memoryTotalGb} GB`,
    `Disk:     [${diskBar}] ${data.diskPct}%`,
    `            ${data.diskUsed}/${data.diskTotal}`,
    data.batteryPct !== null
      ? `Battery:  [${batteryBar}] ${data.batteryPct}%${data.batteryCharging ? " (⚡)" : ""}`
      : "",
    "",
    "OFFLINE AI & AKG",
    "─".repeat(28),
    `Ollama:   ${data.ollamaStatus === "Online" ? "Online" : "Offline"}`,
    data.ollamaModels.length > 0 ? `Models:   ${data.ollamaModels.slice(0, 2).join(", ")}` : "Models:   None loaded",
    data.akgReady ? `AKG:      ✔ Ready  ${data.akgLastIndexed}` : "AKG:      ✗ Not init  /akg init",
    data.akgFilesIndexed > 0
      ? `Indexed:  ${data.akgFilesIndexed} files${data.akgStaleFiles > 0 ? `  ${data.akgStaleFiles} stale` : ""}`
      : "",
    ...(data.akgStaleFiles > 0 ? [`            ${data.akgStaleFiles} files changed since index`] : []),
    data.akgNodes > 0
      ? `Nodes:    ${data.akgNodes.toLocaleString()}  ·  Edges:  ${data.akgEdges.toLocaleString()}`
      : "",
    "",
    "GIT CONTEXT",
    "─".repeat(28),
    `Branch:   ${data.gitBranch}`,
    `Status:   ${data.gitDirtyFiles > 0 ? `${data.gitDirtyFiles} dirty` : "Clean"}`,
  ].filter((l) => l !== undefined);
}

// ── Staleness ─────────────────────────────────────────────────────

/**
 * Cross-platform count of source files newer than the AKG database file.
 * Skips the same paths the indexer ignores.
 */
export function countStaleFiles(workspace: string, dbPath: string): number {
  const STALE_EXTS = new Set([".ts", ".js", ".tsx", ".jsx", ".py", ".go", ".md", ".rs", ".java", ".c", ".cpp", ".h"]);
  const SKIP_DIRS = new Set([".astrivya", "node_modules", ".git", "dist", "out", "coverage", ".next"]);
  let dbMtime = 0;
  try {
    dbMtime = fs.statSync(dbPath).mtimeMs;
  } catch {
    return 0;
  }
  let count = 0;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        if (!STALE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
        try {
          if (fs.statSync(path.join(dir, entry.name)).mtimeMs > dbMtime) count++;
        } catch {
          // unreadable file — skip
        }
      }
    }
  };

  walk(workspace);
  return count;
}

export { hasSubCommands };
