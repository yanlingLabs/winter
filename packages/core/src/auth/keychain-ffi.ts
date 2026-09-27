// WS-25 §7 B + the doctor fix: the few Security.framework calls `Bun.secrets` does not offer, over bun:ffi.
//
// WHY FFI AT ALL. `Bun.secrets` can read, write and delete a generic password, and that is all: it cannot
// (a) find an item WITHOUT decrypting it, which is what `winter doctor` needs to count legacy items without
// raising a consent prompt per item, or (b) create an item with an explicit access-control list, which is
// what lets the Mac app read the daemon's two pairing tokens without a prompt (`app-token-acl.ts`). Both
// live in the file-based keychain API (`SecKeychain*`), which is where `Bun.secrets` keeps its items too
// (measured 2026-09-27: a `Bun.secrets.set` lands in `login.keychain-db`, class `genp`, label = service).
//
// WHAT THIS FILE NEVER DOES:
//   - `SecKeychainItemSetAccess` on an existing item. Changing an item's ACL asks the user for the
//     keychain PASSWORD; the migration instead deletes and re-creates (its creator may, silently).
//   - Log or throw a value. Errors carry an OSStatus and the ACCOUNT, never the data.
//   - Run anywhere but macOS: every entry point checks the platform first and throws typed.
//
// The APIs are deprecated (since 10.10) but present and supported on every macOS Winter targets — the
// data-protection keychain that replaced them has no per-application ACL at all, only entitlement-gated
// access groups, which a `bun`-launched dev daemon cannot hold. `SecTrustedApplicationCreateFromPath`
// records each application by its DESIGNATED REQUIREMENT (measured: `identifier bun and anchor apple
// generic and … leaf[subject.OU] = "7FRXF46ZSN"`), so a trusted entry survives an update signed by the
// same team — a Sparkle update keeps the app's access.
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";

const SECURITY = "/System/Library/Frameworks/Security.framework/Security";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const CORE_SERVICES = "/System/Library/Frameworks/CoreServices.framework/CoreServices";

/** `errSecItemNotFound`. */
export const ERR_SEC_ITEM_NOT_FOUND = -25300;
/** `errSecDuplicateItem`. */
export const ERR_SEC_DUPLICATE_ITEM = -25299;
const K_CF_STRING_ENCODING_UTF8 = 0x08000100;

export class KeychainFfiError extends Error {
  constructor(readonly operation: string, readonly status: number, account?: string) {
    super(`keychain ${operation}${account === undefined ? "" : ` (${account})`} failed: OSStatus ${status}`);
    this.name = "KeychainFfiError";
  }
}

function fourCC(code: string): number {
  return code.split("").reduce((acc, c) => ((acc << 8) | c.charCodeAt(0)) >>> 0, 0);
}
const GENERIC_PASSWORD_CLASS = fourCC("genp");
const SERVICE_ATTR = fourCC("svce");
const ACCOUNT_ATTR = fourCC("acct");
const LABEL_ATTR = fourCC("labl");

function loadLibs() {
  // Every CF/Sec OBJECT REFERENCE crosses as `u64` (a bigint), never `ptr`: a short CFString is a TAGGED
  // pointer with its high bits set, which a `ptr` return (a JS number, 53 bits) silently corrupts —
  // measured: `CFStringCreateWithCString("x")` came back as a garbage double and `SecAccessCreate`
  // segfaulted on it. `ptr` is kept only for plain memory this process owns (C strings, out-params).
  const REF = FFIType.u64;
  const cf = dlopen(CORE_FOUNDATION, {
    CFStringCreateWithCString: { args: [REF, FFIType.ptr, FFIType.u32], returns: REF },
    CFArrayCreate: { args: [REF, FFIType.ptr, FFIType.i64, REF], returns: REF },
    CFArrayGetCount: { args: [REF], returns: FFIType.i64 },
    CFArrayGetValueAtIndex: { args: [REF, FFIType.i64], returns: REF },
    CFURLGetFileSystemRepresentation: { args: [REF, FFIType.bool, FFIType.ptr, FFIType.i64], returns: FFIType.bool },
    CFRelease: { args: [REF], returns: FFIType.void },
  });
  const sec = dlopen(SECURITY, {
    SecKeychainOpen: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SecKeychainUnlock: { args: [REF, FFIType.u32, FFIType.ptr, FFIType.bool], returns: FFIType.i32 },
    SecKeychainFindGenericPassword: { args: [REF, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SecKeychainItemFreeContent: { args: [REF, REF], returns: FFIType.i32 },
    SecKeychainItemDelete: { args: [REF], returns: FFIType.i32 },
    SecKeychainItemCreateFromContent: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, REF, REF, FFIType.ptr], returns: FFIType.i32 },
    SecTrustedApplicationCreateFromPath: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SecAccessCreate: { args: [REF, REF, FFIType.ptr], returns: FFIType.i32 },
  });
  const ls = dlopen(CORE_SERVICES, {
    LSCopyApplicationURLsForBundleIdentifier: { args: [REF, REF], returns: REF },
  });
  return { cf: cf.symbols, sec: sec.symbols, ls: ls.symbols };
}

