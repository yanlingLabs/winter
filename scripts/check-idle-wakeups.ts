#!/usr/bin/env bun
// The daemon's IDLE cost, measured: how often an idle `winter-core` wakes the CPU (`top`'s IDLEW, in DELTA mode).
//
//   bun run check:idle-wakeups            # boots an isolated daemon, settles, measures 3 × 10 s, fails over 50/s
//   bun run check:idle-wakeups --pid N    # measures an already-running process instead (read-only: `top` only)
//
// WHY DELTA MODE. `top`'s IDLEW column is, by default, the ABSOLUTE count since the process started — 3,962 on a
// daemon up for 8 hours is ~0.14 wakeups/s, not 3,962/s. `-c d` makes each sample the count over its own interval.
//
// ISOLATION. The booted daemon runs IN a child bun process on a temp WINTER_HOME with a FILE secret store
// (`startDaemon({ secrets })`): every Keychain path in the daemon is gated on the profile's default home, and a
// random throwaway WINTER_KEYCHAIN_SERVICE is set besides (no WINTER_PROFILE). It never touches ~/.winter*.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIMIT_PER_SECOND = 50;
const SETTLE_MS = 20_000;
const WINDOWS = 3;
const WINDOW_S = 10;

const CORE = join(import.meta.dir, "..", "packages", "core", "src");

/** IDLEW per interval for `pid`, over `windows` windows of `seconds` (the first, absolute, sample is dropped). */
async function idleWakeups(pid: number, windows: number, seconds: number): Promise<number[]> {
  const proc = Bun.spawn(["top", "-l", String(windows + 1), "-s", String(seconds), "-c", "d", "-pid", String(pid), "-stats", "pid,idlew"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const rows = out.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f[0] === String(pid)).map((f) => Number(f[1]));
  return rows.slice(1).filter((n) => Number.isFinite(n));
}

async function main(): Promise<void> {
  const at = process.argv.indexOf("--pid");
  if (at >= 0) {
    const pid = Number(process.argv[at + 1]);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("--pid takes a process id");
    report(await idleWakeups(pid, WINDOWS, WINDOW_S));
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "winter-idle-check-"));
  const probe = join(home, "probe.ts");
  writeFileSync(probe, [
    `const { startDaemon } = await import(${JSON.stringify(join(CORE, "daemon.ts"))});`,
    `const { FileSecretStore } = await import(${JSON.stringify(join(CORE, "auth", "secret-store.ts"))});`,
    `const d = await startDaemon({ home: ${JSON.stringify(home)}, secrets: new FileSecretStore(${JSON.stringify(join(home, "test-secrets"))}) });`,
    `console.log("READY");`,
    `process.on("SIGTERM", async () => { try { await d.stop(); } finally { process.exit(0); } });`,
  ].join("\n"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "WINTER_PROFILE") env[k] = v;
  Object.assign(env, { WINTER_HOME: home, WINTER_KEYCHAIN_SERVICE: `com.winter.core.test-idle-${crypto.randomUUID().slice(0, 8)}`, WINTER_LOGIN_SHELL_PATH: "off" });
  const daemon = Bun.spawn(["bun", probe], { env, stdout: "pipe", stderr: "inherit" });
  try {
    const reader = daemon.stdout.getReader();
    let seen = "";
    const deadline = Date.now() + 60_000;
    while (!seen.includes("READY")) {
      if (Date.now() > deadline) throw new Error("the daemon did not come up within 60 s");
      const { value, done } = await reader.read();
      if (done) throw new Error("the daemon exited before it was ready");
      seen += new TextDecoder().decode(value);
    }
    console.log(`daemon up (pid ${daemon.pid}); settling ${SETTLE_MS / 1000} s`);
    await Bun.sleep(SETTLE_MS);
    report(await idleWakeups(daemon.pid, WINDOWS, WINDOW_S));
  } finally {
    daemon.kill("SIGTERM");
    await Promise.race([daemon.exited, Bun.sleep(5_000)]);
    rmSync(home, { recursive: true, force: true });
  }
}

function report(samples: number[]): void {
  if (samples.length === 0) throw new Error("top reported nothing for the process");
  const perSecond = samples.map((n) => n / WINDOW_S);
  const worst = Math.max(...perSecond);
  console.log(`idle wakeups per ${WINDOW_S} s: ${samples.join(", ")} → worst ${worst.toFixed(1)}/s (limit ${LIMIT_PER_SECOND}/s)`);
  if (worst > LIMIT_PER_SECOND) {
    console.error("FAIL: the idle daemon wakes too often");
    process.exit(1);
  }
  console.log("PASS");
}

await main();
