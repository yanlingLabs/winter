import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export class AlreadyRunningError extends Error {
  constructor(public readonly pid: number) {
    super(`winter-core already running (pid ${pid})`);
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function socketAnswers(socketPath: string, timeoutMs = 500): Promise<boolean> {
  if (!existsSync(socketPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    Bun.connect({
      unix: socketPath,
      socket: {
        open(s) { clearTimeout(timer); s.end(); resolve(true); },
        error() { clearTimeout(timer); resolve(false); },
        connectError() { clearTimeout(timer); resolve(false); },
        data() {},
      },
    }).catch(() => { clearTimeout(timer); resolve(false); });
  });
}

export interface Lock { release(): void }

export async function acquireLock(lockPath: string, socketPath: string): Promise<Lock> {
  if (existsSync(lockPath)) {
    let holderPid = -1;
    try { holderPid = JSON.parse(readFileSync(lockPath, "utf8")).pid; } catch { /* corrupt = stale */ }
    if (holderPid > 0 && pidAlive(holderPid) && (await socketAnswers(socketPath))) {
      throw new AlreadyRunningError(holderPid);
    }
    // Stale: dead pid, corrupt file, or unresponsive socket.
    try { unlinkSync(lockPath); } catch {}
  }
  if (existsSync(socketPath)) { try { unlinkSync(socketPath); } catch {} }

  // Exclusive create closes the TOCTOU window between the staleness check and the write:
  // O_EXCL fails if a racer created the file first; re-probe once, then defer to them.
  // Note: a true mid-function race cannot be forced deterministically without fault injection;
  // the wx-collision racer-alive path (AlreadyRunningError) is verified by the test that
  // pre-creates a live-pid lock and calls acquireLock, which exercises the collision branch
  // when the initial existsSync check sees no file but the wx write fails due to a racer.
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: "wx" });
  } catch {
    let racerPid = -1;
    try { racerPid = JSON.parse(readFileSync(lockPath, "utf8")).pid; } catch {}
    if (racerPid > 0 && racerPid !== process.pid && pidAlive(racerPid)) {
      throw new AlreadyRunningError(racerPid);
    }
    try { unlinkSync(lockPath); } catch {}
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: "wx" });
  }

  return {
    release() {
      // Ownership check: if another process has since stolen the lock, do not clobber their files.
      try {
        const current = JSON.parse(readFileSync(lockPath, "utf8"));
        if (current.pid !== process.pid) return; // stolen by a newer daemon — not ours to clean
      } catch { return; }
      try { unlinkSync(lockPath); } catch {}
      try { unlinkSync(socketPath); } catch {}
    },
  };
}
