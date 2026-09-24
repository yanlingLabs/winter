import fs from "node:fs";
import { basename, dirname } from "node:path";
import type { Settings } from "./settings";

/** Error → message without assuming the thrown value is an Error (a `throw "str"` must not
 *  become `undefined`). Used for both the load-throw and apply-throw log lines. */
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface SettingsWatcherDeps<T = Settings> {
  path: string; // dirs.settingsPath
  load: (path: string) => T; // loadSettings (throws on parse failure)
  // The atomic swap + feature-flag diff (T4 wires the real one). MAY be async: T4's makeApply
  // returns Promise<void> (its drain gate awaits — e.g. a CU-disable drain up to 10s). The
  // watcher awaits it, so a rejection is caught and prevSnapshot advances only after it resolves.
  apply: (prev: T | null, next: T) => void | Promise<void>;
  debounceMs?: number; // default 150
  watch?: (path: string, cb: () => void) => { close(): void }; // injectable fs.watch seam for tests
  log?: (msg: string) => void;
}

/**
 * Watches settings.json for changes, debounces bursts, reloads with keep-last-good on a torn
 * file, and calls the injected `apply(prev, next)` exactly once per settled good change. Owns
 * only the prev-snapshot used for diffing — the actual reference swap lives in `apply` (T4).
 */
export class SettingsWatcher<T = Settings> {
  private readonly path: string;
  private readonly load: (path: string) => T;
  private readonly apply: (prev: T | null, next: T) => void | Promise<void>;
  private readonly debounceMs: number;
  private readonly watchFn: (path: string, cb: () => void) => { close(): void };
  private readonly log: (msg: string) => void;

  private prevSnapshot: T | null = null;
  private watcher: { close(): void } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  // Single-flight guard: at most one apply in flight (an apply may await a multi-second drain).
  // Changes arriving during an in-flight apply set `pendingReload`, which the runner's loop picks
  // up once — so N overlapping changes collapse to exactly ONE follow-up apply of the LATEST file.
  private applying = false;
  private pendingReload = false;

  constructor(deps: SettingsWatcherDeps<T>) {
    this.path = deps.path;
    this.load = deps.load;
    this.apply = deps.apply;
    this.debounceMs = deps.debounceMs ?? 150;
    this.watchFn =
      deps.watch ??
      ((p, cb) => {
        const w = fs.watch(p, () => cb());
        return { close: () => w.close() };
      });
    this.log = deps.log ?? (() => {});
  }

  start(prev: T | null): void {
    // Idempotent re-arm: if already watching (double start), close the old fs.watch handle and
    // clear any pending timer first so the previous watcher can't also drive an apply (no leak).
    this.teardown();
    this.prevSnapshot = prev;
    this.stopped = false;
    this.watcher = this.watchFn(this.path, () => this.onFsEvent());
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
  }

  /** Close the watch handle and cancel any queued debounce timer. Shared by stop() and start()'s
   *  re-arm guard; safe to call when nothing is armed. Does NOT touch the `stopped` flag —
   *  callers set that per their own semantics (stop() sets it, start() clears it after). */
  private teardown(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private onFsEvent(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onDebounced(), this.debounceMs);
    this.timer.unref?.();
  }

  private onDebounced(): void {
    this.timer = null;
    if (this.stopped) return;
    // Floating is safe: runReload catches everything internally and never rejects.
    void this.runReload();
  }

  /**
   * Single-flight reload runner. If an apply is already in flight, just flag a pending reload and
   * return — the in-flight cycle's loop will pick it up (coalescing a burst of changes during a
   * long apply into ONE follow-up apply reading the LATEST file). Otherwise, drain the load→apply
   * cycle until no reload is pending. Catches both a torn-file load throw and a sync-throw OR
   * async-reject from apply; advances `prevSnapshot` only after a SUCCESSFUL awaited apply.
   */
  private async runReload(): Promise<void> {
    if (this.applying) {
      // An apply (e.g. a 10s CU-disable drain) is in flight → coalesce; let it pick this up.
      this.pendingReload = true;
      return;
    }
    this.applying = true;
    try {
      do {
        this.pendingReload = false;
        if (this.stopped) break; // stop() mid-drain: don't start a new cycle (in-flight one finishes)
        let next: T;
        try {
          next = this.load(this.path);
        } catch (err) {
          // torn file — keep last-known-good, do NOT call apply, do NOT advance prevSnapshot.
          // Stays in the loop only if another change set pendingReload while we were here.
          this.log(`settings reload failed, keeping previous: ${msg(err)}`);
          continue;
        }
        try {
          await this.apply(this.prevSnapshot, next);
          // Advance ONLY after a SUCCESSFUL awaited apply — so a failed apply leaves prevSnapshot
          // at last-known-good and the NEXT good change re-diffs against it (daemon re-converges).
          this.prevSnapshot = next;
        } catch (err) {
          // A sync throw OR an async rejection both land here; must NEVER escape (an uncaught
          // rejection off a timer tick would crash the daemon). prevSnapshot NOT advanced.
          this.log(`settings apply failed, keeping previous: ${msg(err)}`);
        }
      } while (this.pendingReload);
    } finally {
      this.applying = false;
    }
  }
}

/**
 * Does a parent-directory event name the watched file? Its own name, a TEMP spelling of it (its name plus
 * any suffix — `settings.json.tmp`, `settings.json.<pid>.<hex>.tmp`, an editor's `settings.json~`), or no
 * name at all (a platform event without one).
 *
 * Round 6 (measured on macOS, in a busy process): after an atomic replace — a temp file renamed over the
 * target, which is how `updateSdkSettings` and most editors save — the directory event carried the TEMP
 * file's name only (`rename settings.json.tmp`), never the target's. Filtering on the exact name alone
 * missed every such save; a stale event from an earlier write sometimes hid that. A spurious reload costs a
 * JSON parse: the watcher keeps the last good value and applies only what loads.
 */
export function namesWatchedFile(filename: string | Buffer | null | undefined, name: string): boolean {
  if (filename === null || filename === undefined) return true;
  const f = String(filename);
  return f === name || f.startsWith(`${name}.`) || f.startsWith(`${name}~`);
}

/**
 * WS-21: a `watch` seam for a file that may not exist yet and is replaced by atomic rename (both are
 * true of `sdk/settings.json` and `sdk/.winter.json`): watch its PARENT directory and fire on events
 * naming the file or a temp spelling of it (`namesWatchedFile`). A file watch would fail on a missing
 * file and, on some platforms, go deaf after the first rename replaces the inode it holds.
 */
export function watchViaParentDir(path: string, cb: () => void): { close(): void } {
  const name = basename(path);
  const w = fs.watch(dirname(path), (_event, filename) => {
    if (namesWatchedFile(filename, name)) cb();
  });
  return { close: () => w.close() };
}
