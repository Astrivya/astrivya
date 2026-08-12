import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { AkgStorage } from "@astrivya/akg-core";
import type { IndexProgressEvent, WorkspaceUnit, WorkspaceUnitKind } from "./types";

export interface ParallelIndexOptions {
  workspacePath: string;
  /** Minimum pool size (default 2). */
  minWorkers?: number;
  /** Hard cap (default: memory + cpu aware). */
  maxWorkers?: number;
  /** Starting pool size (default = minWorkers). */
  startWorkers?: number;
  /** Adaptive probe window (default 2000ms). */
  probeIntervalMs?: number;
  workerPath?: string;
  onEvent?: (ev: IndexProgressEvent) => void;
}

export interface ParallelUnitResult {
  name: string;
  files: number;
  chunks: number;
  symbols: number;
  errors: number;
}

export interface ParallelIndexResult {
  files: number;
  chunks: number;
  symbols: number;
  errors: number;
  workersUsed: number;
  perUnit: ParallelUnitResult[];
}

interface UnitState {
  name: string;
  kind: WorkspaceUnitKind;
  fileCount: number;
  filesWalked: number;
  files: number;
  chunks: number;
  symbols: number;
  errors: number;
  status: "queued" | "active" | "done" | "failed";
}

interface Task {
  unit: WorkspaceUnit;
  origIndex: number;
}

interface PoolWorker {
  id: number;
  worker: Worker;
  busy: boolean;
  task: Task | null;
  dead: boolean;
}

