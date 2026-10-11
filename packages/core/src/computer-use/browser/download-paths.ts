// ComputerV2 Phase 3 — where a `download()` file goes, and how it gets there.
//
// A captured file is first STAGED in `<home>/cache/downloads/<session>/<random>/` — a place the session's sandboxed
// shell cannot write (all of `<home>/cache` is denied to it). It is then PLACED in its destination:
//   - no `to`: `<the session's temp dir>/downloads/<name>`;
//   - `to`: a path relative to the session's working directory, or absolute inside it or inside the session's temp
//     dir; a `to` ending in "/" is a directory (the name is appended).
// Refused, naming the rule: a segment below the root that starts with "." (.git, .winter, .ssh, .env …), a control-plane
// file name, a path on the sandbox's deny-write list, anything under the Winter home, a symlink anywhere from the root
// down.
//
// Both roots are places the agent itself can write — and so can REPLACE: the session temp dir is a sandbox writable
// root whose own name the shell can swap for a symlink, and any directory under either root can be one. The daemon is
// unsandboxed, so the placing follows `stage-image.ts`'s discipline: the temp dir's own name is never resolved (its root
// is `realpath(<parent>)` + its basename), every directory on the way down must be a real directory (`lstat`), the file
// is created O_CREAT|O_EXCL|O_NOFOLLOW (never over or through anything), and not one byte is written until the open
// descriptor is proved to be the file at the walked path (its realpath is exactly that path and it has the descriptor's
// inode). A swap between the checks and the open costs at most one EMPTY file, which is removed. The bytes are copied
// into that descriptor (never renamed into place, which would follow a swapped directory), and the file gets the
// quarantine attribute a browser sets, so Gatekeeper checks anything run from it.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AutomationFailure } from "../errors";

export const DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
export const DOWNLOADS_PER_RUN = 20;
const NAME_MAX_BYTES = 200;
/** File names a download never takes: the control plane's (a settings tier, a permissions record, trust). */
const FENCED_NAMES: ReadonlySet<string> = new Set(["settings.json", "settings.local.json", "permissions.local.json", "trust.json"]);

export function downloadStagingRoot(home: string): string { return join(home, "cache", "downloads"); }

/** A fresh private staging directory for one capture (0700). */
export function newStagingDir(home: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new AutomationFailure("NotAllowed", "this session can't save downloads");
  const dir = join(downloadStagingRoot(home), sessionId, randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Remove staged files: one session's (its runtime ended), or every one (the engine starting). */
export function clearStagedDownloads(home: string, sessionId?: string): void {
  if (sessionId !== undefined && !/^[A-Za-z0-9_-]+$/.test(sessionId)) return;
  try { rmSync(sessionId === undefined ? downloadStagingRoot(home) : join(downloadStagingRoot(home), sessionId), { recursive: true, force: true }); } catch { /* best effort */ }
}

/** A server's (or browser's) suggested name as a safe basename: no directories, control characters, `/ \ :` or leading
 *  dots; at most 200 bytes (the extension kept); "download" when nothing is left. */
export function safeDownloadName(raw: string | undefined): string {
  let name = basename(String(raw ?? "").replace(/\\/g, "/"));
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f/\\:]/g, "").replace(/[‪-‮⁦-⁩‎‏]/g, "").trim().replace(/^\.+/, "").trim();
  if (Buffer.byteLength(name) > NAME_MAX_BYTES) {
    const ext = extname(name).slice(0, 16);
    let stem = name.slice(0, name.length - ext.length);
    while (Buffer.byteLength(stem + ext) > NAME_MAX_BYTES) stem = stem.slice(0, -1);
    name = stem + ext;
  }
  return name === "" || name === "." || name === ".." ? "download" : name;
}

export interface DownloadRoots {
  /** The session's working directory (its stored cwd), if it has one. */
  cwd: string | null | undefined;
  /** The session's temp directory AS SPELLED (`sessionTmpDirPath`) — never resolved by name. */
  tmpDir: string;
  /** The Winter home: never written. */
  home: string;
  /** The sandbox's deny-write list for the session (`sandboxConfigFor(home, cwd).filesystem.denyWrite`). */
  denyWrite: readonly string[];
}

/** Where a download will go: a root, the directories below it, and the file name. Checked; nothing created yet. */
export interface DownloadPlan {
  root: "cwd" | "tmp";
  /** The root's path (the cwd's realpath; the temp dir's parent's realpath + its basename). */
  rootPath: string;
  /** Directory names below the root, in order. */
  dirs: string[];
  name: string;
}

