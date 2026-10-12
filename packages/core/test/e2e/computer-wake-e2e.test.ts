// ComputerV2 WAKE TRIGGERS, end to end through a REAL daemon and a REAL `winter` binary: a script arms a trigger
// (`app.wakeWhen(…)`), the turn ends, and when the user does what it waits for the session is WOKEN with one
// daemon-written `computer-wake` message and runs a turn for it.
//
// The model is `winter-test/calls` (the SDK's prompt-scripted double: it runs the prompt's `CALL` lines as tool rounds).
// The app is bound through a FAKE Winter Computer Use helper, and the trigger is armed on a FAKE wake backend (lanes B
// and C deliver the real ones) — so "the user clicked" is the test's `fire()`. Everything between is real: the sandboxed
// automation worker, the service, the registry, `wakes.json`, the delivery through the session's own driver (steered
// into a running turn, `send` to an idle one, resumed if need be), Dispatch's follower, the RPCs.
//
//   arm → fire → resume · a fire while a turn runs (steered and FOLDED into it) · coalescing · lost · expired (silent,
//   and with notifyOnTimeout) · cancel from the model and from the RPC · the setting off (`disabled`) · the limits ·
//   an "Allow once" app refused · a Dispatch child's wake turn followed · restart (woken at the next boot).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { sandboxAvailable } from "../../src/workflows/sandbox";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { FakeHelper } from "../computer-use/fake-helper";
import { FakeWakeBackend } from "../computer-use/wake-fakes";

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { code: number; message: string; data?: unknown } }) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: SessionEvent[] = [];
  onEvent: ((e: SessionEvent) => void) | undefined;
  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
            else if (msg.method === METHODS.event) { c.events.push(msg.params as SessionEvent); c.onEvent?.(msg.params as SessionEvent); }
          }
        },
        drain() { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }
  request(method: string, params?: unknown): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
  async call<T>(method: string, params?: unknown): Promise<T> {
    const r = await this.request(method, params);
    if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { rpc: r.error });
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

/** The ComputerV2 call's result text (the last one in the session). */
function cv2Output(log: SessionEvent[]): string {
  const call = [...log].reverse().find((e) => e.type === "tool_call" && (e as { name: string }).name === "computer_v2") as { callId: string } | undefined;
  const res = log.find((e) => e.type === "tool_result" && (e as { callId: string }).callId === call?.callId) as { output: string } | undefined;
  return res?.output ?? "";
}

/** A model turn that loads ComputerV2 and runs `code` — then `extra` CALL lines (a gated Bash), one round each. */
const script = (code: string, extra: string[] = []): string => [
  `CALL ToolSearch {"query":"select:ComputerV2"}`,
  `CALL ComputerV2 ${JSON.stringify({ code, timeoutMs: 60_000 })}`,
  ...extra,
].join("\n");

const run = sandboxAvailable() ? describeWithWinterBinary : (name: string, _fn: (bin: string) => void) => test.skip(`${name} (no sandbox)`, () => {});

