import { fstatSync, readdirSync, statSync } from "node:fs";
import { isatty } from "node:tty";

// The Winter island (`docs/claude/island.md`): a terminal client tells the daemon its controlling terminal in its
// hello (`HelloParams.tty`), so the Mac app can tell whether THIS exact terminal window or tab is in front before it
// shows one of this session's cards on top. Node has no `ttyname(3)`; the device number of the first terminal among
// stdin/stdout/stderr is matched against the `/dev` entries instead (no process is spawned).

/** What `controllingTtyName` reads; tests hand in fakes. */
export interface TtyProbe {
  isatty(fd: number): boolean;
  /** The descriptor's device number, when it is a character device. */
  rdevOf(fd: number): number | undefined;
  /** The device number of a `/dev` path, when it exists. */
  rdevAt(path: string): number | undefined;
  /** The names in `/dev`. */
  devNames(): string[];
}

const LIVE: TtyProbe = {
  isatty: (fd) => { try { return isatty(fd); } catch { return false; } },
  rdevOf: (fd) => {
    try {
      const st = fstatSync(fd);
      return st.isCharacterDevice() ? Number(st.rdev) : undefined;
    } catch { return undefined; }
  },
  rdevAt: (path) => { try { return Number(statSync(path).rdev); } catch { return undefined; } },
  devNames: () => { try { return readdirSync("/dev"); } catch { return []; } },
};

/** A name the hello's schema accepts (`/dev/` and a plain device name). */
const TTY_PATH = /^\/dev\/[A-Za-z0-9._-]+$/;

/** `/dev/ttys004` for a client running in a terminal; undefined with none (a pipe, a launchd job, a test). */
export function controllingTtyName(probe: TtyProbe = LIVE): string | undefined {
  for (const fd of [0, 1, 2]) {
    if (!probe.isatty(fd)) continue;
    const rdev = probe.rdevOf(fd);
    if (rdev === undefined) continue;
    // macOS pseudo-terminals are `/dev/ttysNNN` with NNN the device's minor number: try that first.
    const minor = rdev & 0xffffff;
    const guess = `/dev/ttys${String(minor).padStart(3, "0")}`;
    if (probe.rdevAt(guess) === rdev) return guess;
    for (const name of probe.devNames()) {
      if (!name.startsWith("tty")) continue;
      const path = `/dev/${name}`;
      if (TTY_PATH.test(path) && probe.rdevAt(path) === rdev) return path;
    }
    return undefined;
  }
  return undefined;
}
