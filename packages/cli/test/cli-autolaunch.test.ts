import { describe, expect, test } from "bun:test";
import { ensureDaemonReachable } from "../src/main";

// Lifecycle Task 5: `winter` auto-launches Winter.app when the daemon is down. `ensureDaemonReachable`
// is the pure, injectable core (fs/exec/clock/env seams passed in) — these tests never touch a real
// socket, never shell out to `open`, and never launch the real app; `connect()` wires the real seams
// (see main.ts) and is exercised by hand / the headless sanity check, not here.
describe("ensureDaemonReachable — the three outcomes", () => {
  test("already-up when socket present → never launches", async () => {
    let launched = 0;
    const r = await ensureDaemonReachable({ socketExists: () => true, appBundlePresent: () => true,
      launchApp: () => { launched++; }, sleepMs: async () => {}, now: () => 0, noAutoLaunch: false });
    expect(r).toBe("already-up"); expect(launched).toBe(0);
  });
  test("launches + polls when socket down but app present", async () => {
    let launched = 0; let up = false;
    const r = await ensureDaemonReachable({ socketExists: () => up, appBundlePresent: () => true,
      launchApp: () => { launched++; setTimeout(() => { up = true; }, 0); }, sleepMs: async () => {}, now: (() => { let t = 0; return () => (t += 100); })(), noAutoLaunch: false });
    expect(launched).toBe(1); expect(r).toBe("launched");
  });
  test("no-app when socket down + noAutoLaunch", async () => {
    const r = await ensureDaemonReachable({ socketExists: () => false, appBundlePresent: () => true,
      launchApp: () => {}, sleepMs: async () => {}, now: () => 0, noAutoLaunch: true });
    expect(r).toBe("no-app");
  });
  test("no-app when socket down + no bundle installed (dev tree) → never launches", async () => {
    let launched = 0;
    const r = await ensureDaemonReachable({ socketExists: () => false, appBundlePresent: () => false,
      launchApp: () => { launched++; }, sleepMs: async () => {}, now: () => 0, noAutoLaunch: false });
    expect(r).toBe("no-app"); expect(launched).toBe(0);
  });
});
