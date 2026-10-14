import { dlopen, FFIType } from "bun:ffi";
import { fsyncSync } from "node:fs";
import { CoworkError } from "./types";

// Darwin fcntl(fd, command, ...) has two fixed arguments. Apple arm64 places
// the variadic third argument on the stack: x2-x7 are padding, parameter nine
// is a zero u64 stack value. F_FULLFSYNC ignores arg; supply a correctly placed
// harmless value rather than depending on an undeclared caller stack slot.
// Apple's fcntl(2): F_FULLFSYNC performs fsync and asks the device to flush media.
const F_FULLFSYNC = 51;
function load() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new CoworkError("unsupported_topology");
  return dlopen("/usr/lib/libSystem.B.dylib", {
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  });
}
let library: ReturnType<typeof load> | undefined;
/** Only owned temp/target or held canonical-directory FDs. No path fallback,
 * unsupported-operation fallback or silent success. Storage hardware can still
 * violate flush promises; success is a completed OS request, not power-cut proof. */
export function fullSyncInstructionFd(fd: number): void {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new CoworkError("invalid_request");
  fsyncSync(fd);
  const native = library ??= load();
  if (native.symbols.fcntl!(fd, F_FULLFSYNC, 0n, 0n, 0n, 0n, 0n, 0n, 0n) !== 0) throw new CoworkError("recovery_required");
}
