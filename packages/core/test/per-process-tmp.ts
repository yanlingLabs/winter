// Every test PROCESS gets its own temp root, and removes it at exit.
//
// WHY (2026-10-10). Tests make their homes, fixtures and session scratch with `mkdtempSync(join(tmpdir(),
// "winter-…-"))` and almost none of them remove what they make, so the developer's per-user temp folder
// (`$TMPDIR`, `/var/folders/…/T/`) grew to ~878,000 entries (~839,000 of them `winter-*`): a bare `ls` there
// took over two minutes and `bun` start-up from a path under it slowed to 4-40 s. A full core run alone left
// ~3,600 top-level entries behind.
//
// WHAT: this module, imported FIRST by every package's test preload, creates ONE fresh directory under the
// real temp folder, points `process.env.TMPDIR` at it (Bun's `os.tmpdir()` reads the variable on every call,
// verified on bun 1.3.14), and removes the whole tree when the run ends. Every `tmpdir()` caller in the
// process, every `startDaemon` home, every `sessionTmpDir` and every child that inherits `process.env` then
// lands inside it.
//
// HOW IT IS REMOVED — measured, not assumed. `bun test` ends by exiting natively: neither `process.on("exit")`
// nor `beforeExit` fires at the end of a run (bun 1.3.14), so an exit handler alone removes NOTHING. And a
// preload `afterAll` that removes the tree itself is worse than nothing: a full core run leaves ~3,600
// directories (~150 MB), `rmSync` blocks for ~6 s, and bun's 5 s hook timeout turns that into a failed
// "(unnamed)" test and a red run. So the removal is never done by the test process. A tiny DETACHED
// watcher (`/bin/sh`, its own session, stdio ignored, unref'd) waits for this process to disappear — however
// it went: a normal end, a failing run, SIGINT, SIGTERM, SIGKILL, a crash, bun's native exit — and then
// removes the tree (twice, two seconds apart, so a daemon still dying under it cannot re-create it unseen).
// It polls every half second, so the folder is gone within a second or two of the run ending, and it gives
// up after six hours, so it can never outlive its purpose. No SIGINT/SIGTERM handler is installed: that
// would change how the runner reacts to the signal, and the watcher already covers it. Only if the watcher
// cannot be spawned does the process fall back to a synchronous `process.on("exit")` removal (which runs
// when something calls `process.exit()`, the one exit path that fires it).
//
// KNOWN LIMITS, stated rather than hidden:
//   - Bun 1.3.14's `Bun.spawn`/`child_process.spawn` with NO `env` option hand the child the environment the
//     process STARTED with, not later `process.env` writes. A child spawned that way keeps the starting
//     `$TMPDIR` (the real one). Every spawn site in this repo that matters to temp hygiene (test daemons,
//     workers) passes `env: { ...process.env, … }`; a bare spawn that leaks is a bug in that test.
//   - Things that ask the C library instead of the environment (`confstr(_CS_DARWIN_USER_TEMP_DIR)`: macOS
//     `mktemp`, `getconf DARWIN_USER_TEMP_DIR`) still resolve to the real per-user temp folder BY DESIGN —
//     `agent/sandbox.ts`'s `darwinUserTempDir()` depends on exactly that. Not redirected, not touched.
//   - A process killed with SIGKILL leaves its one root behind (a single directory per killed run).
//
// A NESTED test process (a test that runs `bun test`, or a daemon that loads this preload) reads the
// ALREADY-narrowed `tmpdir()` as its real one, so its root lands inside the parent's and is swept with it.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GLOBAL_KEY = Symbol.for("winter.test.perProcessTmpRoot");

export interface PerProcessTmp {
  /** The directory every temp path of this process lives in (`undefined` when none could be made). */
  root: string | undefined;
  /** The temp folder the process started with — what `os.tmpdir()` answered BEFORE the redirect. */
  realTmp: string;
}

/** Remove a tree even when a test left read-only directories in it. Never throws. */
export function removeTree(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* fall through to the permission repair below */
  }
  if (!existsSync(root)) return;
  // A fixture that chmod'ed a directory 0o000/0o500 stops `rm -r`; make the tree owner-writable and retry.
  const repair = (dir: string): void => {
    try {
      chmodSync(dir, 0o700);
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        try { if (lstatSync(path).isDirectory()) repair(path); } catch { /* vanished */ }
      }
    } catch { /* unreadable: nothing more to do */ }
  };
  repair(root);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort: never throw at exit */ }
}

/**
 * A detached `/bin/sh` that removes `root` once this process is gone — however it went. Returns whether it
 * was spawned. The root is passed as an argument, never interpolated into the script.
 */
function watchAndRemove(root: string): boolean {
  const script = [
    'pid="$1"; root="$2"; deadline=$(( $(date +%s) + 21600 ))',
    'while kill -0 "$pid" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.5; done',
    'for pass in 1 2; do chmod -R u+rwX "$root" 2>/dev/null; rm -rf "$root"; [ "$pass" = 1 ] && sleep 2; done',
  ].join("\n");
  try {
    const watcher = spawn("/bin/sh", ["-c", script, "sh", String(process.pid), root], {
      detached: true,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin" },
    });
    watcher.on("error", () => {});
    watcher.unref();
    return watcher.pid !== undefined;
  } catch {
    return false;
  }
}

function install(): PerProcessTmp {
  const realTmp = tmpdir();
  let root: string | undefined;
  try {
    root = mkdtempSync(join(realTmp, "winter-test-"));
  } catch {
    // The real temp folder is not writable: leave the environment alone and let the tests fail where they
    // would have failed anyway, rather than failing the preload.
    return { root: undefined, realTmp };
  }
  process.env.TMPDIR = root;

  if (!watchAndRemove(root)) process.on("exit", () => removeTree(root!));
  return { root, realTmp };
}

const existing = (globalThis as Record<symbol, PerProcessTmp | undefined>)[GLOBAL_KEY];
/** Idempotent: a preload evaluated twice in one process (a root and a package bunfig) installs once. */
export const perProcessTmp: PerProcessTmp = existing ?? ((globalThis as Record<symbol, PerProcessTmp>)[GLOBAL_KEY] = install());
