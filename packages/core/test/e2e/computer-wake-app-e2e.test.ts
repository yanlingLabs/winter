// ComputerV2 WAKE TRIGGERS ON APPS, end to end with the REAL app backend: a real daemon and a real `winter` binary, the
// production wiring (`AppWakeBackend` over the helper connection — no wake backend injected), and a FAKE Winter Computer
// Use helper that speaks the 1.17.0 wire (`watch.arm`, `watch.cancel`, the `watchEvent` notification).
//
//   arm → the helper's watchEvent → the session is woken · the helper quits → `lost` "Winter Computer Use quit", woken ·
//   the daemon stops → every watch cancelled quietly (no ending, no wake), then `restart` at the next boot, woken once.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { HELPER_GONE_REASON } from "../../src/computer-use/wakes/app-backend";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { sandboxAvailable } from "../../src/workflows/sandbox";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { FakeHelper } from "../computer-use/fake-helper";

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { code: number; message: string; data?: unknown } }) => void>();
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
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }
  async call<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    const r = await new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => this.pending.set(id, resolve));
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result as T;
  }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

async function until<T>(probe: () => T | undefined | false, ms = 40_000, what = "a condition"): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const main = (log: SessionEvent[]): SessionEvent[] => log.filter((e) => (e as { threadId?: string }).threadId === "main");
const count = (log: SessionEvent[], type: string): number => main(log).filter((e) => e.type === type).length;
const wakeMessages = (log: SessionEvent[]) => main(log).filter((e) => e.type === "user_message" && (e as { clientName?: string }).clientName === "computer-wake") as Array<{ text: string; seq: number }>;
const ended = (log: SessionEvent[]) => log.filter((e) => e.type === "wake_ended") as Array<{ wakeId: string; reason: string; woken: boolean }>;
const armedOf = (log: SessionEvent[]) => log.find((e) => e.type === "wake_armed") as { wakeId: string; condition: string; targetLabel: string; elementLabel?: string } | undefined;

/** A model turn that loads ComputerV2, binds Notes and runs `code`. */
const script = (code: string): string => [
  `CALL ToolSearch {"query":"select:ComputerV2"}`,
  `CALL ComputerV2 ${JSON.stringify({ code: `const notes = await apps.open('Notes', { emit: false })\n${code}`, timeoutMs: 60_000 })}`,
].join("\n");

const run = sandboxAvailable() ? describeWithWinterBinary : (name: string, _fn: (bin: string) => void) => test.skip(`${name} (no sandbox)`, () => {});

