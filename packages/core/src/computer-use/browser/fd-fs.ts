// ComputerV2 Phase 3 — directory-relative file system calls (openat / mkdirat / unlinkat over bun:ffi), for placing a
// download inside folders the agent itself can write. A walk by PATH re-resolves every segment at each call, so a shell
// that swaps a folder for a link between two calls can redirect a later mkdir, open or — worst — unlink to anywhere
// the daemon may write. Walking by directory descriptor, each step opened O_NOFOLLOW relative to the one before, pins
// every later call to the very directories that were checked: a swap after the walk changes nothing it does.
//
// `openat` is VARIADIC (its mode), and bun:ffi has no variadic call: on Apple arm64 a variadic argument is passed on the
// STACK, so the mode is bound as the NINTH parameter (x0–x7 carry the three fixed ones plus five pads, and the ninth
// lands at [sp], where the callee's `va_arg` reads it) — the same binding `workflows/sandbox-guard.ts` uses.
import { dlopen, FFIType, read } from "bun:ffi";
import { constants } from "node:fs";

export const AT_FDCWD = -2;
const O_CLOEXEC = 0x0100_0000;

interface Libc {
  openat(fd: number, path: string, flags: number, mode: number): number;
  mkdirat(fd: number, path: string, mode: number): number;
  unlinkat(fd: number, path: string): number;
  close(fd: number): number;
  errno(): number;
}

let libc: Libc | null | undefined;

function load(): Libc {
  if (libc !== undefined && libc !== null) return libc;
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("directory-relative file calls are bound for macOS on Apple silicon only");
  const P = FFIType.u64;
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, P, P, P, P, P, FFIType.u32], returns: FFIType.i32 },
    mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.u16], returns: FFIType.i32 },
    unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  });
  const cstr = (s: string): Buffer => Buffer.from(`${s}\0`, "utf8");
  libc = {
    openat: (fd, path, flags, mode) => { const p = cstr(path); const r = lib.symbols.openat(fd, p, flags, 0n, 0n, 0n, 0n, 0n, mode); void p; return r; },
    mkdirat: (fd, path, mode) => { const p = cstr(path); const r = lib.symbols.mkdirat(fd, p, mode); void p; return r; },
    unlinkat: (fd, path) => { const p = cstr(path); const r = lib.symbols.unlinkat(fd, p, 0); void p; return r; },
    close: (fd) => lib.symbols.close(fd),
    errno: () => { const e = lib.symbols.__error(); return e === null ? 0 : read.i32(e, 0); },
  };
  return libc;
}

/** A failed call, with its errno name ("EEXIST", "ELOOP", …). */
export class FdError extends Error {
  constructor(readonly code: string, readonly errno: number, call: string) {
    super(`${call}: ${code}`);
    this.name = "FdError";
  }
}

const ERRNO_NAMES: Record<number, string> = { 2: "ENOENT", 13: "EACCES", 17: "EEXIST", 20: "ENOTDIR", 21: "EISDIR", 62: "ELOOP", 28: "ENOSPC", 30: "EROFS", 1: "EPERM" };
function fail(call: string): never {
  const e = load().errno();
  throw new FdError(ERRNO_NAMES[e] ?? `errno ${e}`, e, call);
}

/** A segment name must be one plain name: never "", ".", ".." or anything with a slash or NUL. */
function plainName(name: string): string {
  if (name === "" || name === "." || name === ".." || /[/\0]/.test(name)) throw new FdError("EINVAL", 22, `not a plain name: ${JSON.stringify(name.slice(0, 80))}`);
  return name;
}

/** Open the directory `name` in `dirFd` (or an absolute path from AT_FDCWD) without following a link at its LAST
 *  component: a link there fails ELOOP, a non-directory ENOTDIR. */
export function openDirAt(dirFd: number, name: string): number {
  const fd = load().openat(dirFd, dirFd === AT_FDCWD ? name : plainName(name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC, 0);
  if (fd < 0) fail("openat(dir)");
  return fd;
}

/** mkdirat; true when it was created, false when something by that name already existed. */
export function mkdirAt(dirFd: number, name: string, mode: number): boolean {
  if (load().mkdirat(dirFd, plainName(name), mode) === 0) return true;
  const e = load().errno();
  if (e === 17) return false;
  throw new FdError(ERRNO_NAMES[e] ?? `errno ${e}`, e, "mkdirat");
}

/** Create `name` in `dirFd` for writing — O_CREAT|O_EXCL|O_NOFOLLOW: never over, or through, anything. */
export function createFileAt(dirFd: number, name: string, mode: number): number {
  const fd = load().openat(dirFd, plainName(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | O_CLOEXEC, mode);
  if (fd < 0) fail("openat(create)");
  return fd;
}

/** Remove the entry `name` from the directory `dirFd` (never a path resolved again). */
export function unlinkAt(dirFd: number, name: string): void {
  if (load().unlinkat(dirFd, plainName(name)) !== 0) fail("unlinkat");
}

export function closeFd(fd: number): void {
  if (fd >= 0) load().close(fd);
}