let libs: ReturnType<typeof loadLibs> | undefined;
function L(): ReturnType<typeof loadLibs> {
  if (process.platform !== "darwin") throw new KeychainFfiError("load", -4 /* errSecUnimplemented */);
  libs ??= loadLibs();
  return libs;
}

/** A NUL-terminated C string (kept alive by the caller's reference for the duration of the call). */
function cstr(s: string): Buffer {
  return Buffer.from(`${s}\0`, "utf8");
}

function outPtr(): BigUint64Array {
  return new BigUint64Array(1);
}

/** A CF/Sec object reference; `0n` is NULL. */
type Ref = bigint;

function cfString(s: string): Ref {
  const ref = BigInt(L().cf.CFStringCreateWithCString(0n, cstr(s), K_CF_STRING_ENCODING_UTF8));
  if (ref === 0n) throw new KeychainFfiError("CFStringCreate", -1);
  return ref;
}

function release(ref: Ref | undefined): void {
  if (ref !== undefined && ref !== 0n) L().cf.CFRelease(ref);
}

/**
 * Where to look. `null` = the user's default search list (and, for a create, the default keychain) —
 * exactly where `Bun.secrets` reads and writes. A `KeychainFile` is a temporary keychain a TEST created
 * (`security create-keychain`); nothing in production opens one.
 */
export type KeychainTarget = null | KeychainFile;

export interface KeychainFile {
  readonly ref: Ref;
  close(): void;
}

/** Opens and unlocks a keychain FILE (tests only: a throwaway `security create-keychain` file). */
export function openKeychainFile(path: string, password: string): KeychainFile {
  const out = outPtr();
  const opened = L().sec.SecKeychainOpen(cstr(path), ptr(out));
  if (opened !== 0) throw new KeychainFfiError("open", opened);
  const ref = out[0]!;
  const pw = Buffer.from(password, "utf8");
  const unlocked = L().sec.SecKeychainUnlock(ref, pw.length, ptr(pw), true);
  if (unlocked !== 0) {
    release(ref);
    throw new KeychainFfiError("unlock", unlocked);
  }
  return { ref, close: () => release(ref) };
}

function kcRef(target: KeychainTarget): Ref {
  return target === null ? 0n : target.ref;
}

/** One `SecKeychainFindGenericPassword`. With `withData: false` the item is located WITHOUT its data being
 *  requested — no decrypt, so no consent prompt whatever the item's ACL says. */
function find(target: KeychainTarget, service: string, account: string, withData: boolean): { status: number; item?: Ref; value?: string } {
  const svc = Buffer.from(service, "utf8");
  const acct = Buffer.from(account, "utf8");
  const itemOut = outPtr();
  const lenOut = new Uint32Array(1);
  const dataOut = outPtr();
  const status = L().sec.SecKeychainFindGenericPassword(kcRef(target), svc.length, ptr(svc), acct.length, ptr(acct), withData ? ptr(lenOut) : null, withData ? ptr(dataOut) : null, ptr(itemOut));
  if (status !== 0) return { status };
  let value: string | undefined;
  if (withData) {
    const data = dataOut[0]!;
    const length = lenOut[0]!;
    // A heap address (never a tagged pointer), so the number form `toArrayBuffer` takes is exact.
    value = length === 0 || data === 0n ? "" : Buffer.from(toArrayBuffer(Number(data) as never, 0, length)).toString("utf8");
    if (data !== 0n) L().sec.SecKeychainItemFreeContent(0n, data);
  }
  return { status, item: itemOut[0]!, ...(value !== undefined ? { value } : {}) };
}

/** Is there a generic password at (service, account)? Never decrypts, never prompts. */
export function genericPasswordPresent(target: KeychainTarget, service: string, account: string): boolean {
  const found = find(target, service, account, false);
  if (found.status === ERR_SEC_ITEM_NOT_FOUND) return false;
  if (found.status !== 0) throw new KeychainFfiError("find", found.status, account);
  release(found.item);
  return true;
}

/** The item's value, or `null` when there is none. DECRYPTS — used only on items this process created
 *  (its own ACL entry), where the read is silent. */
export function readGenericPassword(target: KeychainTarget, service: string, account: string): string | null {
  const found = find(target, service, account, true);
  if (found.status === ERR_SEC_ITEM_NOT_FOUND) return null;
  if (found.status !== 0) throw new KeychainFfiError("read", found.status, account);
  release(found.item);
  return found.value ?? null;
}

