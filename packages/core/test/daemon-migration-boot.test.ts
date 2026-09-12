// Phase 9c Migration B — proves `daemon.ts`'s OWN boot hook, against a REAL `startDaemon`, never
// against a hand-built mirror of it. Every scenario uses the `opts.migration` test seam (see
// `startDaemon`'s own doc comment): `home`/`legacyHome` are nested, never-pre-bootstrapped
// directories under one mkdtemp parent (so `isPristineHome` sees a genuinely absent destination,
// unlike `test/runtime-state/support.ts`'s `withTempHome`, which pre-bootstraps and would make
// every scenario here "not pristine" before it even starts), and both Keychain sides are
// `FileSecretStore`s — this file never touches `Bun.secrets` or any real home.
//
// P9c-15: auto-migration additionally requires `home` to resolve to the profile's OWN DEFAULT home
// (`~/.winter` dist, `~/.winter-dev` dev) — a real safety ruling made AFTER a review found that any
// real daemon spawned against a temp/custom `WINTER_HOME` with no injected `secrets` (a binary-
// backed e2e test, `verify:workflow`, a live-gate script, a developer's ad-hoc `WINTER_HOME=/tmp/x
// winter daemon run`) would otherwise auto-migrate the user's REAL legacy home into a throwaway
// directory. `opts.migration.homedirOverride` is the ONLY way this file ever makes a temp `home`
// register as "the default" — it overrides `isDefaultWinterHome`'s `homedir()` call, so the real
// home directory is never consulted, let alone touched, by anything below.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { FileSecretStore } from "../src/auth/secret-store";
import { MigrationRefused } from "../src/migration/migrate-b";
import { readMigrationManifest } from "../src/migration/manifest";
import { TOKEN_NAMES } from "../src/auth/tokens";
import { isDefaultWinterHome } from "../src/winter-dir";

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

function captureConsoleError(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.error = original; } };
}

