import cliTable3 from "cli-table3";
import ora from "ora";
import { amber, color as chalkColor } from "./colors";

export const color = chalkColor;
export { amber };

let _printMode = false;
let _silentSpinnerMode = false;

export function setPrintMode(enabled: boolean): void {
  _printMode = enabled;
}

export function isPrintMode(): boolean {
  return _printMode;
}

export function setSilentSpinnerMode(enabled: boolean): void {
  _silentSpinnerMode = enabled;
}

// eslint-disable-next-line no-control-regex
export const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(s: string): string {
  return s.replace(ansiRegex, "");
}

function maybeStrip(s: string): string {
  return _printMode ? s.replace(ansiRegex, "") : s;
}

export function log(...args: unknown[]): void {
  const printed = args.map((a) => (typeof a === "string" ? maybeStrip(a) : a));
  console.log(...printed);
}

export function success(msg: string): void {
  const prefix = _printMode ? "[OK]" : color.green("\u2713");
  console.log(`${prefix} ${msg}`);
}

export function error(msg: string): void {
  const prefix = _printMode ? "[ERR]" : color.red("\u2717");
  console.error(`${prefix} ${msg}`);
}

export function warn(msg: string): void {
  const prefix = _printMode ? "[!]" : color.yellow("\u26A0");
  console.log(`${prefix} ${msg}`);
}

export function info(msg: string): void {
  const prefix = _printMode ? "[i]" : color.cyan("\u2139");
  console.log(`${prefix} ${msg}`);
}

export function header(text: string): void {
  const line = _printMode ? `\n=== ${text} ===` : `\n${color.bold(color.cyan(text))}`;
  console.log(line);
}

export function subheader(text: string): void {
  console.log(`  ${_printMode ? text : color.bold(text)}`);
}

export function divider(char = "\u2500", width = 50): void {
  console.log(_printMode ? char.repeat(width) : color.dim(char.repeat(width)));
}

export function dim(text: string): string {
  return _printMode ? text : color.dim(text);
}

let activeSpinner: any = null;

export function startSpinner(text: string) {
  if (_printMode || _silentSpinnerMode) return { stop: () => {}, succeed: () => {}, fail: () => {}, start: () => {} };
  if (activeSpinner) {
    try {
      activeSpinner.stop();
    } catch {}
  }
  const s = ora({ text, color: "cyan", discardStdin: false }).start();
  activeSpinner = s;

  const originalStop = s.stop.bind(s);
  s.stop = () => {
    activeSpinner = null;
    return originalStop();
  };

  return s;
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function stopAllSpinners(): void {
  if (activeSpinner) {
    try {
      activeSpinner.stop();
    } catch {}
    activeSpinner = null;
  }
}

export function indent(text: string, spaces = 4): string {
  return text
    .split("\n")
    .map((line) => " ".repeat(spaces) + line)
    .join("\n");
}

export function table(headers: string[], rows: string[][]): void {
  if (_printMode) {
    const sep = "  ";
    const h = headers.join(sep);
    console.log(`  ${h}`);
    console.log(`  ${"-".repeat(h.length)}`);
    for (const row of rows) {
      console.log(`  ${row.join(sep)}`);
    }
  } else {
    const t = new cliTable3({
      head: headers.map((h) => color.bold(h)),
      style: { "padding-left": 1, "padding-right": 1 },
    });
    for (const row of rows) {
      t.push(row);
    }
    console.log(t.toString());
  }
}

export function bullet(items: string[], indentLevel = 0): void {
  const pad = "  ".repeat(indentLevel);
  for (const item of items) {
    console.log(`${pad}${_printMode ? "-" : "\u2022"} ${item}`);
  }
}

export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}
