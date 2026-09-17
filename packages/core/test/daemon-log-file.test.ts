import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonLogPathFor, installDaemonLogFile } from "../src/daemon-log-file";

describe("daemon log file (tee of stdout/stderr into <home>/logs/daemon.log)", () => {
  const homes: string[] = [];
  const home = () => { const h = mkdtempSync(join(tmpdir(), "winter-daemon-log-")); homes.push(h); return h; };
  afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

  test("every stdout and stderr line lands in the file, timestamped, and the streams still work", () => {
    const h = home();
    const handle = installDaemonLogFile(h, { now: () => new Date("2026-09-17T00:00:00Z") });
    try {
      process.stdout.write("hello from stdout\n");
      process.stderr.write("runtime-sdk: something typed\n");
      console.error("via console.error", 42); // Bun's console bypasses the stream — wrapped separately
      console.log("via console.log");
    } finally { handle.close(); }
    const text = readFileSync(daemonLogPathFor(h), "utf8");
    expect(text).toBe([
      "2026-09-17T00:00:00.000Z hello from stdout",
      "2026-09-17T00:00:00.000Z runtime-sdk: something typed",
      "2026-09-17T00:00:00.000Z via console.error 42",
      "2026-09-17T00:00:00.000Z via console.log",
      "",
    ].join("\n"));
    // after close() the tee is gone: a later write does not reach the file
    process.stderr.write("after close\n");
    expect(readFileSync(daemonLogPathFor(h), "utf8")).not.toContain("after close");
  });

  test("rotation: past maxBytes the file becomes daemon.log.1 and a fresh daemon.log continues", () => {
    const h = home();
    const handle = installDaemonLogFile(h, { maxBytes: 200 });
    try {
      for (let i = 0; i < 10; i++) process.stderr.write(`line ${i} ${"x".repeat(40)}\n`);
    } finally { handle.close(); }
    const current = daemonLogPathFor(h);
    expect(existsSync(`${current}.1`)).toBe(true);
    expect(statSync(current).size).toBeLessThanOrEqual(200);
    expect(readFileSync(`${current}.1`, "utf8").length).toBeGreaterThan(0);
  });

  test("an unwritable home disables the sink without throwing into the daemon", () => {
    const handle = installDaemonLogFile("/dev/null/not-a-dir");
    try { expect(() => process.stderr.write("still fine\n")).not.toThrow(); } finally { handle.close(); }
  });
});
