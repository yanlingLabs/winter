/*
 * File primitives for the `.winterworkspace` export writer and the restore flow: an APFS clone of a pinned image where the
 * volume allows it, otherwise a sparse copy that skips zero blocks; xattr stripping; streaming hashes; an exclusive or atomic
 * directory rename. Darwin arm64 only, like the rest of the volume layer (`volume-fs.ts`).
 *
 * Nothing here removes or truncates anything of the workspace. A destination is always CREATED (`O_EXCL`), never opened with
 * `O_TRUNC`, and a sparse copy sets the final size with one positioned write rather than `ftruncate`.
 */
import { CString, dlopen, FFIType, read, toArrayBuffer } from "bun:ffi";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";

const AT_FDCWD = -2;
export const RENAME_SWAP = 0x2, RENAME_EXCL = 0x4;
const BLOCK = 1024 * 1024, PAGE = 4096;

function load() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("unsupported_topology");
  return dlopen("/usr/lib/libSystem.B.dylib", {
    fclonefileat: { args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    flistxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
    fremovexattr: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    // Descriptor-relative reads (a held directory cannot be redirected by swapping a path component) and the ACL check.
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
    readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
    closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
    acl_get_file: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
    acl_to_text: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    acl_free: { args: [FFIType.ptr], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  });
}
let native: ReturnType<typeof load> | undefined;
const lib = () => native ??= load();
const errno = (): number => { const address = lib().symbols.__error!(); return address === null ? 0 : read.i32(address, 0); };
/** Every 16 MiB give the daemon's event loop a turn, and honour cancellation, so a multi-GiB image never freezes the daemon. */
async function yieldToLoop(blocks: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new ExportIoError("cancelled");
  if (blocks % 16 === 15) await new Promise<void>(resolve => setImmediate(resolve));
}
const cstr = (value: string): Buffer => Buffer.from(`${value}\0`);

export class ExportIoError extends Error { constructor(readonly reason: string, readonly errno = 0) { super(reason); this.name = "ExportIoError"; } }

/** Rename `from` to `to`. `exclusive` refuses an existing target; `swap` exchanges the two atomically (both must exist). */
export function renameDirect(from: string, to: string, mode: "exclusive" | "swap"): void {
  if (lib().symbols.renamex_np!(cstr(from), cstr(to), mode === "swap" ? RENAME_SWAP : RENAME_EXCL) !== 0) throw new ExportIoError(`rename_${mode}_refused`, errno());
}

/** Remove EVERY extended attribute of an open file, the sticky Time Machine exclusion included. */
export function stripExtendedAttributes(fd: number): void {
  const symbols = lib().symbols;
  for (let attempt = 0; attempt < 4; attempt++) {
    const size = Number(symbols.flistxattr!(fd, null, 0n, 0));
    if (size < 0) throw new ExportIoError("xattr_list_refused", errno());
    if (size === 0) return;
    const names = Buffer.alloc(size), got = Number(symbols.flistxattr!(fd, names, BigInt(size), 0));
    if (got < 0) { if (errno() === 34 /* ERANGE: the list grew */) continue; throw new ExportIoError("xattr_list_refused", errno()); }
    // Each name is passed back as the RAW bytes the kernel listed: a name that is not valid UTF-8 must not be re-encoded.
    for (const raw of attributeNameBuffers(names.subarray(0, got))) {
      if (symbols.fremovexattr!(fd, raw, 0) !== 0 && errno() !== 93 /* ENOATTR */) throw new ExportIoError("xattr_remove_refused", errno());
    }
    if (hasExtendedAttributes(fd)) throw new ExportIoError("xattr_remain");
    return;
  }
  throw new ExportIoError("xattr_list_unstable");
}
/** Split a `flistxattr` buffer into NUL-terminated raw names (the terminator kept), byte for byte. */
export function attributeNameBuffers(list: Buffer): Buffer[] {
  const out: Buffer[] = []; let start = 0;
  for (let i = 0; i < list.length; i++) if (list[i] === 0) { out.push(Buffer.from(list.subarray(start, i + 1))); start = i + 1; }
  return out;
}
export function hasExtendedAttributes(fd: number): boolean {
  const size = Number(lib().symbols.flistxattr!(fd, null, 0n, 0));
  if (size < 0) throw new ExportIoError("xattr_list_refused", errno());
  return size > 0;
}

/** Open `name` (one component) relative to a held directory, never following a link. Throws with the errno. */
export function openAt(directoryFd: number, name: string, flags: number): number {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) throw new ExportIoError("bad_component");
  const fd = lib().symbols.openat!(directoryFd, cstr(name), flags | constants.O_NOFOLLOW | 0x01000000 /* O_CLOEXEC */) as number;
  if (fd < 0) throw new ExportIoError("openat_refused", errno());
  return fd;
}
/** Open an absolute directory path for descriptor-relative work; a final symlink is refused. */
export function openDirectoryNoFollow(path: string): number {
  return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | 0x01000000);
}
/** The entries of a held directory, sorted bytewise, without "." and "..". Names are returned only when they are valid UTF-8. */
export function listDirectoryAt(directoryFd: number): string[] {
  // A fresh open file description of the SAME held directory (`.` relative to it): a dup would share the read offset, so a
  // second listing of the same descriptor would come back empty.
  const symbols = lib().symbols, copy = symbols.openat!(directoryFd, cstr("."), constants.O_RDONLY | constants.O_DIRECTORY | 0x01000000) as number;
  if (copy < 0) throw new ExportIoError("reopen_refused", errno());
  const dir = symbols.fdopendir!(copy);
  if (dir === null) { closeSync(copy); throw new ExportIoError("fdopendir_refused", errno()); }
  const names: Buffer[] = [];
  try {
    for (;;) {
      const entry = symbols.readdir!(dir);
      if (entry === null) break;
      const length = read.u16(entry, 18), raw = Buffer.from(new Uint8Array(toArrayBuffer(entry, 21, length)));
      if (raw.equals(Buffer.from("."))|| raw.equals(Buffer.from(".."))) continue;
      names.push(raw);
    }
  } finally { symbols.closedir!(dir); }
  names.sort(Buffer.compare);
  return names.map(raw => { const text = raw.toString("utf8"); if (!Buffer.from(text, "utf8").equals(raw)) throw new ExportIoError("invalid_name"); return text; });
}
/** Does this directory carry an ACL that lets anyone add files, delete children or change its contents? A chmod 0700 alone
 * does not exclude an ACL entry. Fails closed (true) on a path it cannot judge. */
