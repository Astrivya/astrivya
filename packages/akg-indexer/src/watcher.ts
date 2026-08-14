import * as fs from "node:fs";
import * as path from "node:path";

export interface WatcherOptions {
  /** Debounce window for batching bursts of events (default 600ms). */
  debounceMs?: number;
  /** Directory names ignored at any depth. Defaults cover node_modules/dist/.git. */
  ignoredDirs?: string[];
  /** File extensions ignored (lowercased, with dot). */
  ignoredExtensions?: string[];
  onError?: (err: unknown) => void;
}

const DEFAULT_IGNORED_DIRS = ["node_modules", "dist", "out", "coverage", "graphify-out", ".astrivya"];
const DEFAULT_IGNORED_EXTENSIONS = [".json", ".lock", ".db", ".log", ".tmp", ".sqlite"];

/**
 * Shared recursive file watcher used by `astrivya serve` (Atlas) and the MCP
 * HTTP server (`ASTRIVYA_WATCH=1`). Filters noise (hidden dirs, ignored
 * extensions, non-files), debounces bursts, and delivers batched absolute
 * paths to a single callback.
 */
export class Watcher {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pending = new Set<string>();
  private readonly debounceMs: number;
  private readonly ignoredDirs: Set<string>;
  private readonly ignoredExtensions: Set<string>;
  private readonly onError?: (err: unknown) => void;

  constructor(
    private readonly onChange: (files: string[]) => void | Promise<void>,
    options: WatcherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 600;
    this.ignoredDirs = new Set(options.ignoredDirs ?? DEFAULT_IGNORED_DIRS);
    this.ignoredExtensions = new Set(options.ignoredExtensions ?? DEFAULT_IGNORED_EXTENSIONS);
    this.onError = options.onError;
  }

  /** Start watching `root` recursively. Returns false (without throwing) on failure. */
  start(root: string): boolean {
    try {
      this.watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;

        const parts = filename.replace(/\\/g, "/").split("/");
        if (parts.some((p) => p.startsWith(".") || this.ignoredDirs.has(p))) return;

        const ext = path.extname(filename).toLowerCase();
        if (this.ignoredExtensions.has(ext)) return;

        const fullPath = path.join(root, filename);
        try {
          if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return;
        } catch {
          return;
        }

        this.pending.add(fullPath);

        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          const files = Array.from(this.pending);
          this.pending.clear();
          if (files.length > 0) {
            void Promise.resolve(this.onChange(files)).catch(() => {
              // consumer errors must never crash the watcher loop
            });
          }
        }, this.debounceMs);
      });
      return true;
    } catch (err) {
      this.onError?.(err);
      return false;
    }
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // already closed
      }
      this.watcher = null;
    }
    this.pending.clear();
  }
}