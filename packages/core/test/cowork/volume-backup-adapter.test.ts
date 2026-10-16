// The real Time Machine adapter, checked on disposable temp files only. docs/cowork-storage-security.md:
// "Use the supported sticky item exclusion (`tmutil addexclusion` without `-p`), which travels with the file
// and does not require root. Reapply and verify it whenever an image is created or replaced; tests inject
// disposable paths and never change the user's backup settings."
//
// The test preload puts every disposable home under TMPDIR, which Time Machine already excludes wholesale, so
// `tmutil isexcluded` says "[Excluded]" for ANY temp path. The adapter therefore must not trust that answer
// alone: each check below fails if the corresponding half of `verifyItemExcluded` is removed.
import { afterEach, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { timeMachineVolumeBackup } from "../../src/cowork/volume-backup";
import { AT_FDCWD, hasStickyBackupExclusion, openDirAt, openImageAt } from "../../src/cowork/volume-fs";

const supported = process.platform === "darwin" && process.arch === "arm64";
const dirs: string[] = [], fds: number[] = [];
afterEach(() => { fds.splice(0).forEach(fd => { try { closeSync(fd); } catch { /* closed */ } }); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
/** Descriptors are opened the way the storage code opens images (`openImageAt`), which is also what loads the
 * native metadata reader that `hasStickyBackupExclusion` needs. */
function items() {
  // The storage code passes canonical paths (CoworkVolumes realpaths its home); tmutil prints the canonical spelling.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-backup-adapter-"))); dirs.push(dir);
  const marked = join(dir, "data.ext4"), sibling = join(dir, "env.ext4");
  writeFileSync(marked, "x"); writeFileSync(sibling, "y");
  const dirFd = openDirAt(AT_FDCWD, dir); fds.push(dirFd);
  const markedFd = openImageAt(dirFd, "data.ext4"), siblingFd = openImageAt(dirFd, "env.ext4"); fds.push(markedFd, siblingFd);
  return { dir, marked, sibling, markedFd, siblingFd, dirFd };
}

test.skipIf(!supported)("excludeItem marks exactly the named item: not its sibling and not its directory", () => {
  const t = items();
  expect([hasStickyBackupExclusion(t.markedFd), hasStickyBackupExclusion(t.siblingFd), hasStickyBackupExclusion(t.dirFd)]).toEqual([false, false, false]);
  timeMachineVolumeBackup.excludeItem(t.marked, t.markedFd);
  expect(hasStickyBackupExclusion(t.markedFd)).toBe(true);
  expect(hasStickyBackupExclusion(t.siblingFd)).toBe(false); // no ancestor or neighbour exclusion: shared content stays backed up
  expect(hasStickyBackupExclusion(t.dirFd)).toBe(false);
  expect(timeMachineVolumeBackup.verifyDescriptorExcluded(t.markedFd)).toBe(true);
  expect(timeMachineVolumeBackup.verifyDescriptorExcluded(t.siblingFd)).toBe(false);
});

test.skipIf(!supported)("verifyItemExcluded needs tmutil's answer for THAT path AND the sticky metadata on THAT descriptor", () => {
  const t = items();
  timeMachineVolumeBackup.excludeItem(t.marked, t.markedFd);
  expect(timeMachineVolumeBackup.verifyItemExcluded(t.marked, t.markedFd)).toBe(true);
  // tmutil reports the whole TMPDIR as excluded, so without the descriptor check an unmarked image would pass.
  expect(timeMachineVolumeBackup.verifyItemExcluded(t.sibling, t.siblingFd)).toBe(false);
  expect(timeMachineVolumeBackup.verifyItemExcluded(t.marked, t.siblingFd)).toBe(false); // a named path whose descriptor lacks the marker
  // tmutil canonicalizes the path it prints; a different spelling is not the vetted item. (Plain concatenation:
  // path.join would normalize the ".." away and hand tmutil the canonical spelling after all.)
  expect(timeMachineVolumeBackup.verifyItemExcluded(`${t.dir}/../${basename(t.dir)}/data.ext4`, t.markedFd)).toBe(false);
  mkdirSync(join(t.dir, "nested")); // a path in a directory that is not the pinned image's
  expect(timeMachineVolumeBackup.verifyItemExcluded(`${dirname(t.marked)}/nested/../data.ext4`, t.markedFd)).toBe(false);
  // tmutil's own verdict is required: a path it reports as included (a read-only query on a system folder) never passes,
  // even with a descriptor that carries the marker.
  expect(timeMachineVolumeBackup.verifyItemExcluded("/Applications", t.markedFd)).toBe(false);
});
