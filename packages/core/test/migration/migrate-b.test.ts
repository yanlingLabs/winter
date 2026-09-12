import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIGRATION_B_SECRET_NAMES,
  MigrationRefused,
  describeHomePristineness,
  isPristineHome,
  legacyHomeFor,
  planMigrationB,
  readMigrationManifest,
  resumeMigrationB,
  rollbackMigrationB,
  runMigrationB,
  type MigrationDeps,
  type MigrationPlan,
} from "../../src/migration/migrate-b";
import { completeMarkerPath, manifestPath, rolledBackManifestPath } from "../../src/migration/manifest";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CODEX_SECRET_NAMES, OPENAI_API_KEY_SECRET } from "../../src/auth/legacy-secret-names";
import { CREDENTIAL_MATERIAL_NAMES } from "../../src/auth/credential-material";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { TOKEN_NAMES } from "../../src/auth/tokens";
import { WEB_SEARCH_API_KEY_SECRET } from "../../src/agent/tools/web";
import { EXA_API_KEY_SECRET } from "../../src/agent/tools/search";
import { LEGACY_DEV_HOME_DIR, LEGACY_HOME_DIR, LEGACY_HOME_ENV, LEGACY_WINTER_EXECUTABLE_ENV } from "../../src/legacy-names";

const dirs: string[] = [];
function tempDir(prefix = "winter-migrate-b-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** Populates a legacy home fixture per the plan's own step-1 shape: settings.json, a session
 *  transcript + its index, memory files (global + project), plugins/hooks/skills/output-styles
 *  scaffolding, remote config, a routines db + its wal sibling, a stand-in socket file, a daemon
 *  log, and a cache file. */
function seedLegacyHome(root: string): void {
  mkdirSync(root, { recursive: true });
  write(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, runtimes: { winterExecutable: `$${LEGACY_WINTER_EXECUTABLE_ENV}` } }, null, 2));
  write(join(root, "sessions", "s1", "a.jsonl"), '{"type":"user_message","text":"hi"}\n');
  write(join(root, "sessions", "index.db"), "sqlite-bytes-stand-in");
  write(join(root, "memory", "_global", "x.md"), "# a global memory fact\n");
  write(join(root, "projects", "proj1", "memory", "y.md"), "# a project memory fact\n");
  write(join(root, "plugins", "p1", "manifest.json"), "{}");
  write(join(root, "hooks", "h1.json"), "{}");
  write(join(root, "skills", "self", "s1.md"), "# a skill\n");
  write(join(root, "output-styles", "custom.md"), "# a style\n");
  write(join(root, "remote", "config.json"), "{}");
  write(join(root, "routines.db"), "routines-bytes");
  write(join(root, "routines.db-wal"), "wal-bytes");
  write(join(root, "run", "core.sock"), "socket-stand-in");
  write(join(root, "logs", "daemon.log"), "log line\n");
  write(join(root, "cache", "z"), "cache-bytes");
  write(join(root, "daemon.log"), "top-level log line\n");
}

async function seedTo(legacyHome: string, home: string, profile: "dev" | "dist" = "dev") {
  seedLegacyHome(legacyHome);
  const plan = await planMigrationB({ legacyHome, home, profile });
  return plan;
}

function noopDeps(overrides: Partial<MigrationDeps> = {}): MigrationDeps {
  return {
    from: new FileSecretStore(tempDir("winter-migrate-b-secrets-from-")),
    to: new FileSecretStore(tempDir("winter-migrate-b-secrets-to-")),
    log: () => {},
    ...overrides,
  };
}

