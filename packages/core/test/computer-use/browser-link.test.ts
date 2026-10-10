// Winter.app's BROWSER LINK, daemon side (`computer-use/browser/cef-link/`): the `browserLink.*` RPCs with a fake app
// connection — attach (protocol, replacement), commands and their results (late ones dropped, timeouts, the size cap),
// events (only allowlisted ones), tabs gone, the link closing — and the same through a REAL IPC server: harness role
// only, the close hook, and `computerUse.status`'s browsers.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnWriter, ERR, LineDecoder, METHODS, PROTOCOL_VERSION, encodeLine, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { BROWSER_LINK_PROTOCOL, BrowserLink, BrowserLinkRpcError } from "../../src/computer-use/browser/cef-link/rpc";
import { BrowserBackendRegistry } from "../../src/computer-use/browser/registry";
import { transportFailure } from "../../src/computer-use/browser/tab-driver";
import { AutomationFailure } from "../../src/computer-use/errors";
import { TransportError, type CdpEvent } from "../../src/computer-use/browser/transport";
import { createComputerUseRuntime } from "../../src/computer-use/wiring";
import { REMOTE_ALLOWED_METHODS, startIpcServer } from "../../src/ipc/server";
import { SessionHub } from "../../src/sessions/hub";
import { SessionStore } from "../../src/sessions/store";
import { loadSettings, type Settings } from "../../src/settings";
import { FakeHelper } from "./fake-helper";

const LINK_METHODS = [METHODS.browserLinkAttach, METHODS.browserLinkResult, METHODS.browserLinkEvents, METHODS.browserLinkTabGone];

interface Note { method: string; params: { linkId: string; cmdId: string; op: string; params: Record<string, unknown>; reason?: string } }

/** A fake app connection: the notifications the daemon wrote to it. */
function app(link: BrowserLink, conn: object = {}) {
  const notes: Note[] = [];
  const write = (m: Record<string, unknown>): void => { notes.push(m as unknown as Note); };
  const call = (method: string, params: unknown): Record<string, unknown> => link.handle(conn, write, method, params);
  return { conn, notes, call, last: (): Note => notes[notes.length - 1]! };
}

