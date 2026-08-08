import * as readline from "node:readline";
import { getFlatCommandList } from "./command-registry";
import { amber, color } from "./output";

let _sessionTitle: string | null = null;

export function setSessionTitle(title: string | null): void {
  _sessionTitle = title;
}

export function getSessionTitle(): string | null {
  return _sessionTitle;
}

export interface CommandItem {
  name: string;
  description: string;
}

export type InputResult = { type: "text"; text: string } | { type: "command"; command: string; args: string };

function getCommands(): CommandItem[] {
  return getFlatCommandList();
}

const MAX_VISIBLE = 12;
const MAX_HISTORY = 50;

const HOME = "\x1b[G";
const CLEAR_DOWN = "\x1b[J";

function cursorUp(n: number): string {
  return n > 0 ? `\x1b[${n}A` : "";
}

// ── Non-TTY: single reusable readline interface ──
// Buffer lines because readline fires ALL line events before any await
// can register the next consumer.

let nonTtyRl: readline.Interface | null = null;
let nonTtyQueue: Array<(result: InputResult) => void> = [];
let nonTtyBuffer: string[] = [];

function getNonTtyInput(): Promise<InputResult> {
  return new Promise((resolve) => {
    if (nonTtyBuffer.length > 0) {
      resolve({ type: "text", text: nonTtyBuffer.shift()! });
      return;
    }
    nonTtyQueue.push(resolve);
    if (!nonTtyRl) {
      nonTtyRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      nonTtyRl.on("line", (line) => {
        const next = nonTtyQueue.shift();
        if (next) {
          next({ type: "text", text: line });
        } else {
          nonTtyBuffer.push(line);
        }
      });
    }
  });
}

function closeNonTty(): void {
  if (nonTtyRl) {
    nonTtyRl.close();
    nonTtyRl = null;
  }
  nonTtyQueue = [];
  nonTtyBuffer = [];
}

// ── Helpers ──

