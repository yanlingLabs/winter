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

// b2-agent-browser T1 (spec §5): `session.list`'s per-row `signals` — the standing prerequisite the
// Mac app's browser runtime has been waiting on.
//
// Two claims, and they are the whole surface:
//   1. The signals are computed for EVERY MODE. A chat session's running turn and its phone
//      attachment are facts about this daemon whether or not the session has a lifecycle LABEL —
//      `participatesInActivity` gates the label, and nothing else.
//   2. `attachedElsewhere` excludes the REQUESTING connection. "Is anyone else here?" is a question
//      only the daemon can answer without guessing, because only the daemon knows which attachment
//      is the asker's (the Mac app spent a whole task guessing it — see the deleted
//      `ownAttachmentStillCountedIn`).
//
// Own harness, this codebase's convention (no shared test-harness module) — the raw NDJSON client
// from session-activity-event.test.ts, trimmed to what these rows need.

/** Minimal raw NDJSON JSON-RPC client. */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
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
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
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

  /** The one row of `session.list` this file is about. */
  async row(sessionId: string): Promise<any> {
    const res = await this.request(METHODS.sessionList);
    return res.result.sessions.find((s: any) => s.sessionId === sessionId);
  }

  close(): void { this.socket.end(); }
}

describe("session.list signals (b2-agent-browser T1)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{
    store: SessionStore; hub: SessionHub; socketPath: string; harnessToken: string;
    running: Set<string>; bgWork: Set<string>;
  }> {
    const home = mkdtempSync(join(tmpdir(), "norma-list-signals-"));
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
      interrupt: (id: string) => { running.delete(id); return { wasRunning: true }; },
    };
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub, engine });
    stop = () => { server.stop(); store.close(); };
    return { store, hub, socketPath, harnessToken: tokens.harness, running, bgWork };
  }

  // -----------------------------------------------------------------------------------------
  // Claim 1: every mode, label or no label
  // -----------------------------------------------------------------------------------------

  test("a CHAT session reports both signals while its `activity` label stays absent", async () => {
    const { store, socketPath, harnessToken, running } = await boot();
    const sessionId = store.createSession("global", { mode: "chat" });

    // The phone, holding the session open. A separate connection, because that is the fact the
    // signal is about — "someone else is here".
    const phone = await TestClient.connect(socketPath);
    await phone.hello(harnessToken, "phone");
    await phone.request(METHODS.sessionAttach, { sessionId });
    running.add(sessionId);

    // The Mac shell, asking. Attached to nothing.
    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    const row = await shell.row(sessionId);

    expect(row.signals).toEqual({ attachedElsewhere: true, working: true });
    // The label is untouched by this task: chat does not participate, and absence is its answer.
    // If this ever starts reporting a state, the signals bypass has been "fixed" into the label's
    // mode gate and a chat session has silently acquired a turn-killing lifecycle.
    expect(row.activity).toBeUndefined();
    // Same gate, same row: dirs stays off a chat row too (DIRS_MODE_REFUSAL).
    expect(row.dirs).toBeUndefined();
    phone.close(); shell.close();
  });

  test("a chat session with background work but no turn is still `working`", async () => {
    const { store, socketPath, harnessToken, bgWork } = await boot();
    const sessionId = store.createSession("global", { mode: "chat" });
    bgWork.add(sessionId);

    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    // `turnRunning || bgWork` — a detached bash task outliving its turn is work, exactly as
    // `activityFor` reads it. Nothing is attached, so the other signal is false.
    expect((await shell.row(sessionId)).signals).toEqual({ attachedElsewhere: false, working: true });
    shell.close();
  });

  test("a quiet session reports both false — absence is never how `false` is spelled", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global", { mode: "chat" });
    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    const row = await shell.row(sessionId);
    expect(row.signals).toEqual({ attachedElsewhere: false, working: false });
    shell.close();
  });

  test("a CODE session gets the signals AND keeps its label", async () => {
    const { store, socketPath, harnessToken, running } = await boot();
    const sessionId = store.createSession("global");
    running.add(sessionId);

    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    const row = await shell.row(sessionId);
    expect(row.signals).toEqual({ attachedElsewhere: false, working: true });
    // Work with nothing attached is "background" (activityFor's rule 2) — the label is derived
    // exactly as before, from the same signals, and this task changed none of it.
    expect(row.activity).toBe("background");
    shell.close();
  });

  // -----------------------------------------------------------------------------------------
  // Claim 2: the asker's own attachment is not "elsewhere"
  // -----------------------------------------------------------------------------------------

  test("the requesting connection's OWN attachment does not read as attachedElsewhere", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global", { mode: "chat" });

    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    await shell.request(METHODS.sessionAttach, { sessionId });

    // Asked by the one connection holding the session: nobody ELSE is here.
    expect((await shell.row(sessionId)).signals.attachedElsewhere).toBe(false);

    // Asked by anyone else, about the same instant: somebody is. The two answers differ BY ASKER,
    // which is the entire point of computing this daemon-side.
    const other = await TestClient.connect(socketPath);
    await other.hello(harnessToken, "other");
    expect((await other.row(sessionId)).signals.attachedElsewhere).toBe(true);

    shell.close(); other.close();
  });

  test("a second harness is still visible to the connection that is itself attached", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global", { mode: "chat" });

    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    await shell.request(METHODS.sessionAttach, { sessionId });
    const phone = await TestClient.connect(socketPath);
    await phone.hello(harnessToken, "phone");
    await phone.request(METHODS.sessionAttach, { sessionId });

    // Two attachments, one of them ours: subtracting our own must leave the other standing. A
    // blunt `attachedCount > 0 ? false : ...`-style suppression (or excluding self by ROLE) would
    // hide the phone here, which is the co-attached wrong-stop the app suffered for a whole task.
    expect((await shell.row(sessionId)).signals.attachedElsewhere).toBe(true);
    shell.close(); phone.close();
  });

  test("the exclusion follows the asker's attachment, session by session", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const mine = store.createSession("global", { mode: "chat" });
    const theirs = store.createSession("global", { mode: "chat" });

    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    await shell.request(METHODS.sessionAttach, { sessionId: mine });
    const phone = await TestClient.connect(socketPath);
    await phone.hello(harnessToken, "phone");
    await phone.request(METHODS.sessionAttach, { sessionId: theirs });

    // One answer, two rows, one exclusion applied to the right one — a per-request `selfSessionId`
    // that leaked across rows would blank both.
    expect((await shell.row(mine)).signals.attachedElsewhere).toBe(false);
    expect((await shell.row(theirs)).signals.attachedElsewhere).toBe(true);
    shell.close(); phone.close();
  });

  test("a hop moves the exclusion with the attachment", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const first = store.createSession("global", { mode: "chat" });
    const second = store.createSession("global", { mode: "chat" });

    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    await shell.request(METHODS.sessionAttach, { sessionId: first });
    // Re-attach = move (SessionHub.attach's own contract). The exclusion is read from the HUB per
    // request rather than remembered on the connection, so it moves with it and never strands.
    await shell.request(METHODS.sessionAttach, { sessionId: second });

    const phone = await TestClient.connect(socketPath);
    await phone.hello(harnessToken, "phone");
    await phone.request(METHODS.sessionAttach, { sessionId: first });

    expect((await shell.row(first)).signals.attachedElsewhere).toBe(true);
    expect((await shell.row(second)).signals.attachedElsewhere).toBe(false);
    shell.close(); phone.close();
  });

  // -----------------------------------------------------------------------------------------
  // The archived flag, mode-blind (the third degradation)
  // -----------------------------------------------------------------------------------------

  test("an archived CHAT session reports `archived` on the row with no label to read", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global", { mode: "chat" });
    store.setArchived(sessionId, true);

    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    const row = await shell.row(sessionId);
    expect(row.archived).toBe(true);
    expect(row.activity).toBeUndefined();
    shell.close();
  });

  test("a session that is not archived omits the flag entirely", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global", { mode: "chat" });
    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    expect((await shell.row(sessionId)).archived).toBeUndefined();
    shell.close();
  });
});