run("ComputerV2 wake triggers on apps through a real daemon (the real AppWakeBackend, a fake 1.17.0 helper)", (bin) => {
  let home: string;
  let cwd: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let fake: FakeHelper;

  const boot = async (): Promise<void> => {
    fake = new FakeHelper();
    fake.helperVersion = "1.17.0";
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null,
      computerUse: {
        transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier, launchAllowed: true, browserInstalled: () => false,
        headless: { resolve: () => ({ missing: "no headless browser in this test" }) },
        // No `wakeBackends`: the production wiring builds the app backend over this helper.
        wakeTimings: { coalesceMs: 150 },
      },
    });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    client = await TestClient.connect(daemon.socketPath);
    await client.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: daemon.tokens.harness, clientName: "e2e" });
  };
  const stop = async (): Promise<void> => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
  };

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "winter-wake-app-e2e-")));
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-wake-app-e2e-cwd-")));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 3,
      provider: { model: "winter-test/calls" },
      // A trigger needs the app allowed for the session or always.
      computerUse: { enabled: true, apps: { "com.apple.Notes": { grant: "always" } } },
      runtimes: { winterExecutable: bin, winterIdleTimeoutSec: 30 },
    }, null, 2));
    await boot();
  });
  afterAll(async () => {
    await stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  // An app one session has bound is held from every other session until released; each test's session binds Notes, so
  // the one before it is archived first (an archived session lets go of its apps).
  let previous: string | undefined;
  const session = async (): Promise<string> => {
    if (previous !== undefined) await client.call(METHODS.sessionSetActivity, { sessionId: previous, activity: "archived" });
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: "winter-test/calls", cwd, approvalPolicy: "auto" });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    previous = sessionId;
    return sessionId;
  };
  const log = (sid: string): SessionEvent[] => daemon!.sessions.read(sid);
  const turns = (sid: string, n: number, what: string) => until(() => count(log(sid), "turn_completed") >= n || undefined, 60_000, what);

  test("arm → the helper's watchEvent → the session is woken (the helper armed it, labels from its answer)", async () => {
    const sid = await session();
    await client.call(METHODS.sessionSend, { sessionId: sid, text: script("await notes.wakeWhen({ clicked: 14 }, { note: 'send the reply once they press Send' })") });
    await turns(sid, 1, "the arming turn");
    const armed = armedOf(log(sid));
    expect(armed).toMatchObject({ condition: "clicked", targetLabel: "Notes — Notes window", elementLabel: "“Send”" });
    // The helper got the wire condition: an app's ref is a number.
    const arm = fake.calls("watch.arm").at(-1)!;
    expect(arm).toMatchObject({ watchId: armed!.wakeId, condition: { kind: "clicked", ref: 14 } });
    expect(typeof arm.targetId).toBe("string");
    expect(fake.watches.has(armed!.wakeId)).toBe(true);
    // The user clicks Send: the helper's one event for the watch.
    fake.notify("watchEvent", { watchId: armed!.wakeId, outcome: "fired", at: Date.now(), detail: "clicked" });
    const wake = await until(() => wakeMessages(log(sid))[0], 30_000, "the wake message");
    expect(wake.text).toStartWith("<computer-wake>\nA wake trigger you set has ended.");
    expect(wake.text).toContain(`- ${armed!.wakeId} fired at`);
    expect(wake.text).toContain("Your note: send the reply once they press Send");
    expect(wake.text).toContain("The user may still be working in Notes — acts there are refused (user_working)");
    expect(wake.text).toContain('apps.open("com.apple.Notes")');
    await turns(sid, 2, "the wake turn");
    expect(ended(log(sid))).toEqual([expect.objectContaining({ wakeId: armed!.wakeId, reason: "fired", woken: true })]);
    // A second event for the same watch (a helper that sent it twice) ends nothing more.
    fake.notify("watchEvent", { watchId: armed!.wakeId, outcome: "fired", at: Date.now(), detail: "clicked" });
    await Bun.sleep(400);
    expect(wakeMessages(log(sid)).length).toBe(1);
    expect(daemon!.wakes.countFor(sid)).toBe(0);
  }, 120_000);

  test("the helper quits: the armed watch is `lost` — \"Winter Computer Use quit\" — and the session is woken", async () => {
    const sid = await session();
    await client.call(METHODS.sessionSend, { sessionId: sid, text: script("await notes.wakeWhen({ text: 'Upload complete' })") });
    await turns(sid, 1, "the arming turn");
    const armed = armedOf(log(sid))!;
    expect(fake.calls("watch.arm").at(-1)).toMatchObject({ watchId: armed.wakeId, condition: { kind: "appeared", text: "Upload complete" } });
    fake.quit();
    const wake = await until(() => wakeMessages(log(sid))[0], 30_000, "the loss wake");
    expect(wake.text).toContain(`- ${armed.wakeId} can no longer fire (`);
    expect(wake.text).toContain(HELPER_GONE_REASON);
    expect(ended(log(sid))).toEqual([expect.objectContaining({ wakeId: armed.wakeId, reason: "lost", woken: true })]);
    await turns(sid, 2, "the wake turn");
    expect(daemon!.wakes.countFor(sid)).toBe(0);
  }, 120_000);

  test("the daemon stops: the watch is cancelled quietly (no ending, no wake) — then `restart` at the next boot, woken once", async () => {
    const sid = await session();
    await client.call(METHODS.sessionSend, { sessionId: sid, text: script("await notes.wakeWhen({ title: 'Sent' }, { note: 'file the receipt' })") });
    await turns(sid, 1, "the arming turn");
    const armed = armedOf(log(sid))!;
    const old = fake;
    expect(old.watches.has(armed.wakeId)).toBe(true);
    await stop();
    // The app backend let go of the helper's watch before the connection closed.
    expect(old.calls("watch.cancel").some((p) => p.watchId === armed.wakeId)).toBe(true);
    expect(old.watches.has(armed.wakeId)).toBe(false);
    await boot();
    const wake = await until(() => wakeMessages(log(sid))[0], 60_000, "the restart wake");
    expect(wake.text).toContain("Winter restarted, so this wait ended — arm it again with wakeWhen() if you still need it.");
    expect(wake.text).toContain(`- ${armed.wakeId} (armed at`);
    expect(wake.text).toContain("Your note: file the receipt");
    // Quiet at the stop: the restart is the ONE ending, and its wake the one message.
    expect(ended(log(sid))).toEqual([expect.objectContaining({ wakeId: armed.wakeId, reason: "restart", woken: true })]);
    await turns(sid, 2, "the restart wake turn");
    expect(wakeMessages(log(sid)).length).toBe(1);
    // The new helper was never asked to arm the old trigger.
    expect(fake.calls("watch.arm")).toEqual([]);
  }, 180_000);
});
