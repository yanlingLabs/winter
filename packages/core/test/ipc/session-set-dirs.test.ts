import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { startDaemon } from "../../src/daemon";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { canonicalizeDirPath } from "../../src/sessions/dirs";
import {
  DIRS_MODE_REFUSAL,
  DIR_LOCKED_REFUSAL,
  DIR_DENIED_REFUSAL,
  DIR_REMOVE_PRIMARY_REFUSAL,
} from "../../src/sessions/set-dirs";

// working-directories T3: `session.setDirs` — the WRITE half of a session's working-directory set
// (`session.list`'s `dirs`, T3's read half, is exercised at the bottom of this file too). Params
// `{sessionId, op: "setPrimary" | "add" | "remove", path}`, result `{ok: true, dirs}`.
//
// The handler is a thin wire wrapper — parseParams + assertRemoteMayUseSession + delegate to T2's
// `setSessionDirs` (sessions/set-dirs.ts) + kind→ERR mapping — the exact `session.setActivity`
// template. Every refusal constant this file asserts against is T2's OWN, verbatim: this file is
// NOT re-deciding the refusal matrix, only proving the wire surfaces it correctly.
//
// `grantDenied` is wired to `opts.engine.isGrantDenied` at server construction — most tests below
// fake that accessor on a doubled `engine` (the `session-set-activity.test.ts` precedent); ONE test
// at the bottom boots a REAL daemon (a real `AgentEngine`, `grantDeniedPrefixes: [normaHome]`) to
// prove the wiring reaches the actual dirGrant predicate, not just a plausible-looking fake.
//
// Exercised over a bare IPC server (own SessionStore + SessionHub + TokenAuthority) for every test
// except the last — the same harness shape as session-set-activity.test.ts, whose copy of
// TestClient this duplicates (this codebase's convention: no shared test-harness module).

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated from session-set-activity.test.ts. */
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

