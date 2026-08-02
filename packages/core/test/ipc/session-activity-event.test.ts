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

// session-activity-hygiene T4: the `session_activity` TRANSIENT — the LIVE half of the lifecycle
// `session.list` (T2) made readable and `session.setActivity` (T3) made writable. Without it a
// second harness with the session open learns of a background/archive only on its next
// `session.list` poll.
//
// This file is about the DAEMON's two emission seams, which are in two different handlers:
//   1. `session.setActivity`, after the flag write
//   2. `session.attach`'s archived-clear — the resume path, easy to miss precisely because the
//      lifecycle RPC is somewhere else
// The hub-level contract (change filter, borrowed seq, never persisted, bounded memo) is pinned in
// test/hub.test.ts; what is pinned HERE is that the handlers actually call it, with the same value
// they answer the caller with.
//
// Own harness (this codebase's convention: no shared test-harness module) — a copy of
// session-set-activity.test.ts's client that also CAPTURES events, which that file's deliberately
// does not.

/** Minimal raw NDJSON JSON-RPC client that records both responses and pushed events. */
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

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  activities(): string[] {
    return this.events.filter((e) => e.type === "session_activity").map((e) => e.activity);
  }

  close(): void { this.socket.end(); }
}

/** The events arrive on a socket, so an assertion of ABSENCE has to give them a chance to show up
 *  first — otherwise "no event" is indistinguishable from "not yet". Every negative assertion below
 *  is preceded by a round-trip to the same server (an RPC whose response cannot overtake an event
 *  enqueued before it) plus this settle. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("session_activity transient (session-activity-hygiene T4)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{
    store: SessionStore; hub: SessionHub; socketPath: string; harnessToken: string;
    running: Set<string>; bgWork: Set<string>;
  }> {
    const home = mkdtempSync(join(tmpdir(), "norma-activity-event-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const running = new Set<string>();
    const bgWork = new Set<string>();
    const engine: any = {
      isRunning: (id: string) => running.has(id),
      hasBackgroundWork: (id: string) => bgWork.has(id),
    };
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub, engine });
    stop = () => { server.stop(); store.close(); };
    return { store, hub, socketPath, harnessToken: tokens.harness, running, bgWork };
  }

  // -----------------------------------------------------------------------------------------
  // Seam 1: session.setActivity
  // -----------------------------------------------------------------------------------------

  test("session.setActivity broadcasts the new state to an ALREADY-ATTACHED harness", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");

    // The viewer: a second harness with the session open, which is exactly who would otherwise
    // have to poll session.list to notice.
    const viewer = await TestClient.connect(socketPath);
    await viewer.hello(harnessToken, "viewer");
    await viewer.request(METHODS.sessionAttach, { sessionId });

    const setter = await TestClient.connect(socketPath);
    await setter.hello(harnessToken, "setter");
    const res = await setter.request(METHODS.sessionSetActivity, { sessionId, activity: "background" });

    await waitFor(() => viewer.activities().length === 1, "the session_activity transient");
    expect(viewer.activities()).toEqual(["background"]);
    // The SAME value the caller was handed — one derivation, so the two surfaces cannot describe
    // different states.
    expect(res.result.activity).toBe("background");
    const event = viewer.events.filter((e) => e.type === "session_activity").at(-1);
    expect(event.sessionId).toBe(sessionId);
    // Transient: it borrows the store's head instead of consuming a seq of its own.
    expect(event.seq).toBe(store.lastSeq(sessionId));
    viewer.close(); setter.close();
  });

  test("archiving, then clearing, streams the whole trajectory", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");
    const viewer = await TestClient.connect(socketPath);
    await viewer.hello(harnessToken, "viewer");
    await viewer.request(METHODS.sessionAttach, { sessionId });

    await viewer.request(METHODS.sessionSetActivity, { sessionId, activity: "archived" });
    await viewer.request(METHODS.sessionSetActivity, { sessionId, activity: null });
    await waitFor(() => viewer.activities().length === 2, "both transitions");
    // The clear lands on "active", not "idle": this connection is attached, and the emitted value
    // is the DERIVED state, not the flag that was written.
    expect(viewer.activities()).toEqual(["archived", "active"]);
    viewer.close();
  });

  test("an IDEMPOTENT set emits nothing the second time", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");
    const viewer = await TestClient.connect(socketPath);
    await viewer.hello(harnessToken, "viewer");
    await viewer.request(METHODS.sessionAttach, { sessionId });

    await viewer.request(METHODS.sessionSetActivity, { sessionId, activity: "background" });
    await waitFor(() => viewer.activities().length === 1, "the first transient");
    await viewer.request(METHODS.sessionSetActivity, { sessionId, activity: "background" });
    await settle();
    expect(viewer.activities()).toEqual(["background"]); // still one
    viewer.close();
  });

  test("a REFUSED set emits nothing — no state moved", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const chatId = store.createSession("global", { mode: "chat" });
    const viewer = await TestClient.connect(socketPath);
    await viewer.hello(harnessToken, "viewer");
    await viewer.request(METHODS.sessionAttach, { sessionId: chatId });

    const res = await viewer.request(METHODS.sessionSetActivity, { sessionId: chatId, activity: "background" });
    expect(res.error).toBeDefined();
    await settle();
    expect(viewer.activities()).toEqual([]);
    viewer.close();
  });

  // -----------------------------------------------------------------------------------------
  // Seam 2: session.attach's archived-clear — the one in the OTHER handler
  // -----------------------------------------------------------------------------------------

  test("attaching to an ARCHIVED session announces the resume", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");
    store.setArchived(sessionId, true);

    // A harness already watching this (archived) session — it must learn that someone resumed it.
    const viewer = await TestClient.connect(socketPath);
    await viewer.hello(harnessToken, "viewer");
    await viewer.request(METHODS.sessionAttach, { sessionId });
    await settle();
    // The viewer's OWN attach already cleared the archive and announced it (a resume is a resume
    // whoever performs it) — that is this seam firing once.
    expect(viewer.activities()).toEqual(["active"]);
    expect(store.list().find((s) => s.sessionId === sessionId)!.archived).toBeUndefined();
    viewer.close();
  });

  test("the resume announcement is the DERIVED state — a backgrounded session resumes to 'background', not 'active'", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");
    store.setBackgrounded(sessionId, true);
    store.setArchived(sessionId, true);

    const viewer = await TestClient.connect(socketPath);
    await viewer.hello(harnessToken, "viewer");
    await viewer.request(METHODS.sessionAttach, { sessionId });
    await waitFor(() => viewer.activities().length === 1, "the resume announcement");
    // Attach clears ONLY the archive flag, so the background flag still outranks the attachment.
    // An emission that reported the flag it wrote (or a hardcoded "active") would say the wrong
    // thing here.
    expect(viewer.activities()).toEqual(["background"]);
    viewer.close();
  });

  test("attaching to a NON-archived session announces nothing — attach alone is not a lifecycle change", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");
    const viewer = await TestClient.connect(socketPath);
    await viewer.hello(harnessToken, "viewer");
    await viewer.request(METHODS.sessionAttach, { sessionId });
    await settle();
    // T5 owns attach/detach-driven transitions; T4 emits only where a flag actually moved.
    expect(viewer.activities()).toEqual([]);
    viewer.close();
  });

  test("attaching to a CHAT session announces nothing even if the archived flag was set on it", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global", { mode: "chat" });
    store.setArchived(sessionId, true);
    const viewer = await TestClient.connect(socketPath);
    await viewer.hello(harnessToken, "viewer");
    await viewer.request(METHODS.sessionAttach, { sessionId });
    await settle();
    // Chat does not participate: the derivation returns undefined and `emitActivity` emits nothing.
    // Absence is never represented on the wire.
    expect(viewer.activities()).toEqual([]);
    viewer.close();
  });
});
