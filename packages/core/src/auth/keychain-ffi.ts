// WS-25 §7 B + the doctor fix: the few Security.framework calls `Bun.secrets` does not offer, over bun:ffi.
//
// WHY FFI AT ALL. `Bun.secrets` can read, write and delete a generic password, and that is all: it cannot
// (a) find an item WITHOUT decrypting it, which is what `winter doctor` needs to count legacy items without
// raising a consent prompt per item, or (b) create an item with an explicit access-control list, which is
// what lets the Mac app read the daemon's two pairing tokens without a prompt (`app-token-acl.ts`), or
// (c) list a service's accounts without their data, which the credential ACL migration enumerates with
// (`credential-acl.ts`). All three live in the file-based keychain API (`SecKeychain*`), which is where `Bun.secrets` keeps its items too
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
    SecKeychainGetUserInteractionAllowed: { args: [FFIType.ptr], returns: FFIType.i32 },
    SecKeychainCopyDefault: { args: [FFIType.ptr], returns: FFIType.i32 },
    SecKeychainGetStatus: { args: [REF, FFIType.ptr], returns: FFIType.i32 },
    SecKeychainSetUserInteractionAllowed: { args: [FFIType.bool], returns: FFIType.i32 },
    SecKeychainSearchCreateFromAttributes: { args: [REF, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    SecKeychainSearchCopyNext: { args: [REF, FFIType.ptr], returns: FFIType.i32 },
    SecKeychainItemCopyContent: { args: [REF, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
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
  void pw.length;
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
function find(target: KeychainTarget, service: string, account: string, withData: boolean): { status: number; item?: Ref; bytes?: Uint8Array } {
  const svc = Buffer.from(service, "utf8");
  const acct = Buffer.from(account, "utf8");
  const itemOut = outPtr();
  const lenOut = new Uint32Array(1);
  const dataOut = outPtr();
  const status = L().sec.SecKeychainFindGenericPassword(kcRef(target), svc.length, ptr(svc), acct.length, ptr(acct), withData ? ptr(lenOut) : null, withData ? ptr(dataOut) : null, ptr(itemOut));
  void [svc, acct].length; // alive until the call returned (see `addGenericPassword`)
  if (status !== 0) return { status };
  let bytes: Uint8Array | undefined;
  if (withData) {
    const data = dataOut[0]!;
    const length = lenOut[0]!;
    // A heap address (never a tagged pointer), so the number form `toArrayBuffer` takes is exact. Copied
    // before the content is freed.
    bytes = length === 0 || data === 0n ? new Uint8Array(0) : new Uint8Array(Buffer.from(toArrayBuffer(Number(data) as never, 0, length)));
    if (data !== 0n) L().sec.SecKeychainItemFreeContent(0n, data);
  }
  return { status, item: itemOut[0]!, ...(bytes !== undefined ? { bytes } : {}) };
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
  const bytes = readGenericPasswordBytes(target, service, account);
  return bytes === null ? null : Buffer.from(bytes).toString("utf8");
}

/** `readGenericPassword`'s exact bytes — what a migration compares, so a value that is not valid UTF-8 can
 *  never be "verified" through a lossy decode. */
export function readGenericPasswordBytes(target: KeychainTarget, service: string, account: string): Uint8Array | null {
  const found = find(target, service, account, true);
  if (found.status === ERR_SEC_ITEM_NOT_FOUND) return null;
  if (found.status !== 0) throw new KeychainFfiError("read", found.status, account);
  release(found.item);
  return found.bytes ?? null;
}

/**
 * Every generic-password ACCOUNT under `service`, located and described WITHOUT their data: the search
 * (`SecKeychainSearchCreateFromAttributes`) and each item's attributes (`SecKeychainItemCopyContent` with
 * no data out-parameter) never decrypt, so no item's access list is consulted and nothing prompts. The
 * credential ACL migration enumerates with this before it reads anything.
 */
export function listGenericPasswordAccounts(target: KeychainTarget, service: string): string[] {
  const { sec } = L();
  const svc = Buffer.from(service, "utf8");
  // One SecKeychainAttribute { tag; length; data } in a SecKeychainAttributeList { count; attr }.
  const attr = Buffer.alloc(16);
  attr.writeUInt32LE(SERVICE_ATTR, 0);
  attr.writeUInt32LE(svc.length, 4);
  attr.writeBigUInt64LE(BigInt(ptr(svc)), 8);
  const list = Buffer.alloc(16);
  list.writeUInt32LE(1, 0);
  list.writeBigUInt64LE(BigInt(ptr(attr)), 8);
  const searchOut = outPtr();
  const created = sec.SecKeychainSearchCreateFromAttributes(kcRef(target), GENERIC_PASSWORD_CLASS, ptr(list), ptr(searchOut));
  void [svc, attr, list].length;
  if (created === ERR_SEC_ITEM_NOT_FOUND) return [];
  if (created !== 0) throw new KeychainFfiError("search", created);
  const search = searchOut[0]!;
  const accounts: string[] = [];
  try {
    for (;;) {
      const itemOut = outPtr();
      const next = sec.SecKeychainSearchCopyNext(search, ptr(itemOut));
      if (next === ERR_SEC_ITEM_NOT_FOUND) break;
      if (next !== 0) throw new KeychainFfiError("search next", next);
      const item = itemOut[0]!;
      try {
        // The API fills `data`/`length` of the attribute we name, allocating; FreeContent releases it.
        const want = Buffer.alloc(16);
        want.writeUInt32LE(ACCOUNT_ATTR, 0);
        const wantList = Buffer.alloc(16);
        wantList.writeUInt32LE(1, 0);
        wantList.writeBigUInt64LE(BigInt(ptr(want)), 8);
        const copied = sec.SecKeychainItemCopyContent(item, null, ptr(wantList), null, null);
        // An item whose attributes cannot be read is not listed (nothing can be done with it anyway).
        if (copied !== 0) continue;
        const length = want.readUInt32LE(4);
        const data = want.readBigUInt64LE(8);
        // A heap address (never a tagged pointer), as in `find`.
        accounts.push(length === 0 || data === 0n ? "" : Buffer.from(toArrayBuffer(Number(data) as never, 0, length)).toString("utf8"));
        sec.SecKeychainItemFreeContent(BigInt(ptr(wantList)), 0n);
        void [want, wantList].length;
      } finally {
        release(item);
      }
    }
  } finally {
    release(search);
  }
  return accounts;
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

/** An access object (`SecAccessRef`) built ONCE and reused for every item it is added with. */
export interface KeychainAccess {
  readonly ref: Ref;
  release(): void;
}

/**
 * A `SecAccessRef` whose decrypt entry names exactly `trustedApplications` (`null` = the calling process's
 * own executable), each recorded by its designated requirement. Built BEFORE any item is touched, so a
 * failure here (a missing application path) costs nothing; the caller releases it.
 */
export function createKeychainAccess(description: string, trustedApplications: readonly (string | null)[]): KeychainAccess {
  const { cf, sec } = L();
  const apps: Ref[] = [];
  let array: Ref = 0n;
  let label: Ref = 0n;
  try {
    for (const path of trustedApplications) {
      const out = outPtr();
      const cpath = path === null ? null : cstr(path);
      const status = sec.SecTrustedApplicationCreateFromPath(cpath, ptr(out));
      void cpath?.length; // keep the C string alive past the call
      if (status !== 0) throw new KeychainFfiError("trusted application", status);
      apps.push(out[0]!);
    }
    const values = new BigUint64Array(apps);
    // No callbacks: the array does not retain its values, and they are released below after `access`
    // (which retains what it needs) is created.
    array = BigInt(cf.CFArrayCreate(0n, apps.length === 0 ? null : ptr(values), apps.length, 0n));
    void values.length;
    label = cfString(description);
    const accessOut = outPtr();
    const created = sec.SecAccessCreate(label, array, ptr(accessOut));
    if (created !== 0) throw new KeychainFfiError("access", created);
    const ref = accessOut[0]!;
    let released = false;
    return { ref, release: () => { if (!released) { released = true; release(ref); } } };
  } finally {
    release(label);
    release(array);
    for (const app of apps) release(app);
  }
}

/**
 * Creates a generic password with `access` as its initial ACL. Refuses typed (`ERR_SEC_DUPLICATE_ITEM`)
 * when the item exists — the caller deletes first. The item carries the same attributes a
 * `Bun.secrets.set` item does (service, account, label = service), so `Bun.secrets` and the Swift
 * `SecItemCopyMatching` reader both find it.
 */
export function addGenericPassword(target: KeychainTarget, item: { service: string; account: string; value: string; access: KeychainAccess }): void {
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
  const status = L().sec.SecKeychainItemCreateFromContent(GENERIC_PASSWORD_CLASS, ptr(list), data.length, ptr(data), kcRef(target), item.access.ref, ptr(itemOut));
  // The buffers above are reachable only through raw addresses the call read; keep every one alive until
  // it has returned, so no collection can move or free them mid-call.
  void [svc, acct, attrs, list, data].length;
  if (status !== 0) throw new KeychainFfiError("create", status, item.account);
  release(itemOut[0]!);
}

/** `createKeychainAccess` + `addGenericPassword` for one item (tests; one-off items). */
export function addGenericPasswordWithAccess(target: KeychainTarget, item: { service: string; account: string; value: string; trustedApplications: readonly (string | null)[] }): void {
  const access = createKeychainAccess(item.account, item.trustedApplications);
  try {
    addGenericPassword(target, { service: item.service, account: item.account, value: item.value, access });
  } finally {
    access.release();
  }
}

/**
 * Is the keychain UNLOCKED (`kSecUnlockStateStatus`)? `null` = the user's default keychain. A read of an
 * item's DATA from a locked keychain blocks on an unlock dialog — MEASURED 2026-09-27 to do so even with
 * user interaction disabled (below) — so a caller that will read data checks this first and skips when it
 * answers `false`. Locating an item (no data) on a locked keychain was measured silent.
 */
export function keychainUnlocked(target: KeychainTarget): boolean {
  const { sec } = L();
  let ref = kcRef(target);
  let owned = false;
  if (ref === 0n) {
    const out = outPtr();
    const status = sec.SecKeychainCopyDefault(ptr(out));
    if (status !== 0) throw new KeychainFfiError("default keychain", status);
    ref = out[0]!;
    owned = true;
  }
  try {
    const state = new Uint32Array(1);
    const status = sec.SecKeychainGetStatus(ref, ptr(state));
    if (status !== 0) throw new KeychainFfiError("status", status);
    return (state[0]! & 1) !== 0;
  } finally {
    if (owned) release(ref);
  }
}

/**
 * Runs `fn` with the keychain's user interaction DISABLED (`SecKeychainSetUserInteractionAllowed(false)`),
 * restoring the previous setting after — belt and braces for the presence probes and the boot migration.
 * It is NOT a complete guard: a DATA read of a locked keychain still blocked on its unlock dialog when
 * measured, which is why `keychainUnlocked` exists and the data-reading callers check it first. The setting is
 * process-wide, so `fn` must be synchronous (every call in this file is): nothing else can run while it is
 * off.
 */
export function withKeychainUserInteractionDisabled<T>(fn: () => T): T {
  const { sec } = L();
  const was = new Uint8Array(1);
  const got = sec.SecKeychainGetUserInteractionAllowed(ptr(was));
  sec.SecKeychainSetUserInteractionAllowed(false);
  try {
    return fn();
  } finally {
    sec.SecKeychainSetUserInteractionAllowed(got === 0 ? was[0] !== 0 : true);
  }
}

/** `errSecInteractionNotAllowed`: an operation that needed UI while interaction was disabled. */
export const ERR_SEC_INTERACTION_NOT_ALLOWED = -25308;

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