describe("planMigrationB — classification (Step 1)", () => {
  test("lists every legacy file as copied, except the disposable set and settings.json", async () => {
    const legacyHome = tempDir();
    const home = tempDir();
    const plan = await seedTo(legacyHome, home);
    const byDest = new Map(plan.entries.map((e) => [e.dest.slice(home.length + 1), e.status]));

    expect(byDest.get("settings.json")).toBe("rekeyed");
    expect(byDest.get(join("sessions", "s1", "a.jsonl"))).toBe("copied");
    expect(byDest.get(join("sessions", "index.db"))).toBe("rebuilt");
    expect(byDest.get(join("memory", "_global", "x.md"))).toBe("copied");
    expect(byDest.get(join("projects", "proj1", "memory", "y.md"))).toBe("copied");
    expect(byDest.get(join("plugins", "p1", "manifest.json"))).toBe("copied");
    expect(byDest.get(join("hooks", "h1.json"))).toBe("copied");
    expect(byDest.get(join("skills", "self", "s1.md"))).toBe("copied");
    expect(byDest.get(join("output-styles", "custom.md"))).toBe("copied");
    expect(byDest.get(join("remote", "config.json"))).toBe("copied");
    expect(byDest.get("routines.db")).toBe("copied");
    expect(byDest.get("routines.db-wal")).toBe("skipped");
    expect(byDest.get(join("run", "core.sock"))).toBe("skipped");
    expect(byDest.get(join("logs", "daemon.log"))).toBe("skipped");
    expect(byDest.get(join("cache", "z"))).toBe("skipped");
    expect(byDest.get("daemon.log")).toBe("skipped");
  });
});

describe("runMigrationB — copy + manifest (Step 1)", () => {
  test("copies bytes verbatim (sha256 equality per copied entry), rekeys settings.json, writes the manifest after every entry, and writes COMPLETE last", async () => {
    const legacyHome = tempDir();
    const home = tempDir();
    const plan = await seedTo(legacyHome, home);
    const deps = noopDeps();
    const manifest = await runMigrationB(plan, deps);

    expect(manifest.status).toBe("complete");
    expect(manifest.finishedAt).toBeDefined();
    expect(existsSync(completeMarkerPath(home))).toBe(true);

    for (const entry of manifest.entries) {
      if (entry.status === "copied") {
        expect(existsSync(entry.dest)).toBe(true);
        const srcHash = sha256(readFileSync(entry.src));
        const destHash = sha256(readFileSync(entry.dest));
        expect(destHash).toBe(srcHash);
        expect(entry.sha256).toBe(srcHash);
      }
      if (entry.status === "skipped" || entry.status === "rebuilt") {
        expect(existsSync(entry.dest)).toBe(false);
      }
    }

    const rekeyedSettings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(rekeyedSettings.runtimes.winterExecutable).toBe("$WINTER_RUNTIME_EXECUTABLE");

    // Manifest on disk matches what was returned, and readMigrationManifest agrees.
    const onDisk = readMigrationManifest(home);
    expect(onDisk).toEqual(manifest);
  });
});

describe("MIGRATION_B_SECRET_NAMES — literal parity with the canonical secret-name constants", () => {
  test("is set-equal to the ACTUAL canonical constants declared elsewhere — a real drift tripwire, not a second hand-typed list", () => {
    const canonical = [
      CREDENTIAL_MATERIAL_NAMES.openai,
      CREDENTIAL_MATERIAL_NAMES.codexOauth,
      ANTHROPIC_CREDENTIAL_SECRET_NAME,
      TOKEN_NAMES.harness,
      TOKEN_NAMES.admin,
      TOKEN_NAMES.remote,
      OPENAI_API_KEY_SECRET,
      CODEX_SECRET_NAMES.access,
      CODEX_SECRET_NAMES.refresh,
      CODEX_SECRET_NAMES.id,
      CODEX_SECRET_NAMES.account,
      CODEX_SECRET_NAMES.expires,
      WEB_SEARCH_API_KEY_SECRET,
      EXA_API_KEY_SECRET,
    ];
    expect([...MIGRATION_B_SECRET_NAMES].sort()).toEqual([...canonical].sort());
    // Sanity: the canonical list itself is exactly 14 distinct names — proves this test isn't
    // vacuously passing on two empty (or duplicate-collapsed) arrays.
    expect(new Set(canonical).size).toBe(14);
  });

  test("contains exactly the pinned 14 literal names (global-constraints.md, verbatim)", () => {
    expect([...MIGRATION_B_SECRET_NAMES].sort()).toEqual(
      [
        "openai:default",
        "codex-oauth:default",
        "anthropic:default",
        "harness-token",
        "admin-token",
        "remote-token",
        "openai-api-key",
        "codex-access-token",
        "codex-refresh-token",
        "codex-id-token",
        "codex-account-id",
        "codex-expires-at",
        "web-search-api-key",
        "exa-api-key",
      ].sort(),
    );
  });
});

