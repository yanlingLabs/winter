import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineAuditLog, defaultRoutinesAuditPath } from "../../src/routines/audit";

function lines(path: string): unknown[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

describe("RoutineAuditLog", () => {
  test("append writes ts-stamped JSONL, one line per entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-routines-audit-"));
    const path = join(dir, "routines-audit.jsonl");
    const log = new RoutineAuditLog(path);

    const before = Date.now();
    log.append({ op: "fire", id: "r1", spec: "every 30m", origin: "routine/r1" });
    log.append({ op: "defer", id: "r1", reason: "quota" });
    const after = Date.now();

    const rows = lines(path) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ op: "fire", id: "r1", spec: "every 30m", origin: "routine/r1" });
    expect(rows[1]).toMatchObject({ op: "defer", id: "r1", reason: "quota" });
    for (const r of rows) {
      expect(typeof r.ts).toBe("number");
      expect(r.ts as number).toBeGreaterThanOrEqual(before);
      expect(r.ts as number).toBeLessThanOrEqual(after);
    }
  });

  test("mkdir-safe: creates missing parent directories on first write", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-routines-audit-"));
    const path = join(dir, "nested", "deeper", "routines-audit.jsonl");
    expect(existsSync(path)).toBe(false);

    new RoutineAuditLog(path).append({ op: "fire", id: "r1" });

    expect(existsSync(path)).toBe(true);
  });

  test("a write-time ts always wins over a caller-supplied ts field", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-routines-audit-"));
    const path = join(dir, "routines-audit.jsonl");
    const log = new RoutineAuditLog(path);
    log.append({ op: "fire", id: "r1", ts: 1 });
    const [row] = lines(path) as Array<Record<string, unknown>>;
    expect(row!.ts).not.toBe(1);
    expect(row!.ts as number).toBeGreaterThan(1);
  });
});

// P9b-12: the standalone default path bypassed the home resolver (hardcoded `~/.winter`) before
// this fix — a WINTER_HOME override must move it with everything else.
describe("defaultRoutinesAuditPath", () => {
  test("lands under WINTER_HOME when it is set", () => {
    const saved = process.env.WINTER_HOME;
    const home = mkdtempSync(join(tmpdir(), "winter-routines-audit-home-"));
    try {
      process.env.WINTER_HOME = home;
      expect(defaultRoutinesAuditPath()).toBe(join(home, "routines-audit.jsonl"));
    } finally {
      if (saved === undefined) delete process.env.WINTER_HOME; else process.env.WINTER_HOME = saved;
    }
  });
});
