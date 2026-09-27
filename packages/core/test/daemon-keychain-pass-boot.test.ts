// WS-27 review (N1): a credential migration lock held by a live process past the boot's bound ENDS the boot,
// typed, before any credential is read — the daemon never runs on to `ensureTokens` without its recovery.
// The production pass runs only on a profile's default home; the `keychainPassForTests` seam drives the real
// `beginKeychainPass` here, with the keychain status and the lock's holder stood in (never the Keychain).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { CredentialMigrationBusy, waitForCredentialMigrationLock } from "../src/auth/credential-migration-lock";
import type { CredentialKeychain } from "../src/auth/credential-acl";
import { beginKeychainPass } from "../src/auth/keychain-boot";
import { FileSecretStore, type SecretStore } from "../src/auth/secret-store";
import { startDaemon } from "../src/daemon";
import { withTempHome } from "./runtime-state/support";

test("a live foreign holder of the credential migration lock: the boot waits, then refuses — no credential read, no ensureTokens", async () => {
  await withTempHome(async (home) => {
    const reads: string[] = [];
    const files = new FileSecretStore(join(home, "test-secrets"));
    const secrets: SecretStore = {
      get: async (name) => { reads.push(name); return files.get(name); },
      set: async (name, value) => files.set(name, value),
      delete: async (name) => files.delete(name),
    };
    let waited = 0;
    let refused: unknown;
    try {
      await startDaemon({
        home, secrets, agentProvider: null,
        keychainPassForTests: (h) => beginKeychainPass({
          home: h, service: "ws27.never-used", log: () => {}, unlocked: () => true,
          waitForLock: (hh) => waitForCredentialMigrationLock(hh, { waitMs: 300, pollMs: 20, acquire: () => { waited++; return { heldBy: 4242 }; } }),
        }),
      });
    } catch (err) { refused = err; }
    expect(refused).toBeInstanceOf(CredentialMigrationBusy);
    expect(waited).toBeGreaterThan(1);
    // `ensureTokens` reads harness-token/admin-token/remote-token; the presence probe reads the provider slots.
    expect(reads).toEqual([]);
  });
});

test("M-C: a pass that throws after taking the lock releases it", async () => {
  let released = 0;
  const lock = { release() { released++; } };
  const failing = { keychain: null, service: "ws27.never-used", ops: { createAccess: () => { throw new Error("boom"); }, list: () => { throw new Error("recovery must not run"); } } } as unknown as CredentialKeychain;
  let thrown: unknown;
  try {
    // Everything after the lock is built never to throw, so force it: the access list fails to build and
    // the log line reporting that throws — an exception escaping the pass after the lock was taken.
    await beginKeychainPass({ home: "/x", service: "s", log: () => {}, unlocked: () => true, waitForLock: async () => lock, kc: { ...failing, log: () => { throw new Error("log failed"); } } });
  } catch (err) { thrown = err; }
  expect(thrown).toBeInstanceOf(Error);
  expect(released).toBe(1);
});
