// WS-27 review: the credential migration lock, and the credential delete doors that take a migration shadow
// with them. Temp homes and fakes only — never the Keychain.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcpOAuthStore } from "@yanlinglabs/winter-agent-runtime/mcp-auth";
import {
  acquireCredentialMigrationLock, credentialMigrationLockHolder, credentialMigrationLockPath, CredentialMigrationBusy, processStartTime, UNREADABLE_GRACE_MS, waitForCredentialMigrationLock,
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
  const PARENT_START = processStartTime(process.ppid)!;

  test("created atomically WITH its content (pid and start time), nothing temporary left beside it; never re-entrant; released only by its holder", () => {
    const h = home();
    const first = acquireCredentialMigrationLock(h);
    expect("release" in first).toBe(true);
    const content = JSON.parse(readFileSync(credentialMigrationLockPath(h), "utf8")) as { pid: number; start?: string };
    expect(content.pid).toBe(process.pid);
    expect(content.start).toBe(processStartTime(process.pid));
    expect(readdirSync(join(h, "run"))).toEqual(["credential-migration.lock"]);
    expect(acquireCredentialMigrationLock(h)).toEqual({ heldBy: process.pid });
    (first as { release(): void }).release();
    expect(existsSync(credentialMigrationLockPath(h))).toBe(false);
    // A lock someone else holds is not released by us.
    record(h, JSON.stringify({ pid: process.ppid, start: PARENT_START }));
    (first as { release(): void }).release();
    expect(credentialMigrationLockHolder(h)).toBe(process.ppid);
  });

  test("a live holder whose start time matches holds it — with NO socket anywhere (the boot lock's stale rule does not apply)", () => {
    const h = home();
    record(h, JSON.stringify({ pid: process.ppid, start: PARENT_START }));
    expect(acquireCredentialMigrationLock(h)).toEqual({ heldBy: process.ppid });
  });

  test("stale, and replaced: a dead pid; a live pid with ANOTHER start time (a reused pid); this pid when this process never took it; an unreadable file older than the grace", () => {
    for (const [label, content, age] of [
      ["dead", JSON.stringify({ pid: DEAD, start: "x" }), 0],
      ["reused pid", JSON.stringify({ pid: process.ppid, start: "Thu Jan  1 00:00:00 1970" }), 0],
      ["our pid, not ours", JSON.stringify({ pid: process.pid, start: "whatever" }), 0],
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

  test("the transition refuses while core.lock names ANY live process, answering socket or not", () => {
    const h = home();
    expect(bootLockHolderRefusal(h)).toBeUndefined();
    mkdirSync(join(h, "run"), { recursive: true });
    writeFileSync(join(h, "run", "core.lock"), JSON.stringify({ pid: DEAD }));
    expect(bootLockHolderRefusal(h)).toBeUndefined();
    writeFileSync(join(h, "run", "core.lock"), JSON.stringify({ pid: process.ppid, startedAt: 0 }));
    expect(bootLockHolderRefusal(h)).toContain(`pid ${process.ppid}`);
  });
});

describe("a removed credential takes its migration shadow with it (so recovery can never resurrect it)", () => {
  test("KeychainSecretStore.delete removes `<name>.migrating` too; the answer is the original's", async () => {
    const items = new Map<string, string>([["s/openai:default", "v"], ["s/openai:default.migrating", "old"], ["s/exa-api-key.migrating", "old"]]);
    const backend = {
      get: async ({ service, name }: { service: string; name: string }) => items.get(`${service}/${name}`) ?? null,
      set: async ({ service, name, value }: { service: string; name: string; value: string }) => { items.set(`${service}/${name}`, value); },
      delete: async ({ service, name }: { service: string; name: string }) => items.delete(`${service}/${name}`),
    };
    const store = new KeychainSecretStore(backend as never, "s");
    expect(await store.delete("openai:default")).toBe(true);
    expect([...items.keys()]).toEqual(["s/exa-api-key.migrating"]);
    // Nothing at the name itself: still `false`, but its shadow goes.
    expect(await store.delete("exa-api-key")).toBe(false);
    expect(items.size).toBe(0);
  });

  test("the daemon's MCP OAuth store: remove(account) removes `<account>.migrating` too", async () => {
    const base = createMemoryMcpOAuthStore({ "mcp-oauth:x": "t", "mcp-oauth:x.migrating": "t-old", "mcp-oauth:y": "u" });
    const store = withShadowRemoval(base);
    await store.remove("mcp-oauth:x");
    expect([...base.entries.keys()]).toEqual(["mcp-oauth:y"]);
    expect(await store.read("mcp-oauth:y")).toBe("u");
  });
});
