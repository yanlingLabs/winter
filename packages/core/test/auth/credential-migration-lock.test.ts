// WS-27 review: the credential migration lock, and the credential delete doors that take a migration shadow
// with them. Temp homes and fakes only — never the Keychain.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcpOAuthStore } from "@yanlinglabs/winter-agent-runtime/mcp-auth";
import { acquireCredentialMigrationLock, credentialMigrationLockHolder, credentialMigrationLockPath } from "../../src/auth/credential-migration-lock";
import { adoptLockRefusal } from "../../src/auth/dev-keychain-transition";
import { KeychainSecretStore } from "../../src/auth/secret-store";
import { describeHomePristineness } from "../../src/migration/migrate-b";
import { withShadowRemoval } from "../../src/runtime-sdk/mcp-oauth-store";

const home = (): string => mkdtempSync(join(tmpdir(), "ws27-lock-"));
/** A pid that is certainly not running. */
const DEAD = 2_147_483_000;

describe("the credential migration lock (pid liveness only, never a socket)", () => {
  test("taken exclusively; a second taker is told the live holder; released only by its holder", () => {
    const h = home();
    const first = acquireCredentialMigrationLock(h);
    expect("release" in first).toBe(true);
    expect(credentialMigrationLockHolder(h)).toBe(process.pid);
    // A different (live) process asking: the parent of this test process is alive.
    expect(acquireCredentialMigrationLock(h, process.ppid)).toEqual({ heldBy: process.pid });
    // Never re-entrant, even for the holder.
    expect(acquireCredentialMigrationLock(h)).toEqual({ heldBy: process.pid });
    (first as { release(): void }).release();
    expect(existsSync(credentialMigrationLockPath(h))).toBe(false);
    const second = acquireCredentialMigrationLock(h, process.ppid);
    expect("release" in second).toBe(true);
    // Not ours: a release by anyone else leaves it.
    (first as { release(): void }).release();
    expect(credentialMigrationLockHolder(h)).toBe(process.ppid);
  });

  test("a live holder with NO socket anywhere still holds it (the boot lock's stale rule does not apply)", () => {
    const h = home();
    mkdirSync(join(h, "run"), { recursive: true });
    writeFileSync(credentialMigrationLockPath(h), JSON.stringify({ pid: process.ppid, startedAt: 0 }));
    expect(acquireCredentialMigrationLock(h)).toEqual({ heldBy: process.ppid });
  });

  test("a dead holder, or an unreadable file, is stale and replaced — nothing moved aside is left behind", () => {
    for (const content of [JSON.stringify({ pid: DEAD }), "not json"]) {
      const h = home();
      mkdirSync(join(h, "run"), { recursive: true });
      writeFileSync(credentialMigrationLockPath(h), content);
      const taken = acquireCredentialMigrationLock(h);
      expect("release" in taken).toBe(true);
      expect(credentialMigrationLockHolder(h)).toBe(process.pid);
      expect(readdirSync(join(h, "run"))).toEqual(["credential-migration.lock"]);
      (taken as { release(): void }).release();
    }
  });

  test("the lock never makes a home non-pristine for Migration B (it is taken before Migration B runs)", () => {
    const h = home();
    const taken = acquireCredentialMigrationLock(h);
    expect(describeHomePristineness(h)).toEqual({ pristine: true });
    (taken as { release(): void }).release();
  });

  test("the adopt child acts only while its PARENT holds the lock", () => {
    const h = home();
    expect(adoptLockRefusal(h, process.pid)).toContain("no holder");
    const taken = acquireCredentialMigrationLock(h);
    expect(adoptLockRefusal(h, process.pid)).toBeUndefined();
    expect(adoptLockRefusal(h, process.ppid)).toContain(`(${process.pid})`);
    (taken as { release(): void }).release();
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