/** Deletes the item; `false` when there was none. */
export function deleteGenericPassword(target: KeychainTarget, service: string, account: string): boolean {
  const found = find(target, service, account, false);
  if (found.status === ERR_SEC_ITEM_NOT_FOUND) return false;
  if (found.status !== 0) throw new KeychainFfiError("find", found.status, account);
  try {
    const deleted = L().sec.SecKeychainItemDelete(found.item!);
    if (deleted !== 0) throw new KeychainFfiError("delete", deleted, account);
    return true;
  } finally {
    release(found.item);
  }
}

/**
 * Creates a generic password whose decrypt ACL names exactly `trustedApplications` (`null` = the calling
 * process's own executable). Refuses typed (`ERR_SEC_DUPLICATE_ITEM`) when the item exists — the caller
 * deletes first. The item carries the same attributes a `Bun.secrets.set` item does (service, account,
 * label = service), so `Bun.secrets` and the Swift `SecItemCopyMatching` reader both find it.
 */
export function addGenericPasswordWithAccess(target: KeychainTarget, item: { service: string; account: string; value: string; trustedApplications: readonly (string | null)[] }): void {
  const { cf, sec } = L();
  const apps: Ref[] = [];
  let array: Ref = 0n;
  let description: Ref = 0n;
  let access: Ref = 0n;
  try {
    for (const path of item.trustedApplications) {
      const out = outPtr();
      const status = sec.SecTrustedApplicationCreateFromPath(path === null ? null : cstr(path), ptr(out));
      if (status !== 0) throw new KeychainFfiError("trusted application", status, item.account);
      apps.push(out[0]!);
    }
    const values = new BigUint64Array(apps);
    // No callbacks: the array does not retain its values, and they are released below after `access`
    // (which retains what it needs) is created.
    array = BigInt(cf.CFArrayCreate(0n, apps.length === 0 ? null : ptr(values), apps.length, 0n));
    description = cfString(item.account);
    const accessOut = outPtr();
    const created = sec.SecAccessCreate(description, array, ptr(accessOut));
    if (created !== 0) throw new KeychainFfiError("access", created, item.account);
    access = accessOut[0]!;

    const svc = Buffer.from(item.service, "utf8");
    const acct = Buffer.from(item.account, "utf8");
    // SecKeychainAttributeList { UInt32 count; SecKeychainAttribute *attr } and three
    // SecKeychainAttribute { UInt32 tag; UInt32 length; void *data } (16 bytes each on arm64/x86_64).
    const attrs = Buffer.alloc(48);
    const put = (i: number, tag: number, data: Buffer): void => {
      attrs.writeUInt32LE(tag, i * 16);
      attrs.writeUInt32LE(data.length, i * 16 + 4);
      attrs.writeBigUInt64LE(BigInt(ptr(data)), i * 16 + 8);
    };
    put(0, SERVICE_ATTR, svc);
    put(1, ACCOUNT_ATTR, acct);
    put(2, LABEL_ATTR, svc);
    const list = Buffer.alloc(16);
    list.writeUInt32LE(3, 0);
    list.writeBigUInt64LE(BigInt(ptr(attrs)), 8);
    const data = Buffer.from(item.value, "utf8");
    const itemOut = outPtr();
    const status = sec.SecKeychainItemCreateFromContent(GENERIC_PASSWORD_CLASS, ptr(list), data.length, ptr(data), kcRef(target), access, ptr(itemOut));
    if (status !== 0) throw new KeychainFfiError("create", status, item.account);
    release(itemOut[0]!);
  } finally {
    release(access);
    release(description);
    release(array);
    for (const app of apps) release(app);
  }
}

/** The file paths Launch Services knows for an application bundle id (`[]` when none). */
export function applicationPathsForBundleId(bundleId: string): string[] {
  const { cf, ls } = L();
  const id = cfString(bundleId);
  try {
    const urls = BigInt(ls.LSCopyApplicationURLsForBundleIdentifier(id, 0n));
    if (urls === 0n) return [];
    try {
      const out: string[] = [];
      const count = Number(cf.CFArrayGetCount(urls));
      const buf = Buffer.alloc(4096);
      for (let i = 0; i < count; i++) {
        const url = BigInt(cf.CFArrayGetValueAtIndex(urls, i));
        buf.fill(0);
        if (cf.CFURLGetFileSystemRepresentation(url, true, ptr(buf), buf.length)) out.push(buf.toString("utf8", 0, buf.indexOf(0)));
      }
      return out;
    } finally {
      release(urls);
    }
  } finally {
    release(id);
  }
}
