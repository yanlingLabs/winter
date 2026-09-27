// WS-25 §7 B: the app-token ACL migration and the Keychain FFI under it — against a THROWAWAY keychain
// FILE only (`security create-keychain` in a temp dir, deleted after; measured 2026-09-27 not to touch the
// user's search list). Never the login keychain, never `com.winter.core*`. Every item here is created by
// this test process, so no read below can raise a consent prompt; ACLs are inspected with
// `security dump-keychain -a`, which prints access lists without decrypting anything.
//
// What these tests do NOT prove: that the Mac app then reads without a prompt. That is the ACL's design
// (designated-requirement entries, inspected below) plus the controller's live gate. A throwaway keychain
// is NOT partition-enabled (its blob predates `version_partition`; securityd upgrades only a keychain
// migrating under ~/Library/Keychains), so no item here carries a `partition_id` entry and
// `security set-generic-password-partition-list` is a silent no-op on it (measured 2026-09-27). On the
// login keychain securityd adds one naming the CREATOR's team alone — see `app-token-acl.ts`'s header.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appTokenAclMarkerPath, enclosingAppBundle, migrateAppTokenAcl, prepareAppTokenAccess, recoverAppTokenShadows, REAL_APP_TOKEN_KEYCHAIN_OPS, trustFor, WINTER_TEAM_ID,
  type AppTokenAccess, type AppTokenKeychain, type AppTokenKeychainOps, type AppTokenTrust,
} from "../../src/auth/app-token-acl";
import {
  addGenericPasswordWithAccess, deleteGenericPassword, genericPasswordPresent, openKeychainFile, readGenericPassword, withKeychainUserInteractionDisabled,
  ERR_SEC_DUPLICATE_ITEM, keychainUnlocked, KeychainFfiError, type KeychainFile,
} from "../../src/auth/keychain-ffi";

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

const trust = (...apps: string[]): AppTokenTrust => ({ apps, requirements: ["self", ...apps].sort() });

/** A keychain handle whose `add` fails on cue: `failAdd(account, which)` → throw for that add. */
function keychainWith(opts: { failAdd?: (account: string, wide: boolean) => boolean; logs?: string[] } = {}): { k: AppTokenKeychain; access: (t: AppTokenTrust | undefined) => AppTokenAccess } {
  let wideRef: bigint | undefined;
  const ops: AppTokenKeychainOps = {
    ...REAL_APP_TOKEN_KEYCHAIN_OPS,
    add(target, item) {
      if (opts.failAdd?.(item.account, item.access.ref === wideRef)) throw new KeychainFfiError("create", -25293, item.account);
      REAL_APP_TOKEN_KEYCHAIN_OPS.add(target, item);
    },
  };
  const k: AppTokenKeychain = { keychain: kc, service: SERVICE, ops, ...(opts.logs !== undefined ? { log: (l: string) => opts.logs!.push(l) } : {}) };
  return {
    k,
    access: (t) => {
      const a = prepareAppTokenAccess(k, t);
      wideRef = a.wide?.ref;
      return a;
    },
  };
}

function clean(): void {
  for (const n of ["harness-token", "remote-token", "admin-token"]) {
    deleteGenericPassword(kc, SERVICE, n);
    deleteGenericPassword(kc, SERVICE, `${n}.migrating`);
  }
}

