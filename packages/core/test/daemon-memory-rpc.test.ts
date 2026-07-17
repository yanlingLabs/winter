import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@norma/protocol";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { startIpcServer } from "../src/ipc/server";
import { SessionStore } from "../src/sessions/store";
import { FileSecretStore } from "../src/auth/secret-store";
import { TokenAuthority } from "../src/auth/tokens";
import { memoryDirFor, globalMemoryDirFor } from "../src/agent/memory-dir";
import { FakeProvider } from "../src/agent/fake-provider";

// Phase 5b Task 3 (design doc §4): the memory.list/read/write/delete/audit RPCs over the daemon's
// real MemoryStore (wired unconditionally in daemon.ts — memoryStore needs only normaHome/trust,
// no agentProvider — same precedent as routines/skills/mcp; see server.test.ts's "routines.* RPCs"
// describe block, which this file mirrors: a dedicated real-daemon TestClient harness, kept in its
// own file rather than folded into server.test.ts's already-3000-line suite).
//
// T2 (design doc "dashboard rewire") makes these RPCs backend-sensitive: `memory.enabled` (T1,
// default ON) now routes list/read/write/delete onto MEMDIR files instead of the legacy store —
// see ipc/server.ts's memory.* handlers. The FIRST describe block below explicitly boots every
// daemon with `memory.enabled: false` so every pre-T2 assertion here (trust-gating, the exact
// `<cwd>/.norma/memory` path, the legacy store's audit trail) keeps testing the UNCHANGED escape
// hatch, byte-for-byte. The SECOND describe block is new T2 coverage of the enabled (default)
// files path.

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated (not imported) from
 *  server.test.ts's own TestClient, matching every other *.test.ts in this directory
 *  (peripheral/e2e.test.ts, plugins/gate-4d-ii.test.ts, ...): each carries its own copy, there is
 *  no shared test-harness module. */
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

