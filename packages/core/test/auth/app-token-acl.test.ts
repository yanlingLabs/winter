// WS-25 §7 B: the app-token ACL migration and the Keychain FFI under it — against a THROWAWAY keychain
// FILE only (`security create-keychain` in a temp dir, deleted after; measured 2026-09-27 not to touch the
// user's search list). Never the login keychain, never `com.winter.core*`. Every item here is created by
// this test process, so no read below can raise a consent prompt; ACLs are inspected with
// `security dump-keychain -a`, which prints access lists without decrypting anything.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appTokenAclBootTarget, appTokenAclMarkerPath, enclosingAppBundle, migrateAppTokenAcl, recoverAppTokenShadows, trustedAppBundlesFor, type AppTokenAclTarget } from "../../src/auth/app-token-acl";
import { addGenericPasswordWithAccess, deleteGenericPassword, genericPasswordPresent, openKeychainFile, readGenericPassword, ERR_SEC_DUPLICATE_ITEM, KeychainFfiError, type KeychainFile } from "../../src/auth/keychain-ffi";

const SERVICE = "ws25.app-token-acl.test";
const PASSWORD = "ws25-throwaway";
const CALCULATOR = "/System/Applications/Calculator.app";
const CHESS = "/System/Applications/Chess.app";
const darwin = process.platform === "darwin";

let dir: string;
let kcPath: string;
let kc: KeychainFile;

function dumpAcl(): string {
  return Bun.spawnSync(["security", "dump-keychain", "-a", kcPath]).stdout.toString();
}

/** The access-list block of one account's item in `dump-keychain -a`. */
function aclOf(account: string): string {
  const dump = dumpAcl();
  const at = dump.indexOf(`"acct"<blob>="${account}"`);
  if (at < 0) return "";
  const next = dump.indexOf("keychain: ", at);
  return dump.slice(at, next < 0 ? undefined : next);
}

function target(home: string, apps: string[]): AppTokenAclTarget {
  return { keychain: kc, service: SERVICE, apps, self: process.execPath, home };
}

