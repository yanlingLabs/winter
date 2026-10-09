// WS-27: the dev Keychain transition (`auth/dev-keychain-transition.ts`) — both sides in this process, over
// a JSON round trip, against a THROWAWAY keychain FILE (never the login keychain, never `com.winter.core*`).
// The "old creator can not read what the new one made" fact is simulated with fake ops where it matters;
// the real cross-binary behaviour is the controller's live run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { credentialAclMarkerPath, REAL_CREDENTIAL_KEYCHAIN_OPS, type CredentialKeychain, type CredentialKeychainOps } from "../../src/auth/credential-acl";
import { createAdoptHandler, DEV_KEYCHAIN_SERVICE, devTransitionRefusal, oldCreatorStillOwnsItems, runDevKeychainTransition, spawnAdoptChild, type AdoptRequest, type AdoptResponse } from "../../src/auth/dev-keychain-transition";
import {
  addGenericPasswordWithAccess, createKeychainAccess, deleteGenericPassword, ERR_SEC_INTERACTION_NOT_ALLOWED, genericPasswordPresent, KeychainFfiError, listGenericPasswordAccounts,
  openKeychainFile, readGenericPassword, type KeychainAccess, type KeychainFile,
} from "../../src/auth/keychain-ffi";

const SERVICE = "ws27.dev-transition.test";
const PASSWORD = "ws27-throwaway";
const CALCULATOR = "/System/Applications/Calculator.app";
const darwin = process.platform === "darwin";
const SLOW = 120_000;
const ITEMS = ["admin-token", "harness-token", "openai:default", "remote-token"] as const;

let dir: string;
let kcPath: string;
let kc: KeychainFile;
let access: KeychainAccess;

function dump(): string {
  return Bun.spawnSync(["security", "dump-keychain", "-a", kcPath]).stdout.toString();
}
function aclIn(text: string, account: string): string {
  return text.split("keychain: ").find((b) => b.includes(`"acct"<blob>="${account}"`) && b.includes(`"svce"<blob>="${SERVICE}"`)) ?? "";
}

function seed(): void {
  for (const name of ITEMS) addGenericPasswordWithAccess(kc, { service: SERVICE, account: name, value: `v-${name}`, trustedApplications: [null, CALCULATOR] });
}
function clean(): void {
  for (const account of listGenericPasswordAccounts(kc, SERVICE)) deleteGenericPassword(kc, SERVICE, account);
}

type Failure = { op: "read" | "add" | "remove"; account: string; status?: number; times?: number };
function opsWith(failures: Failure[]): CredentialKeychainOps {
  const left = failures.map((f) => ({ ...f, times: f.times ?? Number.POSITIVE_INFINITY }));
  const trip = (op: Failure["op"], account: string): void => {
    const f = left.find((x) => x.op === op && x.account === account && x.times > 0);
    if (f === undefined) return;
    f.times -= 1;
    throw new KeychainFfiError(op, f.status ?? -25293, account);
  };
  return {
    ...REAL_CREDENTIAL_KEYCHAIN_OPS,
    read(t, s, a) { trip("read", a); return REAL_CREDENTIAL_KEYCHAIN_OPS.read(t, s, a); },
    readBytes(t, s, a) { trip("read", a); return REAL_CREDENTIAL_KEYCHAIN_OPS.readBytes(t, s, a); },
    add(t, item) { trip("add", item.account); REAL_CREDENTIAL_KEYCHAIN_OPS.add(t, item); },
    remove(t, s, a) { trip("remove", a); return REAL_CREDENTIAL_KEYCHAIN_OPS.remove(t, s, a); },
  };
}

/** The two sides: the orchestrator's keychain view and the child's handler, joined by a JSON round trip
 *  (what the pipe does). `sent` records every request, so a test can check no value crossed twice. */
const CHILD_REQUIREMENT = 'identifier "com.winter.core.dev"';