export function hasWritableAcl(path: string): boolean {
  const symbols = lib().symbols, acl = symbols.acl_get_file!(cstr(path), 0x100 /* ACL_TYPE_EXTENDED */);
  if (acl === null) { const code = errno(); return code !== 2 && code !== 0; } // ENOENT: the path has no ACL; any other failure is not "safe"
  try {
    const text = symbols.acl_to_text!(acl, null);
    if (text === null) return true;
    try {
      const dangerous = new Set(["write", "add_file", "add_subdirectory", "delete_child", "append", "delete", "writeattr", "writeextattr", "writesecurity", "chown"]);
      return new CString(text).toString().split("\n").some(line => { const parts = line.split(":"); return parts.at(-2) === "allow" && parts.at(-1)!.split(",").some(permission => dangerous.has(permission)); });
    } finally { symbols.acl_free!(text); }
  } finally { symbols.acl_free!(acl); }
}

export type CopyMethod = "clone" | "sparse";
/**
 * Copy the whole of `sourceFd` (a pinned, already verified descriptor) into a NEW file at `destination`, mode 0600. APFS
 * clonefile first where the volume allows (instant, shares extents), else a sparse copy. Returns how it was done. The
 * destination's extended attributes are stripped in both cases: a clone carries the source's xattrs, which would hand the
 * export the image's sticky backup exclusion, and "export is the backup path" needs the export to be backed up.
 */
export async function copyImageFile(sourceFd: number, destination: string, options: { readonly allowClone?: boolean; readonly signal?: AbortSignal } = {}): Promise<CopyMethod> {
  const size = Number(fstatSync(sourceFd, { bigint: true }).size);
  let method: CopyMethod = "sparse";
  if (options.allowClone !== false && lib().symbols.fclonefileat!(sourceFd, AT_FDCWD, cstr(destination), 0) === 0) method = "clone";
  else if (options.allowClone !== false) {
    // ENOTSUP / EXDEV (not APFS, or another volume) fall back; EEXIST would mean the destination was not fresh.
    if (errno() === 17) throw new ExportIoError("destination_exists", 17);
  }
  if (method === "sparse") await sparseCopy(sourceFd, destination, size, options.signal);
  const fd = openSync(destination, constants.O_RDWR | constants.O_NOFOLLOW);
  try { stripExtendedAttributes(fd); fsyncSync(fd); } finally { closeSync(fd); }
  return method;
}
async function sparseCopy(sourceFd: number, destination: string, size: number, signal?: AbortSignal): Promise<void> {
  const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const buffer = Buffer.alloc(BLOCK);
    for (let position = 0, blocks = 0; position < size; blocks++) {
      await yieldToLoop(blocks, signal);
      const want = Math.min(BLOCK, size - position), got = readSync(sourceFd, buffer, 0, want, position);
      if (got <= 0) throw new ExportIoError("source_short_read");
      // Write only runs that contain a non-zero page; an all-zero page leaves a hole.
      for (let page = 0; page < got; page += PAGE) {
        const end = Math.min(got, page + PAGE);
        if (buffer.subarray(page, end).some(byte => byte !== 0)) writeSync(fd, buffer, page, end - page, position + page);
      }
      position += got;
    }
    // The last byte is written explicitly so the file has its full length even when the tail is a hole. No ftruncate.
    const last = Buffer.alloc(1);
    if (size > 0) { readSync(sourceFd, last, 0, 1, size - 1); writeSync(fd, last, 0, 1, size - 1); }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/** sha256 and length of an open file's first `size` bytes, streaming. Never reads past `size`. */
export async function hashDescriptor(fd: number, size: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256"), buffer = Buffer.alloc(BLOCK);
  for (let position = 0, blocks = 0; position < size; blocks++) {
    await yieldToLoop(blocks, signal);
    const got = readSync(fd, buffer, 0, Math.min(BLOCK, size - position), position);
    if (got <= 0) throw new ExportIoError("source_short_read");
    hash.update(buffer.subarray(0, got)); position += got;
  }
  return hash.digest("hex");
}
/** A cheap, strong-enough change stamp for a pinned file: identity, size and both change times in nanoseconds. */
export function stampDescriptor(fd: number): string {
  const st = fstatSync(fd, { bigint: true });
  return [st.dev, st.ino, st.nlink, st.uid, st.mode, st.size, st.mtimeNs, st.ctimeNs].join(":");
}
