// A runtime child whose spawn races the daemon's own stop must not outlive the daemon.
//
// A real daemon on a temp home, the real `winter` binary, a `winter-test/hang` session (its turn never
// ends). For a range of offsets, the session's first message is sent — which opens the driver and spawns
// the child — and `daemon.stop()` is called that many ms later, so the stop lands before, during and after
// the spawn. Once `stop()` has resolved, no process may still name the test home (every child's config
// carries its cwd, which is under the home).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon } from "../../src/daemon";
import { describeWithWinterBinary } from "../helpers/winter-binary";

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
          }
        },
        drain() { c.writer.onDrain(); },
        close() { for (const [, resolve] of c.pending) resolve({ error: { message: "closed" } }); c.pending.clear(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }
  request(method: string, params?: unknown): Promise<{ result?: unknown; error?: { message: string } }> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

/** Live processes (other than this one) whose command line names `home`. */
function survivors(home: string): number[] {
  const ps = Bun.spawnSync(["/bin/ps", "-axww", "-o", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
  return new TextDecoder().decode(ps.stdout).split("\n")
    .filter((line) => line.includes(home))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

async function bootOn(bin: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-spawn-stop-")));
  const cwd = join(home, "work");
  mkdirSync(cwd);
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    schemaVersion: 3,
    provider: { model: "winter-test/hang" },
    runtimes: { winterExecutable: bin, winterIdleTimeoutSec: 10 },
  }, null, 2));
  const daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
  const client = await TestClient.connect(daemon.socketPath);
  await client.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: daemon.tokens.harness, clientName: "e2e" });
  return { home, cwd, daemon, client };
}

describeWithWinterBinary("a child spawned while the daemon stops does not outlive it", (bin) => {
  for (const offsetMs of [0, 2, 10, 30, 80, 200]) {
    test(`Dispatch's SpawnSession: stop ${offsetMs} ms into the spawn`, async () => {
      const { home, cwd, daemon, client } = await bootOn(bin);
      const dispatchId = ((await client.request(METHODS.sessionDispatch, {})).result as { sessionId: string }).sessionId;
      const servers = daemon.buildSessionCapabilities({ sessionId: dispatchId, mode: "dispatch", cwd: home, roots: [home] });
      const sessions = servers["winter__sessions"]!.instance as { callTool(name: string, args: Record<string, unknown>): Promise<unknown> };
      const spawning = sessions.callTool("session_spawn", { dir: cwd, prompt: "wait forever", model: "winter-test/hang", title: "Racer" }).catch(() => undefined);
      if (offsetMs > 0) await Bun.sleep(offsetMs);
      await daemon.stop();
      await spawning;
      client.close();
      for (let n = 0; n < 25 && survivors(home).length > 0; n++) await Bun.sleep(20);
      const left = survivors(home);
      for (const pid of left) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      rmSync(home, { recursive: true, force: true });
      expect(left).toEqual([]);
    }, 60_000);

    test(`a session's first message: stop ${offsetMs} ms after it`, async () => {
      const { home, cwd, daemon, client } = await bootOn(bin);
      const created = await client.request(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: "winter-test/hang", cwd, approvalPolicy: "auto" });
      const sessionId = (created.result as { sessionId: string }).sessionId;

      const sending = client.request(METHODS.sessionSend, { sessionId, text: "wait forever" });
      if (offsetMs > 0) await Bun.sleep(offsetMs);
      await daemon.stop();
      await sending; // answered or refused — either way it has settled
      client.close();
      // Give an exiting child a moment to be reaped by the OS (stop() already waited for it to be ended).
      for (let n = 0; n < 25 && survivors(home).length > 0; n++) await Bun.sleep(20);
      const left = survivors(home);
      for (const pid of left) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      rmSync(home, { recursive: true, force: true });
      expect(left).toEqual([]);
    }, 60_000);
  }
});