describe.skipIf(!darwin)("the Keychain FFI and the app-token migration (throwaway keychain file)", () => {
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
    // The decrypt entry names this process AND the app, each by its designated requirement. No partition-id
    // entry: this keychain is not partition-enabled (see the header), not something the ACL controls.
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
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "foreign", value: "v", trustedApplications: [CALCULATOR] });
    expect(genericPasswordPresent(kc, SERVICE, "foreign")).toBe(true);
    expect(genericPasswordPresent(kc, SERVICE, "absent")).toBe(false);
    deleteGenericPassword(kc, SERVICE, "foreign");
  });

  test("migrate: ONE access object serves both tokens; same values, a marker; then a no-op; a new requirement set or a minted token re-runs", () => {
    clean();
    const home = mkdtempSync(join(dir, "home-"));
    for (const [name, value] of [["harness-token", "h-1"], ["remote-token", "r-1"], ["admin-token", "a-1"]] as const) {
      addGenericPasswordWithAccess(kc, { service: SERVICE, account: name, value, trustedApplications: [null] });
    }
    const { k, access } = keychainWith();
    const a = access(trust(CALCULATOR));
    try {
      expect(migrateAppTokenAcl(k, a, trust(CALCULATOR), home, { "harness-token": "h-1", "remote-token": "r-1", "admin-token": "a-1" })).toEqual({ kind: "migrated", names: ["harness-token", "remote-token"] });
    } finally { a.release(); }
    expect(readGenericPassword(kc, SERVICE, "harness-token")).toBe("h-1");
    expect(readGenericPassword(kc, SERVICE, "remote-token")).toBe("r-1");
    expect(aclOf("harness-token")).toContain(CALCULATOR);
    expect(aclOf("remote-token")).toContain(CALCULATOR);
    expect(aclOf("admin-token")).not.toContain(CALCULATOR); // the CLI's token: untouched
    expect(genericPasswordPresent(kc, SERVICE, "harness-token.migrating")).toBe(false);
    expect(JSON.parse(readFileSync(appTokenAclMarkerPath(home), "utf8"))).toMatchObject({ v: 2, service: SERVICE, requirements: trust(CALCULATOR).requirements });
    const again = access(trust(CALCULATOR));
    try {
      expect(migrateAppTokenAcl(k, again, trust(CALCULATOR), home, { "harness-token": "h-1", "remote-token": "r-1" })).toEqual({ kind: "current" });
      // A re-minted token carries only the creator's ACL: the same trusted set re-runs for it.
      expect(migrateAppTokenAcl(k, again, trust(CALCULATOR), home, { "harness-token": "h-1", "remote-token": "r-1" }, ["remote-token"])).toMatchObject({ kind: "migrated" });
    } finally { again.release(); }
    const chess = access(trust(CHESS));
    try {
      expect(migrateAppTokenAcl(k, chess, trust(CHESS), home, { "harness-token": "h-1", "remote-token": "r-1" })).toMatchObject({ kind: "migrated" });
    } finally { chess.release(); }
    expect(aclOf("harness-token")).toContain(CHESS);
    expect(aclOf("harness-token")).not.toContain(CALCULATOR);
    expect(readGenericPassword(kc, SERVICE, "harness-token")).toBe("h-1");
    clean();
  });

  test("a partition gap (the creator is not the app's team) is logged at the migration and never re-runs it", () => {
    clean();
    const home = mkdtempSync(join(dir, "home-"));
    for (const [name, value] of [["harness-token", "h-1"], ["remote-token", "r-1"]] as const) {
      addGenericPasswordWithAccess(kc, { service: SERVICE, account: name, value, trustedApplications: [null] });
    }
    const logs: string[] = [];
    const { k, access } = keychainWith({ logs });
    const gap: AppTokenTrust = { ...trust(CALCULATOR), unpartitionedTeams: [WINTER_TEAM_ID] };
    const a = access(gap);
    try {
      expect(migrateAppTokenAcl(k, a, gap, home, { "harness-token": "h-1", "remote-token": "r-1" })).toMatchObject({ kind: "migrated" });
      expect(logs.at(-1)).toContain(`not teamid:${WINTER_TEAM_ID}`);
      // Re-creating cannot widen the partition list (securityd keys it to the creator), and would drop a
      // team the user's "Always Allow" appended — so the same trusted set is current, gap or not.
      expect(migrateAppTokenAcl(k, a, gap, home, { "harness-token": "h-1", "remote-token": "r-1" })).toEqual({ kind: "current" });
    } finally { a.release(); }
    clean();
  });

  test("I1: the wide add fails AFTER the delete → the value is restored at once, self-only; the shadow goes; no marker", () => {
    clean();
    const home = mkdtempSync(join(dir, "home-"));
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "harness-token", value: "h-1", trustedApplications: [null] });
    const logs: string[] = [];
    const { k, access } = keychainWith({ failAdd: (account, wide) => account === "harness-token" && wide, logs });
    const a = access(trust(CALCULATOR));
    try {
      expect(migrateAppTokenAcl(k, a, trust(CALCULATOR), home, { "harness-token": "h-1" })).toMatchObject({ kind: "failed", name: "harness-token" });
    } finally { a.release(); }
    expect(readGenericPassword(kc, SERVICE, "harness-token")).toBe("h-1");
    expect(aclOf("harness-token")).not.toContain(CALCULATOR);
    expect(genericPasswordPresent(kc, SERVICE, "harness-token.migrating")).toBe(false);
    expect(existsSync(appTokenAclMarkerPath(home))).toBe(false);
    expect(logs.join("\n")).toContain("restored with the self-only one");
    expect(logs.join("\n")).not.toContain("h-1");
    clean();
  });

  test("I1: EVERY add of the original fails → the shadow stays, and the next boot's recovery restores the value", () => {
    clean();
    const home = mkdtempSync(join(dir, "home-"));
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "harness-token", value: "h-1", trustedApplications: [null] });
    const failing = keychainWith({ failAdd: (account) => account === "harness-token" });
    const a = failing.access(trust(CALCULATOR));
    try {
      expect(migrateAppTokenAcl(failing.k, a, trust(CALCULATOR), home, { "harness-token": "h-1" })).toMatchObject({ kind: "failed" });
    } finally { a.release(); }
    expect(genericPasswordPresent(kc, SERVICE, "harness-token")).toBe(false);
    expect(readGenericPassword(kc, SERVICE, "harness-token.migrating")).toBe("h-1");
    const healthy = keychainWith();
    const b = healthy.access(trust(CALCULATOR));
    try {
      expect(recoverAppTokenShadows(healthy.k, b)).toEqual(["harness-token"]);
    } finally { b.release(); }
    expect(readGenericPassword(kc, SERVICE, "harness-token")).toBe("h-1");
    expect(aclOf("harness-token")).toContain(CALCULATOR);
    expect(genericPasswordPresent(kc, SERVICE, "harness-token.migrating")).toBe(false);
    clean();
  });

  test("I2: recovery runs with NOTHING to trust (no Winter Dev registered) — the value comes back self-only", () => {
    clean();
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "remote-token.migrating", value: "r-shadow", trustedApplications: [null] });
    const { k, access } = keychainWith();
    const a = access(undefined);
    expect(a.wide).toBeUndefined();
    try {
      expect(recoverAppTokenShadows(k, a)).toEqual(["remote-token"]);
    } finally { a.release(); }
    expect(readGenericPassword(kc, SERVICE, "remote-token")).toBe("r-shadow");
    expect(genericPasswordPresent(kc, SERVICE, "remote-token.migrating")).toBe(false);
    clean();
  });

  test("I2: the recovery's wide add fails → it retries self-only; the value is back", () => {
    clean();
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "harness-token.migrating", value: "h-shadow", trustedApplications: [null] });
    const { k, access } = keychainWith({ failAdd: (_account, wide) => wide });
    const a = access(trust(CALCULATOR));
    try {
      expect(recoverAppTokenShadows(k, a)).toEqual(["harness-token"]);
    } finally { a.release(); }
    expect(readGenericPassword(kc, SERVICE, "harness-token")).toBe("h-shadow");
    expect(aclOf("harness-token")).not.toContain(CALCULATOR);
    clean();
  });

  test("I2: a shadow beside its original is dropped ONLY when the values are equal; a differing pair is kept and logged, and the migration leaves that item alone", () => {
    clean();
    const home = mkdtempSync(join(dir, "home-"));
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "remote-token", value: "r-1", trustedApplications: [null] });
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "remote-token.migrating", value: "r-1", trustedApplications: [null] });
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "harness-token", value: "h-reminted", trustedApplications: [null] });
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "harness-token.migrating", value: "h-original", trustedApplications: [null] });
    const logs: string[] = [];
    const { k, access } = keychainWith({ logs });
    const a = access(trust(CALCULATOR));
    try {
      expect(recoverAppTokenShadows(k, a)).toEqual([]);
      expect(genericPasswordPresent(kc, SERVICE, "remote-token.migrating")).toBe(false);
      expect(readGenericPassword(kc, SERVICE, "harness-token.migrating")).toBe("h-original");
      expect(readGenericPassword(kc, SERVICE, "harness-token")).toBe("h-reminted");
      expect(logs.join("\n")).toContain("hold DIFFERENT values");
      expect(logs.join("\n")).not.toContain("h-original");
      // The migration never overwrites that shadow: the item keeps its ACL and both values survive.
      expect(migrateAppTokenAcl(k, a, trust(CALCULATOR), home, { "harness-token": "h-reminted", "remote-token": "r-1" })).toMatchObject({ kind: "failed", name: "harness-token" });
      expect(readGenericPassword(kc, SERVICE, "harness-token.migrating")).toBe("h-original");
      expect(readGenericPassword(kc, SERVICE, "harness-token")).toBe("h-reminted");
    } finally { a.release(); }
    clean();
  });

  test("a LOCKED keychain is detected before any data read (which would block on an unlock dialog); locating an item there stays silent", () => {
    // Measured 2026-09-27: a DATA read of a locked keychain blocked on its unlock dialog even with user
    // interaction disabled, so this test never reads data from the locked keychain — it proves the guard.
    const lockedPath = join(dir, "locked.keychain-db");
    expect(Bun.spawnSync(["security", "create-keychain", "-p", PASSWORD, lockedPath]).exitCode).toBe(0);
    const locked = openKeychainFile(lockedPath, PASSWORD);
    try {
      addGenericPasswordWithAccess(locked, { service: SERVICE, account: "x", value: "v", trustedApplications: [null] });
      expect(keychainUnlocked(locked)).toBe(true);
      expect(Bun.spawnSync(["security", "lock-keychain", lockedPath]).exitCode).toBe(0);
      expect(keychainUnlocked(locked)).toBe(false);
      expect(withKeychainUserInteractionDisabled(() => genericPasswordPresent(locked, SERVICE, "x"))).toBe(true);
    } finally {
      locked.close();
      Bun.spawnSync(["security", "delete-keychain", lockedPath]);
    }
  });
});