describe("session.setDirs (working-directories T3)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  /** `denied` is the fake engine's own denylist (canonicalized paths a test marks "never grant") —
   *  the SAME shape as `AgentEngine.isGrantDenied`, doubled so the handler's wiring can be exercised
   *  without a real engine. `engine` is entirely OMITTED when the caller wants the no-engine
   *  permissive-default path (mirrors session-set-activity.test.ts's "no injected hub" test). */
  async function boot(opts: { noEngine?: boolean } = {}): Promise<{
    store: SessionStore; socketPath: string; harnessToken: string; remoteToken: string; denied: Set<string>;
  }> {
    const home = mkdtempSync(join(tmpdir(), "norma-set-dirs-rpc-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const denied = new Set<string>();
    // `isRunning`/`hasBackgroundWork` are here ONLY because `session.list`'s activity derivation
    // (unconditionally exercised by this file's session.list assertions) calls them through
    // `opts.engine?.foo(...)` — `?.` guards an ABSENT engine, not an engine missing a method, so a
    // fake with just `isGrantDenied` throws "opts.engine?.isRunning is not a function" the moment
    // any test here calls session.list. Both are stubbed inert (nothing is ever running/backgrounded
    // in this file), matching session-set-activity.test.ts's own fake-engine shape.
    const engine: any = {
      isGrantDenied: (dir: string) => denied.has(dir),
      isRunning: () => false,
      hasBackgroundWork: () => false,
    };
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store, hub,
      ...(opts.noEngine ? {} : { engine }),
    });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote, denied };
  }

  function fixtureBase(): string {
    return mkdtempSync(join(tmpdir(), "norma-set-dirs-fixture-"));
  }

  function fixtureDir(base: string, name: string): string {
    const p = join(base, name);
    mkdirSync(p, { recursive: true });
    return p;
  }

  // -------------------------------------------------------------------------------------------
  // Method resolution + NOT_FOUND (resolved first, matching setSessionActivity's ordering)
  // -------------------------------------------------------------------------------------------

  test("the method exists — a well-formed call is dispatched, not -32601", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");
    const base = fixtureBase();
    const primary = fixtureDir(base, "primary");

    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: primary });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, dirs: [{ path: canonicalizeDirPath(primary), locked: false }] });
    c.close();
  });

  test("unknown session → NOT_FOUND", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");

    const res = await c.request(METHODS.sessionSetDirs, { sessionId: "s_does_not_exist", op: "setPrimary", path: "/tmp" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // Participation (T2's DIRS_MODE_REFUSAL, verbatim) — chat/dispatch have no writable root at all.
  // -------------------------------------------------------------------------------------------

  for (const mode of ["chat", "dispatch"] as const) {
    test(`refuses a ${mode.toUpperCase()} target with INVALID_PARAMS — T2's DIRS_MODE_REFUSAL verbatim`, async () => {
      const { store, socketPath, harnessToken } = await boot();
      const c = await TestClient.connect(socketPath);
      await c.hello(harnessToken, "dirs-setter");
      const sessionId = store.createSession("global", mode === "chat" ? { mode: "chat" } : { mode: "dispatch", origin: "dispatch" });

      const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: "/tmp" });
      expect(res.error).toBeTruthy();
      expect(res.error.code).toBe(ERR.INVALID_PARAMS);
      expect(res.error.message).toBe(DIRS_MODE_REFUSAL);
      c.close();
    });
  }

  // A cowork-shaped session — mode written straight to the store, the idiom
  // session-set-activity.test.ts (and remote-chat-gate.test.ts before it) established: there is no
  // session.create/wire support for "cowork", deliberately.
  function makeCoworkSession(store: SessionStore): string {
    const id = store.createSession("global");
    (store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["cowork", id]);
    return id;
  }

  test("a COWORK session is settable (the participation allowlist is code AND cowork)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = makeCoworkSession(store);
    const primary = fixtureDir(fixtureBase(), "primary");

    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: primary });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, dirs: [{ path: canonicalizeDirPath(primary), locked: false }] });
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // Op semantics end-to-end (setPrimary / add / remove), through the wire
  // -------------------------------------------------------------------------------------------

  test("setPrimary establishes the primary on an empty (workdir-less) set", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");
    const base = fixtureBase();
    const primary = fixtureDir(base, "primary");

    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: primary });
    expect(res.result).toEqual({ ok: true, dirs: [{ path: canonicalizeDirPath(primary), locked: false }] });
    expect(store.dirs(sessionId)).toEqual([{ path: canonicalizeDirPath(primary), locked: false }]);
    c.close();
  });

  test("add appends past an existing primary", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");
    const base = fixtureBase();
    const primary = fixtureDir(base, "primary");
    const added = fixtureDir(base, "added");

    await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: primary });
    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "add", path: added });
    expect(res.result).toEqual({
      ok: true,
      dirs: [
        { path: canonicalizeDirPath(primary), locked: false },
        { path: canonicalizeDirPath(added), locked: false },
      ],
    });
    c.close();
  });

  test("remove drops an unlocked non-primary entry", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");
    const base = fixtureBase();
    const primary = fixtureDir(base, "primary");
    const secondary = fixtureDir(base, "secondary");

    await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: primary });
    await c.request(METHODS.sessionSetDirs, { sessionId, op: "add", path: secondary });
    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "remove", path: secondary });
    expect(res.result).toEqual({ ok: true, dirs: [{ path: canonicalizeDirPath(primary), locked: false }] });
    c.close();
  });

  test("removing a path not present is an idempotent success", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");
    const base = fixtureBase();
    const primary = fixtureDir(base, "primary");
    const notPresent = fixtureDir(base, "not-present");

    await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: primary });
    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "remove", path: notPresent });
    expect(res.result).toEqual({ ok: true, dirs: [{ path: canonicalizeDirPath(primary), locked: false }] });
    c.close();
  });

  test("duplicate add is idempotent — no write, existing lock state survives", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");
    const base = fixtureBase();
    const primary = fixtureDir(base, "primary");
    const secondary = fixtureDir(base, "secondary");
    store.setDirsRaw(sessionId, [
      { path: canonicalizeDirPath(primary), locked: false },
      { path: canonicalizeDirPath(secondary), locked: true },
    ]);

    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "add", path: secondary });
    expect(res.result).toEqual({
      ok: true,
      dirs: [
        { path: canonicalizeDirPath(primary), locked: false },
        { path: canonicalizeDirPath(secondary), locked: true },
      ],
    });
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // Locked mutations (T2's DIR_LOCKED_REFUSAL, verbatim)
  // -------------------------------------------------------------------------------------------

  test("setPrimary over a locked primary refuses — DIR_LOCKED_REFUSAL verbatim, no write", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");
    const base = fixtureBase();
    const primary = fixtureDir(base, "primary");
    const attempted = fixtureDir(base, "attempted");
    const existing = [{ path: canonicalizeDirPath(primary), locked: true }];
    store.setDirsRaw(sessionId, existing);

    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: attempted });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toBe(DIR_LOCKED_REFUSAL);
    expect(store.dirs(sessionId)).toEqual(existing);
    c.close();
  });

  test("remove of a locked non-primary entry refuses — DIR_LOCKED_REFUSAL verbatim, no write", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");
    const base = fixtureBase();
    const primary = fixtureDir(base, "primary");
    const locked = fixtureDir(base, "locked");
    const existing = [
      { path: canonicalizeDirPath(primary), locked: false },
      { path: canonicalizeDirPath(locked), locked: true },
    ];
    store.setDirsRaw(sessionId, existing);

    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "remove", path: locked });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toBe(DIR_LOCKED_REFUSAL);
    expect(store.dirs(sessionId)).toEqual(existing);
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // Removing the primary (T2's DIR_REMOVE_PRIMARY_REFUSAL, verbatim)
  // -------------------------------------------------------------------------------------------

  test("remove of the primary refuses even when unlocked — DIR_REMOVE_PRIMARY_REFUSAL verbatim", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");
    const primary = fixtureDir(fixtureBase(), "primary");
    const existing = [{ path: canonicalizeDirPath(primary), locked: false }];
    store.setDirsRaw(sessionId, existing);

    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "remove", path: primary });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toBe(DIR_REMOVE_PRIMARY_REFUSAL);
    expect(store.dirs(sessionId)).toEqual(existing);
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // Denylist (T2's DIR_DENIED_REFUSAL, verbatim) — the grantDenied wiring itself
  // -------------------------------------------------------------------------------------------

  test("add refuses a grantDenied path — DIR_DENIED_REFUSAL verbatim, no write", async () => {
    const { store, socketPath, harnessToken, denied } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");
    const forbidden = fixtureDir(fixtureBase(), "forbidden");
    denied.add(canonicalizeDirPath(forbidden));

    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "add", path: forbidden });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toBe(DIR_DENIED_REFUSAL);
    expect(store.dirs(sessionId)).toEqual([]);
    c.close();
  });

  test("setPrimary refuses a grantDenied path", async () => {
    const { store, socketPath, harnessToken, denied } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");
    const forbidden = fixtureDir(fixtureBase(), "forbidden");
    denied.add(canonicalizeDirPath(forbidden));

    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: forbidden });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toBe(DIR_DENIED_REFUSAL);
    c.close();
  });

  // End-to-end proof that the WHOLE pipeline (RPC → setDirsDeps.grantDenied closure → the fake
  // engine's isGrantDenied) canonicalizes before consulting the predicate — not just T2's own unit
  // test of `setSessionDirs` in isolation. The denylist is seeded with the REAL (symlink-resolved)
  // path; the RPC is called with a SYMLINK spelling of it.
  test("grantDenied is consulted with the canonicalized path, end-to-end over the wire", async () => {
    const { store, socketPath, harnessToken, denied } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");
    const base = fixtureBase();
    const real = fixtureDir(base, "real");
    const link = join(base, "link");
    symlinkSync(real, link);
    denied.add(canonicalizeDirPath(real));

    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "add", path: link });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toBe(DIR_DENIED_REFUSAL);
    c.close();
  });

  // A server built with NO engine at all (most other IPC tests in this codebase) must not brick
  // session.setDirs — `setDirsDeps.grantDenied`'s `?? false` fallback is the SAME "typed no-op,
  // permissive default" precedent `turnRunning`/`bgWork` use elsewhere in server.ts for an absent
  // engine: nothing to deny when there is no engine's denylist to consult.
  test("a server with no engine wired allows any path (permissive default)", async () => {
    const { store, socketPath, harnessToken } = await boot({ noEngine: true });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");
    const primary = fixtureDir(fixtureBase(), "primary");

    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: primary });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, dirs: [{ path: canonicalizeDirPath(primary), locked: false }] });
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // Params validation: a relative path is refused at the SCHEMA layer (AbsoluteDirPath), not by
  // reaching setSessionDirs's own canonicalizeDirPath (which throws on a relative path).
  // -------------------------------------------------------------------------------------------

  test("a relative path is refused with INVALID_PARAMS at the schema layer", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: "relative/path" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // Remote role gating — the same `assertRemoteMayUseSession` guard every other bare-sessionId
  // remote-allowlisted verb uses.
  // -------------------------------------------------------------------------------------------

  test("remote role: a Mac-local-only (cowork) target is refused before any write", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const sessionId = makeCoworkSession(store);

    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: "/tmp" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toBe("cowork sessions are not available to remote clients");
    expect(store.dirs(sessionId)).toEqual([]);
    c.close();
  });

  test("remote role: a plain code session is settable (the method is on the remote allowlist)", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const sessionId = store.createSession("global");
    const primary = fixtureDir(fixtureBase(), "primary");

    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: primary });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, dirs: [{ path: canonicalizeDirPath(primary), locked: false }] });
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // session.list's read half: `dirs` populated, and `cwd` kept an alias of `dirs[0]?.path`.
  // -------------------------------------------------------------------------------------------

  test("dirs appears in session.list after a write, in order, with cwd aliased to dirs[0]", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global");
    const base = fixtureBase();
    const primary = fixtureDir(base, "primary");
    const added = fixtureDir(base, "added");

    await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: primary });
    await c.request(METHODS.sessionSetDirs, { sessionId, op: "add", path: added });

    const listed = await c.request(METHODS.sessionList, {});
    const row = listed.result.sessions.find((s: any) => s.sessionId === sessionId);
    expect(row.dirs).toEqual([
      { path: canonicalizeDirPath(primary), locked: false },
      { path: canonicalizeDirPath(added), locked: false },
    ]);
    expect(row.cwd).toBe(canonicalizeDirPath(primary));
  });

  test("dirs is ABSENT on session.list for a chat session (same participation gate as activity)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const sessionId = store.createSession("global", { mode: "chat" });

    const listed = await c.request(METHODS.sessionList, {});
    const row = listed.result.sessions.find((s: any) => s.sessionId === sessionId);
    expect(row.dirs).toBeUndefined();
  });

  // T1's lazy migration: a session with a stored `cwd` but a `dirs` column that was NEVER written
  // (the shape a pre-branch row, or any row `session.setDirs` has never touched, actually has).
  // `store.dirs()` derives `[{path: cwd, locked:true}]` straight from that column, so `session.list`'s
  // populate-time alias yields `cwd === dirs[0]?.path` BY CONSTRUCTION — not because anything
  // re-synced the two columns.
  test("a migrated (dirs-column-null) row: dirs[0] equals the stored cwd, by construction", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "dirs-setter");
    const cwd = fixtureDir(fixtureBase(), "legacy-cwd");
    const sessionId = store.createSession("global", { cwd });
    // Never touched by setDirsRaw — the dirs column is still NULL, exactly the "migrated" shape.

    const listed = await c.request(METHODS.sessionList, {});
    const row = listed.result.sessions.find((s: any) => s.sessionId === sessionId);
    expect(row.dirs).toEqual([{ path: cwd, locked: true }]);
    expect(row.cwd).toBe(cwd);
    expect(row.cwd).toBe(row.dirs[0].path);
  });

  // -------------------------------------------------------------------------------------------
  // The REAL wiring: a full daemon with a REAL AgentEngine (grantDeniedPrefixes: [normaHome]) —
  // proves session.setDirs reaches the actual dirGrant predicate, not a plausible-looking fake.
  // -------------------------------------------------------------------------------------------

  test("REAL daemon: session.setDirs refuses normaHome itself via the engine's real grantDenied predicate", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-set-dirs-real-daemon-"));
    const { FakeProvider } = await import("../../src/agent/fake-provider");
    const daemon = await startDaemon({
      home,
      secrets: new FileSecretStore(join(home, "secrets")),
      agentProvider: { provider: new FakeProvider([]), model: "fake-1" },
    });
    stop = daemon.stop;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "dirs-setter-real");
    const created = await c.request(METHODS.sessionCreate, { scope: "global" });
    const sessionId = created.result.sessionId;

    // `normaHome` (== `home`, verbatim — bootstrapNormaDir returns the input path unchanged) is
    // itself one of `grantDeniedPrefixes` (daemon.ts) — the SAME control-plane denylist the
    // out-of-root write/edit grant flow refuses. A FAKE engine could not prove this; only a real
    // `AgentEngine` constructed by `startDaemon` actually consults `grantDeniedPrefixes`.
    const res = await c.request(METHODS.sessionSetDirs, { sessionId, op: "setPrimary", path: home });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toBe(DIR_DENIED_REFUSAL);
    c.close();
  });
});
