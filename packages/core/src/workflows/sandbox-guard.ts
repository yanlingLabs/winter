// WS-27: a workflow worker refuses to run outside a sandbox that denies it the Keychain.
//
// `winter-core __workflow-worker` (the daemon's own worker) and `winter-core __runtime-workflow-worker
// --bridge` (the runtime's, for embedded sessions) run model-authored JavaScript. Their containment is the
// seatbelt the PARENT wraps them in (`/usr/bin/sandbox-exec -p <profile> …`): nothing stopped the same
// binary being launched with those arguments WITHOUT it — by anything that can run a process as the user —
// and then it runs the script with every right `winter-core` has, the Keychain items it created included.
// So each worker checks, before it reads a byte of input, that it is (a) sandboxed at all and (b) denied a
// lookup of the security daemons' mach services — the file-based keychain's `com.apple.SecurityServer`
// (securityd, where `Bun.secrets` and `keychain-ffi.ts` live) and the data-protection keychain's
// `com.apple.securityd.xpc` (secd). Without a connection to either, no Keychain call can succeed.
//
// `sandbox_check(pid, operation, type, ...)` answers what the running process's sandbox would decide,
// without performing the operation (`SANDBOX_CHECK_NO_REPORT`: and without logging a violation). It is
// VARIADIC, and bun:ffi has no variadic call: on Apple arm64 a variadic argument is passed on the STACK,
// so the name is bound as the NINTH parameter (x0–x7 carry the three fixed ones plus five pads, and the
// ninth lands at [sp], exactly where the callee's `va_arg` reads it). On x86_64 variadic arguments ride
// the ordinary registers, so the fourth parameter is the name. A garbage name would be denied by any
// deny-default profile and read as "sandboxed" — which is why the gates also run a worker under a
// profile that ALLOWS `com.apple.SecurityServer` and require the refusal: only a correctly passed name
// can be allowed.
import { dlopen, FFIType } from "bun:ffi";

/** The worker's exit code when it refuses (`EX_NOPERM`). */
export const WORKER_NOT_SANDBOXED_EXIT_CODE = 77;

/** The mach services a sandboxed worker must be denied. */
export const KEYCHAIN_MACH_SERVICES = ["com.apple.SecurityServer", "com.apple.securityd.xpc"] as const;

const SANDBOX_FILTER_NONE = 0;
const SANDBOX_FILTER_GLOBAL_NAME = 2;
const SANDBOX_CHECK_NO_REPORT = 0x40000000;

type SandboxCheck = (pid: number, operation: string | null, type: number, name: string | null) => number;

function loadSandboxCheck(): SandboxCheck {
  const cstr = (s: string | null): Buffer | null => (s === null ? null : Buffer.from(`${s}\0`, "utf8"));
  if (process.arch === "arm64") {
    const P = FFIType.u64;
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      sandbox_check: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, P, P, P, P, P, FFIType.ptr], returns: FFIType.i32 },
    });
    return (pid, operation, type, name) => {
      const op = cstr(operation);
      const n = cstr(name);
      const r = lib.symbols.sandbox_check(pid, op, type, 0n, 0n, 0n, 0n, 0n, n);
      void [op, n]; // alive until the call returned
      return r;
    };
  }
  if (process.arch === "x64") {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      sandbox_check: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    });
    return (pid, operation, type, name) => {
      const op = cstr(operation);
      const n = cstr(name);
      const r = lib.symbols.sandbox_check(pid, op, type, n);
      void [op, n];
      return r;
    };
  }
  throw new Error(`no sandbox_check binding for ${process.arch}`);
}

export type KeychainSandboxState = { ok: true } | { ok: false; reason: string };

/** Is THIS process sandboxed with the Keychain's mach services denied? Never throws. */
export function keychainSandboxState(check?: SandboxCheck): KeychainSandboxState {
  if (process.platform !== "darwin") return { ok: false, reason: "workflow workers run only under the macOS sandbox" };
  let sandboxCheck: SandboxCheck;
  try {
    sandboxCheck = check ?? loadSandboxCheck();
  } catch (err) {
    return { ok: false, reason: `the sandbox could not be inspected (${err instanceof Error ? err.message : "error"})` };
  }
  const pid = process.pid;
  if (sandboxCheck(pid, null, SANDBOX_FILTER_NONE, null) !== 1) return { ok: false, reason: "this process is not sandboxed" };
  for (const service of KEYCHAIN_MACH_SERVICES) {
    if (sandboxCheck(pid, "mach-lookup", SANDBOX_FILTER_GLOBAL_NAME | SANDBOX_CHECK_NO_REPORT, service) === 0) {
      return { ok: false, reason: `the sandbox allows ${service} (the Keychain)` };
    }
  }
  return { ok: true };
}

/**
 * The first thing a workflow worker does: exit `WORKER_NOT_SANDBOXED_EXIT_CODE` with one line on stderr
 * unless `keychainSandboxState` is ok. Synchronous, so no input can be read before it returns.
 */
export function refuseUnlessKeychainSandboxed(worker: string): void {
  const state = keychainSandboxState();
  if (state.ok) return;
  process.stderr.write(`winter-core: the ${worker} refuses to run: ${state.reason}. It is started only by Winter, inside a sandbox that denies it the Keychain.\n`);
  process.exit(WORKER_NOT_SANDBOXED_EXIT_CODE);
}