const real = (p: string): string | undefined => { try { return realpathSync(p); } catch { return undefined; } };
const inside = (child: string, root: string): boolean => child === root || child.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
const refused = (message: string): AutomationFailure => new AutomationFailure("NotAllowed", message);

function tmpRootOf(tmpDir: string): string {
  const parent = real(dirname(tmpDir));
  if (parent === undefined) throw refused("this session's temp directory is unavailable");
  return join(parent, basename(tmpDir));
}

/**
 * Check `to` (or the default) for a file named `name` and say where it will go — or refuse, naming the rule. Nothing
 * is created here.
 */
export function planDownload(to: unknown, suggestedName: string, roots: DownloadRoots): DownloadPlan {
  if (to !== undefined && (typeof to !== "string" || to.trim() === "")) throw Object.assign(new TypeError("download()'s to is a path"), { name: "TypeError" });
  const tmpRoot = tmpRootOf(roots.tmpDir);
  const cwdReal = roots.cwd === null || roots.cwd === undefined ? undefined : real(roots.cwd);
  if (to === undefined) return { root: "tmp", rootPath: tmpRoot, dirs: ["downloads"], name: safeDownloadName(suggestedName) };

  const raw = to as string;
  const shown = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  if (!isAbsolute(raw) && cwdReal === undefined) throw refused("this session has no working directory — leave out { to } (the file goes to the session's temp folder) or give an absolute path in it");
  const asDir = /[/\\]$/.test(raw);
  const target = isAbsolute(raw) ? resolve(raw) : resolve(cwdReal!, raw);
  // Each root in each spelling it may arrive in (macOS: /var/… and /private/var/…).
  const candidates: Array<{ root: "cwd" | "tmp"; spelled: string; path: string }> = [];
  if (cwdReal !== undefined) {
    candidates.push({ root: "cwd", spelled: cwdReal, path: cwdReal });
    candidates.push({ root: "cwd", spelled: resolve(roots.cwd!), path: cwdReal });
  }
  candidates.push({ root: "tmp", spelled: tmpRoot, path: tmpRoot });
  candidates.push({ root: "tmp", spelled: resolve(roots.tmpDir), path: tmpRoot });
  const hit = candidates.filter((c) => inside(target, c.spelled)).sort((a, b) => b.spelled.length - a.spelled.length)[0];
  if (hit === undefined) throw refused(`${shown} is outside this session's working directory and temp folder — a download goes in one of those`);
  const rel = relative(hit.spelled, target);
  const parts = rel === "" ? [] : rel.split(sep).filter((p) => p !== "");
  if (parts.some((p) => p === "..")) throw refused(`${shown} leaves its folder`);
  let name: string;
  let dirs: string[];
  if (asDir || parts.length === 0) {
    dirs = parts;
    name = safeDownloadName(suggestedName);
  } else {
    dirs = parts.slice(0, -1);
    name = safeDownloadName(parts.at(-1));
  }
  // `to`'s own segments as written (a name is sanitised below — a hidden name the model asked for is refused, never
  // quietly renamed), then the final name.
  const dot = [...parts, name].find((p) => p.startsWith("."));
  if (dot !== undefined) throw refused(`${shown}: Winter doesn't save downloads into hidden folders or files ("${dot}")`);
  if (FENCED_NAMES.has(name.toLowerCase())) throw refused(`${shown}: a download can't be named ${name} (a settings file) — give { to } another name`);
  const finalPath = join(hit.path, ...dirs, name);
  const home = [resolve(roots.home), real(roots.home)].filter((h): h is string => h !== undefined);
  if (home.some((h) => inside(finalPath, h))) throw refused(`${shown} is inside Winter's own home — a download can't go there`);
  for (const d of roots.denyWrite) {
    for (const spelled of new Set([resolve(d), real(d) ?? resolve(d)])) {
      if (inside(finalPath, spelled)) throw refused(`${shown} is on the sandbox's protected list — a download can't go there`);
    }
  }
  return { root: hit.root, rootPath: hit.path, dirs, name };
}

