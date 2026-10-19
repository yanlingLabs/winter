// Cowork session door: THE OFF TEST (D1; docs/research/2026-10-18-cowork-session-door-design.md section 6). Kept, and
// inverted at the flip (D6). The single activation switch is whether `startIpcServer` receives a `CoworkSessionDoor`
// (`IpcServerOptions.coworkSessions`). No production caller passes one, so a production-shaped daemon answers EVERY
// `session.create {mode: "cowork"}` with the typed `unsupported_topology` refusal, a well-formed binding to a ready
// source included, and nothing exists afterwards. The positive control (part 2) sends the SAME request to a server
// given a stub door and sees it accepted, so part 1 cannot pass on a schema refusal. Part 3 pins the source facts
// that keep the switch off: nothing outside ipc/server.ts names the option, and no module builds a door.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { ConnWriter, ERR, LineDecoder, METHODS, PROTOCOL_VERSION, encodeLine, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { CoworkRepository } from "../../src/cowork/repository";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import { CoworkError, type CoworkErrorCode } from "../../src/cowork/types";
import type { CoworkConnection } from "../../src/cowork/service";
import type { CoworkSessionCreateInput, CoworkSessionDoor, CoworkSessionDrivers } from "../../src/cowork/session-ports";

class Client {
  readonly notifications: any[] = [];
  private decoder = new LineDecoder(); private next = 1;
  private pending = new Map<number, { resolve(value: any): void; timer: ReturnType<typeof setTimeout> }>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>; private writer!: ConnWriter;
  static async connect(path: string, token: string, role: string, hello?: { reply?: any }): Promise<Client> {
    const client = new Client();
    client.socket = await Bun.connect({ unix: path, socket: {
      data(_socket, bytes) {
        for (const line of client.decoder.push(bytes)) {
          const message = JSON.parse(line), pending = client.pending.get(message.id);
          if (pending) { clearTimeout(pending.timer); client.pending.delete(message.id); pending.resolve(message); } else client.notifications.push(message);
        }
      },
      drain() { client.writer.onDrain(); },
    } });
    client.writer = new ConnWriter(client.socket as unknown as WritableSocket);
    const reply = await client.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, token, role, clientName: `fixture-${role}` });
    if (hello) hello.reply = reply; else expect(reply.error).toBeUndefined();
    return client;
  }
  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("RPC timeout")); }, 10_000);
      this.pending.set(id, { resolve, timer }); this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    });
  }
  close(): void { this.socket.end(); }
}

const UNSUPPORTED = { code: ERR.INVALID_PARAMS, message: "Cowork unavailable", data: { code: "unsupported_topology" } };
const INVALID = { code: ERR.INVALID_PARAMS, message: "Invalid Cowork request", data: { code: "invalid_request" } };
/** The one well-formed request both halves send: part 1 must refuse it, part 2 must accept it. */
const request = (workspaceId: string, sourceId: string, requestId: string, extra: Record<string, unknown> = {}) =>
  ({ scope: "global", mode: "cowork", cowork: { workspaceId, location: { kind: "source", sourceId }, requestId }, ...extra });
const outputsRequest = (workspaceId: string, requestId: string) =>
  ({ scope: "global", mode: "cowork", cowork: { workspaceId, location: { kind: "outputs" }, requestId } });

const homes: string[] = [], clients: Client[] = [];
let daemon: RunningDaemon | undefined, server: { stop(): void } | undefined, store: SessionStore | undefined;
afterEach(async () => {
  clients.splice(0).forEach(client => client.close());
  if (daemon) { try { await daemon.stop(); } catch { /* already stopped */ } daemon = undefined; }
  server?.stop(); server = undefined; store?.close(); store = undefined;
  homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true }));
});
const tempHome = (): string => { const home = mkdtempSync(join(tmpdir(), "winter-session-door-off-")); homes.push(home); return home; };

/** A project workspace whose one folder source is `ready`, written straight into the runtime-state DB before any daemon
 *  opens it, so a refusal cannot come from a missing or unprepared source. Power stays `stopped`, no incarnation. */
