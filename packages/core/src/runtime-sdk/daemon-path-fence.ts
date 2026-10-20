import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homeFenceFor } from "./home-fence";
import { controlPlaneFileTarget, homeFenceTarget, hostStorageReadTarget } from "./control-plane";

/** Core retains credentials and cannot itself enter the tool sandbox. Apply the SAME host-owned
 * fence immediately before opening a model-selected path or dispatching it to a host consumer.
 * Explicit scan checks include ancestors; exact file/root checks retain ordinary files in a
 * broad granted root. Third-party LSP servers retain their ordinary execution policy.
 * This is defense in depth, not same-user disk confidentiality. */
export function assertDaemonPathAccess(home: string | undefined, path: string, cwd: string, access: "read" | "write" | "scan" = "read"): void {
  if (!home) return; // legacy standalone tool fixtures; every daemon consumer supplies its home
  const fence = homeFenceFor(home);
  const hit = hostStorageReadTarget(path, cwd, fence, access === "scan")
    ?? (access === "write" ? controlPlaneFileTarget(path, cwd) ?? homeFenceTarget(path, cwd, fence) : null);
  if (hit) throw new Error("Host file access refused: protected Winter storage is available only through trusted metadata and export services");
}

/** Check again AFTER an awaited server request and open without following a final-component link.
 * The opened descriptor's current name/identity is checked before any content is read. */
export function readDaemonTextFile(home: string | undefined, path: string): string {
  assertDaemonPathAccess(home, path, "/");
  const target = realpathSync(path);
  assertDaemonPathAccess(home, target, "/");
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    const named = lstatSync(target);
    if (!opened.isFile() || !named.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) throw new Error("Host file changed before its content could be read");
    assertDaemonPathAccess(home, target, "/");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
