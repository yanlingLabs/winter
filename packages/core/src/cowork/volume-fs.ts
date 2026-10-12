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

/** Verify the item itself carries tmutil's sticky marker, not merely an ancestor/path exclusion.
 * Exact binary plist emitted by supported tmutil: unknown metadata encoding refuses conservatively.
 * Reads the checked vnode descriptor, never re-resolves an image path. */
export function hasStickyBackupExclusion(fd: number): boolean {
  if (!native) return false;
  const marker = Buffer.from("62706c69737430305f1011636f6d2e6170706c652e6261636b75706408000000000000010100000000000000010000000000000000000000000000001c", "hex");
  const value = Buffer.alloc(256), name = Buffer.from("com.apple.metadata:com_apple_backup_excludeItem\0");
  const bytes = Number(native.symbols.fgetxattr!(fd, name, value, value.length, 0, 0));
  return bytes === marker.length && value.subarray(0, bytes).equals(marker);
}
