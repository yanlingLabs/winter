// SendMessage between Winter sessions (`agent/session-messaging.ts`) — the daemon's half of the agent
// SDK's `Options.hostMessaging`. A REAL SessionStore + SessionHub in a temp home; the driver table is a
// recording fake that behaves like the real one (a `send` appends the `user_message` and, when idle,
// begins the turn). The end-to-end path through a real runtime child is `e2e/dispatch-spawn-e2e`.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { makeActivityDeriver, makeSessionSignalsDeriver } from "../../src/sessions/activity";
import { CHAT_SENDER_REFUSAL, SessionMessaging, sessionIdFromAddress, type MessagingDriverHandle } from "../../src/agent/session-messaging";
import { DispatchChildren } from "../../src/agent/dispatch-children";

class FakeDriver implements MessagingDriverHandle {
  turnRunning = false;
  state: "live" | "resumable" | "ended" = "live";
  readonly sends: Array<{ text: string; clientName?: string }> = [];
  failNext?: Error;
  constructor(private readonly hub: SessionHub, readonly sessionId: string) {}
  async send(text: string, clientName?: string): Promise<{ seq: number; queued: boolean }> {
    if (this.failNext) { const e = this.failNext; this.failNext = undefined; throw e; }
    this.sends.push({ text, ...(clientName === undefined ? {} : { clientName }) });
    const ev = this.hub.append(this.sessionId, { type: "user_message", sessionId: this.sessionId, threadId: "main", text, clientName: clientName ?? "session" });
    if (this.turnRunning) return { seq: ev.seq, queued: true };
    this.turnRunning = true;
    this.state = "live";
    return { seq: ev.seq, queued: false };
  }
}

function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-session-messaging-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const drivers = new Map<string, FakeDriver>();
  const ensured: string[] = [];
  let ensureFails: Error | undefined;
  let ensureNone = false;
  const driverFor = (id: string) => { let d = drivers.get(id); if (!d) { d = new FakeDriver(hub, id); drivers.set(id, d); } return d; };
  const attached = new Set<string>();
  // THE derivation `session.list` and ListSessions use, over fake live sources.
  const derive = makeActivityDeriver({
    attachedCount: (sid) => (attached.has(sid) ? 1 : 0),
    turnRunning: (sid) => drivers.get(sid)?.turnRunning ?? false,
    bgWork: () => false,
    lastEventTs: (sid) => store.lastEventTs(sid),
  });
  const signals = makeSessionSignalsDeriver({
    attachedCount: (sid) => (attached.has(sid) ? 1 : 0),
    turnRunning: (sid) => drivers.get(sid)?.turnRunning ?? false,
    bgWork: () => false,
  });
  const dc = new DispatchChildren({
    store, hub, createSession: () => undefined,
    sessions: { get: (id) => drivers.get(id), ensure: async (id) => driverFor(id) },
    log: () => {}, defer: () => {}, schedule: () => {},
  });
  dc.start();
  const messaging = new SessionMessaging({
    store, derive, working: (sid) => signals(sid).working,
    sessions: {
      get: (id) => drivers.get(id),
      ensure: async (id) => {
        ensured.push(id);
        if (ensureFails) throw ensureFails;
        return ensureNone ? undefined : driverFor(id);
      },
    },
    followUp: () => dc,
    log: () => {},
  });
  const code = (opts: { title?: string } = {}) => {
    const sid = store.createSession("global", { mode: "code", cwd: home });
    if (opts.title) hub.append(sid, { type: "session_titled", sessionId: sid, threadId: "main", title: opts.title });
    return sid;
  };
  let n = 0;
  const send = (from: string, to: string, message = "hello", extra: { notifyWhenIdle?: boolean; summary?: string } = {}) =>
    messaging.send(from, { to, message, messageId: `msg-${++n}`, ...extra });
  return {
    home, store, hub, drivers, driverFor, ensured, attached, messaging, code, send, dc,
    failEnsure: (e: Error) => { ensureFails = e; },
    noDriver: () => { ensureNone = true; },
  };
}

