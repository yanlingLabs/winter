import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { COWORK_TABLES } from "../../src/cowork/schema";
import { downgradeCoworkRuntimeStateToV7 } from "../../src/runtime-state/db";

// Cowork cannot be created or run in production, so a production-shaped daemon must start NO Cowork timer and a failing Cowork boot
// step must not abort startup. (The unit-level timer rules live in workspace-events.test.ts and folder-selections.test.ts.)
let daemon: RunningDaemon | undefined;
const homes: string[] = [];
afterEach(async () => { try { await daemon?.stop(); } catch { /* already stopped */ } daemon = undefined; for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const tempHome = () => { const h = mkdtempSync(join(tmpdir(), "winter-cowork-boot-quiet-")); homes.push(h); return h; };
const boot = async (extra: Record<string, unknown> = {}) => {
  const home = tempHome();
  daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "secrets")), agentProvider: null, ...extra } as never);
  return daemon;
};

/** Run `body` while recording every setInterval whose creating stack passes through src/cowork/. */
async function withIntervalSpy<T>(body: () => Promise<T>): Promise<{ result: T; coworkIntervals: number }> {
  const real = globalThis.setInterval;
  let coworkIntervals = 0;
  (globalThis as { setInterval: unknown }).setInterval = ((...args: Parameters<typeof setInterval>) => {
    if (/src\/cowork\//.test(new Error().stack ?? "")) coworkIntervals++;
    return real(...args);
  }) as typeof setInterval;
  try { return { result: await body(), coworkIntervals }; } finally { globalThis.setInterval = real; }
}

test("a production-shaped daemon (no injected Cowork host) creates no Cowork timer", async () => {
  const { coworkIntervals } = await withIntervalSpy(() => boot());
  expect(coworkIntervals).toBe(0);
});

test("a throwing Cowork boot step does not abort startup", async () => {
  // The schedule tick reads the clock first; a clock that throws makes `schedules.tick()` throw at boot.
  const quiet = console.error; const lines: string[] = [];
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    const d = await boot({ coworkScheduleNow: () => { throw new Error("clock exploded"); } });
    expect(d.socketPath).toBeTruthy();
  } finally { console.error = quiet; }
  expect(lines.filter(l => l.startsWith("cowork: schedule tick failed at boot"))).toHaveLength(1);
});

// The documented rollback ("a revert release reverts the feature, never the schema; roll back with `winter migrate --cowork-schema
// --rollback`") must work for every ordinary user: the `cowork-data-present` refusal needs a Cowork row, and nothing in a production
// daemon writes one.
test("a daemon that booted and stopped leaves every Cowork table empty, so the schema rollback is never refused", async () => {
  const d = await boot();
  const home = d.socketPath.replace(/\/run\/core\.sock$/, "");
  await d.stop(); daemon = undefined;
  const db = new Database(join(home, "runtimes", "runtime-state.db"), { readonly: true });
  try {
    const populated = COWORK_TABLES.filter(table => db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) && db.query(`SELECT 1 FROM ${table} LIMIT 1`).get());
    expect(populated).toEqual([]);
  } finally { db.close(); }
  expect(downgradeCoworkRuntimeStateToV7(home)).toMatchObject({ from: 18, to: 7 });
});

