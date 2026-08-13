import { execFile, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { AkgQuery, AkgStorage, GraphTraversal } from "@astrivya/akg-core";
import { AkgIndexer } from "@astrivya/akg-indexer";
import { executeCommandSafely, isPassthroughCommand } from "../lib/command-registry";
import { getBaseUrl, getToken, loadConfig, saveConfig } from "../lib/compat";
import { amber, color, getErrorMessage } from "../lib/output";
import { setSessionTitle } from "../lib/repl-input";
import { RuntimeExecutor } from "../lib/runtime-manager/runtime-executor";
import { RuntimeManager } from "../lib/runtime-manager/runtime-manager";
import { getSessionStore } from "../lib/session-store";
import {
  type LayoutBudget,
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
  hasSubCommands,
} from "../lib/tui-logic";

let inputBuffer = "";
const chatHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
let tuiConversationId: string | null = null;
let loading = false;
let busy = false;

let streamingText = "";
let akgStorage: any = null;
let akgQuery: any = null;

let slashActive = false;
let slashSelectedIndex = 0;
let slashStartIndex = 0;
const MAX_HISTORY = 100;
const history: string[] = loadHistory();
let historyIdx = -1;

function historyFile(): string {
  return path.join(os.homedir(), ".config", "astrivya", "tui-history");
}

function loadHistory(): string[] {
  try {
    const data = fs.readFileSync(historyFile(), "utf-8");
    const lines = data.split("\n").filter(Boolean);
    return lines.slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

function appendHistory(entry: string): void {
  if (!entry.trim()) return;
  history.push(entry);
  if (history.length > MAX_HISTORY) history.shift();
  try {
    const dir = path.dirname(historyFile());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(historyFile(), `${entry}\n`);
  } catch {
    // non-fatal
  }
}

let authStatus: "checking" | "authenticated" | "unauthenticated" | "expired" = "checking";

function checkAuthStatus(): void {
  const token = getToken();
  if (!token) {
    authStatus = "unauthenticated";
    return;
  }
  authStatus = "authenticated";
}

function needsTerminalPassthrough(cmd: string, args: string): boolean {
  const config = loadConfig();
  const isUsageLive = cmd === "usage" && (config.offlineMode || args.includes("--live") || args.includes("-l"));
  return cmd === "setup" || cmd === "init" || isUsageLive;
}

async function getAkgQuery() {
  if (akgQuery) return akgQuery;
  akgStorage = new AkgStorage();
  await akgStorage.init(process.cwd());
  akgQuery = new AkgQuery(akgStorage, process.cwd());
  return akgQuery;
}

// ── Chat line cache ──

let cachedWrapped: string[] = [];
let cachedChatVersion = -1;
let cachedCols = -1;

function getChatWrapped(cols: number): string[] {
  const v = chatVersion(chatHistory.length, loading);
  if (v !== cachedChatVersion || cols !== cachedCols) {
    cachedWrapped = buildWrapped(chatHistory, loading, streamingText, cols);
    cachedChatVersion = v;
    cachedCols = cols;
  }
  return cachedWrapped;
}

// ── Render regions ──

let sidebarData: SidebarData = {
  batteryPct: null,
  batteryCharging: false,
  memoryUsedGb: "0.0",
  memoryTotalGb: "0.0",
  memoryPct: 0,
  diskUsed: "0.0 B",
  diskTotal: "0.0 B",
  diskPct: 0,
  cpuModel: "Generic CPU",
  cpuCores: 0,
  cpuLoad: "0.0, 0.0, 0.0",
  ollamaStatus: "Checking",
  ollamaModels: [],
  dbSize: "0 B",
  dbNodes: 0,
  dbEdges: 0,
  dbChunks: 0,
  gitBranch: "unknown",
  gitDirtyFiles: 0,
  uptime: "0m",
  akgReady: false,
  akgLastIndexed: "Never",
  akgFilesIndexed: 0,
  akgStaleFiles: 0,
  akgNodes: 0,
  akgEdges: 0,
  unreadCount: 0,
  teamMembers: 0,
  teamDecisions: 0,
  teamStandups: 0,
  teamHandoffs: 0,
  memberActivity: [],
};

let lastStalenessCheck = 0;

let sidebarTimer: NodeJS.Timeout | null = null;
let telemetryInFlight = false;

let dashboardActive = false;
let dashboardScrollIndex = 0;
let sessionPickerActive = false;
let sessionPickerIndex = 0;
let akgOnboardingShown = false;
let sessionPickerSessions: Array<{ id: string; title: string; message_count: number; updated_at: string }> = [];
let sessionPickerSavedHistory: Array<{ role: "user" | "assistant"; content: string }> = [];

/**
 * Run a short-lived command asynchronously. Never blocks the event loop —
 * the TUI stays responsive even if git or system tools are slow.
 */
function runCmd(cmd: string, args: string[], timeoutMs = 1000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf-8", timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve("");
        return;
      }
      resolve(stdout);
    });
  });
}