describe("addressing", () => {
  test("an s_ id and its session: address resolve; anything else does not", () => {
    expect(sessionIdFromAddress("s_171da86bd4ba")).toBe("s_171da86bd4ba");
    expect(sessionIdFromAddress(" session:s_171da86bd4ba ")).toBe("s_171da86bd4ba");
    expect(sessionIdFromAddress("Fix the build")).toBeUndefined();
    expect(sessionIdFromAddress("session:")).toBeUndefined();
    expect(sessionIdFromAddress("agent:s_1:c1")).toBeUndefined();
  });
});

describe("SendMessage to a session", () => {
  test("an IDLE live session gets the message now (delivered), attributed to the sender, under clientName messaging", async () => {
    const t = setup();
    const from = t.code();
    const to = t.code({ title: "Fix login" });
    t.driverFor(to);
    const answer = await t.send(from, to, "please run the tests", { summary: "run tests" });
    expect(answer.status).toBe("delivered");
    expect(answer.note).toContain(`session ${to} ("Fix login") is not one of your children`);
    expect(answer.note).toContain(`SendMessage to ${from}`);
    const sent = t.driverFor(to).sends.at(-1)!;
    expect(sent.clientName).toBe("messaging");
    expect(sent.text).toStartWith(`<agent-message from="session:${from}" message-id="msg-1" sender-permission-class="prompts">`);
    expect(sent.text).toContain("<summary>run tests</summary>");
    expect(sent.text).toContain("please run the tests");
    expect(t.ensured).toEqual([]);
  });

  test("a session mid-turn queues it behind the running turn", async () => {
    const t = setup();
    const from = t.code();
    const to = t.code();
    t.driverFor(to).turnRunning = true;
    expect((await t.send(from, to)).status).toBe("queued");
  });

  test("a FINISHED session (no live driver) is resumed through its driver for the message", async () => {
    const t = setup();
    const from = t.code();
    const to = t.code();
    const answer = await t.send(from, `session:${to}`);
    expect(answer.status).toBe("resumed_and_delivered");
    expect(t.ensured).toEqual([to]);
    expect(t.driverFor(to).sends).toHaveLength(1);
  });

  test("a resumable driver counts as resumed too", async () => {
    const t = setup();
    const from = t.code();
    const to = t.code();
    t.driverFor(to).state = "resumable";
    expect((await t.send(from, to)).status).toBe("resumed_and_delivered");
  });

  test("refusals: self, archived, unknown, a non-id `to`, an empty message, a chat sender — nothing delivered or resumed", async () => {
    const t = setup();
    const from = t.code();
    const archived = t.code();
    t.store.setArchived(archived, true);
    const chat = t.store.createSession("global", { mode: "chat" });
    expect(await t.send(from, from)).toMatchObject({ status: "refused", reason: "cannot SendMessage to your own session" });
    expect((await t.send(from, archived)).status).toBe("refused");
    expect((await t.send(from, archived)).reason).toContain("archived");
    expect(await t.send(from, "s_doesnotexist")).toMatchObject({ status: "not_found", reason: "no Winter session 's_doesnotexist'" });
    expect((await t.send(from, "the build session")).status).toBe("not_found");
    expect((await t.send(from, t.code(), "   ")).status).toBe("refused");
    expect(await t.send(chat, from)).toMatchObject({ status: "refused", reason: CHAT_SENDER_REFUSAL });
    expect(t.ensured).toEqual([]);
    for (const d of t.drivers.values()) expect(d.sends).toEqual([]);
  });

  test("a session with nothing to resume, or one that cannot be reopened, is unavailable (not retryable)", async () => {
    const t = setup();
    const from = t.code();
    t.noDriver();
    expect(await t.send(from, t.code())).toMatchObject({ status: "unavailable", retryable: false });
    const t2 = setup();
    t2.failEnsure(Object.assign(new Error("the transcript is gone"), { code: "session_cwd_unavailable" }));
    const answer = await t2.send(t2.code(), t2.code());
    expect(answer).toMatchObject({ status: "unavailable", retryable: false });
    expect(answer.reason).toContain("session_cwd_unavailable");
  });

  test("a code session may message a dispatch session and a chat session (attributed)", async () => {
    const t = setup();
    const from = t.code();
    const dispatch = t.store.createSession("global", { mode: "dispatch", origin: "dispatch" });
    const chat = t.store.createSession("global", { mode: "chat" });
    expect((await t.send(from, dispatch)).status).toBe("resumed_and_delivered");
    expect((await t.send(from, chat)).status).toBe("resumed_and_delivered");
    expect(t.driverFor(dispatch).sends[0]!.text).toStartWith("<agent-message");
  });

  test("notify_when_idle is answered as a separate refused fact beside a delivered message", async () => {
    const t = setup();
    const answer = await t.send(t.code(), t.code(), "hi", { notifyWhenIdle: true });
    expect(answer.status).toBe("resumed_and_delivered");
    expect(answer.notify?.refused).toBeDefined();
  });

  test("a coordinator's message to its own child that cannot be delivered undoes the background flag it set", async () => {
    const t = setup();
    const dispatch = t.store.createSession("global", { mode: "dispatch", origin: "dispatch" });
    const child = t.store.createSession("global", { mode: "code", origin: "dispatch-child", parentSessionId: dispatch, cwd: t.home });
    t.driverFor(child).failNext = new Error("queue closed");
    const answer = await t.send(dispatch, child);
    expect(answer).toMatchObject({ status: "unavailable" });
    expect(t.store.meta(child).backgrounded).not.toBe(true);
  });

  test("after shutdown begins, nothing is delivered", async () => {
    const t = setup();
    t.messaging.beginShutdown();
    expect(await t.send(t.code(), t.code())).toMatchObject({ status: "unavailable", retryable: true });
    expect(t.ensured).toEqual([]);
  });
});