describe("runMigrationB — Keychain (Step 4)", () => {
  test("present names copy, absent names record absent, an existing destination name is never overwritten, and log lines never carry a value", async () => {
    const legacyHome = tempDir();
    const home = tempDir();
    const plan = await seedTo(legacyHome, home);

    const from = new FileSecretStore(tempDir());
    const to = new FileSecretStore(tempDir());
    await from.set("openai-api-key", "sk-legacy-secret-value");
    await from.set("anthropic:default", "should-never-be-read");
    await to.set("anthropic:default", "already-there-do-not-clobber");

    const lines: string[] = [];
    const manifest = await runMigrationB(plan, { from, to, log: (l) => lines.push(l) });

    const byName = new Map(manifest.keychain.map((k) => [k.name, k.status]));
    expect(byName.get("openai-api-key")).toBe("copied");
    expect(byName.get("anthropic:default")).toBe("skipped-existing");
    expect(byName.get("harness-token")).toBe("absent");

    expect(await to.get("openai-api-key")).toBe("sk-legacy-secret-value");
    expect(await to.get("anthropic:default")).toBe("already-there-do-not-clobber"); // never overwritten

    const joined = lines.join("\n");
    expect(joined).not.toContain("sk-legacy-secret-value");
    expect(joined).not.toContain("should-never-be-read");
    expect(joined).not.toContain("already-there-do-not-clobber");
  });
});