function requireRealDirectory(path: string, what: string): void {
  let st;
  try { st = lstatSync(path); } catch { throw refused(`${what} is unavailable`); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw refused(`${what} is not a plain folder (a link?) — Winter doesn't save through links`);
}

function nameCandidate(name: string, n: number): string {
  if (n === 1) return name;
  const ext = extname(name);
  const stem = ext.length > 0 && ext.length < name.length ? name.slice(0, -ext.length) : name;
  return `${stem} (${n})${stem === name ? "" : ext}`;
}

// ── the quarantine attribute (fsetxattr on the open descriptor: no path is followed again) ──────────────────────

let fsetxattrFn: ((fd: number, name: Buffer, value: Buffer) => number) | null | undefined;
function fsetxattr(fd: number, name: string, value: string): boolean {
  if (fsetxattrFn === undefined) {
    fsetxattrFn = null;
    if (process.platform === "darwin") {
      try {
        const lib = dlopen("/usr/lib/libSystem.B.dylib", {
          fsetxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
        });
        fsetxattrFn = (f, n, v) => lib.symbols.fsetxattr(f, ptr(n), ptr(v), BigInt(v.length), 0, 0);
      } catch { fsetxattrFn = null; }
    }
  }
  if (fsetxattrFn === null) return false;
  try { return fsetxattrFn(fd, Buffer.from(`${name}\0`), Buffer.from(value)) === 0; } catch { return false; }
}

/** The value a browser writes: flags 0083 (downloaded, user approved), the time in hex seconds, the agent's name. */
export function quarantineValue(nowMs: number): string {
  return `0083;${Math.floor(nowMs / 1000).toString(16)};Winter;`;
}

/**
 * Copy the staged file into its planned place and remove the staged copy. `expectedBytes` (when known) must match.
 * Returns the final real path and name (a taken name becomes "name (2).ext", …).
 */
export function placeDownload(stagedPath: string, plan: DownloadPlan, o: { expectedBytes?: number; tmpDir: string; now?: () => number }): { path: string; name: string; bytes: number } {
  // The root: the temp dir is made if missing, and is never followed by its own name; the cwd must exist.
  if (plan.root === "tmp") {
    try { mkdirSync(plan.rootPath, { recursive: false, mode: 0o700 }); } catch { /* exists — checked below */ }
  }
  requireRealDirectory(plan.rootPath, plan.root === "tmp" ? "the session's temp folder" : "the working directory");
  let dir = plan.rootPath;
  for (const seg of plan.dirs) {
    dir = join(dir, seg);
    try { mkdirSync(dir, { mode: 0o755 }); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw refused(`could not create the folder ${seg}`);
    }
    requireRealDirectory(dir, `the folder ${seg}`);
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  let src: number;
  try { src = openSync(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new Error("the downloaded file went away before it could be saved"); }
  try {
    const srcStat = fstatSync(src);
    if (!srcStat.isFile()) throw new Error("the downloaded file is not a regular file");
    if (srcStat.size > DOWNLOAD_MAX_BYTES) throw refused(`the file is larger than ${DOWNLOAD_MAX_BYTES / (1024 * 1024)} MiB — Winter doesn't save it`);
    if (o.expectedBytes !== undefined && srcStat.size !== o.expectedBytes) throw new Error(`the download is incomplete (${srcStat.size} of ${o.expectedBytes} bytes)`);
    for (let n = 1; n <= 1000; n++) {
      const name = nameCandidate(plan.name, n);
      const path = join(dir, name);
      let fd: number;
      try { fd = openSync(path, flags, 0o644); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw refused(`could not create ${name} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      }
      try {
        // Prove the descriptor is the file at the walked path before a single byte is written.
        const opened = fstatSync(fd);
        const realPath = real(path);
        const here = realPath === undefined ? undefined : (() => { try { return statSync(realPath); } catch { return undefined; } })();
        if (realPath !== path || here === undefined || here.ino !== opened.ino || here.dev !== opened.dev) {
          closeSync(fd);
          try { unlinkSync(path); } catch { /* best effort — it is empty */ }
          throw refused("the destination folder changed while the file was being saved (a link?) — nothing was saved");
        }
        fsetxattr(fd, "com.apple.quarantine", quarantineValue((o.now ?? Date.now)()));
        const buf = Buffer.alloc(1024 * 1024);
        let total = 0;
        for (;;) {
          const r = readSync(src, buf, 0, buf.length, null);
          if (r === 0) break;
          total += r;
          if (total > DOWNLOAD_MAX_BYTES) throw refused(`the file is larger than ${DOWNLOAD_MAX_BYTES / (1024 * 1024)} MiB — Winter doesn't save it`);
          let off = 0;
          while (off < r) off += writeSync(fd, buf, off, r - off);
        }
        closeSync(fd);
        try { unlinkSync(stagedPath); } catch { /* the staging directory goes with the session */ }
        return { path, name, bytes: total };
      } catch (err) {
        try { closeSync(fd); } catch { /* already closed */ }
        try { unlinkSync(path); } catch { /* best effort */ }
        throw err;
      }
    }
    throw refused(`could not pick a free name for ${plan.name}`);
  } finally {
    closeSync(src);
  }
}