async function updateSidebarData() {
  if (telemetryInFlight) return;
  telemetryInFlight = true;

  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPct = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;

    let diskInfo = { used: "?", total: "?", pct: 0 };
    try {
      // Cross-platform disk usage: fs.statfs works on Windows, Linux and macOS
      // (Node >= 18.15). Falls back to `df -k /` on POSIX only.
      const statfs = fs.statfsSync(process.cwd());
      const totalBytes = statfs.blocks * statfs.bsize;
      const freeBytes = statfs.bfree * statfs.bsize;
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      if (totalBytes > 0) {
        diskInfo = {
          used: formatBytes(usedBytes),
          total: formatBytes(totalBytes),
          pct: Math.round((usedBytes / totalBytes) * 100),
        };
      }
    } catch {
      if (os.platform() !== "win32") {
        const df = await runCmd("df", ["-k", "/"]);
        const lines = df.trim().split("\n");
        const last = lines[lines.length - 1];
        const parts = last.split(/\s+/);
        if (parts.length >= 5) {
          const totalKb = Number.parseInt(parts[1], 10);
          const usedKb = Number.parseInt(parts[2], 10);
          if (totalKb > 0) {
            diskInfo = {
              used: formatBytes(usedKb * 1024),
              total: formatBytes(totalKb * 1024),
              pct: Math.round((usedKb / totalKb) * 100),
            };
          }
        }
      }
    }

    let batteryPct: number | null = null;
    let batteryCharging = false;
    if (os.platform() === "darwin") {
      const out = await runCmd("pmset", ["-g", "batt"]);
      const match = out.match(/(\d+)%;\s*(.+)/);
      if (match) {
        batteryPct = Number.parseInt(match[1], 10);
        batteryCharging = match[2].includes("charging") || match[2].includes("AC");
      }
    } else if (os.platform() === "linux") {
      try {
        const cap = fs.readFileSync("/sys/class/power_supply/BAT0/capacity", "utf-8");
        batteryPct = Number.parseInt(cap.trim(), 10);
      } catch {}
    }

    const cpus = os.cpus().length;
    const cpuModel = os.cpus()[0]?.model || "Generic CPU";
    const load = os
      .loadavg()
      .map((v) => v.toFixed(1))
      .join(", ");

    let ollamaStatus: "Online" | "Offline" = "Offline";
    let ollamaModels: string[] = [];
    try {
      const config = loadConfig();
      const url = `${config.ollamaUrl || "http://localhost:11434"}/api/tags`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 400);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data: any = await res.json();
        ollamaStatus = "Online";
        ollamaModels = (data.models || []).map((m: any) => m.name.split(":")[0]);
      }
    } catch {}

    let dbSize = "0 B";
    let dbNodes = 0;
    let dbEdges = 0;
    let dbChunks = 0;
    let akgReady = false;
    let akgLastIndexed = "Never";
    let akgFilesIndexed = 0;
    let akgStaleFiles = 0;
    let akgNodeCount = 0;
    let akgEdgeCount = 0;
    try {
      const dbPath = path.join(process.cwd(), ".astrivya", "akg.db");
      if (fs.existsSync(dbPath)) {
        akgReady = true;
        const stats = fs.statSync(dbPath);
        dbSize = formatBytes(stats.size);
        akgLastIndexed = formatRelativeTime(new Date(stats.mtime).toISOString());
        const storage = new AkgStorage();
        await storage.init(process.cwd());
        const s = storage.getStats();
        dbNodes = s.nodes;
        dbEdges = s.edges;
        dbChunks = s.chunks;
        akgNodeCount = s.nodes;
        akgEdgeCount = s.edges;
        try {
          const fileRows = storage.runQuery("SELECT COUNT(*) as cnt FROM nodes WHERE type = 'file'");
          akgFilesIndexed = fileRows[0].cnt;
        } catch {}

        // Staleness check (only every 30s)
        const now = Date.now();
        if (now - lastStalenessCheck > 30000) {
          lastStalenessCheck = now;
          try {
            akgStaleFiles = countStaleFiles(process.cwd(), dbPath);
          } catch {
            akgStaleFiles = 0;
          }
        }
        storage.close();
      }
    } catch {}

    let gitBranch = "unknown";
    let gitDirtyFiles = 0;
    const gitDir = path.join(process.cwd(), ".git");
    if (fs.existsSync(gitDir)) {
      const [branchOut, statusOut] = await Promise.all([
        runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
        runCmd("git", ["status", "--porcelain"]),
      ]);
      gitBranch = branchOut.trim() || "unknown";
      gitDirtyFiles = statusOut ? statusOut.split("\n").filter(Boolean).length : 0;
    }

    // Fetch team KPIs and notification count
    let unreadCount = 0;
    let teamMembers = 0;
    let teamDecisions = 0;
    let teamStandups = 0;
    let teamHandoffs = 0;
    let memberActivity: { name: string; activityCount: number }[] = [];
    try {
      const config = loadConfig();
      const teamId = config.teamId as string | undefined;
      if (teamId) {
        const [notifData, analyticsData] = await Promise.allSettled([
          fetch(`${getBaseUrl()}/api/notifications?unread=true&limit=1`, {
            headers: { Authorization: `Bearer ${getToken()}` },
            signal: AbortSignal.timeout(3000),
          }).then((r) => (r.ok ? r.json() : { notifications: [] })),
          fetch(`${getBaseUrl()}/api/analytics?teamId=${teamId}`, {
            headers: { Authorization: `Bearer ${getToken()}` },
            signal: AbortSignal.timeout(3000),
          }).then((r) => (r.ok ? r.json() : {})),
        ]);
        if (notifData.status === "fulfilled") {
          const n = (notifData.value as any).notifications || [];
          unreadCount = n.length;
        }
        if (analyticsData.status === "fulfilled") {
          const a = analyticsData.value as any;
          teamMembers = a.totalMembers ?? 0;
          teamDecisions = a.totalDecisions ?? 0;
          teamStandups = a.totalStandups ?? 0;
          teamHandoffs = a.totalHandoffs ?? 0;
          memberActivity = (a.memberActivity || []).slice(0, 20).map((m: any) => ({
            name: m.name || m.email || "Unknown",
            activityCount: m.activityCount ?? 0,
          }));
        }
      }
    } catch {}

    sidebarData = {
      batteryPct,
      batteryCharging,
      memoryUsedGb: (usedMem / 1024 ** 3).toFixed(1),
      memoryTotalGb: (totalMem / 1024 ** 3).toFixed(1),
      memoryPct: memPct,
      diskUsed: diskInfo.used,
      diskTotal: diskInfo.total,
      diskPct: diskInfo.pct,
      cpuModel,
      cpuCores: cpus,
      cpuLoad: load,
      ollamaStatus,
      ollamaModels,
      dbSize,
      dbNodes,
      dbEdges,
      dbChunks,
      gitBranch,
      gitDirtyFiles,
      uptime: formatUptime(os.uptime()),
      akgReady,
      akgLastIndexed,
      akgFilesIndexed,
      akgStaleFiles,
      akgNodes: akgNodeCount,
      akgEdges: akgEdgeCount,
      unreadCount,
      teamMembers,
      teamDecisions,
      teamStandups,
      teamHandoffs,
      memberActivity,
    };

    render();
  } catch (err) {
    // ignore
  } finally {
    telemetryInFlight = false;
  }
}

function startSidebarTimer() {
  if (sidebarTimer) return;
  updateSidebarData().catch(() => {});
  sidebarTimer = setInterval(() => {
    updateSidebarData().catch(() => {});
  }, 5000);
}

function stopSidebarTimer() {
  if (sidebarTimer) {
    clearInterval(sidebarTimer);
    sidebarTimer = null;
  }
}

function renderHeader(rows: number): void {
  const budget = getLayoutBudget(rows, slashActive);
  process.stdout.write("\x1b[?25l");

  if (budget.headerHeight === 0) {
    return;
  }

  readline.cursorTo(process.stdout, 0, 0);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(`  ${color.bold("astrivya")} ${amber("/")} ${color.dim("intelligence")}\n`);

  readline.cursorTo(process.stdout, 0, 1);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(
    `  ${color.dim("type ")}${color.bold(amber("/"))}${color.dim(" for commands, or ")}${color.bold(amber("exit"))}${color.dim(" to quit.")}\n`,
  );

  if (budget.headerHeight === 4) {
    readline.cursorTo(process.stdout, 0, 2);
    readline.clearLine(process.stdout, 0);
    process.stdout.write("\n");
    readline.cursorTo(process.stdout, 0, 3);
    readline.clearLine(process.stdout, 0);
    process.stdout.write("\n");
  }
}

