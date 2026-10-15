/** Existing-file-only descriptor-relative output reads. Reuses the reviewed
 * Darwin arm64 three-fixed-argument openat ABI, with no mode-requiring flags. */
import { dlopen, FFIType } from "bun:ffi";
import { constants } from "node:fs";
import { fdErrnoReader } from "../computer-use/browser/fd-fs";
import { CoworkError } from "./types";

const O_CLOEXEC = 0x01000000;
function load() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new CoworkError("unsupported_topology");
  return dlopen("/usr/lib/libSystem.B.dylib", {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
}
let library: ReturnType<typeof load> | undefined;

/** One relative component only. The caller walks parents using held O_NOFOLLOW
 * directories, checks fstat before reading and owns/closes the returned fd.
 * NONBLOCK prevents a substituted FIFO from hanging before that check. */
export function openOutputAt(directory: number, name: string): number {
  if (!Number.isSafeInteger(directory) || directory < 0 || directory > 0x7fffffff || name === "" || name === "." || name === ".." || /[/\0]/.test(name) || Buffer.byteLength(name, "utf8") > 255 || Buffer.from(name, "utf8").toString("utf8") !== name) throw new CoworkError("invalid_request");
  const native = library ??= load();
  const errno = fdErrnoReader();
  const filename = Buffer.from(`${name}\0`);
  const fd = native.symbols.openat!(directory, filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC) as number;
  if (fd < 0) {
    const code = errno();
    throw new CoworkError(code === 2 ? "file_missing" : "file_unavailable");
  }
  return fd;
}
