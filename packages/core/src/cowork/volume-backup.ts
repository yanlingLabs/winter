import { hasStickyBackupExclusion } from "./volume-fs";
import { spawnSync } from "node:child_process";

/** This seam is trusted host infrastructure. Tests inject it; never accepted from RPC/guest data. */
export interface CoworkVolumeBackup {
  /** Add a sticky item exclusion only. Must not configure path/volume/global backup settings. */
  excludeItem(path: string, fd: number): void;
  verifyItemExcluded(path: string, fd: number): boolean;
}
/** Supported nonprivileged sticky item exclusion. Caller pins and validates the image before/after
 * each operation; an identity change is a refusal, never enrollment of a replacement. No ancestor
 * folder exclusion: shared instructions, memory and outputs keep their normal backup eligibility. */
export const timeMachineVolumeBackup: CoworkVolumeBackup = {
  excludeItem(path) {
    if (process.platform !== "darwin") throw new Error("unsupported_topology");
    const result = spawnSync("/usr/bin/tmutil", ["addexclusion", path], { encoding: "utf8", timeout: 5000 });
    if (result.error || result.status !== 0) throw new Error("backup_exclusion_unavailable");
  },
  verifyItemExcluded(path, fd) {
    if (process.platform !== "darwin") return false;
    const result = spawnSync("/usr/bin/tmutil", ["isexcluded", path], { encoding: "utf8", timeout: 5000 });
    return !result.error && result.status === 0 && result.stdout.trim().replace(/^\[Excluded\]\s+/, "") === path && /^\[Excluded\]\s+/.test(result.stdout.trim()) && hasStickyBackupExclusion(fd);
  },
};