describe("ListAgents' session rows", () => {
  test("only RUNNING peers (the session.list label `active`, or `background` AND working), never idle, archived, background-but-idle, the caller, chat or dispatch", async () => {
    const t = setup();
    const caller = t.code();
    const attachedOne = t.code({ title: "Attached one" });
    t.attached.add(attachedOne);
    const working = t.code({ title: "Working\nunattended" });
    t.driverFor(working).turnRunning = true;   // a running turn with no harness → background
    const flagged = t.code();
    t.store.setBackgrounded(flagged, true);
    t.code({ title: "Idle one" });
    const archived = t.code();
    t.store.setArchived(archived, true);
    t.attached.add(archived);
    t.attached.add(caller);
    const dispatch = t.store.createSession("global", { mode: "dispatch", origin: "dispatch" });
    t.attached.add(dispatch);
    const rows = t.messaging.list(caller).sessions;
    // `flagged` is backgrounded but doing nothing (every finished dispatch child looks like this): not listed.
    expect(rows.map((r) => r.address).sort()).toEqual([`session:${attachedOne}`, `session:${working}`].sort());
    expect(rows.some((r) => r.address === `session:${flagged}`)).toBe(false);
    // The same flagged session IS listed while it works.
    t.driverFor(flagged).turnRunning = true;
    expect(t.messaging.list(caller).sessions.some((r) => r.address === `session:${flagged}`)).toBe(true);
    expect(rows.find((r) => r.address === `session:${working}`)).toMatchObject({ name: "Working unattended", status: "running", mode: "code" });
    expect(rows.find((r) => r.address === `session:${attachedOne}`)).toMatchObject({ name: "Attached one", status: "idle" });
  });

  test("a chat caller lists no sessions", () => {
    const t = setup();
    const busy = t.code();
    t.attached.add(busy);
    const chat = t.store.createSession("global", { mode: "chat" });
    expect(t.messaging.list(chat)).toEqual({ sessions: [] });
  });
});
