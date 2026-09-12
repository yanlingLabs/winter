import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@winter/protocol";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { startIpcServer } from "../src/ipc/server";
import { SessionStore } from "../src/sessions/store";
import { FileSecretStore } from "../src/auth/secret-store";
import { TokenAuthority } from "../src/auth/tokens";

// Phase 5c Task 3: the skills.read/write/delete RPCs over the daemon's real SkillStore (wired
// unconditionally in daemon.ts — skillStore needs only winterHome/trust, no agentProvider — same
// precedent as memory/routines/mcp; see daemon-memory-rpc.test.ts, which this file mirrors closely:
// a dedicated real-daemon TestClient harness, kept in its own file rather than folded into
// server.test.ts's existing skills.list tests).

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated (not imported) from
 *  daemon-memory-rpc.test.ts's own copy, matching every other *.test.ts in this directory: each
 *  carries its own copy, there is no shared test-harness module. */
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

describe("skills.read/write/delete RPCs (Phase 5c Task 3)", () => {
  let daemon: RunningDaemon;
  let harnessToken: string;

  async function boot(): Promise<string> {
    const home = mkdtempSync(join(tmpdir(), "winter-daemon-skills-"));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({ home, secrets, agentProvider: null });
    harnessToken = daemon.tokens.harness;
    return home;
  }

  afterEach(() => daemon?.stop());

  test("write -> list (author winter) -> read -> delete round trip", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "skills-tester");

    const written = await c.request(METHODS.skillsWrite, {
      name: "release-notes", description: "Draft release notes", body: "Step one. Step two.",
    });
    expect(written.error).toBeUndefined();
    expect(written.result).toEqual({});

    const listed = await c.request(METHODS.skillsList, {});
    expect(listed.error).toBeUndefined();
    const meta = listed.result.skills.find((s: { name: string }) => s.name === "release-notes");
    expect(meta).toMatchObject({ name: "release-notes", description: "Draft release notes", source: "self", author: "winter" });

    const read = await c.request(METHODS.skillsRead, { name: "release-notes" });
    expect(read.error).toBeUndefined();
    expect(read.result.skill).toMatchObject({
      name: "release-notes", description: "Draft release notes", source: "self", author: "winter",
    });
    expect(read.result.skill.body).toContain("Step one. Step two.");

    const deleted = await c.request(METHODS.skillsDelete, { name: "release-notes" });
    expect(deleted.error).toBeUndefined();
    expect(deleted.result).toEqual({});

    const listedAfter = await c.request(METHODS.skillsList, {});
    expect(listedAfter.result.skills.find((s: { name: string }) => s.name === "release-notes")).toBeUndefined();
    c.close();
  });

  test("overwrite updates body/description in place; author stays stamped by the store, never caller-supplied", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "skills-tester");
    await c.request(METHODS.skillsWrite, { name: "x", description: "v1", body: "V1_BODY" });
    await c.request(METHODS.skillsWrite, { name: "x", description: "v2", body: "V2_BODY" });
    const read = await c.request(METHODS.skillsRead, { name: "x" });
    expect(read.result.skill.description).toBe("v2");
    expect(read.result.skill.body).toContain("V2_BODY");
    expect(read.result.skill.body).not.toContain("V1_BODY");
    c.close();
  });

  test("skills.read on an unknown name -> NOT_FOUND", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "skills-tester");
    const res = await c.request(METHODS.skillsRead, { name: "ghost" });
    expect(res.error?.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("skills.delete on an unknown name -> NOT_FOUND", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "skills-tester");
    const res = await c.request(METHODS.skillsDelete, { name: "ghost" });
    expect(res.error?.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // Server-side self-confinement: a name that resolves to a NON-self source (here, a user-root
  // skill seeded directly on disk before the daemon ever starts) is refused with a typed, specific
  // message — never silently no-oped, and never the generic "not found" deleteSelf alone would give
  // (there being no self/<name> to delete, deleteSelf on its own can't tell "wrong source" apart
  // from "never existed").
  test("deleting a name that resolves to a non-self source (user root) -> INVALID_PARAMS, refused before touching self/", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-daemon-skills-"));
    mkdirSync(join(home, "skills", "greet"), { recursive: true });
    writeFileSync(join(home, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: Say hi\n---\nSay hello warmly.\n");
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({ home, secrets, agentProvider: null });
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "skills-tester");
    const res = await c.request(METHODS.skillsDelete, { name: "greet" });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error?.message).toContain("only self-authored skills can be deleted");
    expect(existsSync(join(home, "skills", "greet", "SKILL.md"))).toBe(true); // untouched
    c.close();
  });

  test("schema validation: empty name is INVALID_PARAMS for read/write/delete; invalid slug on write is INVALID_PARAMS", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "skills-tester");

    const emptyRead = await c.request(METHODS.skillsRead, { name: "" });
    expect(emptyRead.error?.code).toBe(ERR.INVALID_PARAMS);

    const emptyWrite = await c.request(METHODS.skillsWrite, { name: "", description: "d", body: "b" });
    expect(emptyWrite.error?.code).toBe(ERR.INVALID_PARAMS);

    const emptyDelete = await c.request(METHODS.skillsDelete, { name: "" });
    expect(emptyDelete.error?.code).toBe(ERR.INVALID_PARAMS);

    const invalidSlug = await c.request(METHODS.skillsWrite, { name: "Not_A_Slug", description: "d", body: "b" });
    expect(invalidSlug.error?.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  // Degraded split mirrors memory's exactly: skills.list already degrades to an empty list with no
  // store (pre-existing behavior, unchanged); read/write/delete are typed INTERNAL. Reached via a
  // bare startIpcServer with no `skills` wired — the daemon fixture above always wires one.
  test("no SkillStore wired: list degrades to empty; read/write/delete are typed INTERNAL", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-skills-no-store-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });

    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "skills-tester");

    const listed = await c.request(METHODS.skillsList, {});
    expect(listed.error).toBeUndefined();
    expect(listed.result).toEqual({ ok: true, skills: [] });

    for (const [method, params] of [
      [METHODS.skillsRead, { name: "x" }],
      [METHODS.skillsWrite, { name: "x", description: "d", body: "b" }],
      [METHODS.skillsDelete, { name: "x" }],
    ] as const) {
      const res = await c.request(method, params);
      expect(res.error?.code).toBe(ERR.INTERNAL);
    }
    c.close(); server.stop(); store.close();
  });

  // A bare IPC server (own SessionStore + TokenAuthority, no skillStore wired) mirrors
  // daemon-memory-rpc.test.ts's own plugin-role test — RunningDaemon doesn't expose its
  // SessionStore, so the shared boot()/daemon fixture above can't mint plugin tokens. The role gate
  // (ipc/server.ts, checked BEFORE the switch) rejects a plugin connection regardless of whether
  // `skills` is wired.
  test("skills.read/write/delete are role-rejected for a plugin connection, exactly like memory.*", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-skills-plugin-role-"));
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
      [METHODS.skillsRead, { name: "x" }],
      [METHODS.skillsWrite, { name: "x", description: "d", body: "b" }],
      [METHODS.skillsDelete, { name: "x" }],
    ] as const) {
      const res = await plugin.request(method, params);
      expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
    }
    plugin.close(); server.stop(); store.close();
  });
});
