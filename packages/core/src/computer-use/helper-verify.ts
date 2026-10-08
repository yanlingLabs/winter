// ComputerV2 (2026-10-08) — the DAEMON's check that the process on the other end of the helper socket is
// really "Winter Computer Use" (spine §2, pinned): take the `pid` the helper reports in `hello`, ask the kernel
// for its code object (`SecCodeCopyGuestWithAttributes` with `kSecGuestAttributePid`) and check it DYNAMICALLY
// against the helper's designated requirement (`SecCodeCheckValidity`) — identifier + Winter's team. Bun's
// sockets do not expose the fd, so the peer's audit token (`LOCAL_PEERTOKEN`) is not reachable here; the
// helper's own check of the daemon (by audit token) is the load-bearing one, since it guards the TCC power.
//
// Over bun:ffi, the `auth/keychain-ffi.ts` pattern: every CF/Sec object crosses as `u64` (a tagged CFString
// pointer does not survive a JS number). Two things `dlopen` cannot hand over are DATA symbols —
// `kSecGuestAttributePid` and the CFDictionary callback structs. The attribute key is the CFString "pid"
// (dictionary keys compare with `CFEqual`), and the callback structs are found with libSystem's `dlsym`.
//
// Never throws: any failure (not macOS, a symbol missing, a non-zero OSStatus) is "not verified".
import { dlopen, FFIType } from "bun:ffi";

const SECURITY = "/System/Library/Frameworks/Security.framework/Security";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
const K_CF_STRING_ENCODING_UTF8 = 0x08000100;
const K_CF_NUMBER_SINT32_TYPE = 3;
/** `RTLD_DEFAULT` on Darwin: `((void *) -2)`. */
const RTLD_DEFAULT = -2n;

type Ref = bigint;

function loadLibs() {
  const REF = FFIType.u64;
  const cf = dlopen(CORE_FOUNDATION, {
    CFStringCreateWithCString: { args: [REF, FFIType.ptr, FFIType.u32], returns: REF },
    CFNumberCreate: { args: [REF, FFIType.i64, FFIType.ptr], returns: REF },
    CFDictionaryCreate: { args: [REF, FFIType.ptr, FFIType.ptr, FFIType.i64, REF, REF], returns: REF },
    CFRelease: { args: [REF], returns: FFIType.void },
  });
  const sec = dlopen(SECURITY, {
    SecCodeCopyGuestWithAttributes: { args: [REF, REF, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    SecRequirementCreateWithString: { args: [REF, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    SecCodeCheckValidity: { args: [REF, FFIType.u32, REF], returns: FFIType.i32 },
  });
  const sys = dlopen(LIBSYSTEM, {
    dlsym: { args: [FFIType.i64, FFIType.ptr], returns: REF },
  });
  return { cf: cf.symbols, sec: sec.symbols, sys: sys.symbols };
}

let libs: ReturnType<typeof loadLibs> | undefined;
const cstr = (s: string): Buffer => Buffer.from(`${s}\0`, "utf8");

/**
 * Does the RUNNING process `pid` satisfy `requirement` (a designated-requirement string)? `false` on any
 * failure — including the process having exited, which is the right answer for a socket peer that went away.
 */
export function processSatisfiesRequirement(pid: number, requirement: string): boolean {
  if (process.platform !== "darwin" || !Number.isInteger(pid) || pid <= 0) return false;
  const owned: Ref[] = [];
  try {
    libs ??= loadLibs();
    const { cf, sec, sys } = libs;
    const keyCallBacks = BigInt(sys.dlsym(RTLD_DEFAULT, cstr("kCFTypeDictionaryKeyCallBacks")));
    const valueCallBacks = BigInt(sys.dlsym(RTLD_DEFAULT, cstr("kCFTypeDictionaryValueCallBacks")));
    if (keyCallBacks === 0n || valueCallBacks === 0n) return false;

    const key = BigInt(cf.CFStringCreateWithCString(0n, cstr("pid"), K_CF_STRING_ENCODING_UTF8));
    if (key === 0n) return false;
    owned.push(key);
    const pidValue = new Int32Array([pid]);
    const number = BigInt(cf.CFNumberCreate(0n, K_CF_NUMBER_SINT32_TYPE, pidValue));
    if (number === 0n) return false;
    owned.push(number);
    const keys = new BigUint64Array([key]);
    const values = new BigUint64Array([number]);
    const attributes = BigInt(cf.CFDictionaryCreate(0n, keys, values, 1, keyCallBacks, valueCallBacks));
    if (attributes === 0n) return false;
    owned.push(attributes);

    const codeOut = new BigUint64Array(1);
    if (sec.SecCodeCopyGuestWithAttributes(0n, attributes, 0, codeOut) !== 0 || codeOut[0] === 0n) return false;
    owned.push(codeOut[0]!);

    const reqText = BigInt(cf.CFStringCreateWithCString(0n, cstr(requirement), K_CF_STRING_ENCODING_UTF8));
    if (reqText === 0n) return false;
    owned.push(reqText);
    const reqOut = new BigUint64Array(1);
    if (sec.SecRequirementCreateWithString(reqText, 0, reqOut) !== 0 || reqOut[0] === 0n) return false;
    owned.push(reqOut[0]!);

    return sec.SecCodeCheckValidity(codeOut[0]!, 0, reqOut[0]!) === 0;
  } catch {
    return false;
  } finally {
    for (const ref of owned) { try { libs?.cf.CFRelease(ref); } catch { /* best effort */ } }
  }
}