function renderInput(rows: number, cols: number): number {
  const budget = getLayoutBudget(rows, slashActive);
  readline.cursorTo(process.stdout, 0, budget.inputRow);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(`  ${amber("❯")} ${inputBuffer}`);

  const hasDropdownGap = slashActive && rows >= 8;
  if (hasDropdownGap) {
    readline.cursorTo(process.stdout, 0, budget.inputRow + 1);
    readline.clearLine(process.stdout, 0);
  }

  const dropdownStartRow = budget.inputRow + (hasDropdownGap ? 2 : 1);

  if (slashActive && budget.dropdownSize > 0) {
    const q = inputBuffer.slice(1);
    const filtered = getFilteredCommands(q);
    const inSub = q.includes(" ");

    if (filtered.length <= budget.dropdownSize) {
      slashStartIndex = 0;
    } else {
      if (slashSelectedIndex < slashStartIndex) {
        slashStartIndex = slashSelectedIndex;
      } else if (slashSelectedIndex >= slashStartIndex + budget.dropdownSize) {
        slashStartIndex = slashSelectedIndex - budget.dropdownSize + 1;
      }
    }

    const visible = filtered.slice(slashStartIndex, slashStartIndex + budget.dropdownSize);

    let itemRow = dropdownStartRow;
    if (inSub) {
      const parent = q.slice(0, q.indexOf(" "));
      readline.cursorTo(process.stdout, 0, dropdownStartRow);
      readline.clearLine(process.stdout, 0);
      process.stdout.write(`  ${amber(`${parent} ›`)}`);
      itemRow++;
    }

    for (let i = 0; i < budget.dropdownSize; i++) {
      const row = itemRow + i;
      readline.cursorTo(process.stdout, 0, row);
      readline.clearLine(process.stdout, 0);
      const cmd = visible[i];
      if (cmd) {
        const sel = slashStartIndex + i === slashSelectedIndex;
        const bulletChar = sel ? `${amber("\u25B8")} ` : "  ";
        const namePart = sel ? amber(cmd.name.padEnd(14)) : cmd.name.padEnd(14);
        const suffix = !inSub && hasSubCommands(cmd.name) ? ` ${color.dim(amber("›"))}` : "";
        process.stdout.write(`  ${bulletChar}${namePart}${suffix} ${color.dim(cmd.description.slice(0, cols - 24))}`);
      }
    }
  } else {
    if (!slashActive && budget.sepRow > budget.inputRow + 1) {
      readline.cursorTo(process.stdout, 0, budget.inputRow + 1);
      readline.clearLine(process.stdout, 0);
    }
  }

  return budget.sepRow;
}

function renderSessionPicker(rows: number, cols: number, budget: LayoutBudget): void {
  if (budget.chatHeight <= 0) return;
  const maxW = Math.max(1, cols - 6);

  const lines: string[] = [];
  lines.push(`  ${color.dim("─".repeat(Math.min(maxW, 32)))}`);

  for (let i = 0; i < sessionPickerSessions.length; i++) {
    const s = sessionPickerSessions[i];
    const isActive = s.id === tuiConversationId;
    const isSelected = i === sessionPickerIndex;
    const marker = isActive ? color.cyan(">") : " ";
    const title = s.title.length > 38 ? `${s.title.slice(0, 35)}...` : s.title;
    const date = formatRelativeTime(s.updated_at);
    const line = `  ${marker} ${title.padEnd(38)} ${color.dim(date)}`;
    if (isSelected) {
      lines.push(color.inverse(line));
    } else {
      lines.push(line);
    }
  }

  lines.push(`  ${color.dim("─".repeat(Math.min(maxW, 32)))}`);
  lines.push(`  ${color.dim("↑↓ navigate  ·  Enter switch  ·  Esc cancel")}`);

  const sliced = lines.slice(-budget.chatHeight);
  for (let i = 0; i < budget.chatHeight; i++) {
    readline.cursorTo(process.stdout, 0, budget.chatStartRow + i);
    readline.clearLine(process.stdout, 0);
    if (sliced[i] !== undefined) {
      process.stdout.write(sliced[i]);
    }
  }
}

function renderMemberActivity(rows: number, cols: number, budget: LayoutBudget): void {
  const maxW = Math.max(1, cols - 6);
  const activity = sidebarData.memberActivity;
  const lines: string[] = [];

  lines.push(`  ${color.bold(color.cyan("MEMBER ACTIVITY"))}`);
  lines.push(`  ${color.dim("\u2500".repeat(Math.min(maxW, 40)))}`);

  if (activity.length === 0) {
    lines.push(`  ${color.dim("No activity data yet.")}`);
  } else {
    const maxCount = Math.max(1, ...activity.map((m) => m.activityCount));
    const barMax = Math.max(1, Math.min(maxW - 30, 30));
    const startIdx = Math.max(0, Math.min(dashboardScrollIndex, activity.length - budget.chatHeight + 3));
    const visible = activity.slice(startIdx, startIdx + Math.max(1, budget.chatHeight - 3));

    for (const m of visible) {
      const name = m.name.length > 20 ? `${m.name.slice(0, 18)}..` : m.name.padEnd(20);
      const barW = maxCount > 0 ? Math.round((m.activityCount / maxCount) * barMax) : 0;
      const bar = color.cyan("\u2588".repeat(Math.max(1, barW)));
      lines.push(`  ${name} ${bar} ${color.dim(String(m.activityCount))}`);
    }

    if (activity.length > visible.length) {
      lines.push(`  ${color.dim(`\u2191\u2193 scroll  \u2022  ${activity.length} total members`)}`);
    }
  }

  const sliced = lines.slice(-budget.chatHeight);
  for (let i = 0; i < budget.chatHeight; i++) {
    readline.cursorTo(process.stdout, 0, budget.chatStartRow + i);
    readline.clearLine(process.stdout, 0);
    if (sliced[i] !== undefined) {
      process.stdout.write(sliced[i]);
    }
  }
}

function renderChat(rows: number, cols: number, sepRow: number): void {
  const budget = getLayoutBudget(rows, slashActive);
  if (budget.chatHeight <= 0) return;

  // Divider
  readline.cursorTo(process.stdout, 0, sepRow);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(color.dim("─".repeat(cols)));

  if (sessionPickerActive) {
    renderSessionPicker(rows, cols, budget);
    return;
  }

  if (dashboardActive) {
    renderMemberActivity(rows, cols, budget);
    return;
  }

  const wrapped = getChatWrapped(cols);
  const sliced = wrapped.slice(-budget.chatHeight);

  for (let i = 0; i < budget.chatHeight; i++) {
    readline.cursorTo(process.stdout, 0, budget.chatStartRow + i);
    readline.clearLine(process.stdout, 0);
    if (sliced[i] !== undefined) {
      process.stdout.write(`  ${sliced[i]}`);
    }
  }
}

