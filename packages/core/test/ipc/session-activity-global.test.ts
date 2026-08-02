import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// ==============================================================================================
// session-activity-hygiene T9 (the core half): the GLOBAL fan-out of `session_activity`.
//
// T4 shipped the transient on the per-session path only (`emitActivity` → `broadcastTransient` →
// `fanOut`), which reaches ONLY clients attached to that session. The whole subject of `norma
// agents` is sessions nobody has open — and `manage_session`'s own description already promises the
// change is "announced live to the user's open windows", which for an unattached session reached
// exactly zero clients.
//
// The reach of the two paths is NOT the same set, which is why this is a delivery decision and not
// a one-liner (evidence pinned by the tests below):
//
//   per-session `fanOut`  → whoever is ATTACHED, any role — including a remote (phone) connection,
//                           through the one `HubClient` in `session.attach` that applies
//                           `filterRemoteStreamEvent` (allowlist + `capEvent`).
//   global `onGlobalEvent`→ every conn that hello'd with role "harness", ATTACHED OR NOT
//                           (`harnessConns`, added at hello, removed at close). Role "remote" is
//                           never in that set, so a phone never receives a foreign session's
//                           global event — the `session_titled` precedent, pinned below.
//
// Global-only would therefore have silently cut the phone off a type T4 deliberately allowlisted
// for it; dual delivery alone would have doubled every event for an attached harness (transients
// are exempt from seq dedupe by contract, so nothing absorbs it) and broken T4/T5's exact-sequence
// pins. So: BOTH paths, with the overlap removed at the global sink — exactly once for everyone.
// ==============================================================================================