describe("the browser link (daemon side)", () => {
  test("attach registers the built-in browser; a protocol mismatch is refused typed and noted for browsers.list()", () => {
    const registry = new BrowserBackendRegistry();
    const link = new BrowserLink({ registry });
    const a = app(link);
    let err: unknown;
    try { a.call(METHODS.browserLinkAttach, { protocol: 2, appVersion: "9.9.9", pid: 1 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BrowserLinkRpcError);
    expect((err as BrowserLinkRpcError).data).toMatchObject({ code: "protocol_mismatch", expected: BROWSER_LINK_PROTOCOL });
    expect(registry.list()).toEqual([{ id: "winter", family: "winter", name: "Winter (built-in)", connected: false, reason: "Winter's app is newer than its daemon — ask the user to update Winter" }]);
    const res = a.call(METHODS.browserLinkAttach, { protocol: 1, appVersion: "0.124.0", pid: 42 });
    expect(res).toMatchObject({ protocol: 1 });
    expect(String(res.linkId)).toMatch(/^bl_[0-9a-f]{12}$/);
    expect(registry.list()).toEqual([{ id: "winter", family: "winter", name: "Winter (built-in)", connected: true }]);
    expect(link.connected).toBe(true);
  });

  test("a command goes out as a notification and its result settles it; a late or foreign result is dropped and answered {}", async () => {
    const registry = new BrowserBackendRegistry();
    const link = new BrowserLink({ registry });
    const a = app(link);
    const { linkId } = a.call(METHODS.browserLinkAttach, { protocol: 1, appVersion: "x", pid: 1 }) as { linkId: string };
    const t = registry.get("winter")!;
    const p = t.send("tab-1", "Page.getLayoutMetrics", {});
    const note = a.last();
    expect(note.method).toBe("browserLink.command");
    expect(note.params).toMatchObject({ linkId, op: "cdp.send", params: { tabId: "tab-1", method: "Page.getLayoutMetrics", params: {} } });
    // A result on another connection, or for an unknown cmdId, changes nothing.
    expect(link.handle({}, () => {}, METHODS.browserLinkResult, { linkId, cmdId: note.params.cmdId, ok: true, result: { result: { wrong: true } } })).toEqual({});
    expect(a.call(METHODS.browserLinkResult, { linkId, cmdId: "c999", ok: true, result: {} })).toEqual({});
    a.call(METHODS.browserLinkResult, { linkId, cmdId: note.params.cmdId, ok: true, result: { result: { cssVisualViewport: { clientWidth: 10 } } } });
    expect(await p).toEqual({ cssVisualViewport: { clientWidth: 10 } });
    // The same cmdId again is a late result: dropped, still answered.
    expect(a.call(METHODS.browserLinkResult, { linkId, cmdId: note.params.cmdId, ok: true, result: {} })).toEqual({});
  });

  test("an error result maps to the transport's codes; the allowlist is enforced before anything is written", async () => {
    const registry = new BrowserBackendRegistry();
    const link = new BrowserLink({ registry });
    const a = app(link);
    const { linkId } = a.call(METHODS.browserLinkAttach, { protocol: 1, appVersion: "x", pid: 1 }) as { linkId: string };
    const t = registry.get("winter")!;
    const p = t.send("tab-1", "Runtime.evaluate", { expression: "1", contextId: 1 });
    a.call(METHODS.browserLinkResult, { linkId, cmdId: a.last().params.cmdId, ok: false, error: { code: "cdp_error", message: "boom", data: { cdpCode: -32000, cdpMessage: "Cannot find context" } } });
    const e = await p.then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(TransportError);
    expect(e).toMatchObject({ code: "cdp_error", data: { cdpMessage: "Cannot find context" } });
    const before = a.notes.length;
    const refused = await t.send("tab-1", "Network.getResponseBody", {}).then(() => undefined, (x: unknown) => x);
    expect(refused).toMatchObject({ code: "not_allowed" });
    const ev = await t.subscribe("tab-1", ["Network.responseReceived"]).then(() => undefined, (x: unknown) => x);
    expect(ev).toMatchObject({ code: "not_allowed" });
    expect(a.notes.length).toBe(before);
  });

  test("the app's ceiling on held built-in tabs (tab.ensure refused not_allowed) reads as a clear TargetBusy, from attach and from a new tab", async () => {
    const registry = new BrowserBackendRegistry();
    const link = new BrowserLink({ registry });
    const a = app(link);
    const { linkId } = a.call(METHODS.browserLinkAttach, { protocol: 1, appVersion: "x", pid: 1 }) as { linkId: string };
    const t = registry.get("winter")!;
    const CEILING = "Winter's built-in browser already holds 24 tabs for automation — release one first";
    for (const start of [() => t.attach("tab-25", { sessionId: "s1" }), () => t.createTab({ sessionId: "s1", url: "https://a.example/", tabKey: "tab-26" })]) {
      const p = start();
      expect(a.last().params.op).toBe("tab.ensure");
      a.call(METHODS.browserLinkResult, { linkId, cmdId: a.last().params.cmdId, ok: false, error: { code: "not_allowed", message: CEILING } });
      const e = await p.then(() => undefined, (x: unknown) => x);
      expect(e).toMatchObject({ code: "not_allowed", data: { holdCeiling: true } });
      const m = transportFailure(e, "Winter's browser") as AutomationFailure;
      expect(m.kind).toBe("TargetBusy");
      expect(m.message).toBe("too many built-in browser tabs are in use right now — close some with tab.close()");
    }
    // Any other not_allowed stays the browser's refusal.
    expect(transportFailure(new TransportError("not_allowed", "Network.getResponseBody is not on the allowlist"), "x")).not.toBeInstanceOf(AutomationFailure);
  });

  test("a command over 1 MiB is refused; a command nobody answers times out", async () => {
    const registry = new BrowserBackendRegistry();
    const link = new BrowserLink({ registry, timeouts: { send: 30 } });
    const a = app(link);
    a.call(METHODS.browserLinkAttach, { protocol: 1, appVersion: "x", pid: 1 });
    const t = registry.get("winter")!;
    const big = await t.send("tab-1", "Runtime.evaluate", { expression: "x".repeat(1_100_000), contextId: 1 }).then(() => undefined, (x: unknown) => x);
    expect(big).toMatchObject({ code: "not_allowed" });
    const slow = await t.send("tab-1", "Page.enable", {}).then(() => undefined, (x: unknown) => x);
    expect(slow).toMatchObject({ code: "timeout" });
  });

  test("events: only allowlisted ones reach the engine, with their child session; tabGone reaches it too", () => {
    const registry = new BrowserBackendRegistry();
    const link = new BrowserLink({ registry });
    const a = app(link);
    const { linkId } = a.call(METHODS.browserLinkAttach, { protocol: 1, appVersion: "x", pid: 1 }) as { linkId: string };
    const t = registry.get("winter")!;
    const seen: CdpEvent[] = [];
    const gone: string[] = [];
    t.onEvent((e) => seen.push(e));
    t.onTabGone((k, r) => gone.push(`${k}:${r}`));
    a.call(METHODS.browserLinkEvents, { linkId, events: [
      { tabId: "tab-1", method: "Page.frameNavigated", params: { frame: { id: "f" } } },
      { tabId: "tab-1", method: "Network.responseReceived", params: { response: { headers: {} } } },
      { tabId: "tab-1", method: "Runtime.executionContextCreated", params: { context: { id: 3, name: "winter" } }, cdpSessionId: "child" },
    ] });
    expect(seen.map((e) => [e.method, e.cdpSessionId])).toEqual([["Page.frameNavigated", undefined], ["Runtime.executionContextCreated", "child"]]);
    let tooMany: unknown;
    try { a.call(METHODS.browserLinkEvents, { linkId, events: Array.from({ length: 257 }, () => ({ tabId: "t", method: "Page.loadEventFired", params: {} })) }); } catch (e) { tooMany = e; }
    expect(tooMany).toBeInstanceOf(BrowserLinkRpcError);
    a.call(METHODS.browserLinkTabGone, { linkId, tabId: "tab-1", reason: "crashed" });
    expect(gone).toEqual(["tab-1:crashed"]);
  });

  test("a second attach replaces the first: the old connection is told, its commands fail disconnected, its results are ignored", async () => {
    const registry = new BrowserBackendRegistry();
    const link = new BrowserLink({ registry });
    const a = app(link, { name: "first" });
    const b = app(link, { name: "second" });
    const first = a.call(METHODS.browserLinkAttach, { protocol: 1, appVersion: "x", pid: 1 }) as { linkId: string };
    const oldTransport = registry.get("winter")!;
    const pending = oldTransport.send("tab-1", "Page.enable", {}).then(() => undefined, (x: unknown) => x);
    const cmd = a.last().params.cmdId;
    b.call(METHODS.browserLinkAttach, { protocol: 1, appVersion: "x", pid: 2 });
    expect(a.last()).toEqual({ jsonrpc: "2.0", method: "browserLink.detached", params: { linkId: first.linkId, reason: "replaced" } } as unknown as Note);
    expect(await pending).toMatchObject({ code: "disconnected" });
    expect(registry.get("winter")).not.toBe(oldTransport);
    expect(registry.list()[0]).toMatchObject({ id: "winter", connected: true });
    expect(a.call(METHODS.browserLinkResult, { linkId: first.linkId, cmdId: cmd, ok: true, result: {} })).toEqual({});
  });

  test("the link's connection closing: in-flight commands fail disconnected and the built-in browser reads Winter isn't running", async () => {
    const registry = new BrowserBackendRegistry();
    const link = new BrowserLink({ registry });
    const a = app(link);
    a.call(METHODS.browserLinkAttach, { protocol: 1, appVersion: "x", pid: 1 });
    const pending = registry.get("winter")!.send("tab-1", "Page.enable", {}).then(() => undefined, (x: unknown) => x);
    link.connectionClosed({});
    expect(link.connected).toBe(true);
    link.connectionClosed(a.conn);
    expect(await pending).toMatchObject({ code: "disconnected" });
    expect(registry.list()).toEqual([{ id: "winter", family: "winter", name: "Winter (built-in)", connected: false, reason: "Winter isn't running" }]);
  });

  test("tab ops: tab.ensure carries the panel tab's URL; listing, releasing and closing are their ops", async () => {
    const registry = new BrowserBackendRegistry();
    const link = new BrowserLink({ registry, tabUrl: (sid, tab) => (sid === "s1" && tab === "w1" ? "https://example.com/" : undefined) });
    const a = app(link);
    const { linkId } = a.call(METHODS.browserLinkAttach, { protocol: 1, appVersion: "x", pid: 1 }) as { linkId: string };
    const t = registry.get("winter")!;
    const answer = (result: unknown): void => { a.call(METHODS.browserLinkResult, { linkId, cmdId: a.last().params.cmdId, ok: true, result }); };
    const att = t.attach("w1", { sessionId: "s1" });
    expect(a.last().params).toMatchObject({ op: "tab.ensure", params: { sessionId: "s1", tabId: "w1", url: "https://example.com/" } });
    answer({ url: "https://example.com/", title: "Example", loading: false, viewport: [800, 600], dpr: 2 });
    expect(await att).toEqual({ viewport: [800, 600], dpr: 2 });
    const list = t.listTabs({ sessionId: "s1" });
    expect(a.last().params.op).toBe("tabs.live");
    answer({ tabs: [{ tabId: "w1", url: "https://example.com/", title: "Example", held: true }, { tabId: "other", url: "x", title: "y", held: false }] });
    expect((await list).map((x) => x.tabKey)).toEqual(["w1"]);
    const rel = t.detach("w1");
    expect(a.last().params).toMatchObject({ op: "tab.release", params: { tabId: "w1" } });
    answer({});
    await rel;
    const close = t.closeTab("w1");
    expect(a.last().params).toMatchObject({ op: "tab.close", params: { tabId: "w1" } });
    answer({});
    await close;
    t.overlay("w1", { active: true, cursor: { x: 1, y: 2, kind: "press" } });
    expect(a.last().params).toMatchObject({ op: "overlay", params: { tabId: "w1", active: true, cursor: { x: 1, y: 2, kind: "press" } } });
  });
});

// ── through a real IPC server ────────────────────────────────────────────────────────────────────

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  readonly notes: Array<{ method: string; params: any }> = [];
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
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
            else if (msg.id === undefined && typeof msg.method === "string") c.notes.push({ method: msg.method, params: msg.params });
          }
        },
        drain() { c.writer.onDrain(); },
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
  close(): void { this.socket.end(); }
}