describe("daemon.ts boot hook — Migration B (P9c-15: default-home gate)", () => {
  test("(a) a NON-default pristine home with a legacy home present never auto-migrates, and logs exactly one line naming the default-home gate", async () => {
    const parent = tempParent();
    // `home` is an ordinary temp dir — never the resolved default for ANY profile — even though it
    // is otherwise perfectly pristine and a legacy home sits right there with a real settings.json.
    const home = join(parent, "home");
    const legacyHome = join(parent, "legacy");
    seedLegacyHome(legacyHome);

    const capture = captureConsoleError();
    try {
      daemon = await startDaemon({
        home,
        secrets: new FileSecretStore(join(parent, "secrets")),
        migration: { legacyHome, legacySecrets: new FileSecretStore(join(parent, "legacy-secrets")) },
        agentProvider: null,
      });
    } finally {
      capture.restore();
    }

    expect(readMigrationManifest(home)).toBeNull(); // nothing migrated
    const migrationLines = capture.lines.filter((l) => l.startsWith("migration:"));
    expect(migrationLines.length).toBe(1);
    expect(migrationLines[0]).toContain("not the default home");
    expect(migrationLines[0]).toContain(home);
    expect(migrationLines[0]).toContain("winter migrate --from");
  });

  test("(a2) with homedirOverride making `home` resolve as the default, migration proceeds end to end — proves the gate is additive, not a silent replacement for isPristineHome", async () => {
    const parent = tempParent();
    // `home` = <parent>/.winter, and homedirOverride makes `homedir()` resolve to `parent` — so
    // `isDefaultWinterHome(home, "dist", homedirOverride)` is true WITHOUT ever consulting the real
    // home directory (the daemon's ambient profile is "dist" — no WINTER_PROFILE set in this suite).
    const home = join(parent, ".winter");
    const legacyHome = join(parent, "legacy");
    seedLegacyHome(legacyHome);

    const legacySecrets = new FileSecretStore(join(parent, "legacy-secrets"));
    await legacySecrets.set(TOKEN_NAMES.remote, "legacy-remote-token-value");

    daemon = await startDaemon({
      home,
      secrets: new FileSecretStore(join(parent, "secrets")),
      migration: { legacyHome, legacySecrets, homedirOverride: () => parent },
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

  test("(b) an in-progress manifest refuses typed (home_half_migrated) BEFORE the default-home gate is even consulted, and never auto-resumes", async () => {
    const parent = tempParent();
    const home = join(parent, "home"); // non-default — proves the refusal fires regardless
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

  test("(c) a NON-pristine default-resolved home with a legacy home present boots normally, migrates nothing, and logs exactly one 'not pristine' line", async () => {
    const parent = tempParent();
    const home = join(parent, ".winter"); // resolves as default under homedirOverride, below
    const legacyHome = join(parent, "legacy");
    seedLegacyHome(legacyHome);
    // Give `home` content of its own BEFORE boot — a top-level file outside the bootstrap set is
    // enough to fail `isPristineHome`, without colliding with anything the daemon itself opens
    // (unlike a fake `sessions/index.db`, which `SessionStore`'s real constructor would then try —
    // and fail — to open as an actual SQLite file).
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "not-part-of-a-fresh-home.txt"), "already has content");

    const capture = captureConsoleError();
    try {
      daemon = await startDaemon({
        home,
        secrets: new FileSecretStore(join(parent, "secrets")),
        migration: { legacyHome, legacySecrets: new FileSecretStore(join(parent, "legacy-secrets")), homedirOverride: () => parent },
        agentProvider: null,
      });
    } finally {
      capture.restore();
    }

    expect(readMigrationManifest(home)).toBeNull(); // nothing migrated
    const migrationLines = capture.lines.filter((l) => l.startsWith("migration:"));
    expect(migrationLines.length).toBe(1);
    expect(migrationLines[0]).toContain("not pristine");
    // Fix wave C2: the advice here must be the SAME instruction the `winter migrate`/
    // `planMigrationB` refusal itself prints (`mv <home> <home>.bak`, then restart) — never the old
    // `winter migrate --from` advice, which would just hit that same non-pristine refusal.
    expect(migrationLines[0]).toContain(`mv ${home} ${home}.bak`);
    expect(migrationLines[0]).not.toContain("winter migrate --from");
  });

  test("(d) fix wave C3 (P9c-17): a residual throw during Migration B becomes a typed migration_failed refusal, not a crash — and the manifest is left in-progress for --resume", async () => {
    const parent = tempParent();
    const home = join(parent, ".winter"); // resolves as default under homedirOverride, below
    const legacyHome = join(parent, "legacy");
    seedLegacyHome(legacyHome);

    // The destination-existence check (`to.get`) inside `migrateOneSecret` is NOT individually
    // wrapped (only `from.get`/`to.set` are, per the per-item non-fatal contract) — a store that
    // throws there is exactly the kind of residual failure the daemon-level wrap exists to catch,
    // never a crash-loop.
    const throwingSecrets = {
      get: async (): Promise<string | null> => { throw new Error("keychain daemon unreachable"); },
      set: async (): Promise<void> => {},
    };

    let caught: unknown;
    try {
      daemon = await startDaemon({
        home,
        secrets: throwingSecrets,
        migration: { legacyHome, legacySecrets: new FileSecretStore(join(parent, "legacy-secrets")), homedirOverride: () => parent },
        agentProvider: null,
      });
    } catch (err) {
      caught = err;
    }
    daemon = undefined; // startDaemon never returned a handle to stop
    expect(caught).toBeInstanceOf(MigrationRefused);
    expect((caught as MigrationRefused).code).toBe("migration_failed");
    expect((caught as MigrationRefused).message).toContain("winter migrate --resume");

    // The file phase ran to completion (and was written to disk) before the keychain phase hit the
    // throwing store — the manifest is genuinely in-progress on disk, exactly what `winter migrate
    // --resume`/`--rollback` expects to find.
    const manifest = readMigrationManifest(home);
    expect(manifest?.status).toBe("in-progress");
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

describe("isDefaultWinterHome (P9c-15) — pure predicate, a fake homedir only, NEVER the real ~", () => {
  test("recognises the dist default (~/.winter) under a fake home directory", () => {
    expect(isDefaultWinterHome("/fake/home/.winter", "dist", () => "/fake/home")).toBe(true);
    expect(isDefaultWinterHome("/fake/home/.winter-dev", "dist", () => "/fake/home")).toBe(false);
  });

  test("recognises the dev default (~/.winter-dev) under a fake home directory", () => {
    expect(isDefaultWinterHome("/fake/home/.winter-dev", "dev", () => "/fake/home")).toBe(true);
    expect(isDefaultWinterHome("/fake/home/.winter", "dev", () => "/fake/home")).toBe(false);
  });

  test("a custom/temp home is never the default, for either profile", () => {
    expect(isDefaultWinterHome("/tmp/some-random-dir", "dist", () => "/fake/home")).toBe(false);
    expect(isDefaultWinterHome("/tmp/some-random-dir", "dev", () => "/fake/home")).toBe(false);
  });

  test("path.resolve semantics: a trailing slash or a redundant segment still matches", () => {
    expect(isDefaultWinterHome("/fake/home/.winter/", "dist", () => "/fake/home")).toBe(true);
    expect(isDefaultWinterHome("/fake/home/foo/../.winter", "dist", () => "/fake/home")).toBe(true);
  });
});