/** Minimal raw NDJSON JSON-RPC client that records both responses and pushed events (this
 *  codebase's convention: no shared test-harness module — cf. session-activity-event.test.ts). */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: any[] = [];

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            } else if (msg.method === METHODS.event) {
              c.events.push(msg.params);
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  ofType(type: string): any[] { return this.events.filter((e) => e.type === type); }
  activities(): string[] { return this.ofType("session_activity").map((e) => e.activity); }
  close(): void { this.socket.end(); }
}

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** An assertion of ABSENCE has to give the event a chance to show up first, otherwise "never" is
 *  indistinguishable from "not yet". Every negative assertion below is preceded by a round-trip to
 *  the same server plus this settle. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe("session_activity global fan-out (session-activity-hygiene T9)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{
    store: SessionStore; hub: SessionHub; socketPath: string;
    harnessToken: string; remoteToken: string; running: Set<string>;
  }> {
    const home = mkdtempSync(join(tmpdir(), "norma-activity-global-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const running = new Set<string>();
    const engine: any = {
      isRunning: (id: string) => running.has(id),
      hasBackgroundWork: () => false,
      interrupt: (id: string) => { running.delete(id); return { wasRunning: true }; },
    };
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub, engine });
    stop = () => { server.stop(); store.close(); };
    return { store, hub, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote, running };
  }

  // -------------------------------------------------------------------------------------------
  // The reach map, pinned. These two are the EVIDENCE for the delivery decision, not decoration:
  // they are what makes "the global path's reach is not a superset of the attached set" a fact
  // about this daemon rather than a claim about it.
  // -------------------------------------------------------------------------------------------

  test("REACH: a hello'd harness that never attached DOES receive global events today (session_titled, the precedent)", async () => {
    const { store, hub, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");

    const roster = await TestClient.connect(socketPath);
    await roster.hello(harnessToken, "cli-agents"); // hello only — never attaches

    hub.append(sessionId, { type: "session_titled", sessionId, threadId: "main", title: "Fix the reaper" });
    await waitFor(() => roster.ofType("session_titled").length === 1, "the global session_titled");
    expect(roster.ofType("session_titled")[0].title).toBe("Fix the reaper");
    roster.close();
  });

  test("REACH: a REMOTE connection never receives a global event, attached or not — it is not a harness conn", async () => {
    const { store, hub, socketPath, remoteToken } = await boot();
    const sessionId = store.createSession("global", { mode: "code" });
    const other = store.createSession("global", { mode: "code" });

    const phone = await TestClient.connect(socketPath);
    await phone.hello(remoteToken, "iphone-gateway", "remote");
    await phone.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await waitFor(() => phone.ofType("harness_attached").length === 1, "the attach to settle");

    // A title on a session it is NOT attached to: global-only, so it must not arrive.
    hub.append(other, { type: "session_titled", sessionId: other, threadId: "main", title: "Somebody else's work" });
    // A barrier on the session it IS attached to — once this lands, the global above has provably
    // had its chance (both are synchronous, in order).
    hub.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "barrier" });
    await waitFor(() => phone.ofType("assistant_message").length === 1, "the barrier");
    expect(phone.ofType("session_titled")).toEqual([]);
    phone.close();
  });

  // -------------------------------------------------------------------------------------------
  // The change: session_activity now reaches an UNATTACHED harness.
  // -------------------------------------------------------------------------------------------

  test("an UNATTACHED harness learns a session was backgrounded — the roster's whole reason to exist", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");

    const roster = await TestClient.connect(socketPath);
    await roster.hello(harnessToken, "cli-agents"); // never attaches — T5's detach enforcement never sees it

    const setter = await TestClient.connect(socketPath);
    await setter.hello(harnessToken, "setter");
    await setter.request(METHODS.sessionSetActivity, { sessionId, activity: "background" });

    await waitFor(() => roster.activities().length === 1, "the global session_activity");
    expect(roster.activities()).toEqual(["background"]);
    const event = roster.ofType("session_activity")[0];
    expect(event.sessionId).toBe(sessionId);
    expect(event.seq).toBe(store.lastSeq(sessionId)); // still a transient: it borrows the head
    roster.close(); setter.close();
  });

  test("an UNATTACHED harness sees an ARCHIVE of a session nobody has open — the T8-review bug, verbatim", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");

    const roster = await TestClient.connect(socketPath);
    await roster.hello(harnessToken, "cli-agents");

    const setter = await TestClient.connect(socketPath);
    await setter.hello(harnessToken, "setter");
    await setter.request(METHODS.sessionSetActivity, { sessionId, activity: "archived" });
    await setter.request(METHODS.sessionSetActivity, { sessionId, activity: null });

    await waitFor(() => roster.activities().length === 2, "both transitions");
    // The clear lands on "idle", not "active": nothing is attached to this session at all.
    expect(roster.activities()).toEqual(["archived", "idle"]);
    roster.close(); setter.close();
  });

  test("the attach/detach transitions reach an unattached watcher too — a roster tracks OTHER people's windows", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");

    const roster = await TestClient.connect(socketPath);
    await roster.hello(harnessToken, "cli-agents");

    const worker = await TestClient.connect(socketPath);
    await worker.hello(harnessToken, "cli-p");
    await worker.request(METHODS.sessionAttach, { sessionId });
    await waitFor(() => roster.activities().length === 1, "the attach announcement");
    expect(roster.activities()).toEqual(["active"]);

    worker.close(); // a terminal harness letting go with no turn running → idle
    await waitFor(() => roster.activities().length === 2, "the detach announcement");
    expect(roster.activities()).toEqual(["active", "idle"]);
    roster.close();
  });

  // -------------------------------------------------------------------------------------------
  // EXACTLY ONCE: the reason this is not a bare `onGlobalEvent?.(event)` inside emitActivity.
  // -------------------------------------------------------------------------------------------

  test("an ATTACHED harness receives each transition EXACTLY ONCE — never doubled by the new path", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");

    const viewer = await TestClient.connect(socketPath);
    await viewer.hello(harnessToken, "orb");
    await viewer.request(METHODS.sessionAttach, { sessionId });

    await viewer.request(METHODS.sessionSetActivity, { sessionId, activity: "background" });
    await waitFor(() => viewer.activities().length === 2, "attach + background");
    await settle(); // give a duplicate every chance to show up
    // ["active" (the attach), "background"] — NOT ["active","active","background","background"].
    expect(viewer.activities()).toEqual(["active", "background"]);
    viewer.close();
  });

  test("a harness attached to ANOTHER session still gets the global copy — the exclusion is per-session, not per-connection", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const watched = store.createSession("global");
    const elsewhere = store.createSession("global");

    const viewer = await TestClient.connect(socketPath);
    await viewer.hello(harnessToken, "orb");
    await viewer.request(METHODS.sessionAttach, { sessionId: elsewhere });
    await waitFor(() => viewer.activities().length === 1, "its own attach announcement");

    const setter = await TestClient.connect(socketPath);
    await setter.hello(harnessToken, "setter");
    await setter.request(METHODS.sessionSetActivity, { sessionId: watched, activity: "background" });

    await waitFor(() => viewer.ofType("session_activity").length === 2, "the foreign session's transition");
    const last = viewer.ofType("session_activity").at(-1);
    expect(last.sessionId).toBe(watched);
    expect(last.activity).toBe("background");
    viewer.close(); setter.close();
  });

  // -------------------------------------------------------------------------------------------
  // The remote half: unchanged in both directions.
  // -------------------------------------------------------------------------------------------

  test("a REMOTE client ATTACHED to the session still receives its session_activity (the per-session path, allowlisted + capped)", async () => {
    const { store, socketPath, harnessToken, remoteToken } = await boot();
    const sessionId = store.createSession("global", { mode: "code" });

    const phone = await TestClient.connect(socketPath);
    await phone.hello(remoteToken, "iphone-gateway", "remote");
    await phone.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await waitFor(() => phone.activities().length === 1, "the attach announcement");
    expect(phone.activities()).toEqual(["active"]);

    const setter = await TestClient.connect(socketPath);
    await setter.hello(harnessToken, "setter");
    await setter.request(METHODS.sessionSetActivity, { sessionId, activity: "background" });
    await waitFor(() => phone.activities().length === 2, "the background transition");
    expect(phone.activities()).toEqual(["active", "background"]);
    phone.close(); setter.close();
  });

  test("SECURITY: a REMOTE client never learns about a FOREIGN session's activity — no global copy reaches it", async () => {
    const { store, hub, socketPath, harnessToken, remoteToken } = await boot();
    const mine = store.createSession("global", { mode: "code" });
    const foreign = store.createSession("global", { mode: "code" });

    const phone = await TestClient.connect(socketPath);
    await phone.hello(remoteToken, "iphone-gateway", "remote");
    await phone.request(METHODS.sessionAttach, { sessionId: mine, fromSeq: 0 });
    await waitFor(() => phone.activities().length === 1, "its own attach announcement");

    const setter = await TestClient.connect(socketPath);
    await setter.hello(harnessToken, "setter");
    await setter.request(METHODS.sessionSetActivity, { sessionId: foreign, activity: "background" });
    // Barrier on the session the phone IS attached to: once it lands, any global copy of the
    // foreign transition has provably had its chance.
    hub.append(mine, { type: "assistant_message", sessionId: mine, threadId: "main", text: "barrier" });
    await waitFor(() => phone.ofType("assistant_message").length === 1, "the barrier");
    await settle();

    expect(phone.ofType("session_activity").map((e) => e.sessionId)).toEqual([mine]);
    phone.close(); setter.close();
  });
});