function renderFooter(rows: number, cols: number): void {
  const budget = getLayoutBudget(rows, slashActive);
  if (budget.footerHeight === 0) return;

  if (budget.footerHeight === 2) {
    readline.cursorTo(process.stdout, 0, rows - 2);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(color.dim("─".repeat(cols)));
  }

  readline.cursorTo(process.stdout, 0, rows - 1);
  readline.clearLine(process.stdout, 0);
  const config = loadConfig();
  const mode = config.localAiRuntime || "auto";
  const offline = config.offlineMode ? "offline" : "online";
  const authBadge =
    authStatus === "authenticated"
      ? color.green("\u2713")
      : authStatus === "expired"
        ? color.red("\u2717")
        : authStatus === "unauthenticated"
          ? color.dim("\u2014")
          : color.dim("?");
  const notifBadge = sidebarData.unreadCount > 0 ? ` ${color.yellow(`\uD83D\uDD14${sidebarData.unreadCount}`)}` : "";
  const modeHint = dashboardActive ? color.dim("\u2190 chat") : `${color.dim("\u2192 dash")}`;
  const hints = `${color.dim("^O offline")} ${color.dim("^R runtime")} ${color.dim("^P sessions")} ${color.dim("⏎ exec")} ${color.dim("⇥ complete")} ${modeHint}`;
  const statusLine = ` ${mode.toLowerCase()} • ${offline} ${authBadge}${notifBadge} ${hints}`;
  process.stdout.write(`${color.dim(statusLine.slice(0, cols))}`);
}

function renderSidebar(rows: number, cols: number): void {
  const sidebarWidth = 32;
  const separatorCol = cols - sidebarWidth - 1;
  const startCol = cols - sidebarWidth;

  // Recolor the extracted plain-text lines (tui-logic keeps them testable).
  const lines: string[] = buildSidebarLines(sidebarData).map((line) => {
    if (line.startsWith("TEAM KPIs")) return `  ${color.bold(line)}`;
    if (line.startsWith("SYSTEM TELEMETRY")) return `  ${color.bold(line)}`;
    if (line.startsWith("OFFLINE AI & AKG")) return `  ${color.cyan(color.bold(line))}`;
    if (line.startsWith("GIT CONTEXT")) return `  ${color.cyan(color.bold(line))}`;
    if (line.startsWith("─")) return `  ${color.dim(line)}`;
    if (line.startsWith("Ollama:") && sidebarData.ollamaStatus === "Online")
      return `  ${line.replace("Online", color.green("Online"))}`;
    if (line.startsWith("AKG:") && sidebarData.akgReady) return `  ${line.replace("✔ Ready", color.green("✔ Ready"))}`;
    if (line.startsWith("AKG:") && !sidebarData.akgReady)
      return `  ${line.replace("✗ Not init", color.yellow("✗ Not init"))}`;
    if (sidebarData.akgStaleFiles > 0 && line.includes("stale"))
      return `  ${line.replace(/\d+ stale/, color.yellow(`${sidebarData.akgStaleFiles} stale`))}`;
    if (line.startsWith("Status:") && sidebarData.gitDirtyFiles > 0)
      return `  ${line.replace(/\d+ dirty/, color.yellow(`${sidebarData.gitDirtyFiles} dirty`))}`;
    return `  ${line}`;
  });

  // Loop up to rows - 2 to leave row rows - 1 empty on bottom-right, preventing terminal auto-scrolling
  for (let r = 0; r < rows - 1; r++) {
    readline.cursorTo(process.stdout, separatorCol, r);
    process.stdout.write(`${color.dim("│")}\x1b[K`);

    readline.cursorTo(process.stdout, startCol, r);
    const content = lines[r];
    if (content) {
      process.stdout.write(content.slice(0, sidebarWidth));
    }
  }
}

// ── Debounced render dispatch ──

let renderQueued = false;

function render() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    try {
      renderQueued = false;
      const rows = process.stdout.rows || 24;
      const cols = process.stdout.columns || 80;
      const isSidebarExpanded = cols >= 100;
      const leftCols = isSidebarExpanded ? cols - 33 : cols;
      const budget = getLayoutBudget(rows, slashActive);
      const sepRow = renderInput(rows, leftCols);
      renderChat(rows, leftCols, sepRow);
      renderFooter(rows, leftCols);

      if (isSidebarExpanded) {
        renderSidebar(rows, cols);
      }

      readline.cursorTo(process.stdout, 4 + inputBuffer.length, budget.inputRow);
      process.stdout.write("\x1b[?25h");
    } catch {
      // render errors are non-fatal
    }
  });
}

// Synchronous render for immediate updates (submit, resize)
function renderNow() {
  const rows = process.stdout.rows || 24;
  const cols = process.stdout.columns || 80;
  const isSidebarExpanded = cols >= 100;
  const leftCols = isSidebarExpanded ? cols - 33 : cols;
  const budget = getLayoutBudget(rows, slashActive);
  process.stdout.write("\x1b[?25l");
  renderHeader(rows);
  const sepRow = renderInput(rows, leftCols);
  renderChat(rows, leftCols, sepRow);
  renderFooter(rows, leftCols);

  if (isSidebarExpanded) {
    renderSidebar(rows, cols);
  }

  readline.cursorTo(process.stdout, 4 + inputBuffer.length, budget.inputRow);
  process.stdout.write("\x1b[?25h");
}

function cleanupAndExit() {
  stopSidebarTimer();
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();

  try {
    const native = RuntimeManager.getInstance().getRuntime("native");
    if (native) {
      native.unload();
    }
  } catch {
    // ignore
  }

  if (tuiConversationId && chatHistory.length > 0) {
    console.error(`\n${color.dim("─".repeat(40))}`);
    console.error(color.dim(`To resume: /sessions resume ${tuiConversationId}`));
  }

  process.exit(0);
}

async function toggleOfflineMode() {
  const config = loadConfig();
  const nextMode = !config.offlineMode;
  saveConfig({ ...config, offlineMode: nextMode });
  render();
}

async function switchRuntime() {
  const config = loadConfig();
  const options = ["auto", "native", "ollama"];
  const current = config.localAiRuntime || "auto";
  const nextIdx = (options.indexOf(current) + 1) % options.length;
  const nextVal = options[nextIdx];
  saveConfig({ ...config, localAiRuntime: nextVal as any });
  render();
}

