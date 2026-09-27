// WS-27: the credential ACL migration (`auth/credential-acl.ts`) and the attributes-only enumeration under
// it — against a THROWAWAY keychain FILE only (`security create-keychain` in a temp dir, deleted after),
// never the login keychain, never `com.winter.core*`. Every item is created by this test process; an "old
// Always Allow grant" is simulated by creating the item with Calculator in its decrypt entry too. ACLs are
// inspected with `security dump-keychain -a`, which prints access lists without decrypting anything.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialAclMarkerPath, isCredentialAccount, migrateCredentialAcl, prepareCredentialAccess, recoverCredentialShadows, REAL_CREDENTIAL_KEYCHAIN_OPS, runCredentialMigration,
  type CredentialKeychain, type CredentialKeychainOps,
} from "../../src/auth/credential-acl";
import {
  addGenericPasswordWithAccess, deleteGenericPassword, ERR_SEC_INTERACTION_NOT_ALLOWED, genericPasswordPresent, KeychainFfiError, listGenericPasswordAccounts, openKeychainFile,
  readGenericPassword, readGenericPasswordBytes, withKeychainUserInteractionDisabled, type KeychainFile,
} from "../../src/auth/keychain-ffi";

const SERVICE = "ws27.credential-acl.test";
const OTHER_SERVICE = "ws27.credential-acl.other";
const PASSWORD = "ws27-throwaway";
const CALCULATOR = "/System/Applications/Calculator.app";
const darwin = process.platform === "darwin";

let dir: string;
let kcPath: string;
let kc: KeychainFile;

/** One `dump-keychain -a` (slow: call once per group of assertions). */
function dump(): string {
  return Bun.spawnSync(["security", "dump-keychain", "-a", kcPath]).stdout.toString();
}

/** The access-list block of one account's item in a dump. */
function aclIn(text: string, account: string, service = SERVICE): string {
  return text.split("keychain: ").find((b) => b.includes(`"acct"<blob>="${account}"`) && b.includes(`"svce"<blob>="${service}"`)) ?? "";
}

function aclOf(account: string, service = SERVICE): string {
  return aclIn(dump(), account, service);
}

/** Keychain-file operations are slow (tens of ms each); the default 5 s is not enough for a whole seed. */
const SLOW = 120_000;

const CREDENTIALS = ["admin-token", "anthropic:console", "exa-api-key", "mcp-oauth-client-secret:abc", "mcp-oauth:abc", "openai:default"] as const;

/** Seeds the credential items (plus the two app-read tokens, and one item in another service), each with an
 *  "Always Allow" grant for Calculator standing in for an older runtime binary. */
function seed(): void {
  for (const name of [...CREDENTIALS, "harness-token", "remote-token"]) {
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: name, value: `v-${name}`, trustedApplications: [null, CALCULATOR] });
  }
  addGenericPasswordWithAccess(kc, { service: OTHER_SERVICE, account: "openai:default", value: "v-other", trustedApplications: [null, CALCULATOR] });
}

function clean(): void {
  for (const service of [SERVICE, OTHER_SERVICE]) {
    for (const account of listGenericPasswordAccounts(kc, service)) deleteGenericPassword(kc, service, account);
  }
}

type Failure = { op: "read" | "add" | "remove"; account: string; status?: number; times?: number };

/** A keychain handle whose calls fail on cue (each failure `times` times, default always). `onAdd` runs
 *  after each successful add (a test's way to land a concurrent write at an exact point). */
function keychainWith(failures: Failure[] = [], logs?: string[], onAdd?: (account: string) => void): CredentialKeychain {
  const left = failures.map((f) => ({ ...f, times: f.times ?? Number.POSITIVE_INFINITY }));
  const trip = (op: Failure["op"], account: string): void => {
    const f = left.find((x) => x.op === op && x.account === account && x.times > 0);
    if (f === undefined) return;
    f.times -= 1;
    throw new KeychainFfiError(op, f.status ?? -25293, account);
  };
  const ops: CredentialKeychainOps = {
    ...REAL_CREDENTIAL_KEYCHAIN_OPS,
    read(target, service, account) { trip("read", account); return REAL_CREDENTIAL_KEYCHAIN_OPS.read(target, service, account); },
    readBytes(target, service, account) { trip("read", account); return REAL_CREDENTIAL_KEYCHAIN_OPS.readBytes(target, service, account); },
    add(target, item) { trip("add", item.account); REAL_CREDENTIAL_KEYCHAIN_OPS.add(target, item); onAdd?.(item.account); },
    remove(target, service, account) { trip("remove", account); return REAL_CREDENTIAL_KEYCHAIN_OPS.remove(target, service, account); },
  };
  return { keychain: kc, service: SERVICE, ops, ...(logs !== undefined ? { log: (l: string) => logs.push(l) } : {}) };
}

