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

  /** The engine signals the activity derivation reads (`isRunning`, `hasBackgroundWork` — the SAME
   *  pair `session.list`'s own signal builder consumes, T2) plus `interrupt`, which T5's last-detach
   *  enforcement calls. The first two back onto MUTABLE sets the caller keeps, so a test can mark a
   *  session running AFTER creating it (the engine is bound at server construction, before any
   *  session id exists). `any`-cast because `IpcServerOptions.engine` is the full `AgentEngine`: a
   *  missing method here would be a runtime TypeError inside the handler, never a compile error,
   *  which is why all three are declared. */
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
      interrupt: (id: string) => { running.delete(id); return { wasRunning: true }; },
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

  // activity-verb-semantics ruling 2: RESUME (`null`) clears the ARCHIVE flag ONLY. `backgrounded`
  // survives it, which is what makes verb-resume mean the same thing as resume-by-opening
  // (`session.attach` has always cleared only the archive bit) — an archived background worker comes
  // back as a background worker, not as a session the fleet has forgotten how to think about.
  test("resume (null) clears the ARCHIVE flag only — backgrounded survives", async () => {
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
    // The derived answer, not just the flag: a resumed background worker READS "background".
    expect(res.result).toEqual({ ok: true, activity: "background" });

    const row = store.list().find((s) => s.sessionId === sessionId)!;
    expect(row.backgrounded).toBe(true);
    expect(row.archived).toBeUndefined();
    c.close();
  });

  // activity-verb-semantics ruling 3: `unbackground` clears the BACKGROUND flag only — the exact
  // mirror of resume. Before it existed, `null` was the only way to un-background and it dragged the
  // archive flag with it; now each stored bit has its own clearing verb.
  test("unbackground clears the BACKGROUND flag only", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");
    store.setBackgrounded(sessionId, true);

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: "unbackground" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, activity: "idle" });
    expect(store.list().find((s) => s.sessionId === sessionId)!.backgrounded).toBeUndefined();
    c.close();
  });

  test("unbackground on a session that was never backgrounded is an idempotent success", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: "unbackground" });
    expect(res.result).toEqual({ ok: true, activity: "idle" });
    expect(store.list().find((s) => s.sessionId === sessionId)!.backgrounded).toBeUndefined();
    c.close();
  });

  // ------------------------------------------------------------------------------------------
  // activity-verb-semantics ruling 1: an ARCHIVED session is IMMUTABLE except through resume.
  //
  // This DELIBERATELY REVERSES T3's "background is a target state, so it un-archives" — a target
  // state that silently un-hides what the user hid is the same invisible-resurrection the
  // send_message guard already refuses, just spelled with a different verb. Resume is now the ONE
  // door out, and it is named in the refusal.
  // ------------------------------------------------------------------------------------------
  for (const activity of ["background", "unbackground"] as const) {
    test(`${activity} on an ARCHIVED session is REFUSED and names resume — nothing is written`, async () => {
      const { store, socketPath, harnessToken } = await boot();
      const c = await TestClient.connect(socketPath);
      await c.hello(harnessToken, "activity-setter");
      const sessionId = store.createSession("global");
      store.setArchived(sessionId, true);

      const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity });
      expect(res.error).toBeTruthy();
      expect(res.error.code).toBe(ERR.INVALID_PARAMS);
      expect(res.error.message).toBe("session is archived — resume it first");
      const row = store.list().find((s) => s.sessionId === sessionId)!;
      expect(row.archived).toBe(true);
      expect(row.backgrounded).toBeUndefined();
      c.close();
    });
  }

  test("archive on an ALREADY-ARCHIVED session is an idempotent success, not a refusal", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");
    store.setArchived(sessionId, true);

    const res = await c.request(METHODS.sessionSetActivity, { sessionId, activity: "archived" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, activity: "archived" });
    expect(store.list().find((s) => s.sessionId === sessionId)!.archived).toBe(true);
    c.close();
  });

  test("resume is the door OUT of archived, and it leaves the background flag exactly as it found it", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-setter");
    const sessionId = store.createSession("global");
    store.setArchived(sessionId, true);

    expect((await c.request(METHODS.sessionSetActivity, { sessionId, activity: null })).result)
      .toEqual({ ok: true, activity: "idle" });
    // …and now that it is resumed, the refused verbs work.
    expect((await c.request(METHODS.sessionSetActivity, { sessionId, activity: "background" })).result)
      .toEqual({ ok: true, activity: "background" });
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
    // Resume clears the archive bit only (ruling 2), so the flag this test just set survives it —
    // `unbackground` is the verb that takes it back off.
    expect(store.list().find((s) => s.sessionId === sessionId)!.backgrounded).toBe(true);
    expect((await c.request(METHODS.sessionSetActivity, { sessionId, activity: "unbackground" })).result)
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

  // activity-verb-semantics ruling 2, stated as the PARITY it exists to create: there are two ways
  // to resume a session — name it (`setActivity` null) or open it (`session.attach`) — and before
  // this round they disagreed about the background flag. `attach` cleared only `archived`; the verb
  // cleared both. A user who resumed an archived background worker got a background worker one way
  // and a plain idle session the other. Same two flags in, same two flags out, both doors.
  test("verb-resume ≡ attach-resume: both clear archived and both leave backgrounded set", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "activity-resumer");
    const viaVerb = store.createSession("global");
    const viaAttach = store.createSession("global");
    for (const id of [viaVerb, viaAttach]) {
      store.setBackgrounded(id, true);
      store.setArchived(id, true);
    }

    await c.request(METHODS.sessionSetActivity, { sessionId: viaVerb, activity: null });
    await c.request(METHODS.sessionAttach, { sessionId: viaAttach });

    const flagsOf = (id: string) => {
      const row = store.list().find((s) => s.sessionId === id)!;
      return { archived: row.archived, backgrounded: row.backgrounded };
    };
    expect(flagsOf(viaVerb)).toEqual({ archived: undefined, backgrounded: true });
    expect(flagsOf(viaVerb)).toEqual(flagsOf(viaAttach));
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

  // T2 seam, closed by T3's shared `deriveActivity`: `startIpcServer` falls back to a PRIVATE
  // SessionHub when none is injected (legal — the constructor only requires one alongside an
  // engine), and that private hub is then the one every `session.attach` actually attaches to.
  // T2's `session.list` derived off `opts.hub?.attachedCount(...) ?? 0`, so on such a server it
  // reported a hard 0 — "idle" for a session with a live harness sitting on it. Deriving off the
  // LOCAL binding is what makes both surfaces read the hub that holds the attachments.
  test("a server built with NO injected hub still sees its own attachments (both surfaces)", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-set-activity-nohub-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };

    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "activity-setter");
    const sessionId = store.createSession("global");
    await c.request(METHODS.sessionAttach, { sessionId });

    const listed = await c.request(METHODS.sessionList, {});
    expect(listed.result.sessions.find((s: any) => s.sessionId === sessionId).activity).toBe("active");
    expect((await c.request(METHODS.sessionSetActivity, { sessionId, activity: null })).result)
      .toEqual({ ok: true, activity: "active" });
    c.close();
  });
});
