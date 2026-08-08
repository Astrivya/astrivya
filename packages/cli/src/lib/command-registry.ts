import type { Command } from "commander";
import { setSilentSpinnerMode, stripAnsi } from "./output";

// ── Command metadata (for dropdown UI) ──

export interface CmdEntry {
  name: string;
  description: string;
}

export interface SubCmdMap {
  [parent: string]: CmdEntry[];
}

const COMMANDS: CmdEntry[] = [];
let HAS_SUBCOMMANDS: Record<string, boolean> = {};
let SUB_CMD_MAP: SubCmdMap = {};

// ── Share the commander program from index.ts ──

let commanderProgram: Command | null = null;

export function setGlobalProgram(program: Command): void {
  commanderProgram = program;
  buildFromProgram(program);
}

export function getCommanderProgram(): Command {
  if (!commanderProgram) {
    throw new Error("Commander program not initialized. Call setGlobalProgram() first.");
  }
  return commanderProgram;
}

// ── Build metadata from a populated commander program ──

function buildFromProgram(program: Command): void {
  COMMANDS.length = 0;
  HAS_SUBCOMMANDS = {};
  SUB_CMD_MAP = {};

  const seen = new Set<string>();

  function walk(cmd: Command, parentName?: string) {
    const name = cmd.name();

    if (parentName) {
      const fullName = `${parentName} ${name}`;
      if (!seen.has(fullName)) {
        seen.add(fullName);
        COMMANDS.push({ name: fullName, description: cmd.description() });
      }
      if (!SUB_CMD_MAP[parentName]) SUB_CMD_MAP[parentName] = [];
      SUB_CMD_MAP[parentName].push({ name, description: cmd.description() });
      HAS_SUBCOMMANDS[parentName] = true;
    } else if (name !== "astrivya") {
      if (!seen.has(name)) {
        seen.add(name);
        COMMANDS.push({ name, description: cmd.description() });
      }
    }

    const aliasList: string[] =
      typeof (cmd as any).aliases === "function" ? (cmd as any).aliases() : (cmd as any).aliases;
    for (const alias of aliasList) {
      if (!seen.has(alias)) {
        seen.add(alias);
        COMMANDS.push({ name: alias, description: cmd.description() });
      }
    }

    for (const sub of cmd.commands) {
      walk(sub, parentName || name);
    }
  }

  for (const cmd of program.commands) {
    walk(cmd);
  }
}

export function getFlatCommandList(): CmdEntry[] {
  return COMMANDS;
}

export function getSubCommandMap(): SubCmdMap {
  return SUB_CMD_MAP;
}

export function hasSubCommands(name: string): boolean {
  return !!HAS_SUBCOMMANDS[name];
}

export function isPassthroughCommand(input: string): boolean {
  const cmdName = input.trim().split(/\s+/)[0].toLowerCase();
  const passthrough = new Set(["setup", "init"]);
  return passthrough.has(cmdName);
}

// ── Stack-based process.exit / stdout / stderr patch management ──
//
// Prevents concurrent-call race where one call's `finally` restores
// the real process.exit while another call's action handler still needs
// the patch. Each call pushes the current function onto a stack and pops
// it on exit, so concurrent calls restore layer by layer.

const exitStack: Array<typeof process.exit> = [];
const stdoutStack: Array<typeof process.stdout.write> = [];
const stderrStack: Array<typeof process.stderr.write> = [];

function pushExitPatch(): void {
  exitStack.push(process.exit);
  process.exit = ((code?: number) => {
    throw new CommandExitError(code ?? 1);
  }) as typeof process.exit;
}

function popExitPatch(): void {
  process.exit =
    exitStack.pop() ||
    exitStack[0] ||
    ((() => {
      process.exitCode = 1;
    }) as typeof process.exit);
}

function pushStdoutCapture(capture: typeof process.stdout.write): void {
  stdoutStack.push(process.stdout.write);
  process.stdout.write = capture;
}

function popStdoutCapture(): void {
  process.stdout.write = stdoutStack.pop() || stdoutStack[0] || ((..._args: any[]) => true as any);
}

function pushStderrCapture(capture: typeof process.stderr.write): void {
  stderrStack.push(process.stderr.write);
  process.stderr.write = capture;
}

function popStderrCapture(): void {
  process.stderr.write = stderrStack.pop() || stderrStack[0] || ((..._args: any[]) => true as any);
}

// ── Output capture + process.exit prevention ──

export interface ExecutionResult {
  output: string;
  error: string | null;
}

export class CommandExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code}) was called`);
    this.name = "CommandExitError";
    this.code = code;
  }
}

// TUI/REPL alias map: user-typed shortcuts → actual commander commands
const INPUT_ALIASES: Record<string, string> = {
  logout: "auth logout",
  s: "search",
  mcp: "mcp-server",
};

export async function executeCommandSafely(input: string): Promise<ExecutionResult> {
  const trimmed = input.trim();
  if (!trimmed) return { output: "", error: null };

  let resolvedInput = trimmed;
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  if (INPUT_ALIASES[firstWord]) {
    resolvedInput = INPUT_ALIASES[firstWord] + trimmed.slice(firstWord.length);
  }

  const parts = resolvedInput.split(/\s+/);
  const cmdName = parts[0];

  // Build argv for commander: "node astrivya <command> <args...>"
  const argv = ["node", "astrivya", cmdName, ...parts.slice(1)];

  const program = getCommanderProgram();

  const outputChunks: string[] = [];
  let exitCode: number | null = null;

  const captureWrite = (chunk: string | Uint8Array): boolean => {
    const str = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    outputChunks.push(str);
    return true;
  };

  pushExitPatch();
  pushStdoutCapture(captureWrite as typeof process.stdout.write);
  pushStderrCapture(captureWrite as typeof process.stderr.write);
  setSilentSpinnerMode(true);

  // Track exit code in the patch
  const _origPatchedExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 1;
    throw new CommandExitError(code ?? 1);
  }) as typeof process.exit;

  const cleanOutput = () => stripAnsi(outputChunks.join("").replace(/\n+$/, ""));

  try {
    await program.parseAsync(argv);
    return {
      output: cleanOutput(),
      error: exitCode !== null ? `Command exited with code ${exitCode}` : null,
    };
  } catch (err: unknown) {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      fs.appendFileSync(
        path.join(process.cwd(), "astrivya-debug.log"),
        `[COMMAND ERROR] ${new Date().toISOString()} - Input: "${input}" - Error: ${err instanceof Error ? err.stack : String(err)}\n`,
      );
    } catch {}

    if (err instanceof CommandExitError) {
      return {
        output: cleanOutput(),
        error: `Command exited with code ${err.code}`,
      };
    }
    return {
      output: cleanOutput(),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    popExitPatch();
    popStdoutCapture();
    popStderrCapture();
    setSilentSpinnerMode(false);
  }
}
