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
// every call runs with user interaction disabled, so a read that would need consent fails with
// `errSecInteractionNotAllowed` instead. A skipped item keeps its old ACL (and is counted in the marker).
//
// CRASH SAFETY, per item, the app-token module's sequence with a self-only ACL throughout:
//   1. write a SHADOW `<account>.migrating` holding the value, read it back;
//   2. delete the original; 3. add it back self-only; 4. read it back; 5. delete the shadow.
// A failure before step 2 skips that item (its shadow dropped) and moves on. A failure after it restores
// the value at once, in-process (self-only — the target posture anyway), and stops without the marker, so
// the next boot tries again; if even the restore failed, the shadow stays for recovery.
//
// RECOVERY runs twice per qualifying boot. `recoverCredentialShadows(..., { dropEqualShadows: false })`
// runs BEFORE the boot lock and before `credentialPresenceFrom` — the first read that could treat a
// credential as missing — and only puts back an original that a shadow outlived. That is safe without the
// lock: a lock-holder caught between its delete and its add then meets `errSecDuplicateItem`, reads back
// the same value and carries on. It never drops a shadow beside its original there, because that pair is
// exactly what a lock-holder's in-flight migration looks like. The full pass (`dropEqualShadows: true`)
// runs after the lock, where no one else can be mid-migration.
//
// ONCE. The marker `<home>/migration/credential-acl.json` records the service; the migration is a no-op
// while it matches. It is not keyed on this process's designated requirement: a change of creator (the
// dev daemon moving from `bun` to a compiled `winter-core`) cannot be handled here — the new creator
// cannot read the old one's items silently — and is `dev-keychain-transition.ts`'s job.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_READ_TOKEN_NAMES, APP_TOKEN_SHADOW_SUFFIX, REAL_APP_TOKEN_KEYCHAIN_OPS, type AppTokenKeychainOps } from "./app-token-acl";
import { ERR_SEC_DUPLICATE_ITEM, KeychainFfiError, listGenericPasswordAccounts, type KeychainAccess, type KeychainTarget } from "./keychain-ffi";

export const CREDENTIAL_ACL_MARKER_VERSION = 1;

export function credentialAclMarkerPath(home: string): string {
  return join(home, "migration", "credential-acl.json");
}

/** The Keychain calls this module makes: the app-token set plus the attributes-only enumeration. */
export interface CredentialKeychainOps extends AppTokenKeychainOps {
  list(target: KeychainTarget, service: string): string[];
}

export const REAL_CREDENTIAL_KEYCHAIN_OPS: CredentialKeychainOps = { ...REAL_APP_TOKEN_KEYCHAIN_OPS, list: listGenericPasswordAccounts };

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

/** Adds `value` at `account` self-only and reads it back; an item that is already there with the same
 *  value (someone restored it first) counts as done. Throws otherwise. */
function putBack(kc: CredentialKeychain, access: KeychainAccess, account: string, value: string): void {
  const ops = opsOf(kc);
  try {
    ops.add(kc.keychain, { service: kc.service, account, value, access });
  } catch (err) {
    if (!(err instanceof KeychainFfiError && err.status === ERR_SEC_DUPLICATE_ITEM)) throw err;
  }
  if (ops.read(kc.keychain, kc.service, account) !== value) throw new KeychainFfiError("verify", -1, account);
}

/**
 * Finishes what an interrupted migration (or dev transition) left: an original missing beside its shadow is
 * put back from the shadow, self-only, and the shadow dropped. With `dropEqualShadows`, a shadow beside an
 * original holding the same value is dropped too; a differing pair is always kept and logged. The app-read
 * tokens' shadows are `app-token-acl.ts`'s. Returns the accounts it restored. Never throws.
 */
