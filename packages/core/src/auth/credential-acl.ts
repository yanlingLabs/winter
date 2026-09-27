// WS-27: every Keychain item the daemon owns — except the two the app reads — trusts `winter-core` alone.
//
// THE PROBLEM. Before WS-25 §7, a code session's `winter` child read its provider key, the Exa key and its
// MCP sign-ins from the Keychain itself, and each read by a binary the item did not name raised a consent
// prompt; "Always Allow" appended that binary to the item's decrypt ACL (and, on a partition-enabled
// keychain, its team to the partition list). Those grants outlive the reason for them: no child reads the
// Keychain any more (`runtime-sdk/host-credentials.ts`), but every older runtime binary the user allowed can
// still read those items silently.
//
// THE FIX. Re-create each item ONCE with an ACL naming only this process (`null` below), which also resets
// the partition list to this process's team (securityd writes it from the creator alone — see
// `app-token-acl.ts`'s header). Changing an existing item's ACL asks for the keychain password, so, as for
// the pairing tokens, the item is deleted and added again by a process it already trusts, which is silent.
//
// WHICH ITEMS. Every generic password under the daemon's service, ENUMERATED WITHOUT DATA
// (`listGenericPasswordAccounts`): the provider slots, the tool keys, the MCP sign-in items, the admin
// token. Never `harness-token`/`remote-token` (the app reads them; `app-token-acl.ts` owns their ACL) and
// never a `.migrating` shadow. An item this process cannot read SILENTLY is skipped, never prompted for:
// every call runs with user interaction disabled, so a read that would need consent fails instead. A value
// that is not valid UTF-8 is skipped too (it could not be written back byte for byte): every comparison
// here is of the stored BYTES, never of a decoded string.
//
// CRASH SAFETY, per item, the app-token module's sequence with a self-only ACL throughout:
//   1. write a SHADOW `<account>.migrating` holding the value, read it back;
//   2. read the original again — a value changed since step 1 (a write that landed meanwhile) skips the
//      item, its shadow dropped; 3. delete the original; 4. add it back self-only; 5. read it back;
//   6. delete the shadow.
// A failure before step 3 skips that item (its shadow dropped) and moves on. A failure after it restores
// the value at once, in-process (self-only — the target posture anyway), and stops without the marker, so
// the next boot tries again; if even the restore failed, the shadow stays for recovery (and the daemon runs
// a restore pass at once, before anything reads credentials).
//
// EXCLUSION. Every pass here runs under `credential-migration-lock.ts`'s lock — NOT the daemon's boot lock,
// which a booting daemon (no socket yet) or a dev transition (no socket at all) cannot hold against a
// second process. Without the lock, nothing runs.
//
// RECOVERY. `recoverCredentialShadows(..., { dropShadowsBesideOriginals: false })` runs early, before
// `credentialPresenceFrom` — the first read that could treat a credential as missing — and only puts back
// an original a shadow outlived. The full pass also drops a shadow beside its original: an equal one is
// done; a DIFFERING one is stale, because an original beside a shadow is always the newer write (the
// migration writes the shadow from the original, and every later write goes to the original), so keeping
// it could only ever resurrect an old value. Every credential delete door deletes `<name>.migrating` too.
//
// ONCE. The marker `<home>/migration/credential-acl.json` records the service and this process's designated
// requirement; the migration is a no-op while both match, so a differently signed binary on the same home
// migrates for itself. No marker is written when nothing could be migrated and something was skipped. A
// change of creator the new binary cannot read silently (the dev daemon moving from `bun` to a compiled
// `winter-core`) is `dev-keychain-transition.ts`'s job.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_READ_TOKEN_NAMES, APP_TOKEN_SHADOW_SUFFIX, REAL_APP_TOKEN_KEYCHAIN_OPS, type AppTokenKeychainOps } from "./app-token-acl";
import { ERR_SEC_DUPLICATE_ITEM, KeychainFfiError, listGenericPasswordAccounts, readGenericPasswordBytes, type KeychainAccess, type KeychainTarget } from "./keychain-ffi";

export const CREDENTIAL_ACL_MARKER_VERSION = 2;

export function credentialAclMarkerPath(home: string): string {
  return join(home, "migration", "credential-acl.json");
}

