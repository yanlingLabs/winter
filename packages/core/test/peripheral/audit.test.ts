import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../../src/peripheral/audit";

function lines(path: string): unknown[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

describe("AuditLog", () => {
  test("append writes ts-stamped JSONL, one line per entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-audit-"));
    const path = join(dir, "audit.jsonl");
    const log = new AuditLog(path);

    const before = Date.now();
    log.append({ kind: "lease", action: "lease_grant", leaseId: "lease_1", class: "noop", holder: { kind: "session", id: "s1" } });
    log.append({ kind: "lease", action: "lease_lost", leaseId: "lease_1", reason: "expired", class: "noop", holder: { kind: "session", id: "s1" } });
    const after = Date.now();

    const rows = lines(path) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "lease", action: "lease_grant", leaseId: "lease_1", class: "noop", holder: { kind: "session", id: "s1" } });
    expect(rows[1]).toMatchObject({ kind: "lease", action: "lease_lost", leaseId: "lease_1", reason: "expired", class: "noop", holder: { kind: "session", id: "s1" } });
    for (const r of rows) {
      expect(typeof r.ts).toBe("number");
      expect(r.ts as number).toBeGreaterThanOrEqual(before);
      expect(r.ts as number).toBeLessThanOrEqual(after);
    }
  });

  test("mkdir-safe: creates missing parent directories on first write", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-audit-"));
    const path = join(dir, "nested", "deeper", "audit.jsonl");
    expect(existsSync(path)).toBe(false);

    new AuditLog(path).append({ action: "advertise" });

    expect(existsSync(path)).toBe(true);
    expect(lines(path)).toHaveLength(1);
  });

  test("a caller-supplied ts field is clobbered by the write-time stamp", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-audit-"));
    const path = join(dir, "audit.jsonl");
    const log = new AuditLog(path);

    log.append({ kind: "lease", action: "lease_grant", leaseId: "lease_1", class: "noop", holder: { kind: "session", id: "s1" }, ts: 1 });

    const row = lines(path)[0] as Record<string, unknown>;
    expect(row.ts).not.toBe(1);
    expect(row.ts as number).toBeGreaterThan(1);
  });

  test("write errors are logged, never thrown — a directory colliding with the log path is swallowed", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-audit-"));
    const path = join(dir, "audit.jsonl");
    // Pre-create the "file" path AS A DIRECTORY so appendFileSync fails with EISDIR.
    mkdirSync(path);
    const log = new AuditLog(path);

    const origError = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => { captured.push(String(args[0])); };
    try {
      expect(() => log.append({ action: "advertise" })).not.toThrow();
    } finally {
      console.error = origError;
    }
    expect(captured.some((m) => m.includes("[audit]"))).toBe(true);
  });
});
