import type { IndexProgressEvent, IndexResult } from "@astrivya/akg-indexer";
import { color } from "./output";

const FULL = "█";
const EMPTY = "░";
const FULL_ASCII = "#";
const EMPTY_ASCII = ".";

type UnitStatus = "queued" | "active" | "done" | "failed";

interface UnitView {
  name: string;
  kind: string;
  kindLabel: string;
  filesTotal: number;
  filesDone: number;
  errors: number;
  status: UnitStatus;
}

export interface IndexRenderer {
  update(ev: IndexProgressEvent): void;
  embed(done: number, total: number): void;
  embedSkipped(reason: string): void;
  done(result: IndexResult, extra?: { embedded?: number; embeddedTotal?: number; embedSkipped?: string }): void;
  fail(message: string): void;
}

const KIND_LABELS: Record<string, string> = {
  "git-repo": "git repo",
  "workspace-root": "workspace",
  folder: "folder",
  loose: "loose",
};

const PHASE_LABELS: Record<string, string> = {
  detect: "scan",
  agent: "agent logs",
  todos: "todos",
  code: "code",
  merge: "merge",
  adr: "adrs",
  save: "save",
  done: "done",
};

function isTty(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.CI && process.env.TERM !== "dumb";
}

function plainMode(): boolean {
  return process.env.ASTRIVYA_PROGRESS === "plain" || process.env.NO_COLOR !== undefined;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function visLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function truncate(s: string, max: number): string {
  const visible = visLen(s);
  if (visible <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}\u2026`;
}

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  const diff = width - visLen(s);
  if (diff <= 0) return s;
  const padStr = " ".repeat(diff);
  return align === "left" ? s + padStr : padStr + s;
}

function bar(done: number, total: number, width: number): string {
  if (total <= 0) return (plainMode() ? EMPTY_ASCII : EMPTY).repeat(width);
  const filled = Math.min(width, Math.round((done / total) * width));
  const f = plainMode() ? FULL_ASCII : FULL;
  const e = plainMode() ? EMPTY_ASCII : EMPTY;
  return f.repeat(filled) + e.repeat(width - filled);
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${String(rem).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** EWMA-smoothed rate/ETA tracker (α = 0.25). */
class RateTracker {
  private rate = 0;
  private last = { time: 0, done: 0 };
  private samples = 0;
  private total: number | undefined;

  setTotal(total: number | undefined): void {
    this.total = total;
  }

  note(done: number): void {
    const now = Date.now();
    const dt = now - this.last.time;
    if (dt < 250) return;
    if (this.last.time === 0) {
      this.last = { time: now, done };
      return;
    }
    const inst = (done - this.last.done) / (dt / 1000);
    if (inst > 0) {
      this.rate = this.samples === 0 ? inst : 0.25 * inst + 0.75 * this.rate;
      this.samples++;
    }
    this.last = { time: now, done };
  }

  perSec(): number {
    return this.rate;
  }

  etaMs(done: number): number | undefined {
    if (this.total === undefined || this.total <= done || this.samples < 3 || this.rate <= 0) return undefined;
    return ((this.total - done) / this.rate) * 1000;
  }
}

class TtyIndexRenderer implements IndexRenderer {
  private units = new Map<number, UnitView>();
  private unitOrder: number[] = [];
  private unitCount = 0;
  private filesTotal: number | undefined;
  private filesDone = 0;
  private nodes = 0;
  private edges = 0;
  private chunks = 0;
  private errors = 0;
  private elapsedMs = 0;
  private detail = "";
  private detectLine = "";
  private phase = "detect";
  private phaseChangedAt = 0;
  private workerCount = 0;
  private activeWorkers = 0;
  private unitPending = 0;
  private embedding = { active: false, done: 0, total: 0 };
  private embedSkippedReason = "";
  private rate = new RateTracker();
  private dirty = false;
  private renderedLines = 0;
  private timer: NodeJS.Timeout | null = null;
  private finished = false;
  private lastFrame = 0;
  private sigintHandler: (() => void) | null = null;

  constructor() {
    this.sigintHandler = () => {
      this.finishFrame();
      process.stdout.write("\x1b[?25h");
      process.exit(130);
    };
    process.once("SIGINT", this.sigintHandler);
  }

  update(ev: IndexProgressEvent): void {
    if (this.finished) return;
    if (ev.filesTotal !== undefined) {
      this.filesTotal = ev.filesTotal;
      this.rate.setTotal(ev.filesTotal);
    }
    if (ev.filesDone !== undefined) {
      this.filesDone = ev.filesDone;
      this.rate.note(ev.filesDone);
    }
    if (ev.nodes !== undefined) this.nodes = ev.nodes;
    if (ev.edges !== undefined) this.edges = ev.edges;
    if (ev.chunks !== undefined) this.chunks = ev.chunks;
    if (ev.errors !== undefined) this.errors = ev.errors;
    if (ev.elapsedMs !== undefined) this.elapsedMs = ev.elapsedMs;
    if (ev.workerCount !== undefined) this.workerCount = ev.workerCount;
    if (ev.activeWorkers !== undefined) this.activeWorkers = ev.activeWorkers;
    if (ev.unitPending !== undefined) this.unitPending = ev.unitPending;

    if (ev.phase !== this.phase) {
      this.phase = ev.phase;
      this.phaseChangedAt = Date.now();
    }

    if (ev.phase === "detect") {
      this.unitCount = ev.unitCount ?? 0;
      this.filesTotal = ev.filesTotal;
      this.rate.setTotal(ev.filesTotal);
      this.detectLine = ev.message ?? "";
      this.unitOrder = [];
      this.units.clear();
    } else if (ev.phase === "code" && ev.unitIndex !== undefined) {
      const idx = ev.unitIndex;
      let u = this.units.get(idx);
      if (!u) {
        u = {
          name: ev.unitName ?? `unit ${idx + 1}`,
          kind: ev.unitKind ?? "",
          kindLabel: KIND_LABELS[ev.unitKind ?? ""] ?? "",
          filesTotal: ev.unitFilesTotal ?? 0,
          filesDone: 0,
          errors: 0,
          status: "queued",
        };
        this.units.set(idx, u);
        this.unitOrder.push(idx);
      }
      if (ev.unitStart) u.status = "active";
      if (ev.unitFilesTotal !== undefined) u.filesTotal = ev.unitFilesTotal;
      if (ev.unitFilesDone !== undefined) u.filesDone = ev.unitFilesDone;
      if (ev.unitErrors !== undefined) u.errors = ev.unitErrors;
      if (ev.unitComplete) u.status = "done";
      if (ev.file) this.detail = ev.file;
    } else if (ev.phase === "merge") {
      this.detail = ev.message ?? "";
    } else {
      this.detail = ev.message ?? "";
      if (ev.phase === "done") this.detail = "";
    }

    this.schedule();
  }

  embed(done: number, total: number): void {
    if (this.finished) return;
    if (!this.embedding.active) {
      this.embedding = { active: true, done: 0, total };
      this.phase = "embedding";
      this.phaseChangedAt = Date.now();
    }
    this.embedding.done = done;
    this.embedding.total = total;
    this.rate.setTotal(total);
    this.rate.note(done);
    this.schedule();
  }

  embedSkipped(reason: string): void {
    if (this.finished) return;
    this.embedSkippedReason = reason;
    this.schedule();
  }

  done(result: IndexResult, extra?: { embedded?: number; embeddedTotal?: number; embedSkipped?: string }): void {
    if (this.finished) return;
    this.finishFrame();
    this.finished = true;
    if (this.sigintHandler) process.removeListener("SIGINT", this.sigintHandler);
    process.stdout.write("\x1b[?25h");

    const elapsed = (result.elapsedMs / 1000).toFixed(1);
    const workers =
      result.workersUsed > 0 ? ` with ${result.workersUsed} parallel worker${result.workersUsed === 1 ? "" : "s"}` : "";
    const embedLine = extra?.embedSkipped
      ? `  ${color.yellow("Embeddings skipped:")} ${extra.embedSkipped} (keyword search still works)`
      : extra?.embeddedTotal
        ? `  ${color.green("\u2713")} Embedded ${fmt(extra.embedded ?? 0)}/${fmt(extra.embeddedTotal)} chunks (vector search enabled)`
        : "";

    console.log();
    console.log(`  ${color.bold(color.cyan("AKG indexed"))} ${color.dim(`in ${elapsed}s${workers}`)}`);
    console.log(
      `  Indexed ${color.cyan(fmt(result.filesIndexed))} files ${color.dim("->")} ${color.cyan(fmt(result.nodesCreated))} nodes, ${color.cyan(fmt(result.edgesCreated))} edges, ${color.cyan(fmt(result.chunks))} chunks`,
    );
    if (embedLine) console.log(embedLine);
    if (result.units.length > 1) {
      console.log();
      console.log(`  ${color.bold("Units indexed:")}`);
      const maxRows = 12;
      for (const u of result.units.slice(0, maxRows)) {
        const marker = u.errors > 0 ? color.yellow("\u26a0") : color.green("\u2713");
        const err = u.errors > 0 ? ` ${color.yellow(`${u.errors} dir err`)}` : "";
        console.log(
          `    ${marker} ${color.bold(u.name)} ${color.dim("-")} ${fmt(u.files)} files, ${fmt(u.chunks)} chunks${err}`,
        );
      }
      if (result.units.length > maxRows) {
        console.log(`    ${color.dim(`... and ${result.units.length - maxRows} more units`)}`);
      }
    }
    if (this.embedding.active && extra?.embeddedTotal === undefined) {
      console.log(
        `  ${color.dim(`Embedding interrupted at ${fmt(this.embedding.done)}/${fmt(this.embedding.total)} chunks`)}`,
      );
    }
    console.log();
  }

  fail(message: string): void {
    if (this.finished) return;
    this.finishFrame();
    this.finished = true;
    if (this.sigintHandler) process.removeListener("SIGINT", this.sigintHandler);
    process.stdout.write("\x1b[?25h");
    console.error(`  ${color.red("\u2717")} ${message}`);
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.finished) return;
      this.draw();
    }, 33);
  }

  private draw(): void {
    if (!this.dirty) return;
    const now = Date.now();
    if (now - this.lastFrame < 33 && this.lastFrame !== 0) {
      this.schedule();
      return;
    }
    this.lastFrame = now;
    this.dirty = false;
    this.render();
  }

  private finishFrame(): void {
    if (this.renderedLines > 0) {
      process.stdout.write(`\x1b[${this.renderedLines}A\x1b[J`);
      this.renderedLines = 0;
    }
  }

  private render(): void {
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    const lines: string[] = [];

    // ── Header ────────────────────────────────────────────────────────────
    const phaseChip = color.cyan(this.phase === "embedding" ? "embeddings" : (PHASE_LABELS[this.phase] ?? this.phase));
    const unitsInfo =
      this.phase === "embedding"
        ? "1 worker"
        : this.unitCount > 0
          ? `${this.unitOrder.length}/${this.unitCount} units`
          : "";
    const workersInfo =
      this.workerCount > 0
        ? this.activeWorkers > 0
          ? `${this.activeWorkers}/${this.workerCount} workers`
          : `${this.workerCount} workers`
        : "";
    const timing = `${fmtDuration(this.elapsedMs)}${this.eta() ? ` \u00b7 ETA ${fmtDuration(this.eta()!)}` : ""}`;
    const headerParts = [
      "AKG INDEXING",
      phaseChip,
      ...(unitsInfo ? [unitsInfo] : []),
      ...(workersInfo ? [workersInfo] : []),
    ].filter(Boolean);
    let header = `  \u25b8 ${headerParts.join("  ") || ""}`;
    const right = `  ${timing}  `;
    if (cols - visLen(header) - visLen(right) > 10) {
      header = pad(header, cols - visLen(right));
    }
    lines.push(color.bold(header) + color.dim(right));
    lines.push(`  ${color.dim("\u2500".repeat(Math.max(10, cols - 4)))}`);

    // ── Phase transition strip (600ms) ────────────────────────────────────
    const inTransition = Date.now() - this.phaseChangedAt < 600;

    if (this.embedding.active) {
      // Embed body: bar + stats.
      const { done, total } = this.embedding;
      const width = Math.max(10, cols - 34);
      const pct = total > 0 ? ` ${Math.round((done / total) * 100)}%`.padStart(4) : "";
      lines.push(`    Chunk vectors ${bar(done, total, width)} ${color.bold(fmt(done))}/${fmt(total)}${pct}`);
      const stats: string[] = [];
      if (this.rate.perSec() > 0) stats.push(`${Math.round(this.rate.perSec())} chunks/s`);
      if (this.eta()) stats.push(`ETA ${fmtDuration(this.eta()!)}`);
      stats.push("onnx \u00b7 all-MiniLM-L6-v2 \u00b7 384-dim");
      lines.push(`  ${color.dim(stats.join("  \u00b7  "))}`);
    } else if (inTransition) {
      lines.push(`  ${color.dim(`  \u2500\u2500 ${this.detail || this.detectLine || "..."} \u2500\u2500`)}`);
    } else if (this.unitOrder.length === 0 && this.unitCount > 0) {
      lines.push(`  ${color.dim(`  ${this.unitCount} units detected - counting files...`)}`);
      lines.push(`  ${color.dim(`  ${truncate(this.detectLine, cols - 8)}`)}`);
    } else {
      // ── Unit rows ────────────────────────────────────────────────────────
      const doneUnits = this.unitOrder.filter((i) => this.units.get(i)?.status === "done");
      const activeIdx = this.unitOrder.find((i) => this.units.get(i)?.status === "active");
      const maxActive = 4;
      const maxRows = Math.max(4, Math.min(10, rows - 8));
      const visible: number[] = [];
      if (activeIdx !== undefined) {
        const doneTail = doneUnits.slice(-Math.max(1, maxRows - maxActive));
        visible.push(...doneTail);
        visible.push(activeIdx);
      } else {
        visible.push(...doneUnits.slice(-maxRows));
      }

      const maxName = Math.max(4, ...this.unitOrder.map((i) => Math.min(26, visLen(this.units.get(i)?.name ?? ""))));
      const barW = Math.max(8, Math.min(24, cols - 80));
      const showKind = cols >= 88;
      const showRate = cols >= 96;

      for (const idx of visible) {
        const u = this.units.get(idx)!;
        let glyph: string;
        if (u.status === "done") {
          glyph = u.errors > 0 ? color.yellow("\u26a0") : color.green("\u2713");
        } else if (u.status === "active") {
          glyph = color.cyan("\u25b8");
        } else {
          glyph = color.dim("\u25cb");
        }
        const name = pad(truncate(u.name, maxName), maxName);
        const kind = showKind ? pad(color.dim(u.kindLabel), 9) : "";
        const count = u.filesTotal > 0 ? pad(`${fmt(u.filesDone)}/${fmt(u.filesTotal)}`, 13, "right") : " ".repeat(13);
        const pct = u.filesTotal > 0 ? `${String(Math.round((u.filesDone / u.filesTotal) * 100)).padStart(3)}%` : "";
        const activeRate =
          showRate && u.status === "active" && this.rate.perSec() > 0
            ? ` ${color.dim(`${Math.round(this.rate.perSec())}/s`)}`
            : "";
        lines.push(
          `  ${glyph} ${color.bold(name)} ${kind}${bar(u.filesDone, u.filesTotal, barW)} ${pct} ${color.dim(count)}${activeRate}`,
        );
      }
      const pending = this.unitPending > 0 ? this.unitPending : this.unitOrder.length - this.units.size;
      if (pending > 0) {
        lines.push(`  ${color.dim(`  \u22ee ${pending} more unit${pending === 1 ? "" : "s"} queued`)}`);
      }
    }

    // ── Footer ────────────────────────────────────────────────────────────
    lines.push(`  ${color.dim("\u2500".repeat(Math.max(10, cols - 4)))}`);
    const totalBarW = Math.max(10, cols - 30);
    const totalPct =
      this.filesTotal !== undefined && this.filesTotal > 0
        ? `${String(Math.round((this.filesDone / this.filesTotal) * 100)).padStart(3)}%`
        : "";
    lines.push(
      `  ${bar(this.filesDone, this.filesTotal ?? 0, totalBarW)} ${color.bold("TOTAL")} ${fmt(this.filesDone)}/${fmt(this.filesTotal ?? 0)} ${totalPct}`,
    );
    const stats: string[] = [];
    if (this.chunks > 0) stats.push(`${fmt(this.chunks)} chunks`);
    if (this.nodes > 0) stats.push(`${fmt(this.nodes)} nodes`);
    if (this.errors > 0) stats.push(color.yellow(`${fmt(this.errors)} errors`));
    if (this.rate.perSec() > 0) stats.push(`${Math.round(this.rate.perSec())} files/s`);
    lines.push(`  ${color.dim(stats.join("  \u00b7  "))}`);

    // ── Ticker ────────────────────────────────────────────────────────────
    if (this.detail && !this.embedding.active) {
      lines.push(`  ${color.dim(truncate(this.detail, Math.max(20, cols - 6)))}`);
    }

    const prev = this.renderedLines;
    const clearOld = prev > 0 ? `\x1b[${prev}A\x1b[J` : "";
    process.stdout.write(`${clearOld}${lines.join("\n")}\n`);
    this.renderedLines = lines.length;
  }

  private eta(): number | undefined {
    const done = this.embedding.active ? this.embedding.done : this.filesDone;
    return this.rate.etaMs(done);
  }
}

class LineIndexRenderer implements IndexRenderer {
  private lastUnit: string | null = null;
  private lastEmbed = 0;
  private lastEtaReport = 0;
  private filesDone = 0;
  private filesTotal: number | undefined;
  private workerCount = 0;

  update(ev: IndexProgressEvent): void {
    if (ev.filesTotal !== undefined) this.filesTotal = ev.filesTotal;
    if (ev.filesDone !== undefined) this.filesDone = ev.filesDone;
    if (ev.workerCount !== undefined) this.workerCount = ev.workerCount;

    if (ev.phase === "detect") {
      const workers = ev.workerCount ? ` (up to ${ev.workerCount} workers)` : "";
      console.log(`${ev.message ?? "Detected workspace units"}${workers}`);
    } else if (ev.phase === "code" && ev.unitStart && ev.unitName && ev.unitName !== this.lastUnit) {
      this.lastUnit = ev.unitName;
      const total = ev.unitFilesTotal ? ` (${fmt(ev.unitFilesTotal)} files)` : "";
      console.log(`  Indexing ${ev.unitName}${total}...`);
    } else if (ev.phase === "code" && ev.unitComplete && ev.unitName) {
      console.log(`  \u2713 ${ev.unitName}: done (${ev.chunks ?? 0} chunks)`);
    } else if (ev.phase === "merge" && ev.unitName) {
      console.log(`  Merging ${ev.unitName}...`);
    } else if (ev.phase === "code" || ev.phase === "merge") {
      // throttled ETA line
      const now = Date.now();
      if (now - this.lastEtaReport < 2000) return;
      this.lastEtaReport = now;
      if (ev.etaMs !== undefined && this.filesTotal) {
        const pct = Math.round((this.filesDone / this.filesTotal) * 100);
        console.log(`  ${this.filesDone}/${this.filesTotal} files (${pct}%) - ETA ${fmtDuration(ev.etaMs)}`);
      }
    }
  }

  embed(done: number, total: number): void {
    if (total === 0) return;
    const now = Date.now();
    if (now - this.lastEmbed < 300 && done < total) return;
    this.lastEmbed = now;
    console.log(`  Embedding chunks... ${fmt(done)}/${fmt(total)} (${Math.round((done / total) * 100)}%)`);
  }

  embedSkipped(reason: string): void {
    console.log(`  Embeddings skipped: ${reason} (keyword search still works)`);
  }

  done(result: IndexResult, extra?: { embedded?: number; embeddedTotal?: number; embedSkipped?: string }): void {
    const workers = result.workersUsed > 0 ? ` with ${result.workersUsed} parallel workers` : "";
    console.log();
    console.log(`\u2713 AKG indexed in ${(result.elapsedMs / 1000).toFixed(1)}s${workers}`);
    console.log(
      `  Indexed ${fmt(result.filesIndexed)} files -> ${fmt(result.nodesCreated)} nodes, ${fmt(result.edgesCreated)} edges, ${fmt(result.chunks)} chunks`,
    );
    if (extra?.embedSkipped) {
      console.log(`  Embeddings skipped: ${extra.embedSkipped} (keyword search still works)`);
    } else if (extra?.embeddedTotal) {
      console.log(`  Embedded ${fmt(extra.embedded ?? 0)}/${fmt(extra.embeddedTotal)} chunks`);
    }
    if (result.units.length > 1) {
      for (const u of result.units) {
        console.log(`    \u2713 ${u.name} - ${fmt(u.files)} files, ${fmt(u.chunks)} chunks`);
      }
    }
  }

  fail(message: string): void {
    console.error(`\u2717 ${message}`);
  }
}

/**
 * Create a progressive index renderer.
 * TTY: full-screen live dashboard (header, per-unit bars, TOTAL bar, EWMA
 * rate/ETA, ticker). Non-TTY / CI / dumb terminal: plain line-by-line output.
 */
export function createIndexRenderer(): IndexRenderer {
  return isTty() ? new TtyIndexRenderer() : new LineIndexRenderer();
}