function len(s: string): number {
  return s.length;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getVisualLines(buffer: string, prefixWidth: number, cols: number): number {
  const lineWidth = prefixWidth + len(buffer);
  return Math.max(1, Math.ceil(lineWidth / cols));
}

// ── Main input function ──

export function replInput(): Promise<InputResult> {
  if (!process.stdin.isTTY) {
    return getNonTtyInput();
  }

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    let buffer = "";
    let selectedIndex = 0;
    let startIndex = 0;
    let slashActive = false;
    let lastSlashActive = false;
    let resolved = false;
    const history: string[] = [];
    let historyIdx = -1;

    // ── Raw mode safety: restore on any exit path ──

    function restoreRaw(): void {
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    }

    const onExit = () => restoreRaw();
    const onSigint = () => {
      restoreRaw();
      process.exit(130);
    };
    const onSigterm = () => {
      restoreRaw();
      process.exit(143);
    };

    process.on("exit", onExit);
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    stdin.setRawMode(true);
    stdin.resume();
    readline.emitKeypressEvents(stdin);

    // ── Filtering ──

    function getFiltered(): CommandItem[] {
      const all = getCommands();
      const q = buffer.slice(1).toLowerCase();
      if (!q) return all;
      return all.filter((c) => c.name.includes(q) || c.description.toLowerCase().includes(q));
    }

    // ── Render ──

    function render() {
      const cols = stdout.columns || 80;
      const titleTag = _sessionTitle ? `${color.cyan(_sessionTitle)} ` : "";
      const pfx = `${titleTag}${amber("\u276F")} `;
      const pfxWidth = len(pfx) + 2; // "  [title] ❯ "
      const visualLines = getVisualLines(buffer, pfxWidth, cols);

      // When previous render had NO dropdown and buffer wrapped, cursor is at
      // end of last wrapped line — move up to first line before clearing.
      // When previous render HAD a dropdown, cursor is already at prompt start.
      if (!lastSlashActive && visualLines > 1) {
        stdout.write(cursorUp(visualLines - 1));
      }
      stdout.write(HOME + CLEAR_DOWN);

      // ── Prompt line ──
      stdout.write(`  ${pfx}${buffer}`);

      if (!slashActive) {
        lastSlashActive = false;
        return;
      }

      // ── Dropdown ──
      stdout.write("\n");

      const filtered = getFiltered();

      // Cap visible to terminal height (dropdown section)
      const termRows = (stdout.rows || 24) - 2;
      const limit = Math.min(MAX_VISIBLE, termRows);

      // Keep selection in view
      if (filtered.length <= limit) {
        startIndex = 0;
      } else {
        if (selectedIndex < startIndex) {
          startIndex = selectedIndex;
        } else if (selectedIndex >= startIndex + limit) {
          startIndex = selectedIndex - limit + 1;
        }
      }

      const visible = filtered.slice(startIndex, startIndex + limit);

      const maxName = Math.min(Math.max(...getCommands().map((c) => len(c.name)), 8), Math.floor(cols * 0.35));
      const bulletW = 2;
      const gap = 2;
      const descW = Math.max(cols - 4 - bulletW - maxName - gap - 2, 10);

      let lineCount = 0;

      if (visible.length === 0) {
        stdout.write(`  ${color.dim("No matching commands")}\n`);
        lineCount = 1;
      } else {
        for (let i = 0; i < visible.length; i++) {
          const cmd = visible[i];
          const sel = startIndex + i === selectedIndex;
          const bullet = sel ? `${amber("\u25B8")} ` : "  ";
          const namePadded = cmd.name.padEnd(maxName);
          const namePart = sel ? amber(namePadded) : namePadded;
          const desc = cmd.description.slice(0, descW);
          stdout.write(`${bullet}${namePart}${" ".repeat(gap)}${color.dim(desc)}\n`);
          lineCount++;
        }

        const remainingBelow = filtered.length - (startIndex + visible.length);
        const remainingAbove = startIndex;
        if (remainingBelow > 0 || remainingAbove > 0) {
          let moreText = "";
          if (remainingAbove > 0 && remainingBelow > 0) {
            moreText = `${remainingAbove} more above, ${remainingBelow} more below`;
          } else if (remainingAbove > 0) {
            moreText = `${remainingAbove} more above`;
          } else {
            moreText = `${remainingBelow} more below`;
          }
          stdout.write(`  ${color.dim(moreText)}\n`);
          lineCount++;
        }
      }

      // Move cursor back to prompt start.
      // After writing prompt (visualLines lines) + `\n` (1 line) + dropdown (lineCount lines),
      // cursor is visualLines + lineCount lines below prompt start.
      stdout.write(cursorUp(visualLines + lineCount));
      lastSlashActive = true;
    }

    // ── Cleanup ──

    function cleanup() {
      if (resolved) return;
      resolved = true;
      restoreRaw();
      stdin.pause();
      stdin.removeAllListeners("keypress");
      stdout.removeListener("resize", onResize);
      process.off("exit", onExit);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }

    // ── Keypress handler ──

    function onKeypress(_str: string, key: readline.Key) {
      if (resolved) return;

      // Ctrl+C
      if (key.ctrl && key.name === "c") {
        cleanup();
        stdout.write("\n");
        restoreRaw();
        process.exit(130);
      }

      // Escape / Tab → dismiss dropdown, remove leading /
      if (key.name === "escape" || key.name === "tab") {
        if (slashActive) {
          slashActive = false;
          // Remove the leading / from buffer
          if (buffer.startsWith("/")) {
            buffer = buffer.slice(1);
          }
          selectedIndex = 0;
          render();
        }
        return;
      }

      // Enter → submit
      if (key.name === "enter" || key.name === "return") {
        stdout.write(HOME + CLEAR_DOWN);
        cleanup();

        if (slashActive) {
          const filtered = getFiltered();
          if (filtered.length > 0 && selectedIndex < filtered.length) {
            const cmd = filtered[selectedIndex];
            const rest = buffer
              .slice(1)
              .replace(new RegExp(`^\\s*${escapeRegex(cmd.name)}(?:\\s|$)`, "i"), "")
              .trim();
            resolve({ type: "command", command: cmd.name, args: rest });
            return;
          }
          // No matching command → strip / and submit as text
          const text = buffer.startsWith("/") ? buffer.slice(1) : buffer;
          if (text.trim()) {
            history.push(text.trim());
            if (history.length > MAX_HISTORY) history.shift();
          }
          historyIdx = -1;
          resolve({ type: "text", text });
          return;
        }

        if (buffer.trim()) {
          history.push(buffer.trim());
          if (history.length > MAX_HISTORY) history.shift();
        }
        historyIdx = -1;
        resolve({ type: "text", text: buffer });
        return;
      }

      // Up arrow
      if (key.name === "up") {
        if (slashActive) {
          const filtered = getFiltered();
          if (filtered.length > 0) {
            selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length;
            render();
          }
        } else if (!buffer && history.length > 0) {
          historyIdx = history.length - 1;
          buffer = history[historyIdx];
          render();
        }
        return;
      }

      // Down arrow
      if (key.name === "down") {
        if (slashActive) {
          const filtered = getFiltered();
          if (filtered.length > 0) {
            selectedIndex = (selectedIndex + 1) % filtered.length;
            render();
          }
        } else if (historyIdx >= 0) {
          historyIdx--;
          buffer = historyIdx >= 0 ? history[historyIdx] : "";
          if (historyIdx < 0) historyIdx = -1;
          render();
        }
        return;
      }

      // Backspace
      if (key.name === "backspace") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          selectedIndex = 0;
          if (buffer.length === 0 && slashActive) slashActive = false;
          render();
        }
        return;
      }

      // Printable character
      if (_str && _str.length === 1 && _str.charCodeAt(0) >= 32) {
        buffer += _str;
        selectedIndex = 0;
        historyIdx = -1;

        if (buffer === "/" && !slashActive) {
          slashActive = true;
        }

        render();
        return;
      }
    }

    // ── Terminal resize ──

    const onResize = () => {
      if (!resolved) render();
    };
    stdout.on("resize", onResize);

    // ── Key handler ──
    stdin.on("keypress", onKeypress);

    // ── Initial render ──
    render();
  });
}

export function closeRepl(): void {
  closeNonTty();
}
