import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CoworkGuestDirectoryError } from "../native/guest-dirs";

/** The outputs directory the host makes where the outputs share is served from (see `native/guest-dirs.ts` for the rules). */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const OPEN_DIRECTORY = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

/** `<root>/<name>` as a real directory owned by this user, mode 0700. Returns true when it was created, false when it already was exactly that. */
export function ensureOwnedDirectory(root: string, name: string): boolean {
  if (!SESSION_ID.test(name) || name === "." || name === "..") throw new CoworkGuestDirectoryError("invalid_name");
  let rootInfo;
  try { rootInfo = lstatSync(root); } catch { throw new CoworkGuestDirectoryError("root_unusable"); }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || realpathSync(root) !== root) throw new CoworkGuestDirectoryError("root_unusable");
  const path = join(root, name);
  let created = false;
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CoworkGuestDirectoryError("not_directory");
    // mkdir never follows a final symlink and fails with EEXIST when something appeared in the meantime; that case is checked below like any existing entry.
    try { mkdirSync(path, { mode: 0o700 }); created = true; } catch (made) { if ((made as NodeJS.ErrnoException).code !== "EEXIST") throw new CoworkGuestDirectoryError("not_directory"); }
  }
  let fd = -1;
  try {
    fd = openSync(path, OPEN_DIRECTORY);
    const info = fstatSync(fd);
    if (!info.isDirectory()) throw new CoworkGuestDirectoryError("not_directory");
    if (info.uid !== process.geteuid?.()) throw new CoworkGuestDirectoryError("wrong_owner");
    if ((info.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
  } catch (error) {
    if (error instanceof CoworkGuestDirectoryError) throw error;
    throw new CoworkGuestDirectoryError("not_directory");
  } finally { if (fd >= 0) closeSync(fd); }
  return created;
}

/** The outputs preparer the native host uses: the outputs share root is `<home>/cowork/workspaces/<workspaceId>/shared/outputs`. */
export function createCoworkOutputsPreparer(home: string): { ensure(workspaceId: string, logicalSessionId: string): void } {
  return {
    ensure(workspaceId, logicalSessionId) {
      if (!SESSION_ID.test(workspaceId)) throw new CoworkGuestDirectoryError("invalid_name");
      ensureOwnedDirectory(join(realpathSync(home), "cowork", "workspaces", workspaceId, "shared", "outputs"), logicalSessionId);
    },
  };
}


/** The share-directory opener the native host uses: the path must already be canonical (its realpath is itself), and it is opened O_NOFOLLOW|O_DIRECTORY and described by the descriptor. */
export function createCoworkShareDirectoryOpener(): { open(hostPath: string): { readonly fd: number; readonly device: string; readonly inode: string; close(): void } } {
  return {
    open(hostPath) {
      if (realpathSync(hostPath) !== hostPath) throw new CoworkGuestDirectoryError("not_directory");
      const fd = openSync(hostPath, OPEN_DIRECTORY);
      try {
        const info = fstatSync(fd, { bigint: true });
        if (!info.isDirectory()) throw new CoworkGuestDirectoryError("not_directory");
        let closed = false;
        return { fd, device: String(info.dev), inode: String(info.ino), close() { if (!closed) { closed = true; closeSync(fd); } } };
      } catch (error) { closeSync(fd); throw error; }
    },
  };
}

/** `<home>/cowork/workspaces/<id>/shared/{guidance,memory,outputs}`, each a real directory owned by this user (mode 0700), made if missing and never through a symlink. */
export function ensureSharedDirectories(home: string, workspaceId: string): void {
  if (!SESSION_ID.test(workspaceId)) throw new CoworkGuestDirectoryError("invalid_name");
  const workspace = join(realpathSync(home), "cowork", "workspaces", workspaceId);
  ensureOwnedDirectory(workspace, "shared");
  for (const name of ["guidance", "memory", "outputs"]) ensureOwnedDirectory(join(workspace, "shared"), name);
}