const until = async (fn: () => boolean, ms = 2_000): Promise<void> => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 5)); }
};

describe("browserLink.* through the IPC server", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot() {
    const home = mkdtempSync(join(tmpdir(), "winter-browser-link-"));
    const settingsPath = join(home, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }));
    const live: Settings | null = loadSettings(settingsPath);
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const fake = new FakeHelper();
    fake.running = false;
    const runtime = createComputerUseRuntime({
      home, profile: "dev", settings: () => live, settingsPath, approvals: new ApprovalBroker(), hub, store, launchAllowed: true,
      inject: { transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier, browserInstalled: () => false },
    });
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, computerUse: runtime.control, browserLink: runtime.browserLink });
    stop = () => { server.stop(); runtime.stop(); store.close(); };
    return { socketPath, tokens, runtime };
  }

  test("none of the link methods is on the remote allowlist", () => {
    for (const m of LINK_METHODS) expect(REMOTE_ALLOWED_METHODS.has(m)).toBe(false);
  });

  test("the app attaches on its own connection, answers a command, and the link closing marks Winter's browser down", async () => {
    const { socketPath, tokens, runtime } = await boot();
    const before = await (async () => { const c = await TestClient.connect(socketPath); await c.hello(tokens.harness, "mac"); const r = await c.request(METHODS.computerUseStatus, {}); c.close(); return r; })();
    expect(before.result.browsers).toEqual([{ id: "winter", name: "Winter (built-in)", connected: false, reason: "Winter isn't running" }]);
    const appConn = await TestClient.connect(socketPath);
    expect((await appConn.hello(tokens.harness, "browser-link")).error).toBeUndefined();
    const att = await appConn.request(METHODS.browserLinkAttach, { protocol: 1, appVersion: "0.124.0", pid: 7 });
    expect(att.result.protocol).toBe(1);
    const linkId = att.result.linkId as string;
    const t = runtime.backends.get("winter")!;
    const sent = t.send("w1", "Page.enable", {});
    await until(() => appConn.notes.length > 0);
    const cmd = appConn.notes[0]!;
    expect(cmd).toMatchObject({ method: "browserLink.command", params: { linkId, op: "cdp.send", params: { tabId: "w1", method: "Page.enable" } } });
    const ack = await appConn.request(METHODS.browserLinkResult, { linkId, cmdId: cmd.params.cmdId, ok: true, result: { result: { ok: 1 } } });
    expect(ack.result).toEqual({});
    expect(await sent).toEqual({ ok: 1 });
    const pending = t.send("w1", "Page.enable", {}).then(() => undefined, (x: unknown) => x);
    appConn.close();
    expect(await pending).toMatchObject({ code: "disconnected" });
    await until(() => runtime.browserLink.connected === false);
    expect(runtime.browsers.listRows()[0]).toMatchObject({ id: "winter", connected: false, reason: "Winter isn't running" });
  });

  test("a remote client is refused every link method; a bad attach is INVALID_PARAMS with the code", async () => {
    const { socketPath, tokens } = await boot();
    const phone = await TestClient.connect(socketPath);
    await phone.hello(tokens.remote, "iphone-gateway", "remote");
    const r = await phone.request(METHODS.browserLinkAttach, { protocol: 1, appVersion: "x", pid: 1 });
    expect(r.error).toBeDefined();
    phone.close();
    const mac = await TestClient.connect(socketPath);
    await mac.hello(tokens.harness, "browser-link");
    const mismatch = await mac.request(METHODS.browserLinkAttach, { protocol: 99, appVersion: "x", pid: 1 });
    expect(mismatch.error.code).toBe(ERR.INVALID_PARAMS);
    expect(mismatch.error.data).toMatchObject({ code: "protocol_mismatch", expected: 1 });
    const garbage = await mac.request(METHODS.browserLinkResult, { nope: true });
    expect(garbage.error.data).toMatchObject({ code: "invalid_params" });
    mac.close();
  });
});