function getCliPath(): string {
  try {
    return fs.realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
}

function terminalPassthrough(cmdName: string, args = ""): Promise<void> {
  return new Promise((resolve) => {
    // Save and temporarily ignore SIGINT in parent process so Ctrl+C in child doesn't kill TUI
    const prevListeners = process.listeners("SIGINT");
    process.removeAllListeners("SIGINT");
    process.on("SIGINT", () => {});

    process.stdout.write("\x1b[?25h\x1b[?1049l\n");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.off("keypress", handleKeypress);
    process.stdin.pause();
    stopSidebarTimer();

    const cliPath = getCliPath();
    const fullCmd = `node "${cliPath}" ${cmdName}${args ? ` ${args}` : ""}`;
    try {
      execSync(fullCmd, { stdio: "inherit", env: { ...process.env, FORCE_COLOR: "1" } });
    } catch {
      // command handled its own errors
    }

    const restoreTuiState = () => {
      process.removeAllListeners("SIGINT");
      for (const l of prevListeners) {
        process.on("SIGINT", l);
      }
      process.stdout.write("\x1b[?25h\x1b[?1049h\x1b[H");
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("keypress", handleKeypress);
      checkAuthStatus();
      startSidebarTimer();
      resolve();
    };

    if (cmdName === "usage") {
      restoreTuiState();
      return;
    }

    process.stdout.write("\n  Press Enter to return to Astrivya TUI...");
    process.stdin.resume();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", () => {
      rl.close();
      restoreTuiState();
    });
  });
}

async function resumeSessionById(id: string): Promise<void> {
  try {
    const store = await getSessionStore();
    const { conversation, messages } = await store.getConversation(id);
    tuiConversationId = conversation.id;
    chatHistory.length = 0;
    for (const m of messages) {
      chatHistory.push({ role: m.role, content: m.content });
    }
    const shortTitle = conversation.title.length > 20 ? `${conversation.title.slice(0, 20)}\u2026` : conversation.title;
    setSessionTitle(shortTitle);
    chatHistory.push({
      role: "assistant",
      content: `Resumed: ${conversation.title} (${messages.length} messages)`,
    });
  } catch (e: unknown) {
    chatHistory.push({ role: "assistant", content: `Error resuming session: ${getErrorMessage(e)}` });
  }
  render();
}