/** The Keychain calls this module makes: the app-token set plus the attributes-only enumeration and the
 *  byte-exact read. */
export interface CredentialKeychainOps extends AppTokenKeychainOps {
  list(target: KeychainTarget, service: string): string[];
  readBytes(target: KeychainTarget, service: string, account: string): Uint8Array | null;
}

export const REAL_CREDENTIAL_KEYCHAIN_OPS: CredentialKeychainOps = { ...REAL_APP_TOKEN_KEYCHAIN_OPS, list: listGenericPasswordAccounts, readBytes: readGenericPasswordBytes };

export interface CredentialKeychain {
  keychain: KeychainTarget;
  /** The daemon's Keychain service (`profile.ts`'s `keychainService()`). */
  service: string;
  ops?: CredentialKeychainOps;
  log?: (line: string) => void;
}

/** An item this module re-creates: anything but the app-read tokens and the migration shadows. */
export function isCredentialAccount(account: string): boolean {
  return account !== "" && !account.endsWith(APP_TOKEN_SHADOW_SUFFIX) && !APP_READ_TOKEN_NAMES.includes(account);
}

function opsOf(kc: CredentialKeychain): CredentialKeychainOps {
  return kc.ops ?? REAL_CREDENTIAL_KEYCHAIN_OPS;
}

function describe(err: unknown): string {
  return err instanceof KeychainFfiError ? `${err.operation}: OSStatus ${err.status}` : err instanceof Error ? err.name : "error";
}

/** A stored value: its exact bytes and their (strict) UTF-8 text, which is what an add writes back. */
export interface StoredValue {
  bytes: Uint8Array;
  text: string;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

export function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  return a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Reads `account` byte-exactly: `null` when absent or empty; throws typed when unreadable or not valid
 *  UTF-8 (an add takes a string, so such a value could not be written back byte for byte). */
export function readStoredValue(kc: CredentialKeychain, account: string): StoredValue | null {
  const bytes = opsOf(kc).readBytes(kc.keychain, kc.service, account);
  if (bytes === null || bytes.length === 0) return null;
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    throw new KeychainFfiError("not UTF-8", -1, account);
  }
  return { bytes, text };
}

/** The self-only access object, built once per boot BEFORE any item is touched. `undefined` (logged) when
 *  it cannot be built — recovery and the migration then do nothing. */
export function prepareCredentialAccess(kc: CredentialKeychain): KeychainAccess | undefined {
  try {
    return opsOf(kc).createAccess("Winter credential", [null]);
  } catch (err) {
    kc.log?.(`keychain: the credential access list could not be built (${describe(err)}) — credential items keep theirs`);
    return undefined;
  }
}

/** Adds `value` at `account` self-only and reads its bytes back; an item already there with the same bytes
 *  (someone restored it first) counts as done. Throws otherwise. */
export function putBack(kc: CredentialKeychain, access: KeychainAccess, account: string, value: StoredValue): void {
  const ops = opsOf(kc);
  try {
    ops.add(kc.keychain, { service: kc.service, account, value: value.text, access });
  } catch (err) {
    if (!(err instanceof KeychainFfiError && err.status === ERR_SEC_DUPLICATE_ITEM)) throw err;
  }
  if (!sameBytes(ops.readBytes(kc.keychain, kc.service, account), value.bytes)) throw new KeychainFfiError("verify", -1, account);
}

/**
 * Finishes what an interrupted migration (or dev transition) left: an original missing beside its shadow is
 * put back from the shadow, self-only, and the shadow dropped. With `dropShadowsBesideOriginals`, a shadow
 * beside its original is dropped too — equal or not for a credential account (see the header: the original is
 * the newer write); a pairing token's DIFFERING pair is kept (either could be what clients hold). The
 * app-read tokens' shadows are `app-token-acl.ts`'s, unless `owns` (default `isCredentialAccount`) says
 * otherwise — the dev transition owns every shadow it wrote. The caller holds the credential migration lock.
 * Returns the accounts it restored. Never throws.
 */