describe.skipIf(!darwin)("the Keychain FFI (throwaway keychain file)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ws25-kc-"));
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

  test("add with an explicit ACL, find without decrypting, read, delete; a duplicate refuses typed", () => {
    expect(genericPasswordPresent(kc, SERVICE, "probe")).toBe(false);
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "probe", value: "v-1", trustedApplications: [null, CALCULATOR] });
    expect(genericPasswordPresent(kc, SERVICE, "probe")).toBe(true);
    expect(readGenericPassword(kc, SERVICE, "probe")).toBe("v-1");
    // The decrypt entry names this process AND the app, each by its designated requirement; there is no
    // partition-id entry (the check that made a dev app's "Always Allow" ask for the password).
    const acl = aclOf("probe");
    expect(acl).toContain("decrypt");
    expect(acl).toContain(CALCULATOR);
    expect(acl).toContain('identifier "com.apple.calculator"');
    expect(acl).not.toContain("partition_id");
    let dup: unknown;
    try { addGenericPasswordWithAccess(kc, { service: SERVICE, account: "probe", value: "v-2", trustedApplications: [null] }); } catch (err) { dup = err; }
    expect(dup instanceof KeychainFfiError && dup.status === ERR_SEC_DUPLICATE_ITEM).toBe(true);
    expect(deleteGenericPassword(kc, SERVICE, "probe")).toBe(true);
    expect(deleteGenericPassword(kc, SERVICE, "probe")).toBe(false);
    expect(readGenericPassword(kc, SERVICE, "probe")).toBeNull();
  });

  test("presence never decrypts: an item whose ACL does NOT trust this process is still found, silently (the doctor's count)", () => {
    // Were the probe to request the data, this item (decryptable by Calculator alone) would raise a consent
    // dialog and the call would block; `winter doctor`'s legacy count rides exactly this probe.
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "foreign", value: "v", trustedApplications: [CALCULATOR] });
    expect(genericPasswordPresent(kc, SERVICE, "foreign")).toBe(true);
    expect(genericPasswordPresent(kc, SERVICE, "absent")).toBe(false);
    deleteGenericPassword(kc, SERVICE, "foreign");
  });

  test("migrate: both app-read tokens re-created with the app in their ACL, the same values, a marker; then a no-op", () => {
    const home = mkdtempSync(join(dir, "home-"));
    // As `ensureTokens` leaves them: created by this process, trusting only it.
    for (const [name, value] of [["harness-token", "h-1"], ["remote-token", "r-1"], ["admin-token", "a-1"]] as const) {
      addGenericPasswordWithAccess(kc, { service: SERVICE, account: name, value, trustedApplications: [null] });
    }
    expect(aclOf("harness-token")).not.toContain(CALCULATOR);
    const outcome = migrateAppTokenAcl(target(home, [CALCULATOR]), { "harness-token": "h-1", "remote-token": "r-1", "admin-token": "a-1" });
    expect(outcome).toEqual({ kind: "migrated", names: ["harness-token", "remote-token"] });
    expect(readGenericPassword(kc, SERVICE, "harness-token")).toBe("h-1");
    expect(readGenericPassword(kc, SERVICE, "remote-token")).toBe("r-1");
    expect(aclOf("harness-token")).toContain(CALCULATOR);
    expect(aclOf("remote-token")).toContain(CALCULATOR);
    // The admin token is the CLI's (the daemon's own binary): untouched.
    expect(aclOf("admin-token")).not.toContain(CALCULATOR);
    expect(genericPasswordPresent(kc, SERVICE, "harness-token.migrating")).toBe(false);
    expect(genericPasswordPresent(kc, SERVICE, "remote-token.migrating")).toBe(false);
    const marker = JSON.parse(readFileSync(appTokenAclMarkerPath(home), "utf8"));
    expect(marker).toMatchObject({ v: 1, service: SERVICE, apps: [CALCULATOR] });
    // Idempotent: the same trusted set is a no-op.
    expect(migrateAppTokenAcl(target(home, [CALCULATOR]), { "harness-token": "h-1", "remote-token": "r-1" })).toEqual({ kind: "current" });
    // A new trusted set (the app moved, a new dev build) re-runs, keeping the values.
    expect(migrateAppTokenAcl(target(home, [CHESS]), { "harness-token": "h-1", "remote-token": "r-1" })).toMatchObject({ kind: "migrated" });
    expect(aclOf("harness-token")).toContain(CHESS);
    expect(aclOf("harness-token")).not.toContain(CALCULATOR);
    expect(readGenericPassword(kc, SERVICE, "harness-token")).toBe("h-1");
    for (const n of ["harness-token", "remote-token", "admin-token"]) deleteGenericPassword(kc, SERVICE, n);
  });

  test("recovery: a shadow that outlived its original (a crash after the delete) restores it — before ensureTokens can mint a new one", () => {
    const home = mkdtempSync(join(dir, "home-"));
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "harness-token.migrating", value: "h-shadow", trustedApplications: [null] });
    expect(recoverAppTokenShadows(target(home, [CALCULATOR]))).toEqual(["harness-token"]);
    expect(readGenericPassword(kc, SERVICE, "harness-token")).toBe("h-shadow");
    expect(aclOf("harness-token")).toContain(CALCULATOR);
    expect(genericPasswordPresent(kc, SERVICE, "harness-token.migrating")).toBe(false);
    // No marker: the next migration still runs (and finds the ACL it wants, re-creating it harmlessly).
    expect(existsSync(appTokenAclMarkerPath(home))).toBe(false);
    deleteGenericPassword(kc, SERVICE, "harness-token");
  });

  test("recovery: a shadow beside its original (a crash before the delete) is dropped, the original untouched", () => {
    const home = mkdtempSync(join(dir, "home-"));
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "remote-token", value: "r-orig", trustedApplications: [null] });
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "remote-token.migrating", value: "r-orig", trustedApplications: [null] });
    expect(recoverAppTokenShadows(target(home, [CALCULATOR]))).toEqual([]);
    expect(readGenericPassword(kc, SERVICE, "remote-token")).toBe("r-orig");
    expect(genericPasswordPresent(kc, SERVICE, "remote-token.migrating")).toBe(false);
    expect(aclOf("remote-token")).not.toContain(CALCULATOR);
    deleteGenericPassword(kc, SERVICE, "remote-token");
  });

  test("a failed migration writes no marker and says which item kept its old ACL", () => {
    const home = mkdtempSync(join(dir, "home-"));
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "harness-token", value: "h-1", trustedApplications: [null] });
    const logs: string[] = [];
    // A trusted application that does not exist cannot be named: refused before any item is touched.
    const outcome = migrateAppTokenAcl({ ...target(home, [join(dir, "no-such.app")]), log: (l) => logs.push(l) }, { "harness-token": "h-1" });
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(existsSync(appTokenAclMarkerPath(home))).toBe(false);
    expect(logs.join("\n")).toContain("left as they are");
    expect(readGenericPassword(kc, SERVICE, "harness-token")).toBe("h-1");
    expect(genericPasswordPresent(kc, SERVICE, "harness-token.migrating")).toBe(false);
    // A failure AFTER the delete (an app that vanished between the check and the add — forced here by
    // deleting the original and leaving only the shadow, which is that state exactly) is healed by the
    // next boot's recovery, and the log never carries a value.
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "harness-token.migrating", value: "h-1", trustedApplications: [null] });
    deleteGenericPassword(kc, SERVICE, "harness-token");
    expect(recoverAppTokenShadows({ ...target(home, [CALCULATOR]), log: (l) => logs.push(l) })).toEqual(["harness-token"]);
    expect(readGenericPassword(kc, SERVICE, "harness-token")).toBe("h-1");
    expect(logs.join("\n")).not.toContain("h-1");
    deleteGenericPassword(kc, SERVICE, "harness-token");
  });
});