function seedReadyWorkspace(home: string): { workspaceId: string; sourceId: string } {
  const db = openRuntimeStateDb(home);
  try {
    const records = new CoworkRepository(db);
    const made = records.create({ principalId: "fixture-user", requestId: "seed" }, { ownership: "project", title: "Door fixture",
      ceiling: { toolClasses: ["read", "write", "execute"], hostServices: [], connectors: [], network: "none" },
      sources: [{ kind: "folder", label: "Door fixture", access: "read-write", detail: { grantRef: "fixture-grant", rootIdentity: "fixture-root" } }] });
    const sourceId = records.sources(made.workspaceId)[0]!.sourceId;
    db.db.run("UPDATE cowork_sources SET state='ready',ack_revision=revision WHERE workspace_id=? AND source_id=?", [made.workspaceId, sourceId]);
    expect(records.source(made.workspaceId, sourceId).state).toBe("ready");
    return { workspaceId: made.workspaceId, sourceId };
  } finally { db.close(); }
}
const raw = (home: string) => new Database(join(home, "runtimes", "runtime-state.db"), { readonly: true });

// ---------------------------------------------------------------------------------------------------- 1. production-shaped
describe("1. a production-shaped daemon refuses a well-formed Cowork create", () => {
  test("harness, admin and remote each get unsupported_topology for a ready source and for the outputs location, and nothing exists", async () => {
    const home = tempHome(), { workspaceId, sourceId } = seedReadyWorkspace(home);
    // Exactly the production options: no coworkHost, no coworkNative, no coworkSessions (startDaemon has no such option yet).
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "secrets")), agentProvider: null });
    const socket = join(home, "run", "core.sock");
    const harness = await Client.connect(socket, daemon.tokens.harness, "harness");
    const admin = await Client.connect(socket, daemon.tokens.admin, "admin");
    const remote = await Client.connect(socket, daemon.tokens.remote, "remote");
    const observer = await Client.connect(socket, daemon.tokens.harness, "harness");
    clients.push(harness, admin, remote, observer);
    // The fourth role cannot even connect: no plugin token verifies (auth/tokens.ts), whichever token it presents, so no
    // plugin connection reaches session.create (and part 3 pins that its method gate excludes it too).
    for (const token of [daemon.tokens.harness, daemon.tokens.admin, daemon.tokens.remote]) {
      const attempt: { reply?: any } = {}, plugin = await Client.connect(socket, token, "plugin", attempt);
      clients.push(plugin);
      expect(attempt.reply?.error).toBeDefined();
      expect(attempt.reply?.result).toBeUndefined();
    }
    for (const [role, client] of [["harness", harness], ["admin", admin], ["remote", remote]] as const) {
      expect([role, (await client.request(METHODS.sessionCreate, request(workspaceId, sourceId, `create-${role}`))).error]).toEqual([role, UNSUPPORTED]);
      expect([role, (await client.request(METHODS.sessionCreate, outputsRequest(workspaceId, `outputs-${role}`))).error]).toEqual([role, UNSUPPORTED]);
      // The bare mode, as every client sends it today, and one carrying every host-derived field: the same one answer.
      expect([role, (await client.request(METHODS.sessionCreate, { scope: "global", mode: "cowork" })).error]).toEqual([role, UNSUPPORTED]);
      expect([role, (await client.request(METHODS.sessionCreate, request(workspaceId, sourceId, `extra-${role}`, { cwd: tmpdir(), approvalPolicy: "bypass", model: "x/y", effort: "high", origin: "routine/x" }))).error]).toEqual([role, UNSUPPORTED]);
    }
    expect((await harness.request(METHODS.sessionList, {})).result.sessions).toEqual([]);
    expect(daemon.coworkNative?.built).toBe(false);
    const capabilities = await harness.request("workspace.capabilities.get", {});
    expect(capabilities.error).toBeUndefined();
    expect(capabilities.result).toMatchObject({ provisioning: false, execution: false });
    await Bun.sleep(30);
    expect(observer.notifications.filter(n => n.method === METHODS.event)).toEqual([]); // no session_created broadcast
    clients.splice(0).forEach(client => client.close());
    await daemon.stop(); daemon = undefined;

    const db = raw(home);
    try {
      expect(db.query("SELECT count(*) AS n FROM cowork_conversations").get()).toEqual({ n: 0 });
      expect(db.query("SELECT incarnation_id, power FROM cowork_workspaces WHERE workspace_id=?").get(workspaceId)).toEqual({ incarnation_id: null, power: "stopped" });
      expect(db.query("SELECT state FROM cowork_sources WHERE source_id=?").get(sourceId)).toEqual({ state: "ready" });
    } finally { db.close(); }
    const reopened = new SessionStore(home);
    try { reopened.recoverAll(); expect(reopened.list()).toEqual([]); } finally { reopened.close(); }
    const sessions = join(home, "sessions");
    let leftovers: string[] = [];
    try { leftovers = readdirSync(sessions, { recursive: true }).map(String).filter(name => !name.startsWith("index.db")); } catch { /* no sessions dir */ }
    expect(leftovers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------- 2. positive control
function stubDoor(refusal?: { code: CoworkErrorCode }): { door: CoworkSessionDoor; seen: { input: CoworkSessionCreateInput; caller: CoworkConnection }[] } {
  const seen: { input: CoworkSessionCreateInput; caller: CoworkConnection }[] = [];
  const unused = (name: string) => () => { throw new Error(`the door's drivers are not called by session.create (${name})`); };
  const drivers: CoworkSessionDrivers = { get: unused("get"), ensure: unused("ensure"), runTurn: unused("runTurn"), evict: unused("evict"), list: () => [], beginShutdown: async () => {} };
  return { seen, door: { drivers, async create(input, caller) {
    seen.push({ input: structuredClone(input), caller: { ...caller } });
    if (refusal) throw new CoworkError(refusal.code);
    return { sessionId: "s_0123456789ab" };
  } } };
}
async function bootWithDoor(door: CoworkSessionDoor | undefined) {
  const home = tempHome(); store = new SessionStore(home);
  const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json"))), tokens = await authority.ensureTokens();
  const socketPath = join(home, "core.sock");
  server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, ...(door ? { coworkSessions: door } : {}) });
  const harness = await Client.connect(socketPath, tokens.harness, "harness"), remote = await Client.connect(socketPath, tokens.remote, "remote");
  const admin = await Client.connect(socketPath, tokens.admin, "admin");
  clients.push(harness, remote, admin);
  return { harness, remote, admin, store };
}