export function recoverCredentialShadows(kc: CredentialKeychain, access: KeychainAccess | undefined, opts: { dropShadowsBesideOriginals: boolean; owns?: (account: string) => boolean }): string[] {
  const owns = opts.owns ?? isCredentialAccount;
  const ops = opsOf(kc);
  const restored: string[] = [];
  let accounts: string[];
  try {
    accounts = ops.list(kc.keychain, kc.service);
  } catch (err) {
    kc.log?.(`keychain: credential migration shadows were not checked (${describe(err)})`);
    return restored;
  }
  for (const shadow of accounts) {
    if (!shadow.endsWith(APP_TOKEN_SHADOW_SUFFIX)) continue;
    const name = shadow.slice(0, -APP_TOKEN_SHADOW_SUFFIX.length);
    if (!owns(name)) continue;
    try {
      const value = readStoredValue(kc, shadow);
      if (value === null) {
        kc.log?.(`keychain: ${shadow} holds no value — left as found`);
        continue;
      }
      if (ops.present(kc.keychain, kc.service, name)) {
        if (!opts.dropShadowsBesideOriginals) continue;
        const same = sameBytes(ops.readBytes(kc.keychain, kc.service, name), value.bytes);
        if (!same && !isCredentialAccount(name)) {
          // A pairing token (the dev transition owns those too): either value could be the one the paired
          // clients hold, so a differing pair is kept, as `app-token-acl.ts` keeps it.
          kc.log?.(`keychain: ${shadow} and ${name} hold DIFFERENT values — both kept; remove the shadow once the paired clients work`);
          continue;
        }
        ops.remove(kc.keychain, kc.service, shadow);
        if (!same) kc.log?.(`keychain: ${shadow} differed from ${name}, which is the newer write — the stale shadow was dropped`);
        continue;
      }
      if (access === undefined) throw new KeychainFfiError("no access list", -1, name);
      putBack(kc, access, name, value);
      ops.remove(kc.keychain, kc.service, shadow);
      restored.push(name);
      kc.log?.(`keychain: restored ${name} from its migration shadow`);
    } catch (err) {
      kc.log?.(`keychain: could not recover ${name} from its migration shadow (${describe(err)}) — left as found`);
    }
  }
  return restored;
}

interface Marker {
  v: number;
  service: string;
  requirement: string;
  migratedAt: string;
  migrated: number;
  skipped: number;
}

