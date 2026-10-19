/** Narrow descriptor-relative I/O for private Cowork images. No arbitrary path operations. */
import { dlopen, FFIType, read } from "bun:ffi";
import { constants } from "node:fs";
export { openDirAt, mkdirAt, createFileAt, closeFd, AT_FDCWD } from "../computer-use/browser/fd-fs";

function loadNative() {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    fgetxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32], returns: FFIType.i64 },
    __error: { args: [], returns: FFIType.ptr },
  });
}
let native: ReturnType<typeof loadNative> | undefined;
/** O_NONBLOCK prevents a substituted FIFO/device from hanging before fstat rejects it. */
export function openImageAt(dir: number, name: "data.ext4" | "env.ext4"): number {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("unsupported_topology");
  native ??= loadNative();
  const bytes = Buffer.from(`${name}\0`);
  const fd = native.symbols.openat!(dir, bytes, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW | 0x01000000) as number;
  if (fd < 0) { const address = native.symbols.__error!(); const errno = address === null ? 0 : read.i32(address, 0); throw new Error(`image_open_refused:${errno}`); }
  return fd;
}

/** The same image, opened READ-ONLY (O_RDONLY, no follow, close-on-exec): what a restore reads while it holds the exclusive restore claim. */
export function openImageReadOnlyAt(dir: number, name: "data.ext4" | "env.ext4"): number {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("unsupported_topology");
  native ??= loadNative();
  const bytes = Buffer.from(`${name}\0`);
  const fd = native.symbols.openat!(dir, bytes, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | 0x01000000) as number;
  if (fd < 0) { const address = native.symbols.__error!(); const errno = address === null ? 0 : read.i32(address, 0); throw new Error(`image_open_refused:${errno}`); }
  return fd;
}

function loadPropertyLists() {
  return dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFDataCreate: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.ptr },
    CFPropertyListCreateWithData: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    CFGetTypeID: { args: [FFIType.ptr], returns: FFIType.u64 },
    CFStringGetTypeID: { args: [], returns: FFIType.u64 },
    CFStringGetLength: { args: [FFIType.ptr], returns: FFIType.i64 },
    CFStringGetCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.u32], returns: FFIType.u8 },
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
  });
}
let propertyLists: ReturnType<typeof loadPropertyLists> | undefined;
export const BACKUP_EXCLUSION_MAX_BYTES = 256;
/** Parse only a bounded binary plist whose root is exactly the expected string. No byte-for-byte
 * serialization assumption, recursive JS parser, subprocess, XML or external entity processing. */
export function isStickyBackupExclusion(value: Buffer): boolean {
  if (process.platform !== "darwin" || process.arch !== "arm64" || value.length < 40 || value.length > BACKUP_EXCLUSION_MAX_BYTES || !value.subarray(0, 8).equals(Buffer.from("bplist00"))) return false;
  propertyLists ??= loadPropertyLists();
  const cf = propertyLists.symbols, data = cf.CFDataCreate!(null, value, BigInt(value.length));
  if (data === null) return false;
  let plist: ReturnType<typeof cf.CFPropertyListCreateWithData> = null;
  try {
    plist = cf.CFPropertyListCreateWithData!(null, data, 0n, null, null);
    const expected = Buffer.from("com.apple.backupd"), decoded = Buffer.alloc(expected.length + 1);
    if (plist === null || cf.CFGetTypeID!(plist) !== cf.CFStringGetTypeID!() || Number(cf.CFStringGetLength!(plist)) !== expected.length) return false;
    return cf.CFStringGetCString!(plist, decoded, BigInt(decoded.length), 0x08000100) !== 0 && decoded.subarray(0, expected.length).equals(expected);
  } finally {
    if (plist !== null) cf.CFRelease!(plist);
    cf.CFRelease!(data);
  }
}

/** Verify sticky item metadata on the checked vnode, never re-resolve an image path. */
export function hasStickyBackupExclusion(fd: number): boolean {
  if (!native) return false;
  const value = Buffer.alloc(BACKUP_EXCLUSION_MAX_BYTES), name = Buffer.from("com.apple.metadata:com_apple_backup_excludeItem\0");
  const bytes = Number(native.symbols.fgetxattr!(fd, name, value, value.length, 0, 0));
  return bytes > 0 && bytes <= value.length && isStickyBackupExclusion(value.subarray(0, bytes));
}