describe("2. positive control: the same request reaches an injected door, and only a well-formed local one", () => {
  test("a well-formed source and outputs request reach the door verbatim and answer {sessionId, trusted: false}", async () => {
    const { door, seen } = stubDoor(), { harness, admin } = await bootWithDoor(door);
    expect(await harness.request(METHODS.sessionCreate, request("w_one", "src_one", "req_one"))).toMatchObject({ result: { sessionId: "s_0123456789ab", trusted: false } });
    const nested = { scope: "global", mode: "cowork", cowork: { workspaceId: "w_one", location: { kind: "source", sourceId: "src_one", relativeCwd: "repo/sub" }, requestId: "req_two" } };
    expect((await harness.request(METHODS.sessionCreate, nested)).result).toEqual({ sessionId: "s_0123456789ab", trusted: false });
    expect((await harness.request(METHODS.sessionCreate, outputsRequest("w_one", "req_three"))).result).toEqual({ sessionId: "s_0123456789ab", trusted: false });
    expect(seen.map(entry => entry.input)).toEqual([
      { scope: "global", workspaceId: "w_one", requestId: "req_one", location: { kind: "source", sourceId: "src_one" } },
      { scope: "global", workspaceId: "w_one", requestId: "req_two", location: { kind: "source", sourceId: "src_one", relativeCwd: "repo/sub" } },
      { scope: "global", workspaceId: "w_one", requestId: "req_three", location: { kind: "outputs" } },
    ]);
    for (const { caller } of seen) { expect(caller.role).toBe("harness"); expect(Number.isInteger(caller.connectionId)).toBe(true); }
    // The caller is the connection's own authenticated role and id, never a constant.
    expect((await admin.request(METHODS.sessionCreate, outputsRequest("w_one", "req_admin"))).result).toEqual({ sessionId: "s_0123456789ab", trusted: false });
    expect(seen[3]!.caller.role).toBe("admin");
    expect(seen[3]!.caller.connectionId).not.toBe(seen[0]!.caller.connectionId);
  });

  test("the SAME request without a door is the production refusal (the control's only difference is the door)", async () => {
    const { harness, store: sessions } = await bootWithDoor(undefined);
    expect((await harness.request(METHODS.sessionCreate, request("w_one", "src_one", "req_one"))).error).toEqual(UNSUPPORTED);
    expect(sessions.list()).toEqual([]);
  });

  test("with a door, a paired caller is still refused unsupported_topology and the door is never asked", async () => {
    const { door, seen } = stubDoor(), { remote } = await bootWithDoor(door);
    expect((await remote.request(METHODS.sessionCreate, request("w_one", "src_one", "req_remote"))).error).toEqual(UNSUPPORTED);
    expect((await remote.request(METHODS.sessionCreate, outputsRequest("w_one", "req_remote_outputs"))).error).toEqual(UNSUPPORTED);
    expect(seen).toEqual([]);
  });

  test("with a door, a missing binding and every host-derived field are invalid_request, the default approval policy included", async () => {
    const { door, seen } = stubDoor(), { harness, store: sessions } = await bootWithDoor(door);
    expect((await harness.request(METHODS.sessionCreate, { scope: "global", mode: "cowork" })).error).toEqual(INVALID);
    // `approvalPolicy: "ask"` is the schema's own default: only the RAW params can tell it was sent.
    for (const [key, value] of [["cwd", tmpdir()], ["approvalPolicy", "ask"], ["approvalPolicy", "bypass"], ["model", "x/y"], ["effort", "high"], ["origin", "routine/x"]] as const) {
      expect([key, (await harness.request(METHODS.sessionCreate, request("w_one", "src_one", "req_extra", { [key]: value }))).error]).toEqual([key, INVALID]);
    }
    expect(seen).toEqual([]);
    expect(sessions.list()).toEqual([]);
  });

  test("a Cowork binding beside any other mode is invalid_request, never ignored, and mints nothing", async () => {
    const { door, seen } = stubDoor(), { harness, store: sessions } = await bootWithDoor(door);
    const binding = { workspaceId: "w_one", location: { kind: "outputs" }, requestId: "req_mode" };
    for (const mode of [undefined, "code", "chat", "dispatch"]) {
      expect([mode, (await harness.request(METHODS.sessionCreate, { scope: "global", ...(mode ? { mode } : {}), cowork: binding })).error]).toEqual([mode, INVALID]);
    }
    expect(seen).toEqual([]);
    expect(sessions.list()).toEqual([]);
    // ...and the same server still mints a plain code session (the refusal above is about the binding, not the mode).
    expect((await harness.request(METHODS.sessionCreate, { scope: "global" })).error?.data?.code).not.toBe("invalid_request");
  });

  test("a malformed binding fails the schema before the door: an absolute, parent-escaping or NUL cwd, an outputs location with a source, an unknown key", async () => {
    const { door, seen } = stubDoor(), { harness } = await bootWithDoor(door);
    const location = (value: unknown) => ({ scope: "global", mode: "cowork", cowork: { workspaceId: "w_one", location: value, requestId: "req_bad" } });
    for (const params of [
      location({ kind: "source", sourceId: "src_one", relativeCwd: "/etc" }),
      location({ kind: "source", sourceId: "src_one", relativeCwd: "a/../../b" }),
      location({ kind: "source", sourceId: "src_one", relativeCwd: "a\0b" }),
      location({ kind: "source", sourceId: "src_one", relativeCwd: "a\\b" }),
      location({ kind: "source", sourceId: "src_one", relativeCwd: "" }),
      location({ kind: "outputs", sourceId: "src_one" }),
      location({ kind: "source" }),
      location({ kind: "folder", sourceId: "src_one" }),
      { scope: "global", mode: "cowork", cowork: { workspaceId: "w_one", location: { kind: "outputs" }, requestId: "req_bad", cwd: "/" } },
      { scope: "global", mode: "cowork", cowork: { workspaceId: "w_one", location: { kind: "outputs" } } },
    ]) {
      const reply = await harness.request(METHODS.sessionCreate, params);
      expect([params, reply.error?.code, reply.error?.data?.code]).toEqual([params, ERR.INVALID_PARAMS, undefined]);
    }
    expect(seen).toEqual([]);
  });

  test("a door refusal is the typed Cowork refusal on the wire, never INTERNAL", async () => {
    for (const code of ["provider_unavailable", "conversation_limit", "cold_resume_unavailable", "source_unavailable"] as const) {
      const { door } = stubDoor({ code }), { harness } = await bootWithDoor(door);
      expect((await harness.request(METHODS.sessionCreate, request("w_one", "src_one", `req_${code}`))).error).toEqual({ code: ERR.INVALID_PARAMS, message: "Cowork request refused", data: { code } });
      clients.splice(0).forEach(client => client.close()); server?.stop(); server = undefined; store?.close(); store = undefined;
    }
    const { door } = stubDoor({ code: "authority_denied" }), { harness } = await bootWithDoor(door);
    expect((await harness.request(METHODS.sessionCreate, request("w_one", "src_one", "req_denied"))).error).toEqual({ code: ERR.UNAUTHORIZED, message: "Cowork request refused", data: { code: "authority_denied" } });
  });
});

