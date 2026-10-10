// ComputerV2 Phase 2 — `tab.upload(ref, paths)`: which files a script may hand a page's file input. Each path is
// resolved (`realpath`) and must be a regular file — not a symlink (`lstat`) — inside the session's working directory
// (its stored cwd) or its temp directory, never under the Winter home and never on the sandbox's read-deny list. At
// most 10 files and 50 MiB together. The engine then sets them with `DOM.setFileInputFiles` (full access).
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { AutomationFailure } from "../errors";

export const UPLOAD_MAX_FILES = 10;
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

export interface UploadRoots {
  /** The session's working directory (`meta.cwd`). */
  cwd: string | null | undefined;
  /** The session's temp directory (`sessionTmpDir`). */
  tmpDir?: string;
  /** The Winter home: never uploaded from. */
  home: string;
  /** The sandbox's read-deny list for the session (`sandboxConfigFor(home, cwd).filesystem.denyRead`). */
  denyRead: readonly string[];
}

const real = (p: string): string | undefined => { try { return realpathSync(p); } catch { return undefined; } };
const inside = (child: string, root: string): boolean => child === root || child.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** The checked, real paths to upload — or a typed refusal naming the first path that fails (never its content). */
export function checkUploadPaths(input: unknown, roots: UploadRoots): string[] {
  const list = typeof input === "string" ? [input] : Array.isArray(input) ? input : undefined;
  if (list === undefined || list.length === 0 || !list.every((p) => typeof p === "string" && p.length > 0)) {
    throw Object.assign(new TypeError("upload() takes a file path or an array of paths"), { name: "TypeError" });
  }
  if (list.length > UPLOAD_MAX_FILES) throw new AutomationFailure("NotAllowed", `upload() takes at most ${UPLOAD_MAX_FILES} files at once`);
  const cwd = roots.cwd === null || roots.cwd === undefined ? undefined : real(roots.cwd);
  const tmp = roots.tmpDir === undefined ? undefined : real(roots.tmpDir);
  const home = real(roots.home) ?? roots.home;
  const denied = roots.denyRead.map((d) => real(d) ?? d);
  const allowedRoots = [cwd, tmp].filter((r): r is string => r !== undefined);
  if (allowedRoots.length === 0) throw new AutomationFailure("NotAllowed", "this session has no working directory to upload from");
  const out: string[] = [];
  let total = 0;
  for (const raw of list as string[]) {
    const shown = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
    const given = isAbsolute(raw) ? raw : resolve(cwd ?? tmp!, raw);
    let link;
    try { link = lstatSync(given); } catch { throw new AutomationFailure("NotAllowed", `${shown}: no such file`); }
    if (link.isSymbolicLink()) throw new AutomationFailure("NotAllowed", `${shown} is a symbolic link — upload the file itself`);
    const path = real(given);
    if (path === undefined) throw new AutomationFailure("NotAllowed", `${shown}: no such file`);
    const st = statSync(path);
    if (!st.isFile()) throw new AutomationFailure("NotAllowed", `${shown} is not a regular file`);
    if (!allowedRoots.some((r) => inside(path, r))) {
      throw new AutomationFailure("NotAllowed", `${shown} is outside this session's working directory and temp directory — only files from those can be uploaded`);
    }
    if (inside(path, home)) throw new AutomationFailure("NotAllowed", `${shown} is inside Winter's own home — it can't be uploaded`);
    if (denied.some((d) => inside(path, d))) throw new AutomationFailure("NotAllowed", `${shown} is on the sandbox's read-deny list — it can't be uploaded`);
    total += st.size;
    if (total > UPLOAD_MAX_BYTES) throw new AutomationFailure("NotAllowed", `upload() takes at most ${UPLOAD_MAX_BYTES / (1024 * 1024)} MiB of files at once`);
    out.push(path);
  }
  return out;
}
