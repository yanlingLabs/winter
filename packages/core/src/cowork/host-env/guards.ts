import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import type { CoworkVolumeRecord } from "../volumes";
import type { ProcessInspection, ProcessTable } from "../native/admission-probes";
import type { CoworkNativeLaunchEntry, CoworkNativeLaunchJournalPort, CoworkNativeRecoverGuards, CoworkNativeRecoverSubject } from "../native/stop-proof";

/*
 * The two D1 guard probes (process absent, images unlocked), implemented over real host facts. They are ALWAYS asked together with a MAC or an owner Recover and
 * can only make recovery stricter: neither can release anything on its own, and anything they cannot show is "no".
 */

/** The identity token of a process: its start time. Shared with the launcher port so a journal entry and a later inspection compare like with like. */
export function processStartToken(inspection: Extract<ProcessInspection, { kind: "present" }>): string {
  return `${inspection.startSeconds}.${String(inspection.startMicroseconds).padStart(6, "0")}`;
}

export interface CoworkGuardDeps {
  readonly journal: CoworkNativeLaunchJournalPort;
  readonly processes: ProcessTable;
  /** The host's current boot session id, or null when it cannot be read (then nothing is shown). */
  readonly bootId: () => string | null;
  /** True when any volume of the workspace still names an owner. */
  readonly ownersHeld: (workspaceId: string) => boolean;
  readonly home: string;
  /** Test seam; the default opens the image with a non-blocking exclusive lock, which fails while the worker holds its flock. */
  readonly lockProbe?: (path: string) => { identity: { device: string; inode: string } } | "locked" | "missing";
}

/**
 * Is a recorded process gone? A pid alone is never enough (pids are reused): the start token and the boot id make it an identity.
 *  - boot id differs from the entry's: nothing survives a reboot, so gone;
 *  - the pid is absent, or a zombie, or present with ANOTHER start token (the recorded process is gone, the pid belongs to someone else): gone;
 *  - present with the recorded start token, or unknowable: not shown.
 */
function recordedProcessGone(entry: CoworkNativeLaunchEntry, process_: { pid: number; startToken: string }, deps: CoworkGuardDeps): boolean {
  const boot = deps.bootId();
  if (boot === null) return false;
  if (entry.bootId !== boot) return true;
  const seen = deps.processes.inspect(process_.pid);
  if (seen.kind === "absent") return true;
  if (seen.kind !== "present") return false;
  return seen.zombie || processStartToken(seen) !== process_.startToken;
}

const O_EXLOCK = 0x20;

export function createCoworkRecoverGuards(deps: CoworkGuardDeps): CoworkNativeRecoverGuards {
  return {
    /**
     * Ordering facts this relies on (host.ts): the journal entry is written BEFORE the launcher is spawned, with the launcher's identity as soon as it is known and the
     * worker's at `begun`; the volumes are claimed only AFTER `begun`. So:
     *  - an entry with no launcher identity: a process exists that nobody can name, not shown;
     *  - no entry and no volume owner: no launch was ever recorded and nothing was claimed, so there is no process to wait for;
     *  - no entry but a volume owner: the journal was lost, not shown;
     *  - an entry with a launcher and no worker identity while a volume owner exists: inconsistent with the order above, not shown.
     */
    processAbsent(subject: Readonly<CoworkNativeRecoverSubject>): boolean {
      try {
        const held = deps.ownersHeld(subject.workspaceId);
        const entry = subject.processes ?? deps.journal.load(subject);
        if (entry === null) return !held;
        if (entry.workspaceId !== subject.workspaceId || entry.incarnationId !== subject.incarnationId || entry.leaseEpoch !== subject.leaseEpoch) return false;
        if (entry.launcher === null) return false;
        if (!recordedProcessGone(entry, entry.launcher, deps)) return false;
        if (entry.worker === null) return !held;
        return recordedProcessGone(entry, entry.worker, deps);
      } catch { return false; }
    },
    /**
     * The worker takes `flock(LOCK_EX | LOCK_NB)` on both images (S3, `cw_volume_lock`) and libkrun keeps the open file description, so the lock lives as long as the VM
     * does. Opening the image with O_EXLOCK | O_NONBLOCK fails (EAGAIN) while it is held. The file is verified to be the recorded one (device and inode), by path
     * under the home, never through `CoworkVolumes.open` (which would burn the virgin eligibility).
     */
    imagesUnlocked(volumes: readonly CoworkVolumeRecord[]): boolean {
      try {
        if (volumes.length !== 2) return false;
        const probe = deps.lockProbe ?? defaultLockProbe;
        for (const volume of volumes) {
          if (volume.identity === null) return false;
          const name = volume.purpose === "data" ? "data.ext4" : volume.purpose === "environment" ? "env.ext4" : null;
          if (name === null) return false;
          const result = probe(join(deps.home, "cowork", "workspaces", volume.workspaceId, name));
          if (result === "locked" || result === "missing") return false;
          if (result.identity.device !== volume.identity.device || result.identity.inode !== volume.identity.inode) return false;
        }
        return true;
      } catch { return false; }
    },
  };
}

function defaultLockProbe(path: string): { identity: { device: string; inode: string } } | "locked" | "missing" {
  if (process.platform !== "darwin") throw new Error("unsupported_topology");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_EXLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") return "locked";
    if (code === "ENOENT") return "missing";
    throw error;
  }
  try { const info = fstatSync(fd, { bigint: true }); return { identity: { device: String(info.dev), inode: String(info.ino) } }; }
  finally { closeSync(fd); }
}
