// ComputerV2 Phase 2 — `tab.upload(ref, paths)`: which files a script may hand a page's file input. Each path is
// resolved (`realpath`) and must be a regular file — not a symlink (`lstat`) — inside the session's working directory
// (its stored cwd) or its temp directory, never under the Winter home and never on the sandbox's read-deny list. At
// most 10 files and 50 MiB together.
//
// What the browser gets is a private COPY (`stageUploads`): each checked file is opened without following a link and
// must still be the very file (device + inode) the checks saw, then copied into `<home>/cache/uploads/<session>/
// <random>/` — a place the session's sandboxed shell cannot write (all of `<home>/cache` is denied) — and only the copy
// is handed to `DOM.setFileInputFiles`. A path swapped after the checks therefore can't change what is uploaded. The
// copies go when the session ends, and every leftover at the daemon's next start.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
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

/** One checked file: its real path and the identity the checks saw. */
export interface CheckedUpload { path: string; dev: number; ino: number; size: number }

/** The checked, real paths to upload — or a typed refusal naming the first path that fails (never its content). */
export function checkUploadPaths(input: unknown, roots: UploadRoots): string[] {
  return checkUploadFiles(input, roots).map((f) => f.path);
}

/** `checkUploadPaths`, with each file's identity (device + inode) for `stageUploads`. */
export function checkUploadFiles(input: unknown, roots: UploadRoots): CheckedUpload[] {
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
  const out: CheckedUpload[] = [];
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
    out.push({ path, dev: st.dev, ino: st.ino, size: st.size });
  }
  return out;
}

export function uploadStagingRoot(home: string): string { return join(home, "cache", "uploads"); }

/**
 * Private copies of checked files for the browser to read. Each source is opened with O_NOFOLLOW and must still be
 * the file the checks saw (device + inode, a regular file); the copy keeps its name and is 0600 in a fresh 0700
 * directory. Throws `NotAllowed` when a file changed under the checks.
 */
export function stageUploads(files: readonly CheckedUpload[], home: string, sessionId: string): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new AutomationFailure("NotAllowed", "this session can't stage uploads");
  const dir = join(uploadStagingRoot(home), sessionId, randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out: string[] = [];
  const names = new Set<string>();
  let total = 0;
  const buf = Buffer.alloc(1024 * 1024);
  for (const f of files) {
    let name = basename(f.path);
    for (let n = 2; names.has(name); n++) name = `${n}-${basename(f.path)}`;
    names.add(name);
    let src: number | undefined;
    let dst: number | undefined;
    try {
      try { src = openSync(f.path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch {
        throw new AutomationFailure("NotAllowed", `${basename(f.path)} changed while it was being uploaded — try again`);
      }
      const st = fstatSync(src);
      if (!st.isFile() || st.dev !== f.dev || st.ino !== f.ino) throw new AutomationFailure("NotAllowed", `${basename(f.path)} changed while it was being uploaded — try again`);
      const dest = join(dir, name);
      dst = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      for (;;) {
        const n = readSync(src, buf, 0, buf.length, null);
        if (n === 0) break;
        total += n;
        if (total > UPLOAD_MAX_BYTES) throw new AutomationFailure("NotAllowed", `upload() takes at most ${UPLOAD_MAX_BYTES / (1024 * 1024)} MiB of files at once`);
        writeSync(dst, buf, 0, n);
      }
      out.push(dest);
    } catch (err) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      throw err;
    } finally {
      if (src !== undefined) closeSync(src);
      if (dst !== undefined) closeSync(dst);
    }
  }
  return out;
}

/** Remove staged copies: one session's (its end), or every one (the daemon starting). */
export function clearStagedUploads(home: string, sessionId?: string): void {
  if (sessionId !== undefined && !/^[A-Za-z0-9_-]+$/.test(sessionId)) return;
  try { rmSync(sessionId === undefined ? uploadStagingRoot(home) : join(uploadStagingRoot(home), sessionId), { recursive: true, force: true }); } catch { /* best effort */ }
}