const SELF = "identifier \"test-self\"";

function migrate(k: CredentialKeychain, home: string, requirement = SELF) {
  const access = prepareCredentialAccess(k);
  try {
    return withKeychainUserInteractionDisabled(() => migrateCredentialAcl(k, access, home, requirement));
  } finally {
    access?.release();
  }
}

function recover(k: CredentialKeychain, dropShadowsBesideOriginals: boolean): string[] {
  const access = prepareCredentialAccess(k);
  try {
    return withKeychainUserInteractionDisabled(() => recoverCredentialShadows(k, access, { dropShadowsBesideOriginals }));
  } finally {
    access?.release();
  }
}

test("which accounts are credential items", () => {
  expect(isCredentialAccount("openai:default")).toBe(true);
  expect(isCredentialAccount("admin-token")).toBe(true);
  expect(isCredentialAccount("mcp-oauth-client:x")).toBe(true);
  expect(isCredentialAccount("harness-token")).toBe(false);
  expect(isCredentialAccount("remote-token")).toBe(false);
  expect(isCredentialAccount("openai:default.migrating")).toBe(false);
  expect(isCredentialAccount("")).toBe(false);
});

describe.skipIf(!darwin)("the credential ACL migration (throwaway keychain file)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ws27-kc-"));
    kcPath = join(dir, "throwaway.keychain-db");
    const made = Bun.spawnSync(["security", "create-keychain", "-p", PASSWORD, kcPath]);
    if (made.exitCode !== 0) throw new Error(`create-keychain failed: ${made.stderr.toString()}`);
    kc = openKeychainFile(kcPath, PASSWORD);
  });
  afterAll(() => {
    try { kc?.close(); } catch { /* closed */ }
    Bun.spawnSync(["security", "delete-keychain", kcPath]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("enumeration lists one service's accounts WITHOUT decrypting: an item that does not trust this process is listed silently", () => {
    clean();
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "mine", value: "v", trustedApplications: [null] });
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "foreign", value: "v", trustedApplications: [CALCULATOR] });
    addGenericPasswordWithAccess(kc, { service: OTHER_SERVICE, account: "elsewhere", value: "v", trustedApplications: [null] });
    expect(withKeychainUserInteractionDisabled(() => listGenericPasswordAccounts(kc, SERVICE)).sort()).toEqual(["foreign", "mine"]);
    expect(listGenericPasswordAccounts(kc, "ws27.no-such-service")).toEqual([]);
    // The foreign item's DATA is refused with interaction disabled — the path a migration takes to skip it
    let refused: unknown;
    try { withKeychainUserInteractionDisabled(() => readGenericPassword(kc, SERVICE, "foreign")); } catch (err) { refused = err; }
    // (`errSecAuthFailed` on a throwaway file; `errSecInteractionNotAllowed` where a prompt would have been
    // raised.) Either way it throws typed and returns at once — no dialog.
    expect(refused instanceof KeychainFfiError && [-25293, ERR_SEC_INTERACTION_NOT_ALLOWED].includes(refused.status)).toBe(true);
    clean();
  }, SLOW);

  test("migrate: every credential item loses the old grant and keeps its value; the app-read tokens and other services are untouched; a marker; then a no-op", () => {
    clean();
    seed();
    const home = mkdtempSync(join(dir, "home-"));
    const logs: string[] = [];
    const outcome = migrate(keychainWith([], logs), home);
    expect(outcome).toEqual({ kind: "migrated", names: [...CREDENTIALS].sort(), skipped: [] });
    const after = dump();
    for (const name of CREDENTIALS) {
      expect(readGenericPassword(kc, SERVICE, name)).toBe(`v-${name}`);
      expect(aclIn(after, name)).toContain("decrypt");
      expect(aclIn(after, name)).not.toContain(CALCULATOR);
      expect(genericPasswordPresent(kc, SERVICE, `${name}.migrating`)).toBe(false);
    }
    expect(aclIn(after, "harness-token")).toContain(CALCULATOR);
    expect(aclIn(after, "remote-token")).toContain(CALCULATOR);
    expect(aclIn(after, "openai:default", OTHER_SERVICE)).toContain(CALCULATOR);
    expect(JSON.parse(readFileSync(credentialAclMarkerPath(home), "utf8"))).toMatchObject({ v: 2, service: SERVICE, requirement: SELF, migrated: CREDENTIALS.length, skipped: 0 });
    expect(logs.join("\n")).not.toContain("v-");
    expect(migrate(keychainWith(), home)).toEqual({ kind: "current" });
    // Another service's marker is not this one's; nor is another binary's (a differently signed winter-core).
    expect(migrateCredentialAcl({ ...keychainWith(), service: OTHER_SERVICE }, undefined, home, SELF)).toMatchObject({ kind: "failed", reason: "no access list" });
    expect(migrate(keychainWith(), home, "identifier \"someone-else\"")).toMatchObject({ kind: "migrated", names: [...CREDENTIALS].sort() });
    clean();
  }, SLOW);

  test("a read refused (an item this process may not read silently) is skipped before anything is written, and counted", () => {
    clean();
    seed();
    const home = mkdtempSync(join(dir, "home-"));
    const logs: string[] = [];
    const outcome = migrate(keychainWith([{ op: "read", account: "exa-api-key", status: ERR_SEC_INTERACTION_NOT_ALLOWED }], logs), home);
    expect(outcome).toMatchObject({ kind: "migrated", skipped: ["exa-api-key"] });
    expect(aclOf("exa-api-key")).toContain(CALCULATOR);
    expect(genericPasswordPresent(kc, SERVICE, "exa-api-key.migrating")).toBe(false);
    expect(aclOf("openai:default")).not.toContain(CALCULATOR);
    expect(JSON.parse(readFileSync(credentialAclMarkerPath(home), "utf8"))).toMatchObject({ skipped: 1 });
    expect(logs.join("\n")).toContain("exa-api-key kept its old access list");
    clean();
  }, SLOW);

  test("the shadow's add fails → that item is skipped, nothing left behind", () => {
    clean();
    seed();
    const home = mkdtempSync(join(dir, "home-"));
    expect(migrate(keychainWith([{ op: "add", account: "openai:default.migrating" }]), home)).toMatchObject({ kind: "migrated", skipped: ["openai:default"] });
    expect(readGenericPassword(kc, SERVICE, "openai:default")).toBe("v-openai:default");
    expect(aclOf("openai:default")).toContain(CALCULATOR);
    expect(genericPasswordPresent(kc, SERVICE, "openai:default.migrating")).toBe(false);
    clean();
  }, SLOW);

  test("the delete is refused → that item is skipped, its shadow dropped, the original untouched", () => {
    clean();
    seed();
    const home = mkdtempSync(join(dir, "home-"));
    expect(migrate(keychainWith([{ op: "remove", account: "mcp-oauth:abc", status: ERR_SEC_INTERACTION_NOT_ALLOWED }]), home)).toMatchObject({ kind: "migrated", skipped: ["mcp-oauth:abc"] });
    expect(readGenericPassword(kc, SERVICE, "mcp-oauth:abc")).toBe("v-mcp-oauth:abc");
    expect(aclOf("mcp-oauth:abc")).toContain(CALCULATOR);
    expect(genericPasswordPresent(kc, SERVICE, "mcp-oauth:abc.migrating")).toBe(false);
    clean();
  }, SLOW);

  test("the re-add fails AFTER the delete → the value is restored self-only at once, the shadow goes, no marker; the next boot finishes", () => {
    clean();
    seed();
    const home = mkdtempSync(join(dir, "home-"));
    const logs: string[] = [];
    expect(migrate(keychainWith([{ op: "add", account: "anthropic:console", times: 1 }], logs), home)).toMatchObject({ kind: "failed", name: "anthropic:console" });
    expect(readGenericPassword(kc, SERVICE, "anthropic:console")).toBe("v-anthropic:console");
    expect(aclOf("anthropic:console")).not.toContain(CALCULATOR);
    expect(genericPasswordPresent(kc, SERVICE, "anthropic:console.migrating")).toBe(false);
    expect(existsSync(credentialAclMarkerPath(home))).toBe(false);
    expect(logs.join("\n")).toContain("restored self-only");
    // It stopped there: items after it (sorted) still carry the old grant until the next boot.
    expect(aclOf("openai:default")).toContain(CALCULATOR);
    expect(migrate(keychainWith(), home)).toMatchObject({ kind: "migrated" });
    expect(aclOf("openai:default")).not.toContain(CALCULATOR);
    clean();
  }, SLOW);

  test("EVERY add of the original fails → its shadow stays; the pre-lock recovery restores it before anything could read it as missing", () => {
    clean();
    seed();
    const home = mkdtempSync(join(dir, "home-"));
    expect(migrate(keychainWith([{ op: "add", account: "admin-token" }]), home)).toMatchObject({ kind: "failed", name: "admin-token" });
    expect(genericPasswordPresent(kc, SERVICE, "admin-token")).toBe(false);
    expect(readGenericPassword(kc, SERVICE, "admin-token.migrating")).toBe("v-admin-token");
    expect(recover(keychainWith(), false)).toEqual(["admin-token"]);
    expect(readGenericPassword(kc, SERVICE, "admin-token")).toBe("v-admin-token");
    expect(aclOf("admin-token")).not.toContain(CALCULATOR);
    expect(genericPasswordPresent(kc, SERVICE, "admin-token.migrating")).toBe(false);
    clean();
  }, SLOW);

  test("recovery: the restore-only pass never drops a shadow beside its original (an in-flight migration looks like that); the full pass drops it, equal or not (the original is the newer write); app-token shadows are not its business", () => {
    clean();
    for (const [account, value] of [["openai:default", "same"], ["openai:default.migrating", "same"], ["exa-api-key", "value-current"], ["exa-api-key.migrating", "value-shadowed"], ["harness-token.migrating", "h"]] as const) {
      addGenericPasswordWithAccess(kc, { service: SERVICE, account, value, trustedApplications: [null] });
    }
    const logs: string[] = [];
    expect(recover(keychainWith([], logs), false)).toEqual([]);
    expect(genericPasswordPresent(kc, SERVICE, "openai:default.migrating")).toBe(true);
    expect(genericPasswordPresent(kc, SERVICE, "exa-api-key.migrating")).toBe(true);
    expect(recover(keychainWith([], logs), true)).toEqual([]);
    expect(genericPasswordPresent(kc, SERVICE, "openai:default.migrating")).toBe(false);
    // A stale shadow can never resurrect an old value: dropped, the newer original kept.
    expect(genericPasswordPresent(kc, SERVICE, "exa-api-key.migrating")).toBe(false);
    expect(readGenericPassword(kc, SERVICE, "exa-api-key")).toBe("value-current");
    expect(logs.join("\n")).toContain("the stale shadow was dropped");
    expect(logs.join("\n")).not.toContain("value-");
    // The app-token shadow is left for `recoverAppTokenShadows` (it restores with the app's access list).
    expect(genericPasswordPresent(kc, SERVICE, "harness-token.migrating")).toBe(true);
    expect(genericPasswordPresent(kc, SERVICE, "harness-token")).toBe(false);
    clean();
  }, SLOW);

  test("a stale shadow found by the MIGRATION beside its original is dropped too, and the item migrated from the original", () => {
    clean();
    seed();
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "exa-api-key.migrating", value: "value-old", trustedApplications: [null] });
    const home = mkdtempSync(join(dir, "home-"));
    expect(migrate(keychainWith(), home)).toMatchObject({ kind: "migrated", skipped: [] });
    expect(readGenericPassword(kc, SERVICE, "exa-api-key")).toBe("v-exa-api-key");
    expect(genericPasswordPresent(kc, SERVICE, "exa-api-key.migrating")).toBe(false);
    clean();
  }, SLOW);

  test("the original is re-read just before the delete: a write that landed after the shadow skips the item, the new value intact, no shadow left", () => {
    clean();
    seed();
    const home = mkdtempSync(join(dir, "home-"));
    const land = (account: string): void => {
      if (account !== "openai:default.migrating") return;
      deleteGenericPassword(kc, SERVICE, "openai:default");
      addGenericPasswordWithAccess(kc, { service: SERVICE, account: "openai:default", value: "v-rotated", trustedApplications: [null, CALCULATOR] });
    };
    expect(migrate(keychainWith([], undefined, land), home)).toMatchObject({ kind: "migrated", skipped: ["openai:default"] });
    expect(readGenericPassword(kc, SERVICE, "openai:default")).toBe("v-rotated");
    expect(genericPasswordPresent(kc, SERVICE, "openai:default.migrating")).toBe(false);
    clean();
  }, SLOW);

  test("a value that is not valid UTF-8 is skipped and never re-added; the comparison is of raw bytes", () => {
    clean();
    const add = Bun.spawnSync(["security", "add-generic-password", "-s", SERVICE, "-a", "binary:default", "-X", "fffe41", "-A", kcPath]);
    expect(add.exitCode).toBe(0);
    const before = readGenericPasswordBytes(kc, SERVICE, "binary:default");
    expect([...before!]).toEqual([0xff, 0xfe, 0x41]);
    const home = mkdtempSync(join(dir, "home-"));
    const logs: string[] = [];
    expect(migrate(keychainWith([], logs), home)).toMatchObject({ kind: "migrated", names: [], skipped: ["binary:default"] });
    expect([...readGenericPasswordBytes(kc, SERVICE, "binary:default")!]).toEqual([0xff, 0xfe, 0x41]);
    expect(genericPasswordPresent(kc, SERVICE, "binary:default.migrating")).toBe(false);
    expect(logs.join("\n")).toContain("not UTF-8");
    clean();
  }, SLOW);

  test("nothing migrated and something skipped: no marker (the next boot, or another binary, tries again)", () => {
    clean();
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "openai:default", value: "v", trustedApplications: [null] });
    const home = mkdtempSync(join(dir, "home-"));
    const logs: string[] = [];
    expect(migrate(keychainWith([{ op: "read", account: "openai:default", status: ERR_SEC_INTERACTION_NOT_ALLOWED }], logs), home)).toMatchObject({ kind: "migrated", names: [], skipped: ["openai:default"] });
    expect(existsSync(credentialAclMarkerPath(home))).toBe(false);
    expect(logs.join("\n")).toContain("no marker written");
    clean();
  }, SLOW);

  test("the boot pass: when the migration fails with a deleted original it could not restore, a restore-only pass puts it back at once", () => {
    clean();
    seed();
    const home = mkdtempSync(join(dir, "home-"));
    // The migration's own add and its in-process restore both fail; the third add (the restore pass) works.
    const k = keychainWith([{ op: "add", account: "admin-token", times: 2 }]);
    const access = prepareCredentialAccess(k);
    try {
      expect(withKeychainUserInteractionDisabled(() => runCredentialMigration(k, access, home, SELF))).toMatchObject({ kind: "failed", name: "admin-token" });
    } finally { access?.release(); }
    expect(readGenericPassword(kc, SERVICE, "admin-token")).toBe("v-admin-token");
    expect(genericPasswordPresent(kc, SERVICE, "admin-token.migrating")).toBe(false);
    expect(existsSync(credentialAclMarkerPath(home))).toBe(false);
    clean();
  }, SLOW);

  test("a restore the recovery cannot read back is left as found (logged), never thrown", () => {
    clean();
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "openai:default.migrating", value: "v", trustedApplications: [null] });
    const logs: string[] = [];
    expect(recover(keychainWith([{ op: "add", account: "openai:default" }], logs), false)).toEqual([]);
    expect(readGenericPassword(kc, SERVICE, "openai:default.migrating")).toBe("v");
    expect(logs.join("\n")).toContain("could not recover openai:default");
    clean();
  });
});