// ---------------------------------------------------------------------------------------------------- 3. source pins
const PACKAGES = join(import.meta.dir, "..", "..", "..");
const sourcesUnder = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String)
  .map(name => join(dir, name)).filter(path => /\.(ts|tsx|js|mjs)$/.test(path) && statSync(path).isFile());
const allSources = (): string[] => readdirSync(PACKAGES).flatMap(name => {
  const src = join(PACKAGES, name, "src");
  try { return statSync(src).isDirectory() ? sourcesUnder(src) : []; } catch { return []; }
});
const shown = (path: string) => relative(PACKAGES, path).split(sep).join("/");

/** Source text with comments removed, so a pin judges code, not prose. */
const code = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
/** What `daemon.ts` may say about the door before the flip: S7B's pass-through of a host-only option, and nothing else. */
const DAEMON_PASS_THROUGH = [/\bcoworkSessions\?\s*:\s*CoworkSessionDoor\b/g, /\bcoworkSessions\s*:\s*opts\.coworkSessions\b/g, /\bopts\.coworkSessions\b/g, /\bimport type \{[^}]*\bCoworkSessionDoor\b[^}]*\} from "\.\/cowork\/session-ports";/g];
const beyondPassThrough = (text: string) => DAEMON_PASS_THROUGH.reduce((rest, allowed) => rest.replace(allowed, ""), text);