/** Resolve the worker entry file emitted by the build (dist/workers/index-worker.js). */
export function resolveWorkerPath(): string | null {
  const candidates: string[] = [];
  const fromEnv = process.env.ASTRIVYA_INDEX_WORKER_PATH;
  if (fromEnv) candidates.push(fromEnv);
  candidates.push(path.join(__dirname, "workers", "index-worker.js"));
  // Walk up from the module dir to cover src-based execution (vitest, tsx):
  // <pkg>/src/parallel.ts -> <pkg>/dist/workers/index-worker.js
  let dir = __dirname;
  for (let i = 0; i < 6 && dir !== path.dirname(dir); i++) {
    candidates.push(path.join(dir, "dist", "workers", "index-worker.js"));
    dir = path.dirname(dir);
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/** Memory-aware worker cap: never burn the box. */
export function computeMemoryCap(): number {
  const memGb = os.totalmem() / 1024 ** 3;
  if (memGb < 4) return 2;
  if (memGb < 8) return 3;
  if (memGb < 16) return 4;
  return 6;
}

/** Overall cap: cpus - 1, bounded by memory headroom. */
export function computeMaxWorkers(): number {
  const cpus = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
  return Math.min(Math.max(2, cpus - 1), computeMemoryCap());
}

/**
 * Decide the next pool size for the adaptive worker pool.
 * Starts small, ramps up while adding a worker keeps per-worker throughput
 * within 5% (scaling still efficient), ramps down on >30% per-worker
 * collapse (contention). Never below min, never above max. Pure function.
 */
export function computeNextWorkerCount(opts: {
  current: number;
  min: number;
  max: number;
  rateNow: number;
  ratePrev: number;
  windowElapsedMs: number;
}): number {
  const { current, min, max, rateNow, ratePrev, windowElapsedMs } = opts;
  if (windowElapsedMs < 1000) return current;
  if (current >= max) return current;
  const prevWorkers = Math.max(1, current - 1);
  const perWorkerNow = rateNow / current;
  const perWorkerPrev = ratePrev / prevWorkers;
  if (ratePrev === 0) return current + 1; // first real window: scale up
  if (perWorkerNow >= perWorkerPrev * 0.95) return current + 1;
  if (perWorkerNow < perWorkerPrev * 0.7 && current > min) return current - 1;
  return current;
}

interface WorkerProgress {
  type: "progress";
  unitIndex: number;
  file?: string;
  unitFilesDone: number;
  chunksDelta: number;
  errorsDelta: number;
  unitComplete: boolean;
}

interface WorkerResult {
  type: "result";
  unitIndex: number;
  files: number;
  chunks: number;
  symbols: number;
  errors: number;
  buffer: Buffer;
}

interface WorkerError {
  type: "error";
  unitIndex: number;
  message: string;
}

/**
 * Index units in parallel via worker_threads.
 *
 * Each worker indexes its unit into a fresh in-memory sql.js database
 * (content-hash skip via a preloaded hash map), then ships the exported DB
 * buffer back; the main thread merges tables (INSERT OR REPLACE/IGNORE) so
 * node ids stay workspace-relative and disjoint across units.
 *
 * Pool is adaptive: starts at `startWorkers` (default 2), probes throughput
 * every `probeIntervalMs`, and scales toward the memory/cpu-aware cap while
 * marginal workers remain efficient.
 */
export async function indexUnitsParallel(
  storage: AkgStorage,
  units: WorkspaceUnit[],
  opts: ParallelIndexOptions,
): Promise<ParallelIndexResult> {
  const workerPath = opts.workerPath ?? resolveWorkerPath();
  if (!workerPath) {
    throw new Error(
      "Parallel index worker not found. Build the package or set ASTRIVYA_INDEX_WORKER_PATH to the worker file.",
    );
  }

  const minWorkers = Math.max(1, opts.minWorkers ?? 2);
  const maxWorkers = Math.min(opts.maxWorkers ?? computeMaxWorkers(), Math.max(minWorkers, units.length));
  let poolSize = Math.min(opts.startWorkers ?? minWorkers, maxWorkers);
  const probeIntervalMs = opts.probeIntervalMs ?? 2000;
  const onEvent = opts.onEvent;
  const t0 = Date.now();

  // Longest-processing-time first: big units start early.
  const queue: Task[] = units
    .map((unit, origIndex) => ({ unit, origIndex }))
    .sort((a, b) => b.unit.fileCount - a.unit.fileCount);

  const states = new Map<number, UnitState>();
  units.forEach((u, i) => {
    states.set(i, {
      name: u.name,
      kind: u.kind,
      fileCount: u.fileCount,
      filesWalked: 0,
      files: 0,
      chunks: 0,
      symbols: 0,
      errors: 0,
      status: "queued",
    });
  });

  const filesTotal = units.reduce((acc, u) => acc + u.fileCount, 0) || undefined;
  let globalFiles = 0;
  let globalChunks = 0;
  let globalErrors = 0;
  let workersUsed = 0;

  // EWMA rate + ETA (computed here so line-mode renderers get it too).
  let rate = 0;
  let lastSample = { time: Date.now(), files: 0 };
  let etaMs: number | undefined;

  // Adaptive probe window.
  let windowStart = { time: Date.now(), files: 0 };
  let prevWindowRate = 0;
  let probeTimer: NodeJS.Timeout | null = null;

  const skipHashes = storage.getFileHashes();
  const skipHashEntries = Array.from(skipHashes.entries());

  const emit = (ev: Partial<IndexProgressEvent>, workerId?: number): void => {
    onEvent?.({
      ...ev,
      workerId,
      workerCount: poolSize,
      activeWorkers: pool.filter((w) => w.busy).length,
      etaMs,
      filesPerSec: rate,
      elapsedMs: Date.now() - t0,
    } as IndexProgressEvent);
  };

  const noteProgress = (filesDelta: number): void => {
    globalFiles += filesDelta;
    const now = Date.now();
    const dt = now - lastSample.time;
    if (dt >= 250) {
      const inst = (globalFiles - lastSample.files) / (dt / 1000);
      rate = rate === 0 ? inst : 0.25 * inst + 0.75 * rate;
      lastSample = { time: now, files: globalFiles };
      if (filesTotal !== undefined && rate > 0) {
        etaMs = Math.max(0, ((filesTotal - globalFiles) / rate) * 1000);
      }
    }
  };

  const pool: PoolWorker[] = [];
  let nextWorkerId = 0;
  let finished = false;
  let resolve!: (r: ParallelIndexResult) => void;
  let reject!: (e: Error) => void;
  const done = new Promise<ParallelIndexResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const maybeFinished = (): void => {
    if (finished) return;
    if (queue.length === 0 && pool.every((w) => !w.busy)) {
      finished = true;
      if (probeTimer) clearInterval(probeTimer);
      const perUnit = units.map((_, i) => {
        const s = states.get(i)!;
        return { name: s.name, files: s.files, chunks: s.chunks, symbols: s.symbols, errors: s.errors };
      });
      resolve({ files: 0, chunks: 0, symbols: 0, errors: 0, workersUsed, perUnit });
    }
  };

  const dispatchNext = (w: PoolWorker): void => {
    if (w.dead) {
      // crashed worker: replace it before dispatching anything new
      const replacement = spawnWorker();
      dispatchNext(replacement);
      return;
    }
    const task = queue.shift();
    if (!task) {
      w.busy = false;
      maybeFinished();
      return;
    }
    w.busy = true;
    w.task = task;
    const st = states.get(task.origIndex)!;
    st.status = "active";
    emit(
      {
        phase: "code",
        message: `Indexing ${st.name}...`,
        unitIndex: task.origIndex,
        unitCount: units.length,
        unitName: st.name,
        unitKind: st.kind,
        unitStart: true,
        unitFilesDone: 0,
        unitFilesTotal: st.fileCount || undefined,
        filesDone: globalFiles,
        filesTotal,
        chunks: globalChunks,
        errors: globalErrors,
        unitPending: queue.length,
      },
      w.id,
    );
    w.worker.postMessage({
      type: "task",
      unit: task.unit,
      workspacePath: opts.workspacePath,
      unitIndex: task.origIndex,
      skipHashes: skipHashEntries,
    });
  };

  const handleProgress = (w: PoolWorker, msg: WorkerProgress): void => {
    const st = states.get(msg.unitIndex);
    if (!st) return;
    const filesDelta = msg.unitFilesDone - st.filesWalked;
    st.filesWalked = msg.unitFilesDone;
    st.chunks += msg.chunksDelta;
    st.errors += msg.errorsDelta;
    globalChunks += msg.chunksDelta;
    globalErrors += msg.errorsDelta;
    noteProgress(Math.max(0, filesDelta));

    if (msg.unitComplete) {
      emit(
        {
          phase: "code",
          message: `Indexed ${st.name}: ${st.files} files, ${st.chunks} chunks`,
          unitIndex: msg.unitIndex,
          unitCount: units.length,
          unitName: st.name,
          unitKind: st.kind,
          unitComplete: true,
          unitFilesDone: st.filesWalked,
          unitFilesTotal: st.fileCount || undefined,
          unitErrors: st.errors,
          filesDone: globalFiles,
          filesTotal,
          chunks: globalChunks,
          errors: globalErrors,
          unitPending: queue.length,
        },
        w.id,
      );
      // The worker still has to ship the exported DB buffer back as a
      // `result` message; that message completes the task (merge + next
      // dispatch). Do NOT free this worker here - doing so lets the pool
      // finish and terminate the worker before its result arrives.
      return;
    }

    emit(
      {
        phase: "code",
        message: msg.file ? `Indexing ${msg.file}` : `Indexing ${st.name}...`,
        unitIndex: msg.unitIndex,
        unitCount: units.length,
        unitName: st.name,
        unitKind: st.kind,
        file: msg.file,
        unitFilesDone: st.filesWalked,
        unitFilesTotal: st.fileCount || undefined,
        filesDone: globalFiles,
        filesTotal,
        chunks: globalChunks,
        errors: globalErrors,
        unitPending: queue.length,
      },
      w.id,
    );
  };

  const handleResult = async (w: PoolWorker, msg: WorkerResult): Promise<void> => {
    const st = states.get(msg.unitIndex);
    if (!st) return;
    try {
      emit({
        phase: "merge",
        message: `Merging ${st.name} into the graph...`,
        unitIndex: msg.unitIndex,
        unitCount: units.length,
        unitName: st.name,
        filesDone: globalFiles,
        filesTotal,
        chunks: globalChunks,
        errors: globalErrors,
        unitPending: queue.length,
      });
      await storage.mergeDatabase(msg.buffer);
      st.files = msg.files;
      st.chunks = msg.chunks;
      st.symbols = msg.symbols;
      st.errors += msg.errors;
      workersUsed += 1;
    } catch (err) {
      st.errors += 1;
      st.status = "failed";
      st.files = Math.max(st.files, msg.files);
      st.chunks = Math.max(st.chunks, msg.chunks);
      st.symbols = Math.max(st.symbols, msg.symbols);
    }
    w.busy = false;
    w.task = null;
    dispatchNext(w);
  };

  const spawnWorker = (): PoolWorker => {
    const id = nextWorkerId++;
    const worker = new Worker(workerPath);
    const w: PoolWorker = { id, worker, busy: false, task: null, dead: false };
    worker.on("message", (msg: WorkerProgress | WorkerResult | WorkerError) => {
      if (msg.type === "progress") handleProgress(w, msg);
      else if (msg.type === "result") void handleResult(w, msg);
      else if (msg.type === "error") {
        const st = msg.unitIndex !== undefined ? states.get(msg.unitIndex) : undefined;
        if (st) {
          st.errors += 1;
          st.status = "failed";
          globalErrors += 1;
        }
        w.busy = false;
        w.task = null;
        dispatchNext(w);
      }
    });
    worker.on("error", (err) => {
      const st = w.task ? states.get(w.task.origIndex) : undefined;
      if (st) {
        st.errors += 1;
        st.status = "failed";
        globalErrors += 1;
      }
      w.busy = false;
      if (w.task) queue.unshift(w.task); // re-queue on crash
      w.task = null;
    });
    worker.on("exit", () => {
      if (finished) return;
      w.dead = true;
      w.busy = false;
      if (w.task) queue.unshift(w.task); // re-queue a mid-flight task on hard exit
      w.task = null;
      if (queue.length > 0) {
        dispatchNext(w); // spawns a replacement via the dead guard
      } else {
        maybeFinished();
      }
    });
    pool.push(w);
    return w;
  };

  // Adaptive probe: sample throughput every window; scale pool up/down.
  const probe = (): void => {
    const now = Date.now();
    const elapsed = now - windowStart.time;
    if (elapsed >= probeIntervalMs) {
      const rateNow = (globalFiles - windowStart.files) / (elapsed / 1000);
      const next = computeNextWorkerCount({
        current: poolSize,
        min: minWorkers,
        max: maxWorkers,
        rateNow,
        ratePrev: prevWindowRate,
        windowElapsedMs: elapsed,
      });
      prevWindowRate = rateNow;
      windowStart = { time: now, files: globalFiles };
      if (next > poolSize) {
        while (poolSize < next) {
          spawnWorker();
          dispatchNext(pool[pool.length - 1]);
          poolSize += 1;
        }
      } else if (next < poolSize) {
        // shrink: terminate the least recently busy idle worker
        const idle = pool.filter((p) => !p.busy);
        const toKill = idle[0];
        if (toKill && poolSize > next) {
          poolSize -= 1;
          toKill.worker.terminate().catch(() => {});
          pool.splice(pool.indexOf(toKill), 1);
        }
      }
    }
  };

  probeTimer = setInterval(probe, Math.min(500, probeIntervalMs / 2));
  probeTimer.unref?.();

  // Start the pool.
  for (let i = 0; i < poolSize; i++) {
    const w = spawnWorker();
    dispatchNext(w);
  }
  if (pool.length === 0 || (queue.length === 0 && pool.every((p) => !p.busy))) {
    maybeFinished();
  }

  const result = await done;
  // Aggregate totals from the merged per-unit stats.
  const files = result.perUnit.reduce((a, u) => a + u.files, 0);
  const chunks = result.perUnit.reduce((a, u) => a + u.chunks, 0);
  const symbols = result.perUnit.reduce((a, u) => a + u.symbols, 0);
  const errors = result.perUnit.reduce((a, u) => a + u.errors, 0);
  for (const w of pool) w.worker.terminate().catch(() => {});
  return { files, chunks, symbols, errors, workersUsed, perUnit: result.perUnit };
}