async function executeCliCommand(cmd: string, args: string) {
  // Intercept session management commands to update TUI-local state
  if (cmd === "sessions") {
    const sub = args.trim();
    if (sub === "new" || sub.startsWith("new ")) {
      const title = sub.startsWith("new ") ? sub.slice(4).trim() : undefined;
      try {
        const store = await getSessionStore();
        const conv = await store.createConversation(title || "New Conversation");
        tuiConversationId = conv.id;
        chatHistory.length = 0;
        setSessionTitle("New\u2026");
        chatHistory.push({ role: "assistant", content: `Started new session: ${conv.id}` });
      } catch (e: unknown) {
        chatHistory.push({ role: "assistant", content: `Error creating session: ${getErrorMessage(e)}` });
      }
      render();
      return;
    }
    if (sub.startsWith("resume ") || sub === "resume") {
      const id = sub.startsWith("resume ") ? sub.slice(7).trim() : "";
      if (!id) {
        chatHistory.push({ role: "assistant", content: "Usage: /sessions resume <id>" });
        render();
        return;
      }
      await resumeSessionById(id);
      return;
    }
    if (sub === "") {
      await openSessionPicker();
      return;
    }
    if (sub === "list" || sub === "ls") {
      try {
        const store = await getSessionStore();
        const conversations = await store.listConversations();
        if (conversations.length === 0) {
          chatHistory.push({ role: "assistant", content: "No sessions yet. Start a chat to create one." });
        } else {
          const lines: string[] = [];
          for (const c of conversations) {
            const active = c.id === tuiConversationId ? ">" : " ";
            const pin = c.is_pinned ? color.yellow("\u2605") : " ";
            const title = c.title.length > 28 ? `${c.title.slice(0, 25)}...` : c.title;
            const date = new Date(c.updated_at).toLocaleDateString();
            const msgCount = c.message_count;
            lines.push(`${active} ${pin} ${color.bold(title)} ${color.dim(`${msgCount} msgs, ${date}`)}`);
          }
          chatHistory.push({ role: "assistant", content: lines.join("\n") });
        }
      } catch (e: unknown) {
        chatHistory.push({ role: "assistant", content: `Error listing sessions: ${getErrorMessage(e)}` });
      }
      render();
      return;
    }
  }

  // ── AKG command interception ──
  if (cmd === "akg") {
    const sub = args.trim();

    // Helper: show progress by mutating the last assistant message in-place
    let akgProgressIdx: number | null = null;
    const showAkgProgress = async (msg: string) => {
      if (akgProgressIdx !== null) {
        chatHistory[akgProgressIdx].content = msg;
        // Content mutated in place — message count is unchanged, so the chat
        // wrap cache (keyed on count + loading) would serve stale lines.
        // Invalidate it so the new content actually renders.
        cachedChatVersion = -1;
      } else {
        chatHistory.push({ role: "assistant", content: msg });
        akgProgressIdx = chatHistory.length - 1;
      }
      renderNow();
      // Yield to event loop so terminal flushes before any blocking sync op
      await new Promise((r) => setImmediate(r));
    };

    // /akg init [path]  or  /akg reindex
    if (sub === "init" || sub.startsWith("init ") || sub === "reindex" || sub.startsWith("reindex ")) {
      const targetPath = sub.includes(" ")
        ? path.resolve(process.cwd(), sub.split(" ").slice(1).join(" "))
        : process.cwd();
      const isReindex = sub.startsWith("reindex");

      await showAkgProgress(`${color.dim("⟳")} ${isReindex ? "Re-indexing" : "Initializing"} AKG...`);
      try {
        const storage = new AkgStorage();
        await storage.init(targetPath);

        await showAkgProgress(`${color.dim("⟳")} Discovering workspace files...`);
        const indexer = new AkgIndexer(storage, targetPath);
        const result = await indexer.indexWorkspace(async (msg: string) => {
          await showAkgProgress(`${color.dim("⟳")} ${msg}`);
        });

        if (args.includes("--embed")) {
          await showAkgProgress(`${color.dim("⟳")} Loading ONNX model and generating embeddings...`);
          try {
            const { AkgEmbedder } = require("@astrivya/akg-indexer");
            const embedder = new AkgEmbedder();
            const paths = (require("env-paths") as typeof import("env-paths"))("astrivya", { suffix: "" });
            const modelsDir = path.join(paths.config, "models");
            const embResult = await embedder.embedAllChunks(storage, modelsDir, async (done: number, total: number) => {
              await showAkgProgress(
                `${color.dim("⟳")} Embedding chunks... ${done}/${total} (${Math.round((done / total) * 100)}%)`,
              );
            });
            await showAkgProgress(`${color.green("✔")} Embedded ${embResult.embedded}/${embResult.total} chunks.`);
          } catch (e: unknown) {
            await showAkgProgress(`${color.yellow("!")} Embedding skipped: ${getErrorMessage(e)}`);
          }
        }

        await showAkgProgress(
          `${color.green("✔")} AKG ${isReindex ? "reindexed" : "initialized"}! ` +
            `${result.filesIndexed} files indexed.`,
        );
      } catch (e: unknown) {
        await showAkgProgress(`${color.red("✘")} Failed: ${getErrorMessage(e)}`);
      }
      return;
    }

    // /akg query <question>
    if (sub.startsWith("query ") || sub === "query") {
      const question = sub.startsWith("query ") ? sub.slice(6).trim() : "";
      if (!question) {
        chatHistory.push({ role: "assistant", content: "Usage: /akg query <question>" });
        render();
        return;
      }

      await showAkgProgress(
        `${color.dim("⟳")} Searching AKG for "${question.length > 40 ? `${question.slice(0, 37)}...` : question}"...`,
      );
      try {
        const storage = new AkgStorage();
        await storage.init(process.cwd());
        const queryEngine = new AkgQuery(storage, process.cwd());
        const results = await queryEngine.retrieve(question);

        if (results.length === 0) {
          await showAkgProgress(`${color.yellow("!")} No matches found for "${question}"`);
        } else {
          const lines: string[] = [];
          lines.push(`  ${color.bold(`Results for: ${question}`)}`);
          lines.push(`  ${color.dim("─".repeat(32))}`);
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const loc = r.startLine ? `:${r.startLine}-${r.endLine}` : "";
            lines.push(`  ${color.green(`[${i + 1}]`)} ${color.bold(r.filePath)}${loc}`);
            lines.push(`  ${color.dim(`score: ${r.score.toFixed(2)} · ${r.source}`)}`);
            const snippet = r.content.length > 150 ? `${r.content.slice(0, 150)}...` : r.content;
            lines.push(`  ${snippet.split("\n")[0]}`);
            lines.push("");
          }
          await showAkgProgress(lines.join("\n"));
        }
      } catch (e: unknown) {
        await showAkgProgress(`${color.red("✘")} Query failed: ${getErrorMessage(e)}`);
      }
      return;
    }

    // /akg topo — show topological dependency order
    if (sub === "topo") {
      const dbPath = path.join(process.cwd(), ".astrivya", "akg.db");
      if (!fs.existsSync(dbPath)) {
        chatHistory.push({ role: "assistant", content: "AKG not initialized. Run /akg init first." });
        render();
        return;
      }

      await showAkgProgress(`${color.dim("⟳")} Computing dependency order...`);
      try {
        const storage = new AkgStorage();
        await storage.init(process.cwd());
        const traversal = new GraphTraversal(storage);

        const startTime = performance.now();
        const result = traversal.topologicalSort(["imports", "depends_on"], ["file"]);
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

        const lines: string[] = [];
        lines.push(`  ${color.dim("─".repeat(44))}`);
        lines.push(`  ${color.bold("Dependency Order (topological sort)")}`);
        lines.push(`  ${color.dim("─".repeat(44))}`);
        lines.push(`  ${result.entries.length} files · ${elapsed}s`);

        // Depth summary
        const depthCounts = new Map<number, number>();
        for (const e of result.entries) {
          depthCounts.set(e.depth, (depthCounts.get(e.depth) || 0) + 1);
        }
        const depthSummary = [...depthCounts.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([d, cnt]) => `${color.dim(`D${d}:`)}${cnt}`)
          .join(" · ");
        lines.push(`  ${depthSummary}`);

        if (result.cycleNodeIds.length > 0) {
          lines.push(
            `  ${color.yellow(`⚠ ${result.cycleNodeIds.length} file${result.cycleNodeIds.length > 1 ? "s" : ""} in cycles`)}`,
          );
        }
        lines.push("");

        // Show entries (truncated if too many)
        const MAX_SHOW = 40;
        const showAll = result.entries.length <= MAX_SHOW;
        if (!showAll) {
          lines.push(
            `  ${color.dim(`Showing 20 of ${result.entries.length} files (use /akg topo --all for full list):`)}`,
          );
        }
        const displayed = showAll ? result.entries : result.entries.slice(0, 20);
        for (const e of displayed) {
          const label = e.node.sourceFile || e.node.label;
          lines.push(`  ${color.dim(`${e.depth}`)} ${label}`);
        }
        if (!showAll) {
          const omitted = result.entries.length - 20;
          lines.push(`  ${color.dim(`  … ${omitted} more`)}`);
        }

        // Show cycle participants
        if (result.cycleNodeIds.length > 0) {
          lines.push("");
          lines.push(`  ${color.yellow("⚠ Cycle participants:")}`);
          for (const id of result.cycleNodeIds) {
            const node = storage.getNode(id);
            const label = node?.sourceFile || node?.label || id;
            lines.push(`    ${color.yellow("⟳")} ${color.dim(label)}`);
          }
        }

        storage.close();
        await showAkgProgress(lines.join("\n"));
      } catch (e: unknown) {
        await showAkgProgress(`${color.red("✘")} Topological sort failed: ${getErrorMessage(e)}`);
      }
      return;
    }

    // /akg (bare) — show dashboard
    if (sub === "") {
      await showAkgProgress(`${color.dim("⟳")} Loading AKG status...`);

      const dbPath = path.join(process.cwd(), ".astrivya", "akg.db");
      const exists = fs.existsSync(dbPath);
      const lines: string[] = [];
      lines.push(`  ${color.dim("─".repeat(32))}`);
      lines.push(`  ${color.bold("Astrivya Knowledge Graph")}`);
      lines.push(`  ${color.dim("─".repeat(32))}`);

      if (exists) {
        let lastIdx = "Never";
        let fileCount = 0;
        let nodeCount = 0;
        let edgeCount = 0;
        let staleCount = 0;
        try {
          const stats = fs.statSync(dbPath);
          lastIdx = formatRelativeTime(new Date(stats.mtime).toISOString());
          const storage = new AkgStorage();
          await storage.init(process.cwd());
          const s = storage.getStats();
          nodeCount = s.nodes;
          edgeCount = s.edges;
          try {
            const rows = storage.runQuery("SELECT COUNT(*) as cnt FROM nodes WHERE type = 'file'");
            fileCount = rows[0].cnt;
          } catch {}
          try {
            staleCount = countStaleFiles(process.cwd(), dbPath);
          } catch {}
          storage.close();
        } catch {}
        lines.push(`  ${color.green("✔")} AKG Ready`);
        lines.push(`  Last indexed: ${color.dim(lastIdx)}`);
        lines.push(`  ${fileCount} files · ${nodeCount} nodes · ${edgeCount} edges`);
        if (staleCount > 0) {
          lines.push(`  ${color.yellow(`${staleCount} stale file${staleCount > 1 ? "s" : ""} (run /akg reindex)`)}`);
        }
      } else {
        lines.push(`  ${color.yellow("⚠ Not initialized")}`);
        lines.push(`  Run ${color.cyan("/akg init")} to index this repo.`);
        lines.push("  Free, local, private — helps me understand your code.");
      }

      lines.push("");
      lines.push(`  ${color.dim("Quick actions:")}`);
      lines.push(`  ${color.cyan("/akg init")}     Initialize or re-index`);
      if (exists) {
        lines.push(`  ${color.cyan("/akg reindex")}  Incremental re-index`);
        lines.push(`  ${color.cyan("/akg status")}   Detailed statistics`);
        lines.push(`  ${color.cyan("/akg query")}    Search the knowledge graph`);
        lines.push(`  ${color.cyan("/akg topo")}     Dependency order (topological sort)`);
      }
      lines.push(`  ${color.cyan("/akg help")}     All commands`);
      lines.push("");
      lines.push(`  ${color.dim("Every AI prompt is enriched with relevant")}`);
      lines.push(`  ${color.dim("code context from your workspace.")}`);
      lines.push(`  ${color.dim("─".repeat(32))}`);

      await showAkgProgress(lines.join("\n"));
      return;
    }

    // /akg status, /akg help, /akg export, etc. → fall through to commander
  }

  // Terminal passthrough for interactive commands (setup, init)
  if (needsTerminalPassthrough(cmd, args)) {
    await terminalPassthrough(cmd, args);
    render();
    return;
  }

  const input = `${cmd} ${args}`.trim();

  const result = await executeCommandSafely(input);

  // Re-ref and resume stdin after command dispatch (can lose ref or become paused during parseAsync/stdout capture)
  if (process.stdin.isTTY) {
    process.stdin.ref();
    process.stdin.resume();
  }

  if (result.error) {
    const combined = `${result.output} ${result.error}`;
    if (combined.includes("401") || combined.includes("Unauthorized") || combined.includes("token may be expired")) {
      chatHistory.push({
        role: "assistant",
        content: `${combined}\n\n  ${amber("!")} Token expired. Type ${amber("/auth login")} to re-authenticate.`,
      });
      authStatus = "expired";
    } else if (result.output.startsWith("Usage:")) {
      chatHistory.push({ role: "assistant", content: result.output });
    } else {
      chatHistory.push({ role: "assistant", content: `/ ${cmd}: ${result.error}` });
    }
  } else {
    chatHistory.push({ role: "assistant", content: result.output || `/${cmd}: ok` });
  }
  checkAuthStatus();
  render();
}