describe("memory.* RPCs (Phase 5b Task 3) — legacy store (memory.enabled: false)", () => {
  let daemon: RunningDaemon;
  let harnessToken: string;

  async function boot(): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-memory-"));
    // T2: memory.enabled defaults ON (T1), which would route these RPCs onto MEMDIR files instead
    // — every test below asserts the LEGACY store's own behavior (trust-gating, the exact
    // `<cwd>/.norma/memory` path, its central audit.jsonl), so it's disabled here explicitly.
    writeFileSync(join(home, "settings.json"), JSON.stringify({ memory: { enabled: false } }));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({ home, secrets, agentProvider: null });
    harnessToken = daemon.tokens.harness;
  }

  afterEach(() => daemon?.stop());

  test("write -> list -> read -> delete round trip (user scope)", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");

    const written = await c.request(METHODS.memoryWrite, {
      scope: "user", name: "coffee-pref", description: "Likes oat milk lattes", body: "Prefers oat milk.",
    });
    expect(written.error).toBeUndefined();
    expect(written.result).toEqual({});

    const listed = await c.request(METHODS.memoryList, { scope: "user" });
    expect(listed.error).toBeUndefined();
    expect(listed.result.facts).toEqual([{ name: "coffee-pref", description: "Likes oat milk lattes", type: "user" }]);

    const read = await c.request(METHODS.memoryRead, { scope: "user", name: "coffee-pref" });
    expect(read.error).toBeUndefined();
    expect(read.result.fact).toEqual({
      name: "coffee-pref", description: "Likes oat milk lattes", type: "user", body: "Prefers oat milk.",
    });

    const deleted = await c.request(METHODS.memoryDelete, { scope: "user", name: "coffee-pref" });
    expect(deleted.error).toBeUndefined();
    expect(deleted.result).toEqual({});

    const listedAfter = await c.request(METHODS.memoryList, { scope: "user" });
    expect(listedAfter.result.facts).toEqual([]);
    c.close();
  });

  test("memory.write's optional type defaults to 'user' over the wire, same as the tool", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");
    await c.request(METHODS.memoryWrite, { scope: "user", name: "a", description: "d", body: "b" });
    const read = await c.request(METHODS.memoryRead, { scope: "user", name: "a" });
    expect(read.result.fact.type).toBe("user");
    c.close();
  });

  test("memory.audit returns newest FIRST and records source:'rpc' with no sessionId", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");
    await c.request(METHODS.memoryWrite, { scope: "user", name: "a", description: "d1", body: "b1" });
    await c.request(METHODS.memoryWrite, { scope: "user", name: "b", description: "d2", body: "b2" });
    await c.request(METHODS.memoryDelete, { scope: "user", name: "a" });

    const audit = await c.request(METHODS.memoryAudit, {});
    expect(audit.error).toBeUndefined();
    expect(audit.result.lines).toHaveLength(3);
    // newest-first: the delete (3rd mutation) leads, the first write trails.
    expect(audit.result.lines[0]).toMatchObject({ action: "delete", name: "a", source: "rpc", scope: "user" });
    expect(audit.result.lines[0].sessionId).toBeUndefined();
    expect(audit.result.lines[2]).toMatchObject({ action: "write", name: "a", source: "rpc" });

    const limited = await c.request(METHODS.memoryAudit, { limit: 1 });
    expect(limited.result.lines).toHaveLength(1);
    expect(limited.result.lines[0]).toMatchObject({ action: "delete", name: "a" });
    c.close();
  });

  // T3 (task-23): `cwd` is now an accepted (additive/optional) param on memory.audit's wire
  // schema even under the legacy backend — it's simply never consulted there (the central
  // audit.jsonl has no per-project split), so passing it must be a complete no-op.
  test("memory.audit accepts (but ignores) a cwd param under the legacy backend", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");
    await c.request(METHODS.memoryWrite, { scope: "user", name: "a", description: "d", body: "b" });
    await c.request(METHODS.memoryDelete, { scope: "user", name: "a" });

    const withoutCwd = await c.request(METHODS.memoryAudit, {});
    const projectDir = mkdtempSync(join(tmpdir(), "norma-memory-legacy-audit-cwd-"));
    const withCwd = await c.request(METHODS.memoryAudit, { cwd: projectDir });
    expect(withCwd.error).toBeUndefined();
    expect(withCwd.result.lines).toEqual(withoutCwd.result.lines);
    c.close();
  });

  test("project scope on an untrusted cwd -> INVALID_PARAMS for every verb, nothing persisted", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");
    const projectDir = mkdtempSync(join(tmpdir(), "norma-memory-project-"));

    const w = await c.request(METHODS.memoryWrite, {
      scope: "project", name: "x", description: "d", body: "b", cwd: projectDir,
    });
    expect(w.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(w.error?.message).toBe("project memory requires a trusted directory");
    expect(existsSync(join(projectDir, ".norma", "memory", "x.md"))).toBe(false);

    const l = await c.request(METHODS.memoryList, { scope: "project", cwd: projectDir });
    expect(l.error?.code).toBe(ERR.INVALID_PARAMS);

    const r = await c.request(METHODS.memoryRead, { scope: "project", name: "x", cwd: projectDir });
    expect(r.error?.code).toBe(ERR.INVALID_PARAMS);

    const d = await c.request(METHODS.memoryDelete, { scope: "project", name: "x", cwd: projectDir });
    expect(d.error?.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  test("project scope on a directory trusted via daemon.trustDir round-trips under <cwd>/.norma/memory", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");
    const projectDir = mkdtempSync(join(tmpdir(), "norma-memory-project-"));
    const trusted = await c.request(METHODS.trustDir, { path: projectDir });
    expect(trusted.error).toBeUndefined();

    const w = await c.request(METHODS.memoryWrite, {
      scope: "project", name: "x", description: "d", body: "b", cwd: projectDir,
    });
    expect(w.error).toBeUndefined();
    expect(existsSync(join(projectDir, ".norma", "memory", "x.md"))).toBe(true);

    const read = await c.request(METHODS.memoryRead, { scope: "project", name: "x", cwd: projectDir });
    expect(read.result.fact).toMatchObject({ name: "x", description: "d", body: "b" });
    c.close();
  });

  test("memory.read on an unknown name -> NOT_FOUND", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");
    const res = await c.request(METHODS.memoryRead, { scope: "user", name: "ghost" });
    expect(res.error?.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // T3 review Finding 2 regression: an INVALID name whose text happens to contain "not found"
  // must classify by the store's structural error `kind` ("invalid" — spaces fail the slug jail),
  // never by substring-matching the error message (which embeds the raw name verbatim).
  test("invalid name containing 'not found' -> INVALID_PARAMS, never NOT_FOUND", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");

    const read = await c.request(METHODS.memoryRead, { scope: "user", name: "why is this not found" });
    expect(read.error?.code).toBe(ERR.INVALID_PARAMS);

    const del = await c.request(METHODS.memoryDelete, { scope: "user", name: "why is this not found" });
    expect(del.error?.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  test("memory.delete on an unknown name -> NOT_FOUND", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");
    const res = await c.request(METHODS.memoryDelete, { scope: "user", name: "ghost" });
    expect(res.error?.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("schema validation: bad scope, missing name, and reserved/invalid slug names are all INVALID_PARAMS", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-tester");

    const badScope = await c.request(METHODS.memoryList, { scope: "bogus" });
    expect(badScope.error?.code).toBe(ERR.INVALID_PARAMS);

    const missingName = await c.request(METHODS.memoryRead, { scope: "user", name: "" });
    expect(missingName.error?.code).toBe(ERR.INVALID_PARAMS);

    const reservedName = await c.request(METHODS.memoryWrite, {
      scope: "user", name: "memory", description: "d", body: "b",
    });
    expect(reservedName.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(reservedName.error?.message).toContain("reserved name");

    const invalidSlug = await c.request(METHODS.memoryWrite, {
      scope: "user", name: "Not_A_Slug", description: "d", body: "b",
    });
    expect(invalidSlug.error?.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  // T3 review Finding 1: the no-MemoryStore split — collection reads (list/audit) degrade to
  // empty results (routines.list precedent); single-fact reads and mutations fail hard with a
  // typed INTERNAL (a silently no-oping write/delete would mask a wiring bug). Reached via a bare
  // startIpcServer with no `memory` wired — the daemon fixture above always wires one.
  test("no MemoryStore wired: list/audit degrade to empty; read/write/delete are typed INTERNAL", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-memory-no-store-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });

    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "memory-tester");

    const listed = await c.request(METHODS.memoryList, { scope: "user" });
    expect(listed.error).toBeUndefined();
    expect(listed.result).toEqual({ facts: [] });

    const audit = await c.request(METHODS.memoryAudit, {});
    expect(audit.error).toBeUndefined();
    expect(audit.result).toEqual({ lines: [] });

    for (const [method, params] of [
      [METHODS.memoryRead, { scope: "user", name: "x" }],
      [METHODS.memoryWrite, { scope: "user", name: "x", description: "d", body: "b" }],
      [METHODS.memoryDelete, { scope: "user", name: "x" }],
    ] as const) {
      const res = await c.request(method, params);
      expect(res.error?.code).toBe(ERR.INTERNAL);
    }
    c.close(); server.stop(); store.close();
  });

  // A bare IPC server (own SessionStore + TokenAuthority, no memoryStore wired) mirrors
  // server.test.ts's `bootPluginTestServer` — RunningDaemon doesn't expose its SessionStore, so
  // the shared boot()/daemon fixture above can't mint plugin tokens. The role gate (ipc/server.ts,
  // checked BEFORE the switch) rejects a plugin connection regardless of whether `memory` is wired.
  test("memory.* verbs are role-rejected for a plugin connection, exactly like routines.*", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-memory-plugin-role-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });

    const raw = store.mintPluginToken("sample-echo");
    const plugin = await TestClient.connect(socketPath);
    await plugin.request(METHODS.hello, {
      protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: "sample-echo", pluginId: "sample-echo",
    });
    for (const [method, params] of [
      [METHODS.memoryList, { scope: "user" }],
      [METHODS.memoryRead, { scope: "user", name: "x" }],
      [METHODS.memoryWrite, { scope: "user", name: "x", description: "d", body: "b" }],
      [METHODS.memoryDelete, { scope: "user", name: "x" }],
      [METHODS.memoryAudit, {}],
    ] as const) {
      const res = await plugin.request(method, params);
      expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
    }
    plugin.close(); server.stop(); store.close();
  });
});

// T2 (design doc "dashboard rewire"): the SAME five RPCs, now against MEMDIR files — booted with
// memory.enabled at its DEFAULT (true, T1) so no settings.json override is needed unless a test
// exercises the hot toggle. `scope` is NOT consulted once this path is taken (memory-file-ops.ts
// has no scope concept) — a request's `cwd` (present or absent) is what decides the directory; see
// ipc/server.ts's `memoryFileDir` helper.
describe("memory.* RPCs (T2) — file-backed (memory.enabled: true, default)", () => {
  let daemon: RunningDaemon;
  let harnessToken: string;
  let home: string;

  async function boot(settingsOverrides?: Record<string, unknown>): Promise<void> {
    home = mkdtempSync(join(tmpdir(), "norma-daemon-memory-files-"));
    if (settingsOverrides) writeFileSync(join(home, "settings.json"), JSON.stringify(settingsOverrides));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({ home, secrets, agentProvider: null });
    harnessToken = daemon.tokens.harness;
  }

  afterEach(() => daemon?.stop());

  test("no cwd -> write/list/read/delete round-trip against the GLOBAL bucket (globalMemoryDirFor)", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-files-tester");

    const written = await c.request(METHODS.memoryWrite, {
      scope: "user", name: "coffee-pref", description: "Likes oat milk lattes", body: "Prefers oat milk.",
    });
    expect(written.error).toBeUndefined();

    const target = globalMemoryDirFor({ normaHome: home });
    expect(existsSync(join(target, "coffee-pref.md"))).toBe(true);

    const listed = await c.request(METHODS.memoryList, { scope: "user" });
    expect(listed.result.facts).toEqual([{ name: "coffee-pref", description: "Likes oat milk lattes", type: "user" }]);

    const read = await c.request(METHODS.memoryRead, { scope: "user", name: "coffee-pref" });
    expect(read.result.fact).toEqual({ name: "coffee-pref", description: "Likes oat milk lattes", type: "user", body: "Prefers oat milk." });

    const deleted = await c.request(METHODS.memoryDelete, { scope: "user", name: "coffee-pref" });
    expect(deleted.error).toBeUndefined();
    expect(existsSync(join(target, "coffee-pref.md"))).toBe(false);

    const listedAfter = await c.request(METHODS.memoryList, { scope: "user" });
    expect(listedAfter.result.facts).toEqual([]);
    c.close();
  });

  test("a cwd -> the requester's OWN project MEMDIR (memoryDirFor), NOT trust-gated (unlike the legacy store)", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-files-tester");
    const projectDir = mkdtempSync(join(tmpdir(), "norma-memory-files-project-")); // deliberately never trusted

    const w = await c.request(METHODS.memoryWrite, {
      scope: "project", name: "build-cmd", description: "d", body: "Use bun run build", cwd: projectDir,
    });
    expect(w.error).toBeUndefined(); // no trust check on this path — unlike the legacy store's PROJECT_TRUST_ERROR

    const target = memoryDirFor(projectDir, { normaHome: home });
    expect(existsSync(join(target, "build-cmd.md"))).toBe(true);
    // and NOT at the legacy store's own project path — the two backends never cross-write.
    expect(existsSync(join(projectDir, ".norma", "memory", "build-cmd.md"))).toBe(false);

    const read = await c.request(METHODS.memoryRead, { scope: "project", name: "build-cmd", cwd: projectDir });
    expect(read.result.fact).toMatchObject({ name: "build-cmd", body: "Use bun run build" });
    c.close();
  });

  test("delete appends a (ts/op/name) line to <dir>/.audit.jsonl — the restored per-project audit trail", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-files-tester");
    await c.request(METHODS.memoryWrite, { scope: "user", name: "a", description: "d", body: "b" });
    await c.request(METHODS.memoryDelete, { scope: "user", name: "a" });

    const target = globalMemoryDirFor({ normaHome: home });
    const lines = readFileSync(join(target, ".audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([{ ts: expect.any(Number), op: "delete", name: "a" }]);
    c.close();
  });

  // T3 (task-23) closes T2's documented limitation (this test used to assert memory.audit always
  // read the legacy store's central log and so saw nothing here — see task-22-report.md). Now
  // memory.audit gets the SAME cwd targeting memory.list/read/write/delete already have: no cwd
  // resolves to the global bucket, exactly the directory a cwd-less memory.write/delete already
  // lands in above.
  test("memory.audit with no cwd reads the GLOBAL bucket's .audit.jsonl", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-files-tester");
    await c.request(METHODS.memoryWrite, { scope: "user", name: "a", description: "d", body: "b" });
    await c.request(METHODS.memoryDelete, { scope: "user", name: "a" });

    const audit = await c.request(METHODS.memoryAudit, {});
    expect(audit.error).toBeUndefined();
    expect(audit.result.lines).toEqual([
      { ts: expect.any(Number), source: "rpc", scope: "user", action: "delete", name: "a" },
    ]);
    c.close();
  });

  test("memory.audit with a cwd reads that PROJECT's own .audit.jsonl, not the global bucket (and vice versa)", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-files-tester");
    const projectDir = mkdtempSync(join(tmpdir(), "norma-memory-files-audit-project-"));

    // A project-scope delete lands in that project's own MEMDIR .audit.jsonl...
    await c.request(METHODS.memoryWrite, { scope: "project", name: "x", description: "d", body: "b", cwd: projectDir });
    await c.request(METHODS.memoryDelete, { scope: "project", name: "x", cwd: projectDir });
    // ...while a separate cwd-less delete lands in the global bucket instead.
    await c.request(METHODS.memoryWrite, { scope: "user", name: "y", description: "d", body: "b" });
    await c.request(METHODS.memoryDelete, { scope: "user", name: "y" });

    const projectAudit = await c.request(METHODS.memoryAudit, { cwd: projectDir });
    expect(projectAudit.error).toBeUndefined();
    expect(projectAudit.result.lines).toEqual([
      { ts: expect.any(Number), source: "rpc", scope: "project", action: "delete", name: "x" },
    ]);

    const globalAudit = await c.request(METHODS.memoryAudit, {});
    expect(globalAudit.result.lines).toEqual([
      { ts: expect.any(Number), source: "rpc", scope: "user", action: "delete", name: "y" },
    ]);
    c.close();
  });

  test("unknown name -> NOT_FOUND; invalid slug -> INVALID_PARAMS; reserved 'memory' name -> INVALID_PARAMS (same structural mapping as the legacy store)", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-files-tester");

    const notFound = await c.request(METHODS.memoryRead, { scope: "user", name: "ghost" });
    expect(notFound.error?.code).toBe(ERR.NOT_FOUND);

    const invalidDelete = await c.request(METHODS.memoryDelete, { scope: "user", name: "Not A Slug" });
    expect(invalidDelete.error?.code).toBe(ERR.INVALID_PARAMS);

    const reserved = await c.request(METHODS.memoryWrite, { scope: "user", name: "memory", description: "d", body: "b" });
    expect(reserved.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(reserved.error?.message).toContain("reserved name");
    c.close();
  });

  // The settings HOT-reload watcher (SettingsWatcher, settings-watcher.ts) is only constructed
  // inside daemon.ts's `if (agentProvider)` gate — a live (even inert) provider is needed here so
  // a settings.json edit actually reaches the running daemon's `settings` holder; the other tests
  // in this block pass `agentProvider: null` (no turns driven, so the boot-time snapshot never
  // needs to change) and rely on `boot()`'s own default. This test overrides that.
  test("hot toggle: flipping memory.enabled true -> false (no restart) makes the NEXT call read the legacy store instead", async () => {
    home = mkdtempSync(join(tmpdir(), "norma-daemon-memory-files-hot-"));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: new FakeProvider([]), model: "fake-1" } });
    harnessToken = daemon.tokens.harness;
    const daemonRef = daemon;
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "memory-files-tester");

    await c.request(METHODS.memoryWrite, { scope: "user", name: "a", description: "d", body: "b" });
    const target = globalMemoryDirFor({ normaHome: home });
    expect(existsSync(join(target, "a.md"))).toBe(true);

    writeFileSync(join(home, "settings.json"), JSON.stringify({ memory: { enabled: false } }));

    // Polls with a FRESH name each attempt (debounced fs.watch, ~150ms default, so the reload
    // isn't necessarily visible on the very next call) — a repeated name would risk an early
    // in-flight (still-files-mode) write landing at `target` and staying there, which a shared-name
    // retry loop could mistake for "never switched" or leave as stray cross-contamination once it
    // eventually DOES land in the legacy store under that same name.
    // Generous deadline (was 5000ms): the reload rides a REAL fs.watch → 150ms debounce → apply
    // pipeline, all on the event loop. Under heavy concurrent-suite CPU load that loop starves and
    // the pipeline legitimately overruns a 5s budget (~1-in-3 flake at merge-gate load). 30s gives
    // ample headroom while preserving correctness — a genuinely broken hot-reload never lands and
    // still fails this assertion, just later. (Root-caused: shrinking this below the 150ms debounce
    // deterministically reproduces the exact `landedInLegacyStore` failure.)
    const deadline = Date.now() + 30_000;
    let landedInLegacyStore = false;
    let i = 0;
    while (Date.now() < deadline && !landedInLegacyStore) {
      const probe = `probe-${i++}`;
      const w2 = await c.request(METHODS.memoryWrite, { scope: "user", name: probe, description: "d2", body: "b2" });
      expect(w2.error).toBeUndefined();
      if (existsSync(join(home, "memory", `${probe}.md`))) {
        landedInLegacyStore = true;
        expect(existsSync(join(target, `${probe}.md`))).toBe(false); // never ALSO written to files
      } else {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(landedInLegacyStore).toBe(true);

    expect(daemon).toBe(daemonRef);
    c.close();
  });
});
