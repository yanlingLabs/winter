import { describe, test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Whole-branch review repro: a SIGTERM'd `daemon run` must leave NO stale socket file — otherwise
 * the app's DaemonSupervisor sees the leftover file on the next launch and goes `.connectOnly`,
 * stranding a dead engine. The fix registers SIGTERM/SIGINT handlers in main.ts's `daemon run` case
 * (daemon.ts's own handlers are gated behind `import.meta.main`, which is false for the CLI entry),
 * calling `daemon.stop()` → `lock.release()` → `unlinkSync(socketPath)` — the clean-quit path.
 *
 * This spawns a subprocess that runs `startDaemon` with an injected `FileSecretStore` + the SAME
 * shutdown handler main.ts registers — NOT the literal `main.ts daemon run`, deliberately: the real
 * entry defaults to `KeychainSecretStore` (global service "com.winter.core"), so spawning it would
 * read the LIVE daemon's Keychain token, which the review forbids touching. The socket-cleanup
 * behavior under test is identical either way (the handler + `stop()`/`lock.release()` are shared).
 */
describe("daemon run SIGTERM socket cleanup", () => {
  const fixture = `
    import { startDaemon, FileSecretStore } from "@yanlinglabs/winter-core";
    const home = process.env.WINTER_HOME;
    const daemon = await startDaemon({ home, secrets: new FileSecretStore(home + "/secrets"), agentProvider: null });
    const shutdown = async () => { await daemon.stop(); process.exit(0); };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  `;

  test("SIGTERM leaves NO stale socket file (the reviewer's exact repro, now passing)", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-sigterm-"));
    const socketPath = join(home, "run", "core.sock");

    const proc = Bun.spawn(["bun", "-e", fixture], {
      // cwd inside the cli package so `@yanlinglabs/winter-core` resolves via the workspace.
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, WINTER_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for the daemon to come up and create its socket.
    const deadline = Date.now() + 15_000;
    while (!existsSync(socketPath) && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(existsSync(socketPath)).toBe(true); // the daemon started and created the socket

    proc.kill("SIGTERM");
    await proc.exited;

    expect(existsSync(socketPath)).toBe(false); // graceful stop unlinked the socket — no stale file
  }, 30_000);
});
