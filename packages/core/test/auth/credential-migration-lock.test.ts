// WS-27 review: the credential migration lock, and the credential delete doors that take a migration shadow
// with them. Temp homes and fakes only — never the Keychain.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcpOAuthStore } from "@yanlinglabs/winter-agent-runtime/mcp-auth";
import {
  acquireCredentialMigrationLock, credentialMigrationLockHolder, credentialMigrationLockPath, CredentialMigrationBusy, processStartSeconds, processStartSecondsViaPs, processStartSecondsViaSysctl, UNREADABLE_GRACE_MS, waitForCredentialMigrationLock,
} from "../../src/auth/credential-migration-lock";
import { adoptLockRefusal, bootLockHolderRefusal } from "../../src/auth/dev-keychain-transition";
import { KeychainSecretStore } from "../../src/auth/secret-store";
import { describeHomePristineness } from "../../src/migration/migrate-b";
import { withShadowRemoval } from "../../src/runtime-sdk/mcp-oauth-store";

const home = (): string => mkdtempSync(join(tmpdir(), "ws27-lock-"));
/** A pid that is certainly not running. */
const DEAD = 2_147_483_000;

describe("the credential migration lock (the holder process itself, never a socket)", () => {
  const record = (h: string, content: string, ageMs = 0): void => {
    mkdirSync(join(h, "run"), { recursive: true });
    writeFileSync(credentialMigrationLockPath(h), content);
    if (ageMs > 0) { const t = (Date.now() - ageMs) / 1000; utimesSync(credentialMigrationLockPath(h), t, t); }
  };
  const PARENT_START = processStartSeconds(process.ppid)!;

  test("created atomically WITH its content (pid and start time), nothing temporary left beside it; never re-entrant; released only by its holder", () => {
    const h = home();
    const first = acquireCredentialMigrationLock(h);
    expect("release" in first).toBe(true);
    const content = JSON.parse(readFileSync(credentialMigrationLockPath(h), "utf8")) as { pid: number; startSec?: number };
    expect(content.pid).toBe(process.pid);
    expect(content.startSec).toBe(processStartSeconds(process.pid));
    expect(readdirSync(join(h, "run"))).toEqual(["credential-migration.lock"]);
    expect(acquireCredentialMigrationLock(h)).toEqual({ heldBy: process.pid });
    (first as { release(): void }).release();
    expect(existsSync(credentialMigrationLockPath(h))).toBe(false);
    // A lock someone else holds is not released by us.
    record(h, JSON.stringify({ pid: process.ppid, startSec: PARENT_START }));
    (first as { release(): void }).release();
    expect(credentialMigrationLockHolder(h)).toBe(process.ppid);
  });

  test("a live holder whose start time matches holds it — with NO socket anywhere (the boot lock's stale rule does not apply)", () => {
    const h = home();
    record(h, JSON.stringify({ pid: process.ppid, startSec: PARENT_START }));
    expect(acquireCredentialMigrationLock(h)).toEqual({ heldBy: process.ppid });
  });

  test("stale, and replaced: a dead pid; a live pid with ANOTHER start time (a reused pid); this pid when this process never took it; an unreadable file older than the grace", () => {
    for (const [label, content, age] of [
      ["dead", JSON.stringify({ pid: DEAD, startSec: 1 }), 0],
      ["reused pid", JSON.stringify({ pid: process.ppid, startSec: PARENT_START - 3_600 }), 0],
      ["our pid, not ours", JSON.stringify({ pid: process.pid, startSec: 1 }), 0],
      ["unreadable, old", "not json", UNREADABLE_GRACE_MS + 5_000],
    ] as const) {
      const h = home();
      record(h, content, age);
      const taken = acquireCredentialMigrationLock(h);
      expect({ label, taken: "release" in taken }).toEqual({ label, taken: true });
      expect(credentialMigrationLockHolder(h)).toBe(process.pid);
      expect(readdirSync(join(h, "run"))).toEqual(["credential-migration.lock"]);
      (taken as { release(): void }).release();
    }
  });

  test("a live holder whose start time cannot be read, or reads garbled, is HELD — only a clear different start time is stale", () => {
    for (const reading of [undefined, Number.NaN, -1, 0, 1.5]) {
      const h = home();
      record(h, JSON.stringify({ pid: process.ppid, startSec: PARENT_START }));
      expect({ reading, taken: acquireCredentialMigrationLock(h, { startOf: () => reading }) }).toEqual({ reading, taken: { heldBy: process.ppid } });
    }
    // A garbled RECORD (no usable start time in the file): the live pid alone decides — held.
    for (const startSec of ["Sun Sep 27 19:46:04 2026", null, 1.5, -3]) {
      const h = home();
      record(h, JSON.stringify({ pid: process.ppid, startSec }));
      expect(acquireCredentialMigrationLock(h)).toEqual({ heldBy: process.ppid });
    }
    // And the clear case still decides the other way.
    const h = home();
    record(h, JSON.stringify({ pid: process.ppid, startSec: PARENT_START }));
    expect("release" in acquireCredentialMigrationLock(h, { startOf: (pid) => (pid === process.ppid ? PARENT_START + 60 : processStartSeconds(pid)) })).toBe(true);
  });

  test("an unreadable file younger than the grace is taken to be held (a writer mid-way)", () => {
    const h = home();
    record(h, "");
    expect(acquireCredentialMigrationLock(h)).toEqual({ heldBy: -1 });
  });

  test("the lock never makes a home non-pristine for Migration B (it is taken before Migration B runs)", () => {
    const h = home();
    const taken = acquireCredentialMigrationLock(h);
    expect(describeHomePristineness(h)).toEqual({ pristine: true });
    (taken as { release(): void }).release();
  });

  test("the boot's wait: it polls while the lock is held and takes it once freed; held to the end, it refuses typed", async () => {
    let clock = 0;
    const sleep = async (ms: number): Promise<void> => { clock += ms; };
    let polls = 0;
    const freed = { release() {} };
    const lock = await waitForCredentialMigrationLock("/h", { now: () => clock, sleep, pollMs: 250, waitMs: 60_000, acquire: () => (++polls < 4 ? { heldBy: 4242 } : freed) });
    expect(lock).toBe(freed);
    expect(polls).toBe(4);
    clock = 0;
    let refused: unknown;
    try {
      await waitForCredentialMigrationLock("/h", { now: () => clock, sleep, pollMs: 250, waitMs: 60_000, acquire: () => ({ heldBy: 4242 }) });
    } catch (err) { refused = err; }
    expect(refused).toBeInstanceOf(CredentialMigrationBusy);
    expect((refused as CredentialMigrationBusy).code).toBe("credential_migration_busy");
    expect(clock).toBe(60_000);
  });

  test("the adopt child acts only while its PARENT holds the lock", () => {
    const h = home();
    expect(adoptLockRefusal(h, process.pid)).toContain("no holder");
    const taken = acquireCredentialMigrationLock(h);
    expect(adoptLockRefusal(h, process.pid)).toBeUndefined();
    expect(adoptLockRefusal(h, process.ppid)).toContain(`(${process.pid})`);
    (taken as { release(): void }).release();
  });

  test("the transition refuses while core.lock names ANY live process, answering socket or not — unless that pid started AFTER the lock was written (reused)", () => {
    const h = home();
    expect(bootLockHolderRefusal(h)).toBeUndefined();
    mkdirSync(join(h, "run"), { recursive: true });
    writeFileSync(join(h, "run", "core.lock"), JSON.stringify({ pid: DEAD, startedAt: Date.now() }));
    expect(bootLockHolderRefusal(h)).toBeUndefined();
    // Written by the live parent after it started: held. The message names the way out for a stale file.
    writeFileSync(join(h, "run", "core.lock"), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    expect(bootLockHolderRefusal(h)).toContain(`pid ${process.ppid}`);
    expect(bootLockHolderRefusal(h)).toContain("or remove run/core.lock if no dev daemon is running");
    // Written an hour BEFORE that pid's process started: a reused pid, stale.
    writeFileSync(join(h, "run", "core.lock"), JSON.stringify({ pid: process.ppid, startedAt: (PARENT_START - 3_600) * 1000 }));
    expect(bootLockHolderRefusal(h)).toBeUndefined();
    // No start time to compare (an older core.lock): the pid alone decides.
    writeFileSync(join(h, "run", "core.lock"), JSON.stringify({ pid: process.ppid }));
    expect(bootLockHolderRefusal(h)).toContain(`pid ${process.ppid}`);
  });

  test("I-A: start times are epoch seconds, identical from sysctl and from ps, whatever the reader's locale and zone", () => {
    const script = join(home(), "start.ts");
    writeFileSync(script, `import { processStartSecondsViaPs, processStartSecondsViaSysctl } from ${JSON.stringify(join(import.meta.dir, "../../src/auth/credential-migration-lock.ts"))};\nconst pid = Number(process.argv[2]);\nprocess.stdout.write(JSON.stringify([processStartSecondsViaSysctl(pid), processStartSecondsViaPs(pid)]));\n`);
    const answers = new Set<string>();
    for (const env of [{ LC_ALL: "fr_FR.UTF-8", TZ: "Pacific/Auckland" }, { LC_ALL: "ja_JP.UTF-8", TZ: "America/Los_Angeles" }, { LC_ALL: "C", TZ: "UTC" }]) {
      const r = Bun.spawnSync([process.execPath, script, String(process.ppid)], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
      const [viaSysctl, viaPs] = JSON.parse(r.stdout.toString()) as [number, number];
      expect(viaSysctl).toBe(PARENT_START);
      expect(viaPs).toBe(PARENT_START);
      answers.add(r.stdout.toString());
    }
    expect(answers.size).toBe(1);
    expect(processStartSecondsViaSysctl(DEAD)).toBeUndefined();
    expect(processStartSecondsViaPs(DEAD)).toBeUndefined();
  }, 30_000); // three cold `bun` spawns, each compiling the module and running `ps`: well past 5 s on a loaded machine

  test("I-A: a lock written by a holder under one locale and zone is judged HELD by a taker under another", async () => {
    const h = home();
    const holder = join(h, "holder.ts");
    const taker = join(h, "taker.ts");
    const mod = JSON.stringify(join(import.meta.dir, "../../src/auth/credential-migration-lock.ts"));
    writeFileSync(holder, `import { acquireCredentialMigrationLock } from ${mod};\nconst t = acquireCredentialMigrationLock(process.argv[2]);\nprocess.stdout.write("release" in t ? "held\\n" : "busy\\n");\nsetInterval(() => {}, 1000);\n`);
    writeFileSync(taker, `import { acquireCredentialMigrationLock } from ${mod};\nprocess.stdout.write(JSON.stringify(acquireCredentialMigrationLock(process.argv[2])));\n`);
    const base = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" };
    const child = Bun.spawn([process.execPath, holder, h], { env: { ...base, LC_ALL: "fr_FR.UTF-8", TZ: "Pacific/Auckland" }, stdout: "pipe" });
    try {
      const reader = child.stdout.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toBe("held\n");
      const r = Bun.spawnSync([process.execPath, taker, h], { env: { ...base, LC_ALL: "C", TZ: "America/Los_Angeles" }, stdout: "pipe" });
      expect(JSON.parse(r.stdout.toString())).toEqual({ heldBy: child.pid });
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    // Its holder gone, the same file is stale to anyone.
    const after = acquireCredentialMigrationLock(h);
    expect("release" in after).toBe(true);
    (after as { release(): void }).release();
  }, 20_000); // a holder and a taker process
});

describe("a removed credential takes its migration shadow with it (so recovery can never resurrect it)", () => {
  test("KeychainSecretStore.delete removes `<name>.migrating` too — FIRST; the answer is the original's", async () => {
    const items = new Map<string, string>([["s/openai:default", "v"], ["s/openai:default.migrating", "old"], ["s/exa-api-key.migrating", "old"]]);
    const order: string[] = [];
    const backend = {
      get: async ({ service, name }: { service: string; name: string }) => items.get(`${service}/${name}`) ?? null,
      set: async ({ service, name, value }: { service: string; name: string; value: string }) => { items.set(`${service}/${name}`, value); },
      delete: async ({ service, name }: { service: string; name: string }) => { order.push(name); return items.delete(`${service}/${name}`); },
    };
    const store = new KeychainSecretStore(backend as never, "s");
    expect(await store.delete("openai:default")).toBe(true);
    expect(order).toEqual(["openai:default.migrating", "openai:default"]);
    expect([...items.keys()]).toEqual(["s/exa-api-key.migrating"]);
    // Nothing at the name itself: still `false`, but its shadow goes.
    expect(await store.delete("exa-api-key")).toBe(false);
    expect(items.size).toBe(0);
  });

  test("the daemon's MCP OAuth store: remove(account) removes `<account>.migrating` too", async () => {
    const base = createMemoryMcpOAuthStore({ "mcp-oauth:x": "t", "mcp-oauth:x.migrating": "t-old", "mcp-oauth:y": "u" });
    const order: string[] = [];
    const store = withShadowRemoval({ ...base, remove: async (a: string) => { order.push(a); await base.remove(a); } });
    await store.remove("mcp-oauth:x");
    expect(order).toEqual(["mcp-oauth:x.migrating", "mcp-oauth:x"]);
    expect([...base.entries.keys()]).toEqual(["mcp-oauth:y"]);
    expect(await store.read("mcp-oauth:y")).toBe("u");
  });
});