describe("who the wide ACL trusts", () => {
  const signed = (map: Record<string, { teamId?: string; requirement?: string }>) => (p: string, _timeoutMs: number) => map[p] ?? {};

  test("dist: only the bundle winter-core itself lives in — never a Launch Services guess", () => {
    expect(enclosingAppBundle("/Applications/Winter.app/Contents/Resources/winter-core")).toBe("/Applications/Winter.app");
    expect(enclosingAppBundle("/usr/local/bin/winter-core")).toBeUndefined();
    const inspect = signed({ "/Applications/Winter.app": { teamId: WINTER_TEAM_ID, requirement: "R-app" }, "/Applications/Winter.app/Contents/Resources/winter-core": { teamId: WINTER_TEAM_ID, requirement: "R-core" } });
    const t = trustFor({ profile: "dist", executable: "/Applications/Winter.app/Contents/Resources/winter-core", lookup: () => ["/out/release/Winter.app"], inspect, exists: () => true });
    // winter-core and the app share Winter's team, so the partition list securityd gives the items covers it.
    expect(t).toEqual({ apps: ["/Applications/Winter.app"], requirements: ["R-app", "R-core"] });
    // An unsigned embedded winter-core (a broken build) would partition by cdhash: reported, not hidden.
    const unsignedCore = signed({ "/Applications/Winter.app": { teamId: WINTER_TEAM_ID, requirement: "R-app" } });
    expect(trustFor({ profile: "dist", executable: "/Applications/Winter.app/Contents/Resources/winter-core", lookup: () => [], inspect: unsignedCore, exists: () => true })?.unpartitionedTeams).toEqual([WINTER_TEAM_ID]);
    expect(trustFor({ profile: "dist", executable: "/opt/dist/winter-core", lookup: () => ["/x/Winter.app"], inspect, exists: () => true })).toBeUndefined();
  });

  test("dev: Winter Dev bundles signed by Winter's team only, one per designated requirement; bun by its requirement", () => {
    const lookups: string[] = [];
    const inspect = signed({
      "/dd/b/Winter Dev.app": { teamId: WINTER_TEAM_ID, requirement: "R-dev" },
      "/dd/a/Winter Dev.app": { teamId: WINTER_TEAM_ID, requirement: "R-dev" },
      "/dd/evil/Winter Dev.app": { teamId: "EVILTEAM01", requirement: "R-evil" },
      "/dd/adhoc/Winter Dev.app": { requirement: "cdhash H\"00\"" },
      "/opt/homebrew/Cellar/bun/1.3.14/bin/bun": { teamId: "7FRXF46ZSN", requirement: "R-bun" },
    });
    const t = trustFor({
      profile: "dev", executable: "/opt/homebrew/Cellar/bun/1.3.14/bin/bun",
      lookup: (id) => { lookups.push(id); return ["/dd/b/Winter Dev.app", "/dd/evil/Winter Dev.app", "/dd/a/Winter Dev.app", "/dd/adhoc/Winter Dev.app", "/dd/gone/Winter Dev.app"]; },
      inspect, exists: (p) => !p.includes("gone"),
    });
    expect(lookups).toEqual(["com.winter.app.dev"]);
    // bun is another team's binary: the items it creates are partitioned `teamid:7FRXF46ZSN` alone, so the
    // Winter Dev team is named as the gap (the app is asked once per item — see `app-token-acl.ts`).
    expect(t).toEqual({ apps: ["/dd/a/Winter Dev.app"], requirements: ["R-bun", "R-dev"], unpartitionedTeams: [WINTER_TEAM_ID] });
    // A DerivedData move or a bun upgrade keeps the SAME requirement set, so the marker stays current.
    const moved = trustFor({ profile: "dev", executable: "/opt/homebrew/Cellar/bun/1.3.15/bin/bun", lookup: () => ["/dd/c/Winter Dev.app"], exists: () => true, inspect: (p: string) => (p.endsWith(".app") ? { teamId: WINTER_TEAM_ID, requirement: "R-dev" } : { requirement: "R-bun" }) });
    expect(moved?.requirements).toEqual(t!.requirements);
    // A dev daemon signed by Winter's team (a compiled winter-core) partitions its items by that team: no gap.
    const teamSigned = trustFor({ profile: "dev", executable: "/src/dist/winter-core", lookup: () => ["/dd/a/Winter Dev.app"], exists: () => true, inspect: (p: string) => (p.endsWith(".app") ? { teamId: WINTER_TEAM_ID, requirement: "R-dev" } : { teamId: WINTER_TEAM_ID, requirement: "R-core-dev" }) });
    expect(teamSigned).toEqual({ apps: ["/dd/a/Winter Dev.app"], requirements: ["R-core-dev", "R-dev"] });
  });

  test("the scan has ONE budget: a slow inspector stops the dev-bundle scan once it is spent, and an uninspected bundle is never trusted", () => {
    let clock = 0;
    const inspected: string[] = [];
    const timeouts: number[] = [];
    const slow = (p: string, timeoutMs: number) => {
      inspected.push(p);
      timeouts.push(timeoutMs);
      clock += 3_000; // every codesign takes 3 s
      return p.endsWith(".app") ? { teamId: WINTER_TEAM_ID, requirement: `R-${p}` } : { requirement: "R-bun" };
    };
    const t = trustFor({
      profile: "dev", executable: "/bin/bun", exists: () => true, now: () => clock, budgetMs: 5_000, inspect: slow,
      lookup: () => ["/dd/1/Winter Dev.app", "/dd/2/Winter Dev.app", "/dd/3/Winter Dev.app"],
    });
    // bun (3 s) + the first bundle (3 s) spend the 5 s budget; bundles 2 and 3 are never inspected nor trusted.
    expect(inspected).toEqual(["/bin/bun", "/dd/1/Winter Dev.app"]);
    expect(t).toEqual({ apps: ["/dd/1/Winter Dev.app"], requirements: ["R-/dd/1/Winter Dev.app", "R-bun"], unpartitionedTeams: [WINTER_TEAM_ID] });
    // Each codesign got only what was left of the budget.
    expect(timeouts).toEqual([5_000, 2_000]);
  });
});