describe("isPristineHome (Step 3, P9c-10)", () => {
  test("true for an absent path", () => {
    const parent = tempDir();
    expect(isPristineHome(join(parent, "does-not-exist"))).toBe(true);
  });

  test("true for an empty directory", () => {
    const home = tempDir();
    expect(isPristineHome(home)).toBe(true);
  });

  test("true for a directory containing only empty bootstrap-set dirs, run/ tolerating core.lock and core.sock", () => {
    const home = tempDir();
    for (const d of ["agents", "hooks", "logs", "memory", "outputs", "plugins", "projects", "runtimes", "sessions", "skills"]) {
      mkdirSync(join(home, d), { recursive: true });
    }
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(join(home, "run", "core.lock"), "{}");
    writeFileSync(join(home, "run", "core.sock"), "");
    expect(isPristineHome(home)).toBe(true);
  });

  test("false once a file exists inside a bootstrap-set dir", () => {
    const home = tempDir();
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", "index.db"), "x");
    expect(isPristineHome(home)).toBe(false);
  });

  test("false once settings.json (or any other top-level file) exists", () => {
    const home = tempDir();
    writeFileSync(join(home, "settings.json"), "{}");
    expect(isPristineHome(home)).toBe(false);
  });

  // Review M2: a Finder browse of a fresh home drops known OS noise with no user action at all —
  // it must never silently block the first-boot migration.
  test("a .DS_Store beside otherwise-empty bootstrap dirs is still pristine", () => {
    const home = tempDir();
    for (const d of ["agents", "hooks", "logs", "memory", "outputs", "plugins", "projects", "runtimes", "sessions", "skills"]) {
      mkdirSync(join(home, d), { recursive: true });
    }
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(join(home, ".DS_Store"), "binary-finder-metadata");
    writeFileSync(join(home, ".localized"), "");
    writeFileSync(join(home, "._sessions"), "apple-double-sidecar");
    expect(isPristineHome(home)).toBe(true);
  });

  test("a .DS_Store PLUS a real top-level file is still not pristine — the noise ignore is not a blanket exemption", () => {
    const home = tempDir();
    writeFileSync(join(home, ".DS_Store"), "binary-finder-metadata");
    writeFileSync(join(home, "not-noise.txt"), "real content");
    expect(isPristineHome(home)).toBe(false);
  });

  test("OS noise INSIDE a bootstrap-set directory still counts as real content — the ignore is top-level only", () => {
    const home = tempDir();
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", ".DS_Store"), "binary-finder-metadata");
    expect(isPristineHome(home)).toBe(false);
  });

  test("describeHomePristineness names the first offending entry, full path", () => {
    const home = tempDir();
    writeFileSync(join(home, ".DS_Store"), "x"); // ignored
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", "index.db"), "x");
    const check = describeHomePristineness(home);
    expect(check.pristine).toBe(false);
    expect(check.reason).toBe(join(home, "sessions", "index.db"));
  });

  test("describeHomePristineness reports pristine:true with no reason for a genuinely pristine home", () => {
    expect(describeHomePristineness(tempDir())).toEqual({ pristine: true });
  });

  test("planMigrationB refuses a non-pristine destination, naming the path and the fix", async () => {
    const legacyHome = tempDir();
    seedLegacyHome(legacyHome);
    const home = tempDir();
    writeFileSync(join(home, "settings.json"), "{}");
    let caught: unknown;
    try {
      await planMigrationB({ legacyHome, home, profile: "dev" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationRefused);
    expect((caught as MigrationRefused).code).toBe("destination_not_pristine");
    expect((caught as MigrationRefused).message).toContain(home);
    expect((caught as MigrationRefused).message).toContain("mv");
  });
});

describe("legacyHomeFor", () => {
  test("the legacy home override env var wins when set", () => {
    expect(legacyHomeFor("dev", { [LEGACY_HOME_ENV]: "/custom/legacy" })).toBe("/custom/legacy");
    expect(legacyHomeFor("dist", { [LEGACY_HOME_ENV]: "/custom/legacy" })).toBe("/custom/legacy");
  });
  test("falls back to the legacy dev/dist home directory names under the user's home", () => {
    const home = require("node:os").homedir();
    expect(legacyHomeFor("dev", {})).toBe(join(home, LEGACY_DEV_HOME_DIR));
    expect(legacyHomeFor("dist", {})).toBe(join(home, LEGACY_HOME_DIR));
  });
});

describe("resume + rollback (Step 2)", () => {
  async function runInterrupted(legacyHome: string, home: string, stopAfter: number): Promise<MigrationPlan> {
    const plan = await seedTo(legacyHome, home);
    let count = 0;
    const deps = noopDeps({
      beforeEntry: () => {
        count++;
        if (count > stopAfter) throw new Error("simulated crash");
      },
    });
    await expect(runMigrationB(plan, deps)).rejects.toThrow("simulated crash");
    return plan;
  }

  test("an interrupted run leaves the manifest in-progress", async () => {
    const legacyHome = tempDir();
    const home = tempDir();
    await runInterrupted(legacyHome, home, 2);
    const manifest = readMigrationManifest(home);
    expect(manifest?.status).toBe("in-progress");
    expect(manifest?.entries.length).toBeGreaterThan(0);
    expect(existsSync(completeMarkerPath(home))).toBe(false);
  });

  test("resumeMigrationB finishes with a manifest matching an uninterrupted run (modulo timestamps)", async () => {
    const legacyHomeA = tempDir();
    const homeA = tempDir();
    await runInterrupted(legacyHomeA, homeA, 3);
    const resumed = await resumeMigrationB(homeA, noopDeps());
    expect(resumed.status).toBe("complete");

    const legacyHomeB = tempDir();
    const homeB = tempDir();
    const planB = await seedTo(legacyHomeB, homeB);
    const clean = await runMigrationB(planB, noopDeps());

    const strip = (m: typeof resumed) => ({
      ...m,
      startedAt: undefined,
      finishedAt: undefined,
      legacyHome: undefined,
      home: undefined,
      entries: m.entries.map((e) => ({ ...e, src: e.src.replace(m.legacyHome, ""), dest: e.dest.replace(m.home, "") })),
      keychain: m.keychain,
    });
    expect(strip(resumed)).toEqual(strip(clean));
  });

  test("resumeMigrationB refuses when there is nothing in-progress to resume", async () => {
    const home = tempDir();
    let caught: unknown;
    try {
      await resumeMigrationB(home, noopDeps());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationRefused);
    expect((caught as MigrationRefused).code).toBe("nothing_to_resume");
  });

  test("rollbackMigrationB removes exactly the copied/rekeyed/rebuilt dest entries, never touches the legacy home, and leaves a rolled-back manifest copy", async () => {
    const legacyHome = tempDir();
    const home = tempDir();
    const plan = await seedTo(legacyHome, home);

    const legacyHashesBefore = new Map<string, string>();
    for (const e of plan.entries) legacyHashesBefore.set(e.src, sha256(readFileSync(e.src)));

    const manifest = await runMigrationB(plan, noopDeps());
    const rolledBack = await rollbackMigrationB(home, { log: () => {} });

    expect(rolledBack.status).toBe("rolled-back");
    for (const entry of manifest.entries) {
      if (entry.status === "copied" || entry.status === "rekeyed" || entry.status === "rebuilt") {
        expect(existsSync(entry.dest)).toBe(false);
      }
    }
    // Legacy home is byte-for-byte untouched.
    for (const [src, hashBefore] of legacyHashesBefore) {
      expect(sha256(readFileSync(src))).toBe(hashBefore);
    }
    // Working manifest is gone; the rolled-back copy exists and reflects the final status.
    expect(existsSync(manifestPath(home))).toBe(false);
    expect(existsSync(completeMarkerPath(home))).toBe(false);
    expect(existsSync(rolledBackManifestPath(home))).toBe(true);
    const onDisk = JSON.parse(readFileSync(rolledBackManifestPath(home), "utf8"));
    expect(onDisk.status).toBe("rolled-back");
  });

  test("rollbackMigrationB keeps a destination file the daemon has since modified (hash mismatch), rather than deleting it", async () => {
    const legacyHome = tempDir();
    const home = tempDir();
    const plan = await seedTo(legacyHome, home);
    const manifest = await runMigrationB(plan, noopDeps());
    const touched = manifest.entries.find((e) => e.status === "copied");
    expect(touched).toBeDefined();
    writeFileSync(touched!.dest, "modified by the daemon after migration");

    await rollbackMigrationB(home, { log: () => {} });
    expect(existsSync(touched!.dest)).toBe(true);
    expect(readFileSync(touched!.dest, "utf8")).toBe("modified by the daemon after migration");
  });

  test("rollbackMigrationB deletes a 'rebuilt' entry's dest UNCONDITIONALLY when the daemon has since created it — there is no recorded hash to guard against overwrite", async () => {
    const legacyHome = tempDir();
    const home = tempDir();
    const plan = await seedTo(legacyHome, home);
    const manifest = await runMigrationB(plan, noopDeps());
    const rebuilt = manifest.entries.find((e) => e.status === "rebuilt");
    expect(rebuilt).toBeDefined();
    expect(existsSync(rebuilt!.dest)).toBe(false); // migration never wrote it
    // Simulate the daemon having since opened sessions/index.db and rebuilt it for real.
    writeFileSync(rebuilt!.dest, "a real sqlite index the daemon rebuilt after migration");

    await rollbackMigrationB(home, { log: () => {} });
    expect(existsSync(rebuilt!.dest)).toBe(false); // removed unconditionally — non-destructive by construction (the store rebuilds it again from the untouched JSONL)
  });

  test("rollbackMigrationB refuses when there is no manifest at all", async () => {
    const home = tempDir();
    let caught: unknown;
    try {
      await rollbackMigrationB(home, { log: () => {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationRefused);
    expect((caught as MigrationRefused).code).toBe("nothing_to_rollback");
  });
});
