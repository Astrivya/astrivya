#!/usr/bin/env node
/**
 * Astrivya CLI end-to-end tests.
 *
 * Spawns the REAL built CLI (`dist/index.js`) against isolated temp
 * workspaces and asserts on its output. No mocks — this is the closest thing
 * to what a user's terminal does.
 *
 * Usage:
 *   npm -w packages/cli run build   (once, or use dist from a prior build)
 *   npm -w packages/cli run test:e2e
 *
 * Requires a TTY-less environment (CI-safe). All state (config dir, home,
 * workspace) is redirected to temp dirs so the run never touches your real
 * config or repos.
 */
import { execSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "..", "dist", "index.js");

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  \u2717 ${msg}`);
  }
}

/** Create an isolated env (no real config, no inherited ASTRIVYA_* vars). */
function isolatedEnv(extra = {}) {
  const env = {
    ...process.env,
    ASTRIVYA_TOKEN: "",
    ASTRIVYA_API_KEY: "",
    ASTRIVYA_BASE_URL: "",
    ASTRIVYA_ORG_ID: "",
    NO_COLOR: "1",
    NO_UPDATE_NOTIFIER: "1",
    ASTRIVYA_AUTO_INDEX: "off",
  };
  // Point all user-config locations at temp dirs.
  if (process.platform === "win32") {
    env.APPDATA = extra.home;
    env.USERPROFILE = extra.home;
  } else {
    env.XDG_CONFIG_HOME = path.join(extra.home, ".config");
    env.HOME = extra.home;
  }
  // Clean the ASTRIVYA_* prefixed vars we know about, keep the rest.
  for (const k of Object.keys(env)) {
    if (k.startsWith("ASTRIVYA_") && !["ASTRIVYA_AUTO_INDEX"].includes(k)) delete env[k];
  }
  return { ...env, ...extra.env };
}

/** Run the CLI in a workspace and return { status, stdout, stderr }. */
function run(args, { cwd, env, timeoutMs = 60_000 } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astrivya-e2e-"));
  return dir;
}

const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const OSC_RE = /\u001b\][^\u0007]*\u0007/g;

/**
 * Drive the interactive TUI over piped stdin (no PTY required — readline
 * emitKeypressEvents parses the bytes, and the renderer falls back to 80x24).
 * Returns the ANSI-stripped output captured before the process was killed.
 */
async function runTui(keys, { cwd, env, waits = [1200, 500, 500, 500, 500, 800] }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
    });
    let step = 0;
    const writeNext = () => {
      if (step >= keys.length) {
        setTimeout(
          () => {
            try {
              child.kill();
            } catch {}
            const plain = out.replace(OSC_RE, "").replace(ANSI_RE, "");
            resolve(plain);
          },
          waits[waits.length - 1],
        );
        return;
      }
      try {
        child.stdin.write(keys[step]);
      } catch {
        // stdin closed — stop feeding keys
        step = keys.length;
      }
      step++;
      setTimeout(writeNext, waits[Math.min(step, waits.length - 2)]);
    };
    setTimeout(writeNext, waits[0]);
  });
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold file locks briefly
  }
}

async function main() {
  if (!fs.existsSync(CLI)) {
    console.error(`CLI not built. Run: npm -w packages/cli run build\n(Expected ${CLI})`);
    process.exit(1);
  }

  console.log(`\nAstrivya CLI e2e — ${CLI}\n`);

  // ── 1. Help & version ──────────────────────────────────────────────
  console.log("1. Help & version");
  const ws1 = makeWorkspace();
  const home1 = makeWorkspace();
  const env1 = isolatedEnv({ home: home1 });
  const help = run(["--help"], { cwd: ws1, env: env1 });
  assert(help.status === 0, "`--help` exits 0");
  for (const cmd of ["init", "akg", "status", "doctor", "mcp-server", "setup", "mcp"]) {
    assert(help.stdout.includes(`  ${cmd}`) || help.stdout.includes(cmd), `help lists \`${cmd}\``);
  }
  const version = run(["--version"], { cwd: ws1, env: env1 });
  assert(version.status === 0 && /\d+\.\d+\.\d+/.test(version.stdout.trim()), "`--version` prints a semver");
  const unknown = run(["definitely-not-a-command"], { cwd: ws1, env: env1 });
  assert(unknown.status !== 0, "unknown command exits non-zero");
  cleanup(ws1);
  cleanup(home1);

  // ── 2. Config get/set/unset round-trip ─────────────────────────────
  console.log("\n2. Config round-trip");
  const ws2 = makeWorkspace();
  const home2 = makeWorkspace();
  const env2 = isolatedEnv({ home: home2 });
  run(["config", "set", "e2e.test", "hello"], { cwd: ws2, env: env2 });
  const got = run(["config", "get", "e2e.test"], { cwd: ws2, env: env2 });
  assert(got.stdout.trim() === "hello", "`config set` → `config get` round-trips");
  const show = run(["config", "show", "--json"], { cwd: ws2, env: env2 });
  assert(show.status === 0 && show.stdout.includes('"e2e.test"'), "`config show --json` includes the key");
  run(["config", "unset", "e2e.test"], { cwd: ws2, env: env2 });
  const gone = run(["config", "get", "e2e.test"], { cwd: ws2, env: env2 });
  assert(gone.stdout.includes("not set"), "`config unset` removes the value");
  cleanup(ws2);
  cleanup(home2);

  // ── 3. AKG init / status / query / export / import ────────────────
  console.log("\n3. AKG lifecycle");
  const ws3 = makeWorkspace();
  const home3 = makeWorkspace();
  const env3 = isolatedEnv({ home: home3 });
  fs.writeFileSync(
    path.join(ws3, "sample.ts"),
    "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n",
  );
  fs.writeFileSync(path.join(ws3, "README.md"), "# E2E Workspace\n\nA sample project for testing.\n");
  const initRes = run(["akg", "init", "--no-embed"], { cwd: ws3, env: env3, timeoutMs: 120_000 });
  assert(initRes.status === 0, "`akg init --no-embed` exits 0");
  assert(fs.existsSync(path.join(ws3, ".astrivya", "akg.db")), "`akg init` creates .astrivya/akg.db");
  const status = run(["akg", "status"], { cwd: ws3, env: env3 });
  assert(status.status === 0 && /Nodes:\s+\d+/.test(status.stdout), "`akg status` prints node counts");
  const query = run(["akg", "query", "greet"], { cwd: ws3, env: env3 });
  assert(query.status === 0, "`akg query` exits 0");
  assert(query.stdout.includes("sample.ts"), "`akg query` finds the indexed file");
  const queryMiss = run(["akg", "query", "zzz_nonexistent_zzz"], { cwd: ws3, env: env3 });
  assert(queryMiss.status === 0, "`akg query` with no matches exits 0");
  const exp = run(["akg", "export", "kg.json"], { cwd: ws3, env: env3 });
  assert(exp.status === 0 && fs.existsSync(path.join(ws3, "kg.json")), "`akg export` writes JSON");
  const imp = run(["akg", "import", "kg.json"], { cwd: ws3, env: env3 });
  assert(imp.status === 0, "`akg import` re-imports the export");
  const impMissing = run(["akg", "import", "nope.json"], { cwd: ws3, env: env3 });
  assert(impMissing.status !== 0, "`akg import` of a missing file fails");
  cleanup(ws3);
  cleanup(home3);

  // ── 4. MCP journal inspection ──────────────────────────────────────
  console.log("\n4. MCP journal");
  const ws4 = makeWorkspace();
  const home4 = makeWorkspace();
  const env4 = isolatedEnv({ home: home4 });
  const mcp = run(["mcp"], { cwd: ws4, env: env4 });
  assert(mcp.status === 0, "`mcp` exits 0");
  assert(/No MCP activity/.test(mcp.stdout), "`mcp` reports no activity on a fresh workspace");
  const mcpLog = run(["mcp", "log"], { cwd: ws4, env: env4 });
  assert(mcpLog.status === 0, "`mcp log` exits 0");
  cleanup(ws4);
  cleanup(home4);

  // ── 5. Non-interactive init wizard ─────────────────────────────────
  console.log("\n5. `init --yes` wizard");
  const ws5 = makeWorkspace();
  const home5 = makeWorkspace();
  const env5 = isolatedEnv({ home: home5 });
  fs.writeFileSync(path.join(ws5, "app.js"), "console.log('hi');\n");
  const wizard = run(["init", "--yes", "--skip-doctor"], {
    cwd: ws5,
    env: env5,
    timeoutMs: 120_000,
  });
  assert(wizard.status === 0, "`init --yes --skip-doctor` exits 0 (non-interactive)");
  assert(wizard.stdout.includes("Setup complete"), "wizard prints the completion banner");
  assert(fs.existsSync(path.join(ws5, ".astrivya", "akg.db")), "wizard indexes the workspace (no --skip-index)");
  const wizardSkip = run(["init", "--yes", "--skip-index", "--skip-doctor"], { cwd: ws5, env: env5 });
  assert(wizardSkip.status === 0, "`init --yes --skip-index --skip-doctor` exits 0");
  cleanup(ws5);
  cleanup(home5);

  // ── 6. --print mode (no ANSI) ──────────────────────────────────────
  console.log("\n6. Print-friendly mode");
  const ws6 = makeWorkspace();
  const home6 = makeWorkspace();
  const env6 = isolatedEnv({ home: home6 });
  const printed = run(["status", "--print"], { cwd: ws6, env: env6 });
  assert(printed.status === 0, "`status --print` exits 0");
  assert(!/\u001b\[/.test(printed.stdout), "`status --print` emits no ANSI escape codes");
  cleanup(ws6);
  cleanup(home6);

  // ── 7. JSON output modes ───────────────────────────────────────────
  console.log("\n7. JSON output");
  const ws7 = makeWorkspace();
  const home7 = makeWorkspace();
  const env7 = isolatedEnv({ home: home7 });
  const json = run(["status", "--json"], { cwd: ws7, env: env7 });
  assert(json.status === 0, "`status --json` exits 0");
  try {
    JSON.parse(json.stdout);
    assert(true, "`status --json` emits valid JSON");
  } catch {
    assert(false, "`status --json` emits valid JSON");
  }
  const mcpJson = run(["mcp", "--json"], { cwd: ws7, env: env7 });
  try {
    const parsed = JSON.parse(mcpJson.stdout);
    assert(parsed.hasJournal === false, "`mcp --json` has hasJournal=false on fresh workspace");
  } catch {
    assert(false, "`mcp --json` emits valid JSON");
  }
  cleanup(ws7);
  cleanup(home7);

  // ── 8. Interactive TUI (slash autocomplete via piped stdin) ───────
  console.log("\n8. Interactive TUI (slash autocomplete)");
  const ws8 = makeWorkspace();
  const home8 = makeWorkspace();
  const env8 = isolatedEnv({ home: home8 });
  fs.writeFileSync(path.join(ws8, "app.js"), "console.log('hi');\n");

  // "/" opens the command dropdown; "/akg " drills into akg subcommands.
  const dropdown = await runTui(["/", "akg "], { cwd: ws8, env: env8 });
  assert(dropdown.includes("query"), "TUI dropdown lists `query` after `/akg `");
  assert(dropdown.includes("reindex"), "TUI dropdown lists `reindex`");
  assert(dropdown.includes("impact"), "TUI dropdown lists `impact`");
  assert(dropdown.includes("trace"), "TUI dropdown lists `trace`");

  // Arrow keys move the dropdown selection; the selected item is marked ▸.
  const arrow = await runTui(["/", "\u001b[B"], { cwd: ws8, env: env8 });
  assert(arrow.includes("▸"), "TUI shows the ▸ selection marker after an arrow key");

  // Tab-complete "/akg" to "/akg " then Enter completes the first subcommand
  // (the TUI's designed dropdown behavior) — that runs `akg init`.
  const completed = await runTui(["/akg", "\t", "\r"], { cwd: ws8, env: env8 });
  assert(completed.includes("Initializing AKG"), "Tab+Enter auto-completes the first subcommand (/akg init)");

  // Escape collapses the dropdown to "/akg"; Enter then runs the AKG dashboard.
  // Fresh workspace (the tab+enter test above indexed ws8) so the dashboard
  // reports "not initialized". Longer final wait: the sidebar telemetry tick
  // interleaves renders.
  const ws9 = makeWorkspace();
  const home9 = makeWorkspace();
  const env9 = isolatedEnv({ home: home9 });
  fs.writeFileSync(path.join(ws9, "app.js"), "console.log('hi');\n");
  // The ESC gap must exceed readline's ~1s escape-timeout, or ESC+\r merge
  // into an unparseable sequence and both are swallowed.
  const dash = await runTui(["/akg", "\t", "\u001b", "\r"], {
    cwd: ws9,
    env: env9,
    waits: [1200, 400, 400, 1300, 2000],
  });
  assert(dash.includes("Not initialized"), "Escape then Enter runs the AKG dashboard");
  assert(dash.includes("/akg init"), "Dashboard suggests `/akg init`");

  cleanup(ws8);
  cleanup(home8);
  cleanup(ws9);
  cleanup(home9);

  // ── 9. Git hooks ────────────────────────────────────────────────────
  console.log("\n9. Git hooks");
  const ws10 = makeWorkspace();
  const home10 = makeWorkspace();
  const env10 = isolatedEnv({ home: home10 });
  try {
    execSync("git init -q", { cwd: ws10, stdio: "ignore" });
    const hooksDir = path.join(ws10, ".git", "hooks");
    const inst = run(["hooks", "install"], { cwd: ws10, env: env10 });
    assert(inst.status === 0, "`hooks install` exits 0");
    const commitHook = fs.existsSync(path.join(hooksDir, "post-commit"));
    const mergeHook = fs.existsSync(path.join(hooksDir, "post-merge"));
    assert(commitHook && mergeHook, "`hooks install` writes post-commit and post-merge");
    const content = fs.readFileSync(path.join(hooksDir, "post-commit"), "utf-8");
    assert(content.includes("Astrivya AKG auto-index hook"), "hook body is the Astrivya auto-index script");
    const st = run(["hooks", "status"], { cwd: ws10, env: env10 });
    assert(st.stdout.includes("All AKG hooks installed"), "`hooks status` reports all installed");
    const unst = run(["hooks", "uninstall"], { cwd: ws10, env: env10 });
    assert(unst.status === 0, "`hooks uninstall` exits 0");
    assert(!fs.existsSync(path.join(hooksDir, "post-commit")), "`hooks uninstall` removes the hooks");
  } catch (e) {
    assert(false, `git hooks lifecycle (git init failed: ${e.message})`);
  }
  const ws10b = makeWorkspace();
  const noGit = run(["hooks", "status"], { cwd: ws10b, env: env10 });
  assert(noGit.stdout.includes("No .git directory"), "`hooks status` outside a repo reports no .git");
  cleanup(ws10b);
  cleanup(ws10);
  cleanup(home10);

  // ── 10. Sync ────────────────────────────────────────────────────────
  console.log("\n10. Sync");
  const ws11 = makeWorkspace();
  const home11 = makeWorkspace();
  const env11 = isolatedEnv({ home: home11, env: { ASTRIVYA_SYNC_URL: "http://127.0.0.1:1" } });
  const syncInit = run(["sync", "init", "--key", "test-key-123"], { cwd: ws11, env: env11 });
  assert(syncInit.status === 0 && syncInit.stdout.includes("Team sync initialized"), "`sync init --key` saves the key");
  const gotKey = run(["config", "get", "syncApiKey"], { cwd: ws11, env: env11 });
  assert(gotKey.stdout.trim() === "test-key-123", "sync key persisted to config");
  const push = run(["sync", "push"], { cwd: ws11, env: env11 });
  const pushAll = push.stdout + push.stderr; // error() writes to stderr
  assert(push.status !== 0 && pushAll.includes("Push failed"), "`sync push` to an unreachable relay fails cleanly");
  const pull = run(["sync", "pull"], { cwd: ws11, env: env11 });
  const pullAll = pull.stdout + pull.stderr;
  assert(pull.status !== 0 && pullAll.includes("Pull failed"), "`sync pull` to an unreachable relay fails cleanly");
  const syncSt = run(["sync", "status"], { cwd: ws11, env: env11 });
  assert(syncSt.status === 0 && syncSt.stdout.includes("Relay unreachable"), "`sync status` reports relay unreachable");
  const home11b = makeWorkspace();
  const noKeyPush = run(["sync", "push"], { cwd: ws11, env: isolatedEnv({ home: home11b }) });
  assert(
    noKeyPush.status !== 0 && (noKeyPush.stdout + noKeyPush.stderr).includes("No sync API key"),
    "`sync push` without a key errors",
  );
  cleanup(home11b);
  const syncKey = run(["sync", "key"], { cwd: ws11, env: env11 });
  assert(syncKey.status !== 0, "`sync key` without auth errors");
  cleanup(ws11);
  cleanup(home11);

  // ── 11. Team ────────────────────────────────────────────────────────
  console.log("\n11. Team");
  const ws12 = makeWorkspace();
  const home12 = makeWorkspace();
  const env12 = isolatedEnv({ home: home12 });
  const teamSt = run(["team", "status"], { cwd: ws12, env: env12 });
  assert(teamSt.status === 0 && teamSt.stdout.includes("unreachable"), "`team status` without auth shows unreachable");
  const teamCreate = run(["team", "create", "my-team"], { cwd: ws12, env: env12 });
  assert(teamCreate.status !== 0, "`team create` without auth errors");
  const teamMcp = run(["team", "mcp"], { cwd: ws12, env: env12 });
  assert(
    teamMcp.status !== 0 && (teamMcp.stdout + teamMcp.stderr).includes("No team MCP id"),
    "`team mcp` without an id errors",
  );
  const teamJoin = run(["team", "join", "CODE123"], { cwd: ws12, env: env12 });
  assert(teamJoin.status !== 0, "`team join` without auth errors");
  cleanup(ws12);
  cleanup(home12);

  // ── 12. Plugins ─────────────────────────────────────────────────────
  console.log("\n12. Plugins");
  const ws13 = makeWorkspace();
  const home13 = makeWorkspace();
  const env13 = isolatedEnv({ home: home13 });
  const plist = run(["plugins", "list"], { cwd: ws13, env: env13 });
  assert(plist.status === 0 && plist.stdout.includes("No plugins installed"), "`plugins list` on a clean env is empty");
  const psync = run(["plugins", "sync"], { cwd: ws13, env: env13 });
  assert(psync.status !== 0 && psync.stdout.includes("Not authenticated"), "`plugins sync` without auth errors");
  const pupdate = run(["plugins", "update", "foo"], { cwd: ws13, env: env13 });
  assert(pupdate.status !== 0 && pupdate.stdout.includes("Not authenticated"), "`plugins update` without auth errors");
  const pclear = run(["plugins", "clear"], { cwd: ws13, env: env13 });
  assert(
    pclear.status === 0 && pclear.stdout.includes("All plugins removed"),
    "`plugins clear` succeeds on a clean env",
  );
  const pdoc = run(["plugins", "doctor", "--json"], { cwd: ws13, env: env13 });
  assert(pdoc.status === 0, "`plugins doctor --json` exits 0");
  try {
    JSON.parse(pdoc.stdout);
    assert(true, "`plugins doctor --json` emits valid JSON");
  } catch {
    assert(false, "`plugins doctor --json` emits valid JSON");
  }
  cleanup(ws13);
  cleanup(home13);

  // ── 13. Credits ─────────────────────────────────────────────────────
  console.log("\n13. Credits");
  const ws14 = makeWorkspace();
  const home14 = makeWorkspace();
  const env14 = isolatedEnv({ home: home14 });
  const creds = run(["credits"], { cwd: ws14, env: env14 });
  assert(creds.status !== 0 && /not logged in/i.test(creds.stdout), "`credits` without auth says not logged in");
  const credsJson = run(["credits", "--json"], { cwd: ws14, env: env14 });
  assert(
    credsJson.status !== 0 && /not logged in/i.test(credsJson.stdout),
    "`credits --json` without auth says not logged in",
  );
  const hist = run(["credits", "history"], { cwd: ws14, env: env14 });
  assert(hist.status !== 0 && /not logged in/i.test(hist.stdout), "`credits history` without auth says not logged in");
  run(["config", "set", "offlineMode", "true"], { cwd: ws14, env: env14 });
  const offline = run(["credits"], { cwd: ws14, env: env14 });
  assert(offline.stdout.includes("only available in online mode"), "`credits` respects offline mode");
  cleanup(ws14);
  cleanup(home14);

  // ── Summary ────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(52)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(`    \u2717 ${f}`);
  }
  console.log(`${"=".repeat(52)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("e2e runner crashed:", err);
  process.exit(1);
});