describe("which app bundles are trusted", () => {
  test("dist: only the bundle winter-core itself lives in", () => {
    expect(enclosingAppBundle("/Applications/Winter.app/Contents/Resources/winter-core")).toBe("/Applications/Winter.app");
    expect(enclosingAppBundle("/usr/local/bin/winter-core")).toBeUndefined();
    const lookup = (): string[] => ["/Users/x/out/release/0.120.0/Winter.app"];
    expect(trustedAppBundlesFor({ profile: "dist", executable: "/Applications/Winter.app/Contents/Resources/winter-core", lookup })).toEqual(["/Applications/Winter.app"]);
    // A dist daemon outside an app bundle trusts nothing more — never a Launch Services guess.
    expect(trustedAppBundlesFor({ profile: "dist", executable: "/opt/dist/winter-core", lookup })).toEqual([]);
  });

  test("dev: every Winter Dev bundle Launch Services knows that still exists", () => {
    const seen: string[] = [];
    const lookup = (id: string): string[] => { seen.push(id); return ["/dd/a/Winter Dev.app", "/dd/gone/Winter Dev.app"]; };
    const bundles = trustedAppBundlesFor({ profile: "dev", executable: "/opt/homebrew/bin/bun", lookup, exists: (p) => !p.includes("gone") });
    expect(seen).toEqual(["com.winter.app.dev"]);
    expect(bundles).toEqual(["/dd/a/Winter Dev.app"]);
  });

  test("the boot target: nothing to trust is a skip with one line; a dev build found is the default keychain + this process", () => {
    const logs: string[] = [];
    // `bun` (this test) is not inside an app bundle, so a dist profile has nobody to grant the tokens to.
    expect(appTokenAclBootTarget({ home: "/h", service: "svc", profile: "dist", log: (l) => logs.push(l), lookup: () => [CALCULATOR] })).toBeUndefined();
    expect(logs).toHaveLength(1);
    const dev = appTokenAclBootTarget({ home: "/h", service: "svc", profile: "dev", log: (l) => logs.push(l), lookup: () => [CALCULATOR] });
    expect(dev).toMatchObject({ keychain: null, service: "svc", apps: [CALCULATOR], home: "/h" });
  });
});