async function submitPrompt() {
  try {
    // Auto-complete selected slash command if dropdown is active
    if (slashActive && inputBuffer.startsWith("/")) {
      const q = inputBuffer.slice(1);
      const filtered = getFilteredCommands(q);
      if (filtered.length > 0) {
        const selected = filtered[slashSelectedIndex] || filtered[0];
        const spaceIdx = q.indexOf(" ");
        if (spaceIdx > 0) {
          const parent = q.slice(0, spaceIdx);
          inputBuffer = `/${parent} ${selected.name}`;
        } else {
          inputBuffer = `/${selected.name}`;
        }
      }
      slashActive = false;
      slashSelectedIndex = 0;
      slashStartIndex = 0;
    }

    const promptVal = inputBuffer.trim();
    if (!promptVal || loading || busy) return;

    appendHistory(promptVal);
    historyIdx = -1;

    inputBuffer = "";

    if (promptVal === "exit" || promptVal === "quit") {
      cleanupAndExit();
      return;
    }

    if (promptVal.startsWith("/")) {
      busy = true;
      try {
        const parts = promptVal.slice(1).split(" ");
        const cmd = parts[0];
        const args = parts.slice(1).join(" ");
        await executeCliCommand(cmd, args);
      } finally {
        busy = false;
      }
      return;
    }

    loading = true;
    streamingText = "";
    chatHistory.push({ role: "user", content: promptVal });

    // ── Persist to local session store ──
    if (!tuiConversationId) {
      try {
        const store = await getSessionStore();
        const conv = await store.createConversation("New Conversation");
        tuiConversationId = conv.id;
        setSessionTitle("New\u2026");
      } catch {}
    }
    if (tuiConversationId) {
      try {
        const store = await getSessionStore();
        await store.addMessage(tuiConversationId, "user", promptVal);
        // Auto-title from first user message
        const userMsgCount = chatHistory.filter((m) => m.role === "user").length;
        if (userMsgCount === 1) {
          const title = promptVal.length > 50 ? `${promptVal.slice(0, 47)}...` : promptVal;
          await store.updateConversation(tuiConversationId, { title });
          const shortTitle = title.length > 20 ? `${title.slice(0, 20)}\u2026` : title;
          setSessionTitle(shortTitle);
        }
      } catch {}
    }

    renderNow();

    // One-time AKG onboarding hint
    if (!akgOnboardingShown) {
      try {
        const akgDbPath = path.join(process.cwd(), ".astrivya", "akg.db");
        if (!fs.existsSync(akgDbPath)) {
          akgOnboardingShown = true;
          chatHistory.push({
            role: "assistant",
            content:
              `${color.dim("─".repeat(32))}\n` +
              `${color.yellow("⚡")} ${color.bold("Tip:")} I can use your actual code to give better answers.\n` +
              `  Run ${color.cyan("/akg init")} to index this repo — free, local, private.\n` +
              `  Or ${color.cyan("/akg")} to learn more.\n` +
              `${color.dim("─".repeat(32))}`,
          });
        }
      } catch {}
    }

    let enrichedPrompt = promptVal;
    try {
      const query = await getAkgQuery();
      const results = await query.retrieve(promptVal);
      const context = query.buildContext(promptVal, results);
      if (context) {
        enrichedPrompt = `${context}\n\n[User Question]\n${promptVal}`;
      }
    } catch (err) {
      // ignore
    }

    try {
      const result = await RuntimeExecutor.generate(enrichedPrompt, {
        onToken(token: string) {
          streamingText += token;
          render();
        },
      });
      chatHistory.push({ role: "assistant", content: result });
      if (tuiConversationId) {
        try {
          const store = await getSessionStore();
          await store.addMessage(tuiConversationId, "assistant", result);
        } catch {}
      }
    } catch (err: unknown) {
      chatHistory.push({ role: "assistant", content: `Error: ${getErrorMessage(err)}` });
    } finally {
      loading = false;
      streamingText = "";
      renderNow();
    }
  } catch (err: unknown) {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      fs.appendFileSync(
        path.join(process.cwd(), "astrivya-debug.log"),
        `[TUI ERROR] ${new Date().toISOString()} - Error: ${err instanceof Error ? err.stack : String(err)}\n`,
      );
    } catch {}

    busy = false;
    loading = false;
    streamingText = "";
    chatHistory.push({ role: "assistant", content: `Error: ${getErrorMessage(err)}` });
    renderNow();
  }
}