describe("3. source pins: the switch stays off", () => {
  test("the CLI never names the door option", () => {
    expect(sourcesUnder(join(PACKAGES, "cli", "src")).filter(path => readFileSync(path, "utf8").includes("coworkSessions")).map(shown)).toEqual([]);
  });

  test("daemon.ts names the door only as the pass-through of a host-only option (today: not at all)", () => {
    const daemonCode = code(join(PACKAGES, "core", "src", "daemon.ts"));
    // S7B's pass-through (design section 10 item 4) is the only form allowed before D6: the option's declaration, its
    // type-only import and `coworkSessions: opts.coworkSessions`. Constructing a door here IS the flip.
    expect(beyondPassThrough(daemonCode).includes("coworkSessions")).toBe(false);
    expect(beyondPassThrough(daemonCode).includes("CoworkSessionDoor")).toBe(false);
    // The rule itself: the pass-through forms are allowed, anything else is not.
    expect(beyondPassThrough("coworkSessions?: CoworkSessionDoor; ... coworkSessions: opts.coworkSessions,").includes("coworkSessions")).toBe(false);
    expect(beyondPassThrough("coworkSessions: buildDoor(stores)").includes("coworkSessions")).toBe(true);
  });

  test("outside ipc/server.ts and the spine, only that pass-through names the door, and no src module builds one", () => {
    const sources = allSources();
    expect(sources.length).toBeGreaterThan(100);
    const daemon = "core/src/daemon.ts";
    // session-ports.ts names the option only in its header comment; the protocol names the door only in a comment.
    const naming = (needle: string) => sources.filter(path => readFileSync(path, "utf8").includes(needle)).map(shown).filter(name => name !== daemon).sort();
    // The OPTION is judged in code, not prose (D3): a module may explain the switch in a comment without wiring it.
    const namingInCode = (needle: string) => sources.filter(path => code(path).includes(needle)).map(shown).filter(name => name !== daemon).sort();
    expect(namingInCode("coworkSessions")).toEqual(["core/src/ipc/server.ts"]);
    expect(code(join(PACKAGES, "core", "src", "cowork", "session-ports.ts")).includes("coworkSessions")).toBe(false);
    expect(naming("CoworkSessionDoor")).toEqual(["core/src/cowork/session-ports.ts", "core/src/ipc/server.ts", "protocol/src/cowork.ts"]);
    expect(code(join(PACKAGES, "protocol", "src", "cowork.ts")).includes("CoworkSessionDoor")).toBe(false);
    // Nothing implements or constructs one: no `implements`, no `satisfies`, no `: CoworkSessionDoor =`, no cast.
    for (const path of sources) expect([shown(path), /(?:implements|satisfies|as)\s+CoworkSessionDoor\b|:\s*CoworkSessionDoor\s*=/.test(code(path))]).toEqual([shown(path), false]);
  });

  test("D3: nothing in src builds the Cowork driver table, and the driver reaches the guest only through injected ports", () => {
    const sources = allSources(), driver = join(PACKAGES, "core", "src", "cowork", "session-driver.ts");
    expect(sources).toContain(driver);
    // Only its own module names the factory: no daemon, server, CLI or door constructs a table before the flip (D6).
    expect(sources.filter(path => /\bcreateCoworkSessionDrivers\b/.test(code(path))).map(shown)).toEqual(["core/src/cowork/session-driver.ts"]);
    const text = code(driver);
    // No native module, no provider broker or socket, no process, no network, no router: the route, the starter, the
    // offer and the approval port are all injected, and production injects none of them.
    for (const forbidden of [/from "[^"]*\/native\//, /native-wiring|native-activation/, /provider-broker/, /node:(net|child_process|http|https|dgram)/, /\bBun\.(spawn|connect|listen)\b/, /\bfetch\(/, /winter-runtime-sdk/])
      expect([forbidden.source, forbidden.test(text)]).toEqual([forbidden.source, false]);
    expect(text).toMatch(/route === undefined \|\| native === undefined \|\| offer === undefined \|\| approvals === undefined\) throw new CoworkError\("provider_unavailable"\)/);
  });

  test("a plugin connection never reaches session.create (the role gate precedes the switch)", () => {
    const server = readFileSync(join(PACKAGES, "core", "src", "ipc", "server.ts"), "utf8");
    const start = server.indexOf("const PLUGIN_ALLOWED_METHODS = new Set<string>(["), end = server.indexOf("]);", start);
    expect(start).toBeGreaterThan(0);
    expect(server.slice(start, end).includes("sessionCreate")).toBe(false);
  });
});
