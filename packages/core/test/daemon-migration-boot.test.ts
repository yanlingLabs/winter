// Phase 9c Migration B — proves `daemon.ts`'s OWN boot hook, against a REAL `startDaemon`, never
// against a hand-built mirror of it. Every scenario uses the `opts.migration` test seam (see
// `startDaemon`'s own doc comment): `home`/`legacyHome` are nested, never-pre-bootstrapped
// directories under one mkdtemp parent (so `isPristineHome` sees a genuinely absent destination,
// unlike `test/runtime-state/support.ts`'s `withTempHome`, which pre-bootstraps and would make
// every scenario here "not pristine" before it even starts), and both Keychain sides are
// `FileSecretStore`s — this file never touches `Bun.secrets` or any real home.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { FileSecretStore } from "../src/auth/secret-store";
import { MigrationRefused } from "../src/migration/migrate-b";
import { readMigrationManifest } from "../src/migration/manifest";
import { TOKEN_NAMES } from "../src/auth/tokens";

const dirs: string[] = [];
function tempParent(): string {
  const d = mkdtempSync(join(tmpdir(), "winter-migration-boot-"));
  dirs.push(d);
  return d;
}

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  const stopping = daemon?.stop();
  daemon = undefined;
  await stopping;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function seedLegacyHome(legacyHome: string, extra?: (root: string) => void): void {
  mkdirSync(legacyHome, { recursive: true });
  writeFileSync(join(legacyHome, "settings.json"), JSON.stringify({ schemaVersion: 1 }, null, 2));
  mkdirSync(join(legacyHome, "sessions"), { recursive: true });
  writeFileSync(join(legacyHome, "sessions", "a.jsonl"), '{"type":"user_message"}\n');
  extra?.(legacyHome);
}

describe("daemon.ts boot hook — Migration B (P9c)", () => {
  test("(a) pristine home + a legacy home present -> migrates before serving, and a pre-existing legacy remote-token wins over a freshly-minted one", async () => {
    const parent = tempParent();
    const home = join(parent, "home"); // deliberately never bootstrapped before this call
    const legacyHome = join(parent, "legacy");
    seedLegacyHome(legacyHome);

    const legacySecrets = new FileSecretStore(join(parent, "legacy-secrets"));
    await legacySecrets.set(TOKEN_NAMES.remote, "legacy-remote-token-value");

    daemon = await startDaemon({
      home,
      secrets: new FileSecretStore(join(parent, "secrets")),
      migration: { legacyHome, legacySecrets },
      agentProvider: null,
    });

    // Migration ran to completion, and ran BEFORE ensureTokens() — the legacy remote-token was
    // copied in first, so ensureTokens() found it already present and never minted a fresh one.
    expect(daemon.tokens.remote).toBe("legacy-remote-token-value");

    const manifest = readMigrationManifest(home);
    expect(manifest?.status).toBe("complete");
    const sessionEntry = manifest?.entries.find((e) => e.dest.endsWith(join("sessions", "a.jsonl")));
    expect(sessionEntry?.status).toBe("copied");

    // The daemon actually came up on the migrated home.
    expect(daemon.settings()).not.toBeNull();
  });

  test("(b) an in-progress manifest refuses typed (home_half_migrated), and never auto-resumes", async () => {
    const parent = tempParent();
    const home = join(parent, "home");
    const legacyHome = join(parent, "legacy");
    seedLegacyHome(legacyHome);
    mkdirSync(join(home, "migration"), { recursive: true });
    writeFileSync(
      join(home, "migration", "manifest.json"),
      JSON.stringify({ schemaVersion: 1, startedAt: new Date().toISOString(), legacyHome, home, profile: "dev", status: "in-progress", entries: [], keychain: [] }, null, 2),
    );

    let caught: unknown;
    try {
      daemon = await startDaemon({
        home,
        secrets: new FileSecretStore(join(parent, "secrets")),
        migration: { legacyHome, legacySecrets: new FileSecretStore(join(parent, "legacy-secrets")) },
        agentProvider: null,
      });
    } catch (err) {
      caught = err;
    }
    daemon = undefined; // startDaemon never returned a handle to stop
    expect(caught).toBeInstanceOf(MigrationRefused);
    expect((caught as MigrationRefused).code).toBe("home_half_migrated");
  });

  test("(c) a non-pristine home with a legacy home present boots normally, migrates nothing, and logs exactly one migration line", async () => {
    const parent = tempParent();
    const home = join(parent, "home");
    const legacyHome = join(parent, "legacy");
    seedLegacyHome(legacyHome);
    // Give `home` content of its own BEFORE boot — a top-level file outside the bootstrap set is
    // enough to fail `isPristineHome`, without colliding with anything the daemon itself opens
    // (unlike a fake `sessions/index.db`, which `SessionStore`'s real constructor would then try —
    // and fail — to open as an actual SQLite file).
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "not-part-of-a-fresh-home.txt"), "already has content");

    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      daemon = await startDaemon({
        home,
        secrets: new FileSecretStore(join(parent, "secrets")),
        migration: { legacyHome, legacySecrets: new FileSecretStore(join(parent, "legacy-secrets")) },
        agentProvider: null,
      });
    } finally {
      console.error = originalError;
    }

    expect(readMigrationManifest(home)).toBeNull(); // nothing migrated
    const migrationLines = lines.filter((l) => l.startsWith("migration:"));
    expect(migrationLines.length).toBe(1);
    expect(migrationLines[0]).toContain("not pristine");
  });

  test("a caller that supplies `secrets` without `migration` is migration-inert even when a legacy home would otherwise qualify", async () => {
    const parent = tempParent();
    const home = join(parent, "home");
    // No legacyHome is ever passed, and `secrets` IS supplied — the boot hook must not resolve any
    // real legacyHomeFor()/LegacyKeychainSecretStore in this branch.
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(parent, "secrets")), agentProvider: null });
    expect(readMigrationManifest(home)).toBeNull();
  });
});