run("ComputerV2 wake triggers through a real daemon (fake helper, fake wake backend)", (bin) => {
  let home: string;
  let cwd: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let fake: FakeHelper;
  let app: FakeWakeBackend;
  let tab: FakeWakeBackend;

  const boot = async (): Promise<void> => {
    fake = new FakeHelper();
    app = new FakeWakeBackend();
    app.answer = () => ({ element: { role: "button", name: "Submit for review" }, targetLabel: "Notes — Listing", rebind: 'apps.open("com.apple.Notes")' });
    tab = new FakeWakeBackend();
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null,
      computerUse: {
        transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier, launchAllowed: true, browserInstalled: () => false,
        headless: { resolve: () => ({ missing: "no headless browser in this test" }) },
        wakeBackends: { app, tab }, wakeTimings: { coalesceMs: 150 },
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
    home = realpathSync(mkdtempSync(join(tmpdir(), "winter-wake-e2e-")));
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-wake-e2e-cwd-")));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 3,
      provider: { model: "winter-test/calls" },
      // Notes is allowed ALWAYS (a trigger needs a session or always grant); TextEdit is not — the "once" case.
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

  const session = async (policy = "auto"): Promise<string> => {
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: "winter-test/calls", cwd, approvalPolicy: policy });
    // One client attaches to one session at a time (its sends go there); the wakes need no one attached.
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    return sessionId;
  };
  const log = (sid: string): SessionEvent[] => daemon!.sessions.read(sid);
  const turns = (sid: string, n: number, what: string) => until(() => count(log(sid), "turn_completed") >= n || undefined, 60_000, what);
  const arm = (code: string) => `const notes = await apps.open('Notes', { emit: false })\n${code}`;

  test("arm → the turn ends → fire → the session is woken with the <computer-wake> message and runs a turn", async () => {
    const sid = await session();
    await client.call(METHODS.sessionSend, { sessionId: sid, text: script(arm("const wake = await notes.wakeWhen({ clicked: 14 }, { note: 'publish the listing once it is submitted' })")) });
    await turns(sid, 1, "the arming turn");
    const out = cv2Output(log(sid));
    expect(out).toMatch(/Armed (wk_[0-9a-f]{12}) — you'll be woken when the user clicks <screen-data id="[0-9a-f]+">button “Submit for review”<\/screen-data id="[0-9a-f]+"> in <screen-data id="[0-9a-f]+">Notes — Listing<\/screen-data id="[0-9a-f]+"> \(expires in 60 min\)/);
    const armed = log(sid).find((e) => e.type === "wake_armed") as { wakeId: string; condition: string; targetLabel: string; elementLabel?: string };
    expect(armed).toMatchObject({ condition: "clicked", targetLabel: "Notes — Listing", elementLabel: "“Submit for review”" });
    expect(app.requests.at(-1)).toMatchObject({ sessionId: sid, condition: { kind: "clicked", ref: "14" } });
    // The session list's mark (and the global broadcast reached this unattached client).
    const rows = await client.call<{ sessions: Array<{ sessionId: string; wakesArmed?: number }> }>(METHODS.sessionList, {});
    expect(rows.sessions.find((r) => r.sessionId === sid)?.wakesArmed).toBe(1);
    expect(client.events.some((e) => e.type === "wake_armed" && e.sessionId === sid)).toBe(true);
    // The user clicks.
    app.fire(armed.wakeId, "clicked");
    const wake = await until(() => wakeMessages(log(sid))[0], 30_000, "the wake message");
    expect(wake.text).toStartWith("<computer-wake>\nA wake trigger you set has ended.");
    expect(wake.text).toContain(`- ${armed.wakeId} fired at`);
    expect(wake.text).toContain("Your note: publish the listing once it is submitted");
    await turns(sid, 2, "the wake turn");
    // The wake message started a turn of its own (the session was idle), which ran to its end.
    expect(main(log(sid)).some((e) => e.type === "turn_started" && e.seq > wake.seq)).toBe(true);
    expect(main(log(sid)).some((e) => e.type === "turn_completed" && e.seq > wake.seq)).toBe(true);
    expect(ended(log(sid))).toEqual([expect.objectContaining({ wakeId: armed.wakeId, reason: "fired", woken: true })]);
    // An app trigger fired on the user's click: the I6 line (the app is theirs until they leave it).
    expect(wake.text).toContain("The user may still be working in Notes — acts there are refused (user_working)");
    expect((await client.call<{ sessions: Array<{ sessionId: string; wakesArmed?: number }> }>(METHODS.sessionList, {})).sessions.find((r) => r.sessionId === sid)?.wakesArmed).toBeUndefined();
  }, 120_000);

  test("a fire while a turn runs is STEERED and folded into that turn (one turn_completed; the model read it)", async () => {
    const sid = await session();
    const sentinel = join(cwd, "release-fold");
    await client.call(METHODS.sessionSend, { sessionId: sid, text: script(arm("await notes.wakeWhen({ title: 'Submitted' })"), [
      `CALL Bash ${JSON.stringify({ command: `while [ ! -f ${sentinel} ]; do sleep 0.05; done; echo released` })}`,
    ]) });
    const armed = await until(() => log(sid).find((e) => e.type === "wake_armed") as { wakeId: string } | undefined, 60_000, "the arm");
    // The Bash round is running now (it waits on the sentinel): the fire lands mid-turn.
    await until(() => main(log(sid)).filter((e) => e.type === "tool_call").length >= 3 || undefined, 60_000, "the Bash call");
    app.fire(armed.wakeId, "title now “Submitted”");
    await until(() => wakeMessages(log(sid))[0], 30_000, "the steered wake message");
    writeFileSync(sentinel, "");
    await turns(sid, 1, "the turn's end");
    await Bun.sleep(400);
    const l = log(sid);
    expect(count(l, "turn_completed")).toBe(1);
    expect(count(l, "turn_started")).toBe(2);
    const answer = main(l).filter((e) => e.type === "assistant_message").at(-1) as { text: string };
    expect(answer.text).toContain("<computer-wake>");
    expect(answer.text).toContain(armed.wakeId);
  }, 120_000);

  test("coalescing: two triggers ending together wake the session ONCE; lost says so", async () => {
    const sid = await session();
    await client.call(METHODS.sessionSend, { sessionId: sid, text: script(arm("await notes.wakeWhen({ clicked: 14 })\nawait notes.wakeWhen({ gone: 'Uploading' })")) });
    await turns(sid, 1, "the arming turn");
    const ids = (log(sid).filter((e) => e.type === "wake_armed") as Array<{ wakeId: string }>).map((e) => e.wakeId);
    expect(ids.length).toBe(2);
    app.fire(ids[0]);
    app.lose(ids[1], "the app quit");
    const wake = await until(() => wakeMessages(log(sid))[0], 30_000, "the coalesced wake");
    expect(wake.text).toContain("2 wake triggers you set have ended.");
    expect(wake.text).toContain(`- ${ids[0]} fired at`);
    expect(wake.text).toContain(`- ${ids[1]} can no longer fire (`);
    expect(wake.text).toContain("the app quit");
    await turns(sid, 2, "the wake turn");
    await Bun.sleep(400);
    expect(wakeMessages(log(sid)).length).toBe(1);
  }, 120_000);

  test("expired: silent by default, woken with notifyOnTimeout", async () => {
    const sid = await session();
    await client.call(METHODS.sessionSend, { sessionId: sid, text: script(arm("await notes.wakeWhen({ text: 'A' }, { timeoutMs: 1000 })\nawait notes.wakeWhen({ text: 'B' }, { timeoutMs: 1500, notifyOnTimeout: true })")) });
    await turns(sid, 1, "the arming turn");
    await until(() => ended(log(sid)).length === 2 || undefined, 20_000, "both expiries");
    // `woken` tells the silent expiry from the one the model asked to hear about.
    expect(ended(log(sid)).map((e) => [e.reason, e.woken])).toEqual([["expired", false], ["expired", true]]);
    const wake = await until(() => wakeMessages(log(sid))[0], 30_000, "the timeout wake");
    expect(wake.text).toContain("expired at");
    expect(wake.text).toContain("“B”");
    expect(wake.text).not.toContain("“A”");
    await turns(sid, 2, "the wake turn");
  }, 120_000);

  test("cancel from the model (wake.cancel()) and from the RPC (the Mac's [Stop waiting]): no wake", async () => {
    const sid = await session();
    await client.call(METHODS.sessionSend, { sessionId: sid, text: script(arm("const w1 = await notes.wakeWhen({ clicked: 14 })\nconst w2 = await notes.wakeWhen({ clicked: 15 })")) });
    await turns(sid, 1, "the arming turn");
    await client.call(METHODS.sessionSend, { sessionId: sid, text: script("await w1.cancel()") });
    await turns(sid, 2, "the cancelling turn");
    expect(cv2Output(log(sid))).toMatch(/cancelled wk_[0-9a-f]{12} — it will not wake you/);
    const second = (log(sid).filter((e) => e.type === "wake_armed") as Array<{ wakeId: string }>)[1]!.wakeId;
    expect(await client.call<unknown>(METHODS.computerUseWakesCancel, { sessionId: sid, wakeId: second })).toEqual({ ok: true, cancelled: true });
    expect(ended(log(sid)).map((e) => e.reason)).toEqual(["cancelled", "cancelled"]);
    await Bun.sleep(500);
    expect(wakeMessages(log(sid))).toEqual([]);
  }, 120_000);

  test("the setting off: armed triggers end `disabled` and arming is NotAllowed; the limits: 8 per session", async () => {
    const sid = await session();
    await client.call(METHODS.sessionSend, { sessionId: sid, text: script(arm("await notes.wakeWhen({ clicked: 14 })")) });
    await turns(sid, 1, "the arming turn");
    await client.call(METHODS.computerUseSetSettings, { wakes: false });
    expect(ended(log(sid)).map((e) => e.reason)).toEqual(["disabled"]);
    await client.call(METHODS.sessionSend, { sessionId: sid, text: script(arm("await notes.wakeWhen({ clicked: 14 })")) });
    await turns(sid, 2, "the refused arm");
    expect(cv2Output(log(sid))).toContain("wake triggers are turned off in Settings → Computer Use");
    await client.call(METHODS.computerUseSetSettings, { wakes: true });
    await client.call(METHODS.sessionSend, { sessionId: sid, text: script(arm("for (let i = 0; i < 9; i++) { try { await notes.wakeWhen({ clicked: 20 + i }) } catch (e) { print(i, e.name, e.message) } }")) });
    await turns(sid, 3, "the limits");
    expect(cv2Output(log(sid))).toContain("8 TargetBusy this session already has 8 wake triggers armed");
    expect(daemon!.wakes.countFor(sid)).toBe(8);
    await Bun.sleep(400);
    expect(wakeMessages(log(sid))).toEqual([]);
  }, 120_000);

  test("an app allowed only ONCE is refused — a trigger needs a session or always grant", async () => {
    const sid = await session("ask");
    client.onEvent = (e) => {
      if (e.sessionId === sid && e.type === "approval_requested") void client.call(METHODS.approvalRespond, { sessionId: sid, callId: (e as { callId: string }).callId, approved: true, optionId: "once" });
    };
    await client.call(METHODS.sessionSend, { sessionId: sid, text: script("const te = await apps.open('TextEdit', { emit: false })\nawait te.wakeWhen({ clicked: 3 })") });
    await turns(sid, 1, "the refused arm");
    client.onEvent = undefined;
    expect(cv2Output(log(sid))).toContain("TextEdit was allowed for one call only — a wake trigger needs it allowed for this session");
    expect(log(sid).filter((e) => e.type === "wake_armed")).toEqual([]);
  }, 120_000);

  test("Dispatch: a child's trigger armed in a followed turn — its wake turn is followed (child_update + the coordinator's wake)", async () => {
    const d = daemon!;
    const dispatchId = (await client.call<{ sessionId: string }>(METHODS.sessionDispatch, {})).sessionId;
    await d.winter.get(dispatchId)?.end();
    d.sessions.setModel(dispatchId, "winter-test/echo");
    const work = join(cwd, "dispatch-work");
    mkdirSync(work, { recursive: true });
    const servers = d.buildSessionCapabilities({ sessionId: dispatchId, mode: "dispatch", cwd: home, roots: [home] });
    const spawn = await (servers["winter__sessions"]!.instance as WinterMcpServerInstance).callTool("session_spawn", {
      dir: work, model: "winter-test/calls", title: "Listing", prompt: script(arm("await notes.wakeWhen({ clicked: 14 })")),
    }) as { content: Array<{ text: string }>; isError: boolean };
    expect(spawn.isError).toBe(false);
    const child = /spawned session (s_[0-9a-z]+)/.exec(spawn.content[0]!.text)![1]!;
    const updates = () => (log(dispatchId).filter((e) => e.type === "child_update" && (e as { childSessionId: string }).childSessionId === child) as Array<{ status: string }>).map((u) => u.status);
    await until(() => updates().includes("completed") || undefined, 60_000, "the child's first report");
    const armed = await until(() => log(child).find((e) => e.type === "wake_armed") as { wakeId: string } | undefined, 10_000, "the child's trigger");
    const wakesBefore = log(dispatchId).filter((e) => e.type === "user_message" && (e as { clientName?: string }).clientName === "dispatch-wake").length;
    app.fire(armed.wakeId);
    await until(() => wakeMessages(log(child))[0], 30_000, "the child's wake");
    await until(() => updates().filter((s) => s === "completed").length >= 2 || undefined, 60_000, "the wake turn's report");
    expect(updates()).toEqual(["running", "completed", "running", "completed"]);
    await until(() => log(dispatchId).filter((e) => e.type === "user_message" && (e as { clientName?: string }).clientName === "dispatch-wake").length > wakesBefore || undefined, 30_000, "the coordinator's wake");
  }, 180_000);

  test("restart: an armed trigger ends `restart` at the next boot and its session is woken once", async () => {
    const sid = await session();
    await client.call(METHODS.sessionSend, { sessionId: sid, text: script(arm("await notes.wakeWhen({ text: 'Approved' }, { note: 'ship it' })")) });
    await turns(sid, 1, "the arming turn");
    const armed = log(sid).find((e) => e.type === "wake_armed") as { wakeId: string };
    await stop();
    await boot();
    const wake = await until(() => wakeMessages(log(sid))[0], 60_000, "the restart wake");
    expect(wake.text).toContain("Winter restarted, so this wait ended — arm it again with wakeWhen() if you still need it.");
    expect(wake.text).toContain(`- ${armed.wakeId} (armed at`);
    expect(wake.text).toContain("Your note: ship it");
    expect(ended(log(sid))).toEqual([expect.objectContaining({ wakeId: armed.wakeId, reason: "restart", woken: true })]);
    await turns(sid, 2, "the restart wake turn");
  }, 180_000);
});
