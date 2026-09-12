import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore, readMigrationManifest, type SecretStore } from "@yanlinglabs/winter-core";
import { runMigrateCommand, type MigrateCommandDeps } from "../src/commands/migrate";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "winter-cli-migrate-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function seedLegacyHome(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1 }));
  mkdirSync(join(root, "sessions"), { recursive: true });
  writeFileSync(join(root, "sessions", "a.jsonl"), '{"type":"user_message"}\n');
}

function baseDeps(overrides: Partial<MigrateCommandDeps> = {}): { deps: MigrateCommandDeps; lines: string[]; errLines: string[] } {
  const lines: string[] = [];
  const errLines: string[] = [];
  const parent = tempDir();
  const deps: MigrateCommandDeps = {
    home: join(parent, "home"),
    profile: "dev",
    argv: [],
    secretsTo: new FileSecretStore(join(parent, "secrets-to")) as SecretStore,
    legacySecrets: new FileSecretStore(join(parent, "secrets-from")) as SecretStore,
    isDaemonLockHeld: () => false,
    log: (l) => lines.push(l),
    error: (l) => errLines.push(l),
    confirm: async () => true,
    ...overrides,
  };
  return { deps, lines, errLines };
}

describe("winter migrate — --status", () => {
  test("prints 'none' when the home has never migrated", async () => {
    const { deps, lines } = baseDeps({ argv: ["--status"] });
    const code = await runMigrateCommand(deps);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("none");
  });

  test("does not require the daemon to be stopped", async () => {
    const { deps, lines } = baseDeps({ argv: ["--status"], isDaemonLockHeld: () => true });
    const code = await runMigrateCommand(deps);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("none");
  });

  test("prints a summary after a real run", async () => {
    const parent = tempDir();
    const legacyHome = join(parent, "legacy");
    seedLegacyHome(legacyHome);
    const { deps, lines } = baseDeps({ argv: ["--from", legacyHome, "--yes"] });
    expect(await runMigrateCommand(deps)).toBe(0);
    lines.length = 0;
    const status = baseDeps({ argv: ["--status"], home: deps.home });
    expect(await runMigrateCommand(status.deps)).toBe(0);
    expect(status.lines.join("\n")).toContain("complete");
  });
});

describe("winter migrate — refuses every writing action while the daemon is running", () => {
  for (const argv of [["--resume", "--yes"], ["--rollback", "--yes"], ["--yes"]]) {
    test(`argv=${JSON.stringify(argv)}`, async () => {
      const { deps, errLines } = baseDeps({ argv, isDaemonLockHeld: () => true });
      const code = await runMigrateCommand(deps);
      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("daemon is running");
    });
  }
});

describe("winter migrate — a fresh run (--from, or the default legacyHomeFor)", () => {
  test("--from runs a migration into the current home", async () => {
    const parent = tempDir();
    const legacyHome = join(parent, "legacy");
    seedLegacyHome(legacyHome);
    const { deps, lines } = baseDeps({ argv: ["--from", legacyHome, "--yes"] });

    const code = await runMigrateCommand(deps);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("complete");
    const manifest = readMigrationManifest(deps.home);
    expect(manifest?.status).toBe("complete");
  });

  test("refuses when the named legacy home has no settings.json", async () => {
    const { deps, errLines } = baseDeps({ argv: ["--from", "/definitely/not/a/legacy/home", "--yes"] });
    const code = await runMigrateCommand(deps);
    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("no legacy home found");
  });

  test("refuses when the destination is not pristine", async () => {
    const parent = tempDir();
    const legacyHome = join(parent, "legacy");
    seedLegacyHome(legacyHome);
    const { deps, errLines } = baseDeps({ argv: ["--from", legacyHome, "--yes"] });
    mkdirSync(deps.home, { recursive: true });
    writeFileSync(join(deps.home, "not-pristine.txt"), "x");
    const code = await runMigrateCommand(deps);
    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("not a pristine");
  });

  test("without --yes, asks for confirmation and aborts on 'no'", async () => {
    const parent = tempDir();
    const legacyHome = join(parent, "legacy");
    seedLegacyHome(legacyHome);
    let asked: string | undefined;
    const { deps, lines } = baseDeps({ argv: ["--from", legacyHome], confirm: async (p) => { asked = p; return false; } });
    const code = await runMigrateCommand(deps);
    expect(code).toBe(1);
    expect(asked).toContain("Migrate");
    expect(lines.join("\n")).toContain("aborted");
    expect(readMigrationManifest(deps.home)).toBeNull();
  });
});

describe("winter migrate — --resume and --rollback", () => {
  test("--resume continues a real interrupted run to completion", async () => {
    const parent = tempDir();
    const legacyHome = join(parent, "legacy");
    seedLegacyHome(legacyHome);
    const secretsTo = new FileSecretStore(join(parent, "secrets-to")) as SecretStore;
    const legacySecrets = new FileSecretStore(join(parent, "secrets-from")) as SecretStore;
    const home = join(parent, "home");
    const core = await import("@yanlinglabs/winter-core");
    const plan = await core.planMigrationB({ legacyHome, home, profile: "dev" });
    let n = 0;
    await expect(
      core.runMigrationB(plan, {
        from: legacySecrets,
        to: secretsTo,
        log: () => {},
        beforeEntry: () => { n++; if (n > 1) throw new Error("simulated crash"); },
      }),
    ).rejects.toThrow("simulated crash");
    expect(readMigrationManifest(home)?.status).toBe("in-progress");

    const { deps, lines } = baseDeps({ argv: ["--resume", "--yes"], home, secretsTo, legacySecrets });
    const code = await runMigrateCommand(deps);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("complete");
    expect(readMigrationManifest(home)?.status).toBe("complete");
  });

  test("--rollback removes what a completed run copied", async () => {
    const parent = tempDir();
    const legacyHome = join(parent, "legacy");
    seedLegacyHome(legacyHome);
    const { deps, lines } = baseDeps({ argv: ["--from", legacyHome, "--yes"] });
    expect(await runMigrateCommand(deps)).toBe(0);
    lines.length = 0;

    const rollback = baseDeps({ argv: ["--rollback", "--yes"], home: deps.home, secretsTo: deps.secretsTo, legacySecrets: deps.legacySecrets });
    const code = await runMigrateCommand(rollback.deps);
    expect(code).toBe(0);
    expect(rollback.lines.join("\n")).toContain("rolled-back");
  });

  test("--resume without --yes asks for confirmation", async () => {
    let asked = false;
    const { deps } = baseDeps({ argv: ["--resume"], confirm: async () => { asked = true; return false; } });
    const code = await runMigrateCommand(deps);
    expect(code).toBe(1);
    expect(asked).toBe(true);
  });
});
