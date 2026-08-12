import { parentPort } from "node:worker_threads";
import { AkgStorage } from "@astrivya/akg-core";
import { CodeChunker } from "../code-chunker";

/**
 * Index worker: receives one unit per task, indexes it into a fresh in-memory
 * sql.js database (content-hash skip via the preloaded hash map), and posts
 * the exported DB buffer back to the main thread for merging.
 *
 * Protocol (messages from main):
 *   { type: "task", unit, workspacePath, unitIndex, skipHashes: [id, hash][] }
 * Messages to main:
 *   { type: "progress", ... } (throttled to ~10/s per unit)
 *   { type: "result", unitIndex, files, chunks, symbols, errors, buffer }
 *   { type: "error", unitIndex, message }
 */
const port = parentPort;
if (!port) throw new Error("index-worker must run inside a worker_thread");

interface WorkerUnit {
  name: string;
  path: string;
  kind: string;
  markers: string[];
  fileCount: number;
  nestedRepos: string[];
}

interface TaskMsg {
  type: "task";
  unit: WorkerUnit;
  workspacePath: string;
  unitIndex: number;
  skipHashes: Array<[string, string]>;
}

port.on("message", async (msg: { type: string }) => {
  if (msg.type !== "task") return;
  const task = msg as unknown as TaskMsg;
  try {
    const storage = new AkgStorage();
    await storage.initMemory();
    const chunker = new CodeChunker(storage, task.workspacePath);
    const skipHashes = new Map(task.skipHashes);
    let lastPost = 0;
    let lastChunks = 0;
    let lastErrors = 0;

    const res = await chunker.indexUnits([task.unit as never], {
      saveToDisk: false,
      skipHashes,
      onEvent: (ev) => {
        const now = Date.now();
        if (now - lastPost < 100 && !ev.unitComplete) return;
        lastPost = now;
        const chunks = ev.chunks ?? 0;
        const errors = ev.errors ?? 0;
        port.postMessage({
          type: "progress",
          unitIndex: task.unitIndex,
          file: ev.file,
          unitFilesDone: ev.unitFilesDone ?? 0,
          chunksDelta: chunks - lastChunks,
          errorsDelta: errors - lastErrors,
          unitComplete: Boolean(ev.unitComplete),
        });
        lastChunks = chunks;
        lastErrors = errors;
      },
    });

    const buffer = storage.exportBuffer();
    storage.close();
    port.postMessage(
      {
        type: "result",
        unitIndex: task.unitIndex,
        files: res.files,
        chunks: res.chunks,
        symbols: res.symbols,
        errors: res.errors,
        buffer,
      },
      [buffer.buffer as ArrayBuffer],
    );
  } catch (err: unknown) {
    port.postMessage({
      type: "error",
      unitIndex: task.unitIndex,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
