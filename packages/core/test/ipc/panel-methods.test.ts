import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@norma/protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// panel-shell T6: the RPC surface over Task 5's foldPanelTabs (panel/store.ts) — panel.list/
// openTab/closeTab/activateTab/reportNavigation. All five are harness/admin-only: the phone has no
// panel (REMOTE_ALLOWED_METHODS must never carry any of them — see the test below, which is this
// plan's own explicit gate) and a plugin has no reason to drive one (PLUGIN_ALLOWED_METHODS is left
// untouched too, verified by code reading rather than a dedicated test here).
//
// There is deliberately NO panel.navigate: an agent's navigation REQUEST travels later as a
// transient `panel_command` (Plan B, not this task); only a CEF-committed navigation — witnessed
// solely by the app — becomes the persisted `panel_tab_navigated` event, via panel.reportNavigation.
//
// Exercised over a bare IPC server (own SessionStore + SessionHub + TokenAuthority), the
// session-set-dirs.test.ts / session-set-activity.test.ts precedent: this codebase's convention is
// no shared test-harness module, so TestClient below is duplicated per file on purpose.

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated from session-set-dirs.test.ts. */
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

describe("panel RPC methods (panel-shell T6)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{
    store: SessionStore; socketPath: string; harnessToken: string; remoteToken: string;
  }> {
    const home = mkdtempSync(join(tmpdir(), "norma-panel-methods-rpc-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  // -------------------------------------------------------------------------------------------
  // Remote allowlist — the plan's own explicit gate. NOTE: this assertion is TRUE both before and
  // after implementation (an absent METHODS key is `undefined`, and `undefined` is not in the set
  // either) — it is a PIN against a future regression, not a RED driver for this task's TDD cycle.
  // -------------------------------------------------------------------------------------------
  test("panel methods are NOT remote-allowed", async () => {
    for (const m of [
      METHODS.panelList, METHODS.panelOpenTab, METHODS.panelCloseTab,
      METHODS.panelActivateTab, METHODS.panelReportNavigation,
    ]) {
      expect(REMOTE_ALLOWED_METHODS.has(m)).toBe(false);
    }
  });

  test("a remote connection is role-rejected before it ever reaches the handler", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.panelList, { sessionId });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.UNAUTHORIZED);
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // panel.openTab — mints the id; the caller never supplies one.
  // -------------------------------------------------------------------------------------------
  test("panel.openTab mints a tabId and appends panel_tab_opened", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.panelOpenTab, {
      sessionId, kind: "web", url: "https://example.com", title: "Example",
    });
    expect(res.error).toBeUndefined();
    expect(res.result.ok).toBe(true);
    expect(typeof res.result.tabId).toBe("string");
    expect(res.result.tabId.length).toBeGreaterThan(0);

    const events = store.read(sessionId);
    const opened = events.find((e) => e.type === "panel_tab_opened") as any;
    expect(opened).toBeTruthy();
    expect(opened.tabId).toBe(res.result.tabId);
    expect(opened.kind).toBe("web");
    expect(opened.url).toBe("https://example.com");
    expect(opened.title).toBe("Example");
    c.close();
  });

  test("panel.openTab: a caller-supplied tabId is IGNORED — the daemon always mints its own", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    // PanelOpenTabParams has no `tabId` field at all — this proves the wire schema itself has no
    // slot for a caller-chosen id, not just that the handler happens to overwrite one.
    const res = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web", tabId: "caller-supplied" });
    expect(res.error).toBeUndefined();
    expect(res.result.tabId).not.toBe("caller-supplied");
    c.close();
  });

  test("two panel.openTab calls mint two DIFFERENT tabIds", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const a = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });
    const b = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });
    expect(a.result.tabId).not.toBe(b.result.tabId);
    c.close();
  });

  test("panel.openTab: unknown session -> NOT_FOUND", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");

    const res = await c.request(METHODS.panelOpenTab, { sessionId: "s_does_not_exist", kind: "web" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // panel.list — the fold (Task 5's foldPanelTabs), read fresh from the persisted log every call.
  // -------------------------------------------------------------------------------------------
  test("panel.list returns the fold — empty for a fresh session", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.panelList, { sessionId });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ tabs: [], activeTabId: undefined });
    c.close();
  });

  test("panel.list reflects open + activate + navigate, in fold order", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const opened = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });
    const tabId = opened.result.tabId;
    await c.request(METHODS.panelActivateTab, { sessionId, tabId });
    await c.request(METHODS.panelReportNavigation, { sessionId, tabId, url: "https://example.com", title: "Example" });

    const res = await c.request(METHODS.panelList, { sessionId });
    expect(res.result).toEqual({
      tabs: [{ tabId, kind: "web", url: "https://example.com", title: "Example" }],
      activeTabId: tabId,
    });
    c.close();
  });

  test("panel.list: unknown session -> NOT_FOUND", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");

    const res = await c.request(METHODS.panelList, { sessionId: "s_does_not_exist" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // panel.closeTab / panel.activateTab
  // -------------------------------------------------------------------------------------------
  test("panel.closeTab appends panel_tab_closed and removes the tab from the fold", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");
    const opened = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });
    const tabId = opened.result.tabId;

    const res = await c.request(METHODS.panelCloseTab, { sessionId, tabId });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true });

    const listed = await c.request(METHODS.panelList, { sessionId });
    expect(listed.result.tabs).toEqual([]);
    c.close();
  });

  test("panel.activateTab appends panel_tab_activated and sets activeTabId in the fold", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");
    const opened = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });
    const tabId = opened.result.tabId;

    const res = await c.request(METHODS.panelActivateTab, { sessionId, tabId });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true });

    const listed = await c.request(METHODS.panelList, { sessionId });
    expect(listed.result.activeTabId).toBe(tabId);
    c.close();
  });

  test("panel.closeTab / panel.activateTab: unknown session -> NOT_FOUND", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");

    const closeRes = await c.request(METHODS.panelCloseTab, { sessionId: "s_does_not_exist", tabId: "t1" });
    expect(closeRes.error?.code).toBe(ERR.NOT_FOUND);
    const activateRes = await c.request(METHODS.panelActivateTab, { sessionId: "s_does_not_exist", tabId: "t1" });
    expect(activateRes.error?.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // Permissive-append philosophy (documented on the handlers themselves, ipc/server.ts): the RPC
  // layer validates the SESSION exists and nothing else — an unknown/already-gone tabId is an
  // accepted no-op, because foldPanelTabs already tolerates it and close/activate both have TWO
  // producers (the user in the app, the agent in Plan B) that can legitimately race each other.
  test("panel.closeTab on a tabId that was never opened is ACCEPTED, not NOT_FOUND (permissive append)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.panelCloseTab, { sessionId, tabId: "never-opened" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true });
    c.close();
  });

  test("double-close of the same tab is accepted both times", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");
    const opened = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });
    const tabId = opened.result.tabId;

    const first = await c.request(METHODS.panelCloseTab, { sessionId, tabId });
    const second = await c.request(METHODS.panelCloseTab, { sessionId, tabId });
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(first.result).toEqual({ ok: true });
    expect(second.result).toEqual({ ok: true });

    const listed = await c.request(METHODS.panelList, { sessionId });
    expect(listed.result.tabs).toEqual([]);
    c.close();
  });

  test("panel.activateTab on an unknown tabId is accepted but does not change activeTabId (fold ignores it)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.panelActivateTab, { sessionId, tabId: "never-opened" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true });

    const listed = await c.request(METHODS.panelList, { sessionId });
    expect(listed.result.activeTabId).toBeUndefined();
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // panel.reportNavigation — a FACT, not a request. No panel.navigate exists (see below).
  // -------------------------------------------------------------------------------------------
  test("panel.reportNavigation appends panel_tab_navigated", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");
    const opened = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });
    const tabId = opened.result.tabId;

    const res = await c.request(METHODS.panelReportNavigation, { sessionId, tabId, url: "https://a.example", title: "A" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true });

    const events = store.read(sessionId);
    const nav = events.find((e) => e.type === "panel_tab_navigated") as any;
    expect(nav).toBeTruthy();
    expect(nav.tabId).toBe(tabId);
    expect(nav.url).toBe("https://a.example");
    expect(nav.title).toBe("A");
    c.close();
  });

  test("panel.reportNavigation for a tab that no longer exists is accepted (stale in-flight report), not an error", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");
    const opened = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });
    const tabId = opened.result.tabId;
    await c.request(METHODS.panelCloseTab, { sessionId, tabId });

    // The report arrives AFTER the close — foldPanelTabs ignores navigation for an unknown tab
    // rather than resurrecting it, so this must succeed at the RPC layer and simply have no effect.
    const res = await c.request(METHODS.panelReportNavigation, { sessionId, tabId, url: "https://late.example", title: "Late" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true });

    const listed = await c.request(METHODS.panelList, { sessionId });
    expect(listed.result.tabs).toEqual([]);
    c.close();
  });

  test("panel.reportNavigation: unknown session -> NOT_FOUND", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");

    const res = await c.request(METHODS.panelReportNavigation, {
      sessionId: "s_does_not_exist", tabId: "t1", url: "https://x.example", title: "X",
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // No panel.navigate — the method name must not exist on the wire at all (see the module doc
  // comment above, and PanelReportNavigationParams's own doc comment in methods.ts).
  // -------------------------------------------------------------------------------------------
  test("there is no panel.navigate method", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const res = await c.request("panel.navigate", { sessionId, tabId: "t1", url: "https://x.example" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.METHOD_NOT_FOUND);
    c.close();
  });
});
