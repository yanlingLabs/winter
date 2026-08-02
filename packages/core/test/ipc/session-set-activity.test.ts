import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// session-activity-hygiene T3: `session.setActivity` — the WRITE half of spec §1's lifecycle
// (`session.list`'s derived `activity`, T2, is the read half). Params
// `{sessionId, activity: "background" | "archived" | null}`; `null` clears BOTH stored flags back
// to purely-derived. The result echoes the POST-WRITE derived state so a caller never has to guess
// what its write actually produced.
//
// Exercised over a bare IPC server (own SessionStore + SessionHub + TokenAuthority, engine doubled)
// — the same harness shape as session-set-effort.test.ts, whose copy of TestClient this duplicates
// (this codebase's convention: no shared test-harness module, every test/ipc/*.test.ts carries its
// own).

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated from session-set-effort.test.ts. */
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
        drain(_s) {
          c.writer.onDrain();
        },
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

  close(): void { this.socket.end(); }
}

describe("session.setActivity (session-activity-hygiene T3)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  /** The two engine signals the activity derivation reads (`isRunning`, `hasBackgroundWork` — the
   *  SAME pair `session.list`'s own signal builder consumes, T2). Both back onto MUTABLE sets the
   *  caller keeps, so a test can mark a session running AFTER creating it (the engine is bound at
   *  server construction, before any session id exists). `any`-cast because
   *  `IpcServerOptions.engine` is the full `AgentEngine`: a missing method here would be a runtime
   *  TypeError inside the handler, never a compile error, which is why both are declared. */
  async function boot(): Promise<{
    store: SessionStore; hub: SessionHub; socketPath: string; harnessToken: string; remoteToken: string;
    running: Set<string>; bgWork: Set<string>;
  }> {
    const home = mkdtempSync(join(tmpdir(), "norma-set-activity-rpc-"));
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
    return { store, hub, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote, running, bgWork };
  }

  test("background: sets the stored flag and echoes the post-write derived state", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: "background" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, activity: "background" });

    const row = store.list().find((s) => s.sessionId === sessionId)!;
    expect(row.backgrounded).toBe(true);
    expect(row.archived).toBeUndefined();
    c.close();
  });

  test("archived: sets the stored flag and echoes 'archived'", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: "archived" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, activity: "archived" });
    expect(store.list().find((s) => s.sessionId === sessionId)!.archived).toBe(true);
    c.close();
  });

  test("null clears BOTH flags — the state falls back to purely derived", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");
    // Both flags set through the store directly: the RPC's own `archived` write deliberately leaves
    // `backgrounded` alone, so this is the honest way to reach the both-set state.
    store.setBackgrounded(sessionId, true);
    store.setArchived(sessionId, true);

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: null });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, activity: "idle" });

    const row = store.list().find((s) => s.sessionId === sessionId)!;
    expect(row.backgrounded).toBeUndefined();
    expect(row.archived).toBeUndefined();
    c.close();
  });

  // The param names a TARGET STATE, not a flag. `archived` outranks `backgrounded` in the
  // derivation, so writing the background flag while leaving an archive flag set would be a wire
  // no-op — the caller asks for background and is told "archived". Naming background as the target
  // is therefore a deliberate un-archive, exactly like a resume.
  test("background on an ARCHIVED session un-archives it (the value is a target state, not a flag)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");
    store.setArchived(sessionId, true);

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: "background" });
    expect(res.result).toEqual({ ok: true, activity: "background" });
    const row = store.list().find((s) => s.sessionId === sessionId)!;
    expect(row.archived).toBeUndefined();
    expect(row.backgrounded).toBe(true);
    c.close();
  });

  // The mirror of the case above, and the reason the two are NOT symmetric: archiving ranks above
  // background in the derivation, so an archive write contradicts nothing and leaves the other flag
  // alone — `store.setArchived`'s own documented independence ("archiving a backgrounded session
  // leaves it backgrounded, and un-archiving does not clear that"), which is what returns a resumed
  // session to background rather than to idle.
  test("archived on a BACKGROUNDED session leaves the background flag set", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");
    store.setBackgrounded(sessionId, true);

    expect((await c.request(METHODS.sessionSetActivity, { sessionId, activity: "archived" })).result)
      .toEqual({ ok: true, activity: "archived" });
    const row = store.list().find((s) => s.sessionId === sessionId)!;
    expect(row.archived).toBe(true);
    expect(row.backgrounded).toBe(true);
    c.close();
  });

  test("idempotent: setting the same value twice both succeed and leave the same state", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");

    const first = await c.request(METHODS.sessionSetActivity, { sessionId, activity: "background" });
    const second = await c.request(METHODS.sessionSetActivity, { sessionId, activity: "background" });
    expect(first.result).toEqual({ ok: true, activity: "background" });
    expect(second.result).toEqual({ ok: true, activity: "background" });
    expect(store.list().find((s) => s.sessionId === sessionId)!.backgrounded).toBe(true);
    c.close();
  });

  test("clearing an already-clear session is idempotent too", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: null });
    expect(res.result).toEqual({ ok: true, activity: "idle" });
    c.close();
  });

  // The echoed state is DERIVED, never a restatement of what was written: a session whose detached
  // background task is still writing derives "background" even AFTER a clear, and the caller learns
  // that from this response rather than from a second `session.list` round trip.
  test("the echoed activity is derived from live signals, not from the flag just written", async () => {
    const { store, socketPath, harnessToken, bgWork } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");
    bgWork.add(sessionId); // a detached agent thread / backgrounded bash task, nothing attached

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: null });
    expect(res.result).toEqual({ ok: true, activity: "background" });
    expect(store.list().find((s) => s.sessionId === sessionId)!.backgrounded).toBeUndefined();
    c.close();
  });

  // The other half of "derived, not restated": an ATTACHED session reads back "active" after a
  // clear. This also pins that the handler derives against the hub that actually holds attachments
  // — a derivation wired to a different hub instance would report "idle" here.
  test("the echoed activity sees live ATTACHMENTS too", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");
    await c.request(METHODS.sessionAttach, { sessionId });

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: null });
    expect(res.result).toEqual({ ok: true, activity: "active" });
    c.close();
  });

  test("unknown session → NOT_FOUND", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");

    const res = await c.request(METHODS.sessionSetActivity, { sessionId: "s_does_not_exist", activity: "background" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // NOT_FOUND takes PRECEDENCE over every refusal: each refusal reads a fact about the session (its
  // mode, whether a turn is running), so an unknown id must be reported as unknown rather than as a
  // refusal that implies the session exists. `archived` is the value carrying its own refusal, and
  // the engine is primed to claim that very id is running — so a handler that checked the run state
  // before resolving the session would answer INVALID_PARAMS here.
  test("unknown session → NOT_FOUND even for the value that has its own refusal (archived)", async () => {
    const { socketPath, harnessToken, running } = await boot();
    running.add("s_does_not_exist");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");

    const res = await c.request(METHODS.sessionSetActivity, { sessionId: "s_does_not_exist", activity: "archived" });
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("unknown session → NOT_FOUND even when CLEARING", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");

    const res = await c.request(METHODS.sessionSetActivity, { sessionId: "s_does_not_exist", activity: null });
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // Participation is T2's allowlist (code + cowork + absent-means-code): chat and dispatch have NO
  // lifecycle at all, so there is no state to set on them. The refusal is what keeps `session.list`
  // honest about `activity` being ABSENT on those rows rather than merely unset.
  for (const mode of ["chat", "dispatch"] as const) {
    test(`refuses a ${mode.toUpperCase()} target with INVALID_PARAMS — no flag is written`, async () => {
      const { store, socketPath, harnessToken } = await boot();
      const c = await TestClient.connect(socketPath);
      await c.hello(harnessToken, "activity-setter");
      const sessionId = store.createSession("global", mode === "chat"
        ? { mode: "chat", approvalPolicy: "chat" as any }
        : { mode: "dispatch", origin: "dispatch" });

      const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: "background" });
      expect(res.error).toBeTruthy();
      expect(res.error.code).toBe(ERR.INVALID_PARAMS);
      expect(res.error.message).toBe("activity states apply to code and cowork sessions only");
      expect(store.list().find((s) => s.sessionId === sessionId)!.backgrounded).toBeUndefined();
      c.close();
    });
  }

  test("refuses a CLEAR on a chat target too (the refusal is about the session, not the value)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global", { mode: "chat", approvalPolicy: "chat" as any });

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: null });
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  // Archived is a flag over IDLE (spec §1.4). Archiving a session with a turn in flight would
  // strand that turn behind a hidden tab, so the door refuses and names the two ways out.
  test("refuses ARCHIVED on a session with a running turn — nothing is written", async () => {
    const { store, socketPath, harnessToken, running } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");
    running.add(sessionId);

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: "archived" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toBe("stop or background it first");
    expect(store.list().find((s) => s.sessionId === sessionId)!.archived).toBeUndefined();
    c.close();
  });

  // The refusal is scoped to the value that needs it: BACKGROUNDING a running session is the whole
  // point of the flag ("keep running unattended"), so it must stay allowed — and clearing must too,
  // or a mis-flagged running session could never be un-flagged.
  test("BACKGROUND and CLEAR are both allowed on a running session", async () => {
    const { store, socketPath, harnessToken, running } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");
    running.add(sessionId);

    expect((await c.request(METHODS.sessionSetActivity, { sessionId, activity: "background" })).result)
      .toEqual({ ok: true, activity: "background" });
    // Nothing attached + a turn running ⇒ the derivation says "background" regardless of the flag.
    expect((await c.request(METHODS.sessionSetActivity, { sessionId, activity: null })).result)
      .toEqual({ ok: true, activity: "background" });
    expect(store.list().find((s) => s.sessionId === sessionId)!.backgrounded).toBeUndefined();
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // Resume clears the archive flag (spec §1.4: archived is "resumable only deliberately — resume
  // clears the flag").
  //
  // `session.attach` is THE resume seam, and it is the only one this needs: `session.send` refuses
  // outright until the SAME connection has attached ("attach to the session first", ipc/server.ts),
  // so no user message can reach a session without an attach first — on the Mac (CLI/TUI/app) and
  // on the phone alike, whose Gateway relays `session.attach` through the same handler. The test
  // below pins that guard so this reasoning is load-bearing in a test rather than only in prose.
  // -------------------------------------------------------------------------------------------

  test("session.attach on an ARCHIVED session clears the flag (resume = deliberate un-archive)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-resumer");
    const sessionId = store.createSession("global");
    store.setArchived(sessionId, true);

    const res = await c.request(METHODS.sessionAttach, { sessionId });
    expect(res.error).toBeUndefined();
    expect(store.list().find((s) => s.sessionId === sessionId)!.archived).toBeUndefined();
    // …and the session reads as attached-and-active immediately after, not as archived.
    const listed = await c.request(METHODS.sessionList, {});
    expect(listed.result.sessions.find((s: any) => s.sessionId === sessionId).activity).toBe("active");
    c.close();
  });

  test("attach does NOT clear the background flag — only the archive flag is a resume-cleared bit", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-resumer");
    const sessionId = store.createSession("global");
    store.setBackgrounded(sessionId, true);
    store.setArchived(sessionId, true);

    await c.request(METHODS.sessionAttach, { sessionId });
    const row = store.list().find((s) => s.sessionId === sessionId)!;
    expect(row.archived).toBeUndefined();
    expect(row.backgrounded).toBe(true);
    c.close();
  });

  // The structural reason `session.attach` is the ONLY clearing point needed: there is no send
  // path around it. If this guard ever softens, the send path becomes a second resume seam and owes
  // its own clear.
  test("session.send is attach-gated — no user message can reach a session without attaching first", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-resumer");
    const sessionId = store.createSession("global");
    store.setArchived(sessionId, true);

    const res = await c.request(METHODS.sessionSend, { sessionId, text: "hello" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    expect(res.error.message).toBe("attach to the session first");
    // Refused ⇒ nothing resumed ⇒ the flag is untouched.
    expect(store.list().find((s) => s.sessionId === sessionId)!.archived).toBe(true);
    c.close();
  });

  // A cowork-shaped session — mode written straight to the store, the idiom
  // remote-chat-gate.test.ts established (there is no session.create or wire support for "cowork",
  // deliberately). Cowork is on T2's participation allowlist, so a LOCAL caller must be able to set
  // its activity: this is the only end-to-end proof that the allowlist's second member works.
  function makeCoworkSession(store: SessionStore): string {
    const id = store.createSession("global");
    (store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["cowork", id]);
    return id;
  }

  test("a COWORK session is settable (the participation allowlist is code AND cowork)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = makeCoworkSession(store);

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: "background" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, activity: "background" });
    expect(store.list().find((s) => s.sessionId === sessionId)!.backgrounded).toBe(true);
    c.close();
  });

  // A REMOTE caller reaches this method through the same allowlist entry every other bare-sessionId
  // verb uses, so the `assertRemoteMayUseSession` guard must apply here too — and it is a STRICTLY
  // DIFFERENT gate from participation: cowork participates (settable locally, just above) yet stays
  // Mac-local, so remote is refused by the mode gate before any flag is written.
  test("remote role: a Mac-local-only (cowork) target is refused before any write", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const sessionId = makeCoworkSession(store);

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: "background" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toBe("cowork sessions are not available to remote clients");
    expect(store.list().find((s) => s.sessionId === sessionId)!.backgrounded).toBeUndefined();
    c.close();
  });

  test("remote role: a plain code session is settable (the method is on the remote allowlist)", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: "background" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, activity: "background" });
    c.close();
  });
});
