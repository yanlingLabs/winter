import { describe, test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Reads `stream` until `needle` has appeared (true) or the stream ends / `deadlineMs` passes (false). */
async function readUntil(stream: ReadableStream<Uint8Array>, needle: string, deadlineMs: number): Promise<boolean> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), deadlineMs));
  try {
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next === "timeout" || next.done) return false;
      seen += decoder.decode(next.value, { stream: true });
      if (seen.includes(needle)) return true;
    }
  } finally {
    reader.releaseLock();
  }
}

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
    // The handshake: printed only once BOTH handlers are installed. The socket file appears a moment BEFORE
    // startDaemon() returns and the handlers are registered after it, so "the socket exists" is not "SIGTERM
    // is handled": a signal in that gap hits the default disposition and kills the process with the socket
    // still on disk (a CI flake on a loaded runner). The test waits for this line, never for the file.
    console.log("WINTER_TEST_SHUTDOWN_HANDLERS_READY");
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

    // Keep stderr drained so a chatty boot can never fill its pipe and block the child.
    void new Response(proc.stderr).arrayBuffer();

    // Wait for the daemon's own "handlers installed" line (a condition, not a sleep; the deadline only bounds a hang).
    const ready = await readUntil(proc.stdout, "WINTER_TEST_SHUTDOWN_HANDLERS_READY", 25_000);
    expect(ready).toBe(true);
    expect(existsSync(socketPath)).toBe(true); // the daemon started and created the socket

    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0); // the handler ran to its `process.exit(0)` — not killed by the signal

    expect(existsSync(socketPath)).toBe(false); // graceful stop unlinked the socket — no stale file
  }, 40_000);
});