function readMarker(home: string): Marker | undefined {
  try {
    const parsed = JSON.parse(readFileSync(credentialAclMarkerPath(home), "utf8")) as Marker;
    return parsed.v === CREDENTIAL_ACL_MARKER_VERSION ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the marker atomically (0600): the service and the designated requirement of the process every item
 *  now trusts. Also the dev transition's child, once every item landed under it. */
export function writeCredentialAclMarker(home: string, service: string, requirement: string, counts: { migrated: number; skipped: number }): void {
  const next: Marker = { v: CREDENTIAL_ACL_MARKER_VERSION, service, requirement, migratedAt: new Date().toISOString(), ...counts };
  const path = credentialAclMarkerPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export type CredentialAclOutcome =
  | { kind: "current" }
  | { kind: "migrated"; names: string[]; skipped: string[] }
  | { kind: "failed"; name: string; reason: string };

/**
 * Under the credential migration lock, before anything reads or refreshes a credential: re-create every
 * credential item self-only (see the header). `requirement` is this process's designated requirement (the
 * marker's key). A no-op once the marker records this service and requirement. Never throws.
 */
export function migrateCredentialAcl(kc: CredentialKeychain, access: KeychainAccess | undefined, home: string, requirement: string): CredentialAclOutcome {
  const ops = opsOf(kc);
  const marker = readMarker(home);
  if (marker !== undefined && marker.service === kc.service && marker.requirement === requirement) return { kind: "current" };
  if (access === undefined) return { kind: "failed", name: "(all)", reason: "no access list" };
  let accounts: string[];
  try {
    accounts = [...new Set(ops.list(kc.keychain, kc.service))].filter(isCredentialAccount).sort();
  } catch (err) {
    const reason = describe(err);
    kc.log?.(`keychain: the credential items were not listed (${reason}) — their access lists are left as they are`);
    return { kind: "failed", name: "(all)", reason };
  }
  const done: string[] = [];
  const skipped: string[] = [];
  for (const name of accounts) {
    const shadow = `${name}${APP_TOKEN_SHADOW_SUFFIX}`;
    let value: StoredValue | null = null;
    let shadowWritten = false;
    let originalDeleted = false;
    try {
      // Read FIRST: an item this process may not read silently (interaction is disabled), or whose value is
      // not valid UTF-8, fails here and is skipped before anything is written.
      value = readStoredValue(kc, name);
      if (value === null) continue; // gone, or a blanked (absent) slot: nothing to protect
      // 1. The shadow. One left beside the original is stale (the original is the newer write): dropped.
      if (ops.present(kc.keychain, kc.service, shadow)) ops.remove(kc.keychain, kc.service, shadow);
      ops.add(kc.keychain, { service: kc.service, account: shadow, value: value.text, access });
      shadowWritten = true;
      if (!sameBytes(ops.readBytes(kc.keychain, kc.service, shadow), value.bytes)) throw new KeychainFfiError("verify shadow", -1, shadow);
      // 2. Still the value the shadow holds? A write that landed since would otherwise be undone.
      if (!sameBytes(ops.readBytes(kc.keychain, kc.service, name), value.bytes)) throw new KeychainFfiError("changed since it was read", -1, name);
      // 3. Delete. A delete that needs consent fails here (interaction disabled): still before the delete. One
      // that finds nothing (the original vanished since the re-read — a removal that landed) stops this item
      // without putting anything back: the removal wins, and the shadow is dropped below.
      if (!ops.remove(kc.keychain, kc.service, name)) throw new KeychainFfiError("vanished before the delete", -1, name);
      originalDeleted = true;
      // 4–5. Re-add self-only, read back.
      putBack(kc, access, name, value);
      // 6. The shadow's job is done.
      ops.remove(kc.keychain, kc.service, shadow);
      done.push(name);
    } catch (err) {
      const reason = describe(err);
      if (!originalDeleted) {
        if (shadowWritten) {
          try { ops.remove(kc.keychain, kc.service, shadow); } catch { /* the next full recovery drops it */ }
        }
        skipped.push(name);
        kc.log?.(`keychain: ${name} kept its old access list (${reason})`);
        continue;
      }
      // Never leave the boot without the credential.
      let restored = false;
      try {
        if (!ops.present(kc.keychain, kc.service, name) || !sameBytes(ops.readBytes(kc.keychain, kc.service, name), value!.bytes)) putBack(kc, access, name, value!);
        restored = true;
      } catch { /* the shadow stays for the restore pass */ }
      if (restored) {
        try { ops.remove(kc.keychain, kc.service, shadow); } catch { /* the next full recovery drops it */ }
        kc.log?.(`keychain: ${name} could not be re-created (${reason}) — restored self-only; the migration stops here and runs again next boot`);
      } else {
        kc.log?.(`keychain: ${name} could not be restored (${reason}) — its shadow stays for the restore pass`);
      }
      return { kind: "failed", name, reason };
    }
  }
  if (done.length === 0 && skipped.length > 0) {
    // Nothing this process could migrate — likely another binary's items. No marker: not "done" for anyone.
    kc.log?.(`keychain: none of the ${skipped.length} credential items could be re-created by this process — no marker written (${skipped.join(", ")})`);
    return { kind: "migrated", names: done, skipped };
  }
  writeCredentialAclMarker(home, kc.service, requirement, { migrated: done.length, skipped: skipped.length });
  kc.log?.(`keychain: ${done.length} credential item${done.length === 1 ? "" : "s"} now trust only this process${skipped.length > 0 ? ` (${skipped.length} kept their old access list: ${skipped.join(", ")})` : ""}`);
  return { kind: "migrated", names: done, skipped };
}

/**
 * The daemon's post-boot-lock pass, under the credential migration lock: the full recovery, the migration,
 * and — when the migration failed — a restore-only pass at once, so an item it deleted but could not put
 * back is restored from its shadow before anything (`ensureTokens`, a session) could read it as missing.
 */
export function runCredentialMigration(kc: CredentialKeychain, access: KeychainAccess | undefined, home: string, requirement: string): CredentialAclOutcome {
  recoverCredentialShadows(kc, access, { dropShadowsBesideOriginals: true });
  const outcome = migrateCredentialAcl(kc, access, home, requirement);
  if (outcome.kind === "failed") recoverCredentialShadows(kc, access, { dropShadowsBesideOriginals: false });
  return outcome;
}
