/** Fixed-file descriptor-relative host guidance operations. Not a guest file door.
 * Uses the existing Darwin/arm64 directory walk/create/unlink primitives. This
 * narrow extension adds no path-based fallback and never follows the target. */
import { dlopen, FFIType } from "bun:ffi";
import { constants } from "node:fs";
import { CoworkError } from "./types";

const O_CLOEXEC = 0x01000000;
const temporary = (name: string) => /^instruction-[a-f0-9-]{36}\.tmp$/.test(name);
function load() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new CoworkError("unsupported_topology");
  return dlopen("/usr/lib/libSystem.B.dylib", {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
}
let library: ReturnType<typeof load> | undefined;
const native = () => library ??= load();
function failed(): never {
  // Do not expose path/errno text to RPC or log user guidance.
  throw new CoworkError("recovery_required");
}

/** Never add any mode-requiring flags (O_CREAT/O_TMPFILE) to this 3-argument
 * nonvariadic binding. No O_CREAT/O_TRUNC; callers fstat before bounded
 * reads. NONBLOCK prevents a substituted FIFO from hanging before refusal. */
export function openInstructionAt(directory: number): number {
  const filename = Buffer.from("WINTER.md\0");
  const fd = native().symbols.openat!(directory, filename,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | O_CLOEXEC) as number;
  if (fd < 0) failed();
  return fd;
}

/** The source is the service's exclusive-created file in the SAME held directory.
 * renameat replaces the directory entry, never writes through its old inode/link.
 * An ancestor swap cannot redirect either operand to another directory. */
export function replaceInstructionAt(directory: number, temporaryName: string): void {
  if (!temporary(temporaryName)) throw new CoworkError("invalid_request");
  const source = Buffer.from(`${temporaryName}\0`), destination = Buffer.from("WINTER.md\0");
  if (native().symbols.renameat!(directory, source, directory, destination) !== 0) failed();
}