async function openSessionPicker(): Promise<void> {
  try {
    const store = await getSessionStore();
    const convs = await store.listConversations();
    if (convs.length === 0) return;
    sessionPickerSavedHistory = chatHistory.slice();
    sessionPickerSessions = convs.map((c) => ({
      id: c.id,
      title: c.title,
      message_count: c.message_count,
      updated_at: c.updated_at,
    }));
    sessionPickerIndex = sessionPickerSessions.findIndex((s) => s.id === tuiConversationId);
    if (sessionPickerIndex < 0) sessionPickerIndex = 0;
    sessionPickerActive = true;
  } catch {}
  render();
}

function handleKeypress(str: string, key: readline.Key) {
  if (!key) return;

  // ── Session picker key routing ──
  if (sessionPickerActive) {
    if (key.name === "escape") {
      chatHistory.length = 0;
      chatHistory.push(...sessionPickerSavedHistory);
      sessionPickerActive = false;
      sessionPickerIndex = 0;
      render();
      return;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      if (sessionPickerSessions.length > 0) {
        sessionPickerIndex = (sessionPickerIndex - 1 + sessionPickerSessions.length) % sessionPickerSessions.length;
        render();
      }
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      if (sessionPickerSessions.length > 0) {
        sessionPickerIndex = (sessionPickerIndex + 1) % sessionPickerSessions.length;
        render();
      }
      return;
    }
    if (key.name === "return") {
      const selected = sessionPickerSessions[sessionPickerIndex];
      if (selected) {
        sessionPickerActive = false;
        // Cancel current session tracking when switching
        tuiConversationId = null;
        resumeSessionById(selected.id).catch(() => {});
      }
      return;
    }
    // eat all other keys while picker is active
    return;
  }

  if (key.ctrl && key.name === "c") {
    cleanupAndExit();
    return;
  }
  if (key.ctrl && key.name === "o") {
    toggleOfflineMode();
    return;
  }
  if (key.ctrl && key.name === "r") {
    switchRuntime();
    return;
  }
  if (key.ctrl && key.name === "p") {
    openSessionPicker().catch(() => {});
    return;
  }
  if (key.name === "return") {
    submitPrompt().catch(() => {});
    return;
  }
  if (key.name === "escape") {
    if (slashActive) {
      const q = inputBuffer.slice(1);
      if (q.includes(" ")) {
        inputBuffer = `/${q.slice(0, q.indexOf(" "))}`;
      } else {
        slashActive = false;
        inputBuffer = "";
      }
      slashSelectedIndex = 0;
      slashStartIndex = 0;
      render();
    }
    return;
  }
  if (key.name === "tab") {
    if (slashActive) {
      const q = inputBuffer.slice(1);
      if (q.includes(" ")) return;
      const filtered = getFilteredCommands(q);
      const selected = filtered[slashSelectedIndex] || filtered[0];
      if (selected && hasSubCommands(selected.name)) {
        const completed = autoCompleteSlash(inputBuffer);
        if (completed) inputBuffer = completed;
        slashSelectedIndex = 0;
        slashStartIndex = 0;
        render();
      }
    } else {
      dashboardActive = !dashboardActive;
      dashboardScrollIndex = 0;
      render();
    }
    return;
  }
  if (key.name === "left") {
    if (slashActive) {
      const q = inputBuffer.slice(1);
      if (q.includes(" ")) {
        inputBuffer = `/${q.slice(0, q.indexOf(" "))}`;
        slashSelectedIndex = 0;
        slashStartIndex = 0;
        render();
      }
    }
    return;
  }
  if (key.name === "up") {
    if (dashboardActive) {
      if (dashboardScrollIndex > 0) {
        dashboardScrollIndex--;
        render();
      }
      return;
    }
    if (slashActive) {
      const filtered = getFilteredCommands(inputBuffer.slice(1));
      if (filtered.length > 0) {
        slashSelectedIndex = (slashSelectedIndex - 1 + filtered.length) % filtered.length;
        render();
      }
    } else if (history.length > 0) {
      if (historyIdx === -1) {
        historyIdx = history.length - 1;
      } else {
        historyIdx = Math.max(0, historyIdx - 1);
      }
      inputBuffer = history[historyIdx];
      render();
    }
    return;
  }
  if (key.name === "down") {
    if (dashboardActive) {
      const maxScroll = Math.max(0, sidebarData.memberActivity.length - 5);
      if (dashboardScrollIndex < maxScroll) {
        dashboardScrollIndex++;
        render();
      }
      return;
    }
    if (slashActive) {
      const filtered = getFilteredCommands(inputBuffer.slice(1));
      if (filtered.length > 0) {
        slashSelectedIndex = (slashSelectedIndex + 1) % filtered.length;
        render();
      }
    } else if (historyIdx >= 0) {
      historyIdx++;
      if (historyIdx >= history.length) {
        historyIdx = -1;
        inputBuffer = "";
      } else {
        inputBuffer = history[historyIdx];
      }
      render();
    }
    return;
  }
  if (key.name === "backspace" || key.name === "delete" || str === "\x08" || str === "\x7f") {
    if (inputBuffer.length > 0) {
      inputBuffer = inputBuffer.slice(0, -1);
      slashSelectedIndex = 0;
      slashStartIndex = 0;
      if (inputBuffer.length === 0 && slashActive) {
        slashActive = false;
      }
      render();
    }
    return;
  }

  if (str && str.length === 1 && str.charCodeAt(0) >= 32) {
    inputBuffer += str;
    slashSelectedIndex = 0;
    slashStartIndex = 0;
    historyIdx = -1;
    if (inputBuffer === "/") {
      slashActive = true;
    }
    render();
  }
}

export async function startTui(): Promise<void> {
  startSidebarTimer();
  process.stdout.write("\x1b[?1049h\x1b[H");

  readline.emitKeypressEvents(process.stdin);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  // Ensure stdin keeps the event loop alive (it can become unref'd after command dispatch)
  if (process.stdin.isTTY) {
    process.stdin.ref();
  }

  checkAuthStatus();
  renderNow();

  process.stdin.on("keypress", handleKeypress);

  process.stdout.on("resize", () => {
    process.stdout.write("\x1b[2J\x1b[H");
    renderNow();
  });

  process.on("SIGINT", () => cleanupAndExit());
  process.on("SIGTERM", () => cleanupAndExit());
}
