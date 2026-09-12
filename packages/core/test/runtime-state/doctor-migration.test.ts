// Phase 9c (Task M Step 10) — the `winter doctor` migration rows.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseMigration, formatMigrationDoctorLines } from "../../src/runtime-state/doctor";
import { FileSecretStore } from "../../src/auth/secret-store";
import { runMigrationB, planMigrationB } from "../../src/migration/migrate-b";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "winter-doctor-migration-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("diagnoseMigration / formatMigrationDoctorLines", () => {
  test("absent: no manifest, no legacy home present, zero legacy keychain items", async () => {
    const parent = tempDir();
    const report = await diagnoseMigration({
      home: join(parent, "home"),
      legacyHome: join(parent, "legacy"),
      legacyKeychainService: "com.example.legacy",
      legacyStore: new FileSecretStore(join(parent, "legacy-secrets")),
    });
    expect(report.status).toBe("absent");
    expect(report.legacyHomePresent).toBe(false);
    expect(report.legacyKeychainRemaining).toBe(0);
    expect(formatMigrationDoctorLines(report)).toEqual(["migration: absent"]);
  });

  test("complete: after a real migration, reports complete + the legacy home line + the keychain-remaining line, values never included", async () => {
    const parent = tempDir();
    const legacyHome = join(parent, "legacy");
    mkdirSync(legacyHome, { recursive: true });
    writeFileSync(join(legacyHome, "settings.json"), JSON.stringify({ schemaVersion: 1 }));
    const home = join(parent, "home");
    const legacySecrets = new FileSecretStore(join(parent, "legacy-secrets"));
    await legacySecrets.set("openai-api-key", "sk-super-secret-value");
    const secretsTo = new FileSecretStore(join(parent, "secrets-to"));

    const plan = await planMigrationB({ legacyHome, home, profile: "dev" });
    await runMigrationB(plan, { from: legacySecrets, to: secretsTo, log: () => {} });

    // The legacy home is left on disk after migration (Migration B copies, never deletes the
    // source) — "legacy keychain items remaining" reflects that the LEGACY service still has the
    // item too (copying never deletes the source secret either).
    const report = await diagnoseMigration({
      home,
      legacyHome,
      legacyKeychainService: "com.example.legacy",
      legacyStore: legacySecrets,
    });
    expect(report.status).toBe("complete");
    expect(report.legacyHomePresent).toBe(true);
    expect(report.legacyKeychainRemaining).toBe(1);

    const lines = formatMigrationDoctorLines(report);
    expect(lines[0]).toContain("complete");
    expect(lines[0]).toContain(legacyHome);
    expect(lines.some((l) => l.includes("legacy home present"))).toBe(true);
    expect(lines.some((l) => l.includes("legacy keychain items remaining: 1 under com.example.legacy"))).toBe(true);
    expect(lines.join("\n")).not.toContain("sk-super-secret-value");
  });

  test("in-progress: reports IN PROGRESS with the resume/rollback hint", async () => {
    const parent = tempDir();
    const home = join(parent, "home");
    mkdirSync(join(home, "migration"), { recursive: true });
    writeFileSync(
      join(home, "migration", "manifest.json"),
      JSON.stringify({ schemaVersion: 1, startedAt: new Date().toISOString(), legacyHome: "/x", home, profile: "dev", status: "in-progress", entries: [], keychain: [] }),
    );
    const report = await diagnoseMigration({
      home,
      legacyHome: join(parent, "legacy"),
      legacyKeychainService: "com.example.legacy",
      legacyStore: new FileSecretStore(join(parent, "legacy-secrets")),
    });
    expect(report.status).toBe("in-progress");
    const lines = formatMigrationDoctorLines(report);
    expect(lines[0]).toContain("IN PROGRESS");
    expect(lines[0]).toContain("winter migrate --resume");
    expect(lines[0]).toContain("winter migrate --rollback");
  });
});