export function recoverCredentialShadows(kc: CredentialKeychain, access: KeychainAccess | undefined, opts: { dropEqualShadows: boolean }): string[] {
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
    if (!isCredentialAccount(name)) continue;
    try {
      const value = ops.read(kc.keychain, kc.service, shadow);
      if (value === null || value === "") {
        kc.log?.(`keychain: ${shadow} holds no value — left as found`);
        continue;
      }
      if (ops.present(kc.keychain, kc.service, name)) {
        if (!opts.dropEqualShadows) continue;
        if (ops.read(kc.keychain, kc.service, name) === value) ops.remove(kc.keychain, kc.service, shadow);
        else kc.log?.(`keychain: ${shadow} and ${name} hold DIFFERENT values — both kept; remove the shadow once ${name} is known good`);
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

/** Writes the marker atomically (0600). Also the dev transition's, once every item landed under its new creator. */
export function writeCredentialAclMarker(home: string, service: string, counts: { migrated: number; skipped: number }): void {
  const next: Marker = { v: CREDENTIAL_ACL_MARKER_VERSION, service, migratedAt: new Date().toISOString(), ...counts };
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
 * AFTER the lock, before anything reads or refreshes a credential: re-create every credential item
 * self-only (see the header). A no-op once the marker records this service. Never throws.
 */
export function migrateCredentialAcl(kc: CredentialKeychain, access: KeychainAccess | undefined, home: string): CredentialAclOutcome {
  const ops = opsOf(kc);
  const marker = readMarker(home);
  if (marker !== undefined && marker.service === kc.service) return { kind: "current" };
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
    let value: string | null = null;
    let shadowWritten = false;
    let originalDeleted = false;
    try {
      // Read FIRST: an item this process may not read silently fails here (interaction is disabled) and is
      // skipped before anything is written.
      value = ops.read(kc.keychain, kc.service, name);
      if (value === null || value === "") continue; // gone, or a blanked (absent) slot: nothing to protect
      // 1. The shadow. One from an older crash with a different value is not ours to overwrite.
      if (ops.present(kc.keychain, kc.service, shadow)) {
        if (ops.read(kc.keychain, kc.service, shadow) !== value) throw new KeychainFfiError("an older shadow with a different value", -1, shadow);
        ops.remove(kc.keychain, kc.service, shadow);
      }
      ops.add(kc.keychain, { service: kc.service, account: shadow, value, access });
      shadowWritten = true;
      if (ops.read(kc.keychain, kc.service, shadow) !== value) throw new KeychainFfiError("verify shadow", -1, shadow);
      // 2. Delete. A delete that needs consent fails here (interaction disabled): still before the delete.
      ops.remove(kc.keychain, kc.service, name);
      originalDeleted = true;
      // 3–4. Re-add self-only, read back.
      putBack(kc, access, name, value);
      // 5. The shadow's job is done (`false` when a second daemon's pre-lock recovery dropped it first).
      ops.remove(kc.keychain, kc.service, shadow);
      done.push(name);
    } catch (err) {
      const reason = describe(err);
      if (!originalDeleted) {
        if (shadowWritten) {
          try { ops.remove(kc.keychain, kc.service, shadow); } catch { /* recovery drops an equal shadow next boot */ }
        }
        skipped.push(name);
        kc.log?.(`keychain: ${name} kept its old access list (${reason})`);
        continue;
      }
      // Never leave the boot without the credential.
      let restored = false;
      try {
        if (!ops.present(kc.keychain, kc.service, name) || ops.read(kc.keychain, kc.service, name) !== value) putBack(kc, access, name, value!);
        restored = true;
      } catch { /* the shadow stays for the next boot */ }
      if (restored) {
        try { ops.remove(kc.keychain, kc.service, shadow); } catch { /* recovery drops an equal shadow next boot */ }
        kc.log?.(`keychain: ${name} could not be re-created (${reason}) — restored self-only; the migration stops here and runs again next boot`);
      } else {
        kc.log?.(`keychain: ${name} could not be restored (${reason}) — its shadow stays for the next boot to restore`);
      }
      return { kind: "failed", name, reason };
    }
  }
  writeCredentialAclMarker(home, kc.service, { migrated: done.length, skipped: skipped.length });
  kc.log?.(`keychain: ${done.length} credential item${done.length === 1 ? "" : "s"} now trust only this process${skipped.length > 0 ? ` (${skipped.length} kept their old access list: ${skipped.join(", ")})` : ""}`);
  return { kind: "migrated", names: done, skipped };
}