function sides(opts: { old?: Failure[]; child?: Failure[]; childService?: string; channel?: (req: AdoptRequest) => AdoptResponse | undefined } = {}) {
  const home = mkdtempSync(join(dir, "home-"));
  const logs: string[] = [];
  const sent: AdoptRequest[] = [];
  const oldKc: CredentialKeychain = { keychain: kc, service: SERVICE, ops: opsWith(opts.old ?? []) };
  const childKc: CredentialKeychain = { keychain: kc, service: opts.childService ?? SERVICE, ops: opsWith(opts.child ?? []), log: (l) => logs.push(l) };
  const handle = createAdoptHandler(childKc, access, home, CHILD_REQUIREMENT);
  const send = async (req: AdoptRequest): Promise<AdoptResponse> => {
    sent.push(req);
    const intercepted = opts.channel?.(req);
    if (intercepted !== undefined) return intercepted;
    return JSON.parse(JSON.stringify(handle(JSON.parse(JSON.stringify(req)) as AdoptRequest))) as AdoptResponse;
  };
  return { home, logs, sent, run: () => runDevKeychainTransition(oldKc, send, (l) => logs.push(l)) };
}

describe("who may take part", () => {
  const dev = join(homedir(), ".winter-dev");
  test("only the dev profile, on its default home, on the dev service, on macOS", () => {
    expect(devTransitionRefusal({ profile: "dev", home: dev, service: DEV_KEYCHAIN_SERVICE, platform: "darwin" })).toBeUndefined();
    expect(devTransitionRefusal({ profile: "dist", home: dev, service: DEV_KEYCHAIN_SERVICE, platform: "darwin" })).toContain("dev profile");
    expect(devTransitionRefusal({ profile: "dev", home: dev, service: "com.winter.core", platform: "darwin" })).toContain("com.winter.core");
    expect(devTransitionRefusal({ profile: "dev", home: join(homedir(), ".winter"), service: DEV_KEYCHAIN_SERVICE, platform: "darwin" })).toContain("default home");
    expect(devTransitionRefusal({ profile: "dev", home: "/tmp/x", service: DEV_KEYCHAIN_SERVICE, platform: "darwin" })).toContain("default home");
    expect(devTransitionRefusal({ profile: "dev", home: dev, service: DEV_KEYCHAIN_SERVICE, platform: "linux" })).toContain("macOS");
  });

  test("the child route refuses the dist profile and any other home before it touches the Keychain", () => {
    const script = join(mkdtempSync(join(tmpdir(), "ws27-adopt-")), "child.ts");
    writeFileSync(script, `import { runDevKeychainAdopt } from ${JSON.stringify(join(import.meta.dir, "../../src/auth/dev-keychain-transition.ts"))};\nawait runDevKeychainAdopt();\n`);
    const envBase = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" };
    for (const env of [{ ...envBase, WINTER_HOME: join(homedir(), ".winter-dev") }, { ...envBase, WINTER_PROFILE: "dev", WINTER_HOME: tmpdir() }]) {
      const r = Bun.spawnSync([process.execPath, script], { env, stdin: new TextEncoder().encode('{"op":"hello"}\n'), stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(2);
      expect(r.stdout.toString()).toBe("");
      expect(r.stderr.toString()).toContain("__dev-keychain-adopt refused");
    }
  }, 20_000); // two child processes, ~2.4 s each before the refusal — the default 5 s sat on the edge
});

describe.skipIf(!darwin)("the dev Keychain transition (throwaway keychain file)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ws27-devkc-"));
    kcPath = join(dir, "throwaway.keychain-db");
    const made = Bun.spawnSync(["security", "create-keychain", "-p", PASSWORD, kcPath]);
    if (made.exitCode !== 0) throw new Error(`create-keychain failed: ${made.stderr.toString()}`);
    kc = openKeychainFile(kcPath, PASSWORD);
    access = createKeychainAccess("Winter credential", [null]);
  });
  afterAll(() => {
    try { access?.release(); } catch { /* released */ }
    try { kc?.close(); } catch { /* closed */ }
    Bun.spawnSync(["security", "delete-keychain", kcPath]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("every item — the pairing tokens included — is re-created by the child, self-only, same value; no shadow left; the credential marker written; each value crossed once", async () => {
    clean();
    seed();
    const s = sides();
    const outcome = await s.run();
    expect(outcome).toEqual({ kind: "done", adopted: [...ITEMS].sort(), skipped: [], restored: [] });
    const after = dump();
    for (const name of ITEMS) {
      expect(readGenericPassword(kc, SERVICE, name)).toBe(`v-${name}`);
      expect(aclIn(after, name)).toContain("decrypt");
      expect(aclIn(after, name)).not.toContain(CALCULATOR);
      expect(genericPasswordPresent(kc, SERVICE, `${name}.migrating`)).toBe(false);
    }
    expect(JSON.parse(readFileSync(credentialAclMarkerPath(s.home), "utf8"))).toMatchObject({ v: 2, service: SERVICE, requirement: CHILD_REQUIREMENT, migrated: ITEMS.length, skipped: 0 });
    const carrying = s.sent.filter((r) => r.op === "shadow").map((r) => (r as { account: string }).account);
    expect(carrying).toEqual([...ITEMS].sort());
    expect(JSON.stringify(s.sent.filter((r) => r.op !== "shadow"))).not.toContain("v-");
    expect(s.logs.join("\n")).not.toContain("v-");
    clean();
  }, SLOW);

  test("an item the old creator cannot read silently is skipped and left as it is (what a re-run sees for already-adopted items)", async () => {
    clean();
    seed();
    const s = sides({ old: [{ op: "read", account: "openai:default", status: ERR_SEC_INTERACTION_NOT_ALLOWED }] });
    expect(await s.run()).toMatchObject({ kind: "done", skipped: ["openai:default"] });
    expect(aclIn(dump(), "openai:default")).toContain(CALCULATOR);
    expect(JSON.parse(readFileSync(credentialAclMarkerPath(s.home), "utf8"))).toMatchObject({ skipped: 1 });
    clean();
  }, SLOW);

  test("the child cannot write a shadow → skipped, the original untouched", async () => {
    clean();
    seed();
    const s = sides({ child: [{ op: "add", account: "admin-token.migrating" }] });
    expect(await s.run()).toMatchObject({ kind: "done", skipped: ["admin-token"] });
    expect(readGenericPassword(kc, SERVICE, "admin-token")).toBe("v-admin-token");
    expect(aclIn(dump(), "admin-token")).toContain(CALCULATOR);
    expect(genericPasswordPresent(kc, SERVICE, "admin-token.migrating")).toBe(false);
    clean();
  }, SLOW);

  test("the old creator cannot delete → the child drops its shadow; skipped, the original untouched", async () => {
    clean();
    seed();
    const s = sides({ old: [{ op: "remove", account: "remote-token" }] });
    expect(await s.run()).toMatchObject({ kind: "done", skipped: ["remote-token"] });
    expect(readGenericPassword(kc, SERVICE, "remote-token")).toBe("v-remote-token");
    expect(aclIn(dump(), "remote-token")).toContain(CALCULATOR);
    expect(genericPasswordPresent(kc, SERVICE, "remote-token.migrating")).toBe(false);
    clean();
  }, SLOW);

  test("the child cannot re-create after the delete → the run stops with the shadow holding the value; a re-run's recovery restores it and finishes", async () => {
    clean();
    seed();
    const first = sides({ child: [{ op: "add", account: "harness-token" }] });
    const stopped = await first.run();
    expect(stopped).toMatchObject({ kind: "stopped", account: "harness-token", adopted: ["admin-token"] });
    expect(genericPasswordPresent(kc, SERVICE, "harness-token")).toBe(false);
    expect(readGenericPassword(kc, SERVICE, "harness-token.migrating")).toBe("v-harness-token");
    expect(first.logs.join("\n")).toContain("re-run the transition");
    // The re-run. The already-adopted item is the child's now; the "old creator" is refused it, as for real.
    const again = sides({ old: [{ op: "read", account: "admin-token", status: ERR_SEC_INTERACTION_NOT_ALLOWED }] });
    const outcome = await again.run();
    expect(outcome).toMatchObject({ kind: "done", restored: ["harness-token"], skipped: ["admin-token"] });
    for (const name of ITEMS) {
      expect(readGenericPassword(kc, SERVICE, name)).toBe(`v-${name}`);
      expect(genericPasswordPresent(kc, SERVICE, `${name}.migrating`)).toBe(false);
    }
    // The restored item was re-read by the orchestrator and adopted too (its shadow was the child's).
    expect(aclIn(dump(), "harness-token")).not.toContain(CALCULATOR);
    clean();
  }, SLOW);

  test("interrupted between the shadow and the delete: a re-run finds the equal pair and completes (the shadow step is idempotent)", async () => {
    clean();
    seed();
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "openai:default.migrating", value: "v-openai:default", trustedApplications: [null] });
    expect(await sides().run()).toMatchObject({ kind: "done", adopted: [...ITEMS].sort() });
    expect(genericPasswordPresent(kc, SERVICE, "openai:default.migrating")).toBe(false);
    expect(readGenericPassword(kc, SERVICE, "openai:default")).toBe("v-openai:default");
    clean();
  }, SLOW);

  test("the pre-start check: items the old creator still reads mean the transition has not run; none (or none readable) means go", () => {
    clean();
    expect(oldCreatorStillOwnsItems({ keychain: kc, service: SERVICE })).toBe(false);
    seed();
    expect(oldCreatorStillOwnsItems({ keychain: kc, service: SERVICE })).toBe(true);
    const refusedAll = opsWith(ITEMS.map((account) => ({ op: "read" as const, account, status: ERR_SEC_INTERACTION_NOT_ALLOWED })));
    expect(oldCreatorStillOwnsItems({ keychain: kc, service: SERVICE, ops: refusedAll })).toBe(false);
    // EVERY account is looked at: only the last one (sorted or not) still bun's is enough.
    const allButLast = opsWith(ITEMS.slice(0, -1).map((account) => ({ op: "read" as const, account, status: ERR_SEC_INTERACTION_NOT_ALLOWED })));
    expect(oldCreatorStillOwnsItems({ keychain: kc, service: SERVICE, ops: allButLast })).toBe(true);
    clean();
  }, SLOW);

  test("over a REAL pipe: the child's own request loop (`serveAdoptRequests`) in a separate process, driven through `spawnAdoptChild`", async () => {
    clean();
    seed();
    const home = mkdtempSync(join(dir, "home-"));
    const entry = join(dir, "adopt-child.ts");
    const src = join(import.meta.dir, "../../src/auth");
    writeFileSync(entry, [
      `import { createAdoptHandler, serveAdoptRequests } from ${JSON.stringify(join(src, "dev-keychain-transition.ts"))};`,
      `import { createKeychainAccess, openKeychainFile } from ${JSON.stringify(join(src, "keychain-ffi.ts"))};`,
      `const kc = openKeychainFile(process.env.KC_PATH!, process.env.KC_PASSWORD!);`,
      `const access = createKeychainAccess("Winter credential", [null]);`,
      `await serveAdoptRequests(createAdoptHandler({ keychain: kc, service: process.env.KC_SERVICE! }, access, process.env.KC_HOME!, "identifier \\"child\\""), process.stdin, (l) => process.stdout.write(l));`,
      `setTimeout(() => process.exit(0), 50);`,
    ].join("\n"));
    const child = spawnAdoptChild({ file: process.execPath, args: [entry] }, { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", KC_PATH: kcPath, KC_PASSWORD: PASSWORD, KC_SERVICE: SERVICE, KC_HOME: home });
    let outcome;
    try {
      outcome = await runDevKeychainTransition({ keychain: kc, service: SERVICE }, child.send);
    } finally {
      expect(await child.close()).toBe(0);
    }
    expect(outcome).toEqual({ kind: "done", adopted: [...ITEMS].sort(), skipped: [], restored: [] });
    const after = dump();
    for (const name of ITEMS) {
      expect(readGenericPassword(kc, SERVICE, name)).toBe(`v-${name}`);
      expect(aclIn(after, name)).not.toContain(CALCULATOR);
      expect(genericPasswordPresent(kc, SERVICE, `${name}.migrating`)).toBe(false);
    }
    expect(JSON.parse(readFileSync(credentialAclMarkerPath(home), "utf8"))).toMatchObject({ migrated: ITEMS.length });
    clean();
  }, SLOW);

  test("a child that stops answering times out (and is killed) instead of holding the home's lock forever", async () => {
    const child = spawnAdoptChild({ file: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, { PATH: process.env.PATH ?? "/usr/bin:/bin" }, 300);
    expect(await child.send({ op: "hello" })).toEqual({ ok: false, reason: "no answer to hello within 300 ms", fatal: true });
    expect(await child.close()).not.toBe(0);
    expect(await child.send({ op: "hello" })).toMatchObject({ ok: false });
  }, SLOW);

  test("bun's own leftover shadows (a crashed bun-run migration) are recovered first — restored, or dropped beside their original as stale — and then adopted", async () => {
    clean();
    seed();
    // An interrupted bun migration of admin-token: the original gone, only bun's shadow left.
    deleteGenericPassword(kc, SERVICE, "admin-token");
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "admin-token.migrating", value: "v-admin-token", trustedApplications: [null] });
    // A stale bun shadow beside a newer original.
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "openai:default.migrating", value: "value-elsewhere", trustedApplications: [null] });
    const s1 = sides();
    const outcome = await s1.run();
    expect(outcome).toMatchObject({ kind: "done", adopted: [...ITEMS].sort(), skipped: [], restored: ["admin-token"] });
    expect(readGenericPassword(kc, SERVICE, "admin-token")).toBe("v-admin-token");
    expect(readGenericPassword(kc, SERVICE, "openai:default")).toBe("v-openai:default");
    for (const name of ITEMS) expect(genericPasswordPresent(kc, SERVICE, `${name}.migrating`)).toBe(false);
    expect(s1.logs.join("\n")).not.toContain("value-elsewhere");
    clean();
  }, SLOW);

  test("the run STOPS, writing no marker, when the child exits or stops answering mid-run, or its recovery or the marker fails", async () => {
    const fatal = { ok: false as const, reason: "the child exited (1)", fatal: true as const };
    for (const [label, channel] of [
      ["channel lost on a shadow", (r: AdoptRequest) => (r.op === "shadow" && r.account === "harness-token" ? fatal : undefined)],
      ["channel lost on a drop", (r: AdoptRequest) => (r.op === "drop" ? fatal : undefined)],
      ["recovery failed", (r: AdoptRequest) => (r.op === "recover" ? { ok: false as const, reason: "recover: OSStatus -1" } : undefined)],
      ["marker failed", (r: AdoptRequest) => (r.op === "marker" ? { ok: false as const, reason: "EACCES" } : undefined)],
    ] as const) {
      clean();
      seed();
      const s1 = sides({ channel, ...(label === "channel lost on a drop" ? { old: [{ op: "remove" as const, account: "admin-token" }] } : {}) });
      const outcome = await s1.run();
      expect({ label, kind: outcome.kind }).toEqual({ label, kind: "stopped" });
      expect(existsSync(credentialAclMarkerPath(s1.home))).toBe(false);
      for (const name of ITEMS) expect(readGenericPassword(kc, SERVICE, name)).toBe(`v-${name}`);
    }
    clean();
  }, SLOW);

  test("N4: a pairing token's DIFFERING shadow is never dropped — kept by bun's recovery and by the child's shadow step; the token is left alone", async () => {
    clean();
    seed();
    addGenericPasswordWithAccess(kc, { service: SERVICE, account: "remote-token.migrating", value: "r-other-value", trustedApplications: [null] });
    const s1 = sides();
    const outcome = await s1.run();
    expect(outcome).toMatchObject({ kind: "done", skipped: ["remote-token"] });
    expect(readGenericPassword(kc, SERVICE, "remote-token.migrating")).toBe("r-other-value");
    expect(readGenericPassword(kc, SERVICE, "remote-token")).toBe("v-remote-token");
    expect(aclIn(dump(), "remote-token")).toContain(CALCULATOR);
    expect(s1.logs.join("\n")).toContain("hold DIFFERENT values — both kept");
    // The child alone, too.
    const handle = createAdoptHandler({ keychain: kc, service: SERVICE }, access, mkdtempSync(join(dir, "home-")), CHILD_REQUIREMENT);
    expect(handle({ op: "shadow", account: "remote-token", value: "v-remote-token" })).toEqual({ ok: false, reason: "remote-token.migrating holds a different value — kept" });
    expect(readGenericPassword(kc, SERVICE, "remote-token.migrating")).toBe("r-other-value");
    clean();
  }, SLOW);

  test("N5: a child that cannot read its own designated requirement adopts, but writes no marker", async () => {
    clean();
    seed();
    const home = mkdtempSync(join(dir, "home-"));
    const handle = createAdoptHandler({ keychain: kc, service: SERVICE }, access, home, undefined);
    expect(handle({ op: "marker", migrated: 3, skipped: 0 })).toEqual({ ok: true });
    expect(existsSync(credentialAclMarkerPath(home))).toBe(false);
    clean();
  }, SLOW);

  test("N7: an item that vanishes before bun deletes it (remove answers false) is left removed; the child's shadow goes", async () => {
    clean();
    seed();
    const home = mkdtempSync(join(dir, "home-"));
    const logs: string[] = [];
    const oldOps = { ...opsWith([]), remove: (t: never, s: string, a: string) => { const r = REAL_CREDENTIAL_KEYCHAIN_OPS.remove(t, s, a); return a === "openai:default" ? false : r; } };
    const handle = createAdoptHandler({ keychain: kc, service: SERVICE }, access, home, CHILD_REQUIREMENT);
    const outcome = await runDevKeychainTransition({ keychain: kc, service: SERVICE, ops: oldOps as never }, async (r) => handle(r), (l) => logs.push(l));
    expect(outcome).toMatchObject({ kind: "done", skipped: ["openai:default"] });
    expect(genericPasswordPresent(kc, SERVICE, "openai:default")).toBe(false);
    expect(genericPasswordPresent(kc, SERVICE, "openai:default.migrating")).toBe(false);
    expect(logs.join("\n")).toContain("vanished before the delete");
    clean();
  }, SLOW);

  test("nothing adopted and something skipped (a re-run over already-adopted items): no marker", async () => {
    clean();
    seed();
    const s1 = sides({ old: ITEMS.map((account) => ({ op: "read" as const, account, status: ERR_SEC_INTERACTION_NOT_ALLOWED })) });
    expect(await s1.run()).toMatchObject({ kind: "done", adopted: [], skipped: [...ITEMS].sort() });
    expect(existsSync(credentialAclMarkerPath(s1.home))).toBe(false);
    expect(s1.sent.some((r) => r.op === "marker")).toBe(false);
    clean();
  }, SLOW);

  test("a child on another service is refused before anything moves; commit refuses while the original is still there", async () => {
    clean();
    seed();
    expect(await sides({ childService: "ws27.somewhere-else" }).run()).toMatchObject({ kind: "stopped", account: "(child)" });
    expect(readGenericPassword(kc, SERVICE, "openai:default")).toBe("v-openai:default");
    const handle = createAdoptHandler({ keychain: kc, service: SERVICE }, access, mkdtempSync(join(dir, "home-")), CHILD_REQUIREMENT);
    expect(handle({ op: "shadow", account: "openai:default", value: "v-openai:default" })).toEqual({ ok: true });
    expect(handle({ op: "commit", account: "openai:default" })).toEqual({ ok: false, reason: "openai:default is still there" });
    expect(handle({ op: "shadow", account: "x.migrating", value: "v" })).toEqual({ ok: false, reason: "not an item" });
    clean();
  }, SLOW);
});
