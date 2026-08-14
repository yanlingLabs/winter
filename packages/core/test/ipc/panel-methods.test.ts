import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, SessionEvent,
  PANEL_URL_MAX_LENGTH, PANEL_TITLE_MAX_LENGTH,
  PANEL_COMMAND_ARGS_MAX_JSON_BYTES, PANEL_COMMAND_RESULT_MAX_LENGTH, type WritableSocket,
} from "@norma/protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { PanelCommandRegistry } from "../../src/panel/commands";
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
  // panel-cef Task 6b: THE URL SCHEME POLICY — an allowlist (`http`/`https` only), enforced at the
  // daemon as the fourth of four points (`isPersistablePanelWebUrl`, methods.ts, names all four).
  //
  // What it prevents is not "an odd string in a file": a tab's `url` is LOADED into a real Chromium
  // browser on every restore, so a persisted `javascript:` would be re-executed against the page
  // every time the session is reopened — forever, since sessions are user-delete-only.
  // -------------------------------------------------------------------------------------------
  for (const bad of [
    "javascript:alert(document.cookie)",
    "JavaScript:alert(1)",                       // scheme match is case-insensitive
    "file:///Users/someone/.ssh/id_rsa",
    "data:text/html,<script>fetch('//evil')</script>",
    "blob:https://example.com/9d5b",             // an allowlist refuses what a denylist would miss
    "about:blank",
    "chrome://settings",
    "not-a-url-at-all",                          // unparseable is refused too, not just wrong-scheme
  ]) {
    test(`panel.reportNavigation refuses ${bad.slice(0, 28)} — INVALID_PARAMS, nothing appended`, async () => {
      const { store, socketPath, harnessToken } = await boot();
      const c = await TestClient.connect(socketPath);
      await c.hello(harnessToken, "panel-tester");
      const sessionId = store.createSession("global");
      const opened = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });

      const res = await c.request(METHODS.panelReportNavigation, {
        sessionId, tabId: opened.result.tabId, url: bad, title: "T",
      });
      expect(res.error).toBeTruthy();
      expect(res.error.code).toBe(ERR.INVALID_PARAMS);
      // The point of the whole policy: nothing reached the permanent log.
      expect(store.read(sessionId).some((e) => e.type === "panel_tab_navigated")).toBe(false);
      c.close();
    });
  }

  test("panel.openTab refuses a non-http(s) url for a WEB tab", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web", url: "javascript:alert(1)" });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(store.read(sessionId).some((e) => e.type === "panel_tab_opened")).toBe(false);
    c.close();
  });

  // The deliberate exemption, pinned so nobody "tightens" it into a regression: the guard is
  // KIND-CONDITIONAL because a document/code/note tab legitimately carries a local path — the
  // spec's LibreOffice and Monaco slots are exactly that. Restore-side filtering in the app
  // (`PanelWebTab.makeContent`) is what makes the never-loaded guarantee hold regardless.
  test("panel.openTab ALLOWS a file:// url for a non-web kind (the kind-conditional exemption)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.panelOpenTab, {
      sessionId, kind: "document", url: "file:///Users/someone/report.odt",
    });
    expect(res.error).toBeUndefined();
    const listed = await c.request(METHODS.panelList, { sessionId });
    expect(listed.result.tabs[0].url).toBe("file:///Users/someone/report.odt");
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // panel-cef Task 6b: FIELD SIZE CAPS. A page <title> is chosen by whatever site the user visits
  // and lands in an append-only, never-deleted JSONL that `panel.list` re-reads whole.
  // -------------------------------------------------------------------------------------------
  test("panel.reportNavigation refuses an over-cap title, and accepts one exactly AT the cap", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");
    const opened = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });
    const tabId = opened.result.tabId;

    const over = await c.request(METHODS.panelReportNavigation, {
      sessionId, tabId, url: "https://a.example", title: "x".repeat(PANEL_TITLE_MAX_LENGTH + 1),
    });
    expect(over.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(store.read(sessionId).some((e) => e.type === "panel_tab_navigated")).toBe(false);

    const at = await c.request(METHODS.panelReportNavigation, {
      sessionId, tabId, url: "https://a.example", title: "x".repeat(PANEL_TITLE_MAX_LENGTH),
    });
    expect(at.error).toBeUndefined();
    c.close();
  });

  test("panel.reportNavigation refuses an over-cap url, and accepts one exactly AT the cap", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");
    const opened = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });
    const tabId = opened.result.tabId;

    const prefix = "https://a.example/";
    const atCap = prefix + "p".repeat(PANEL_URL_MAX_LENGTH - prefix.length);
    expect(atCap.length).toBe(PANEL_URL_MAX_LENGTH);

    const over = await c.request(METHODS.panelReportNavigation, {
      sessionId, tabId, url: atCap + "p", title: "T",
    });
    expect(over.error?.code).toBe(ERR.INVALID_PARAMS);

    const at = await c.request(METHODS.panelReportNavigation, { sessionId, tabId, url: atCap, title: "T" });
    expect(at.error).toBeUndefined();
    c.close();
  });

  // The caps bind on READ as well as on write — `SessionStore` parses every log line through the
  // same `SessionEvent` schema `hub.append` writes through. That symmetry is what makes the cap a
  // guarantee rather than a request, and it is also the reason LOWERING either number later is a
  // data migration rather than an edit. Pinned so the coupling is visible.
  test("the cap that bounds the write also bounds the read (one schema, both directions)", () => {
    const base = { sessionId: "s1", seq: 1, ts: 0 };
    const overLong = {
      ...base, type: "panel_tab_navigated", tabId: "t1",
      url: "https://a.example", title: "x".repeat(PANEL_TITLE_MAX_LENGTH + 1),
    };
    expect(SessionEvent.safeParse(overLong).success).toBe(false);
    expect(SessionEvent.safeParse({ ...overLong, title: "x".repeat(PANEL_TITLE_MAX_LENGTH) }).success).toBe(true);
  });

  // The Swift half of the same two numbers lives in `PanelURLPolicy` (apple/Norma/Sources/AppShell/
  // PanelURLPolicy.swift) with its own literal pin naming this one. Two hand-mirrored constants in
  // two languages with no compile-time coupling is this repo's worst known drift class, and drift
  // here is SILENT in both directions: the app's `try?`-wrapped RPC swallows the rejection, so a
  // too-generous Swift cap simply stops recording navigations with no error anywhere.
  test("the caps are the exact values the Swift mirror pins", () => {
    expect(PANEL_URL_MAX_LENGTH).toBe(2048);
    expect(PANEL_TITLE_MAX_LENGTH).toBe(256);
  });

  // Whole-branch review F4: the two sides agreed on the NUMBER and disagreed on the UNIT, which is
  // why the literal pin above — and its Swift twin — were structurally blind to it. Zod's `.max(n)`
  // counts JS `String.length`, i.e. UTF-16 code units; Swift's `String.prefix(n)` counts extended
  // grapheme clusters. Identical for ASCII, which is every literal either test uses.
  //
  // This pins the DAEMON's unit from the daemon's side, so the Swift mirror
  // (`PanelURLPolicy.cappedTitle`, `testTheCapsCountTheSameUnitTheDaemonCounts`) has something
  // stable to be correct against. A title of 256 emoji is 256 Characters and 512 units: refused.
  test("the caps count UTF-16 units, which is the unit the Swift mirror truncates in", () => {
    const emoji = "\u{1F600}";           // one grapheme cluster, ONE JS "character"…
    expect([...emoji].length).toBe(1);
    expect(emoji.length).toBe(2);        // …and two UTF-16 code units. Zod counts these.

    const title = emoji + "t".repeat(PANEL_TITLE_MAX_LENGTH - 1);   // 256 clusters, 257 units
    expect([...title].length).toBe(PANEL_TITLE_MAX_LENGTH);
    expect(title.length).toBe(PANEL_TITLE_MAX_LENGTH + 1);
    const base = { sessionId: "s1", seq: 1, ts: 0 };
    expect(SessionEvent.safeParse({
      ...base, type: "panel_tab_navigated", tabId: "t1", url: "https://a.example", title,
    }).success).toBe(false);

    // One cluster shorter — 255 clusters, 256 units — is exactly AT the cap and accepted. This is
    // the value the Swift side now emits for the same input.
    const fitted = emoji + "t".repeat(PANEL_TITLE_MAX_LENGTH - 2);
    expect(fitted.length).toBe(PANEL_TITLE_MAX_LENGTH);
    expect(SessionEvent.safeParse({
      ...base, type: "panel_tab_navigated", tabId: "t1", url: "https://a.example", title: fitted,
    }).success).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // panel-cef Task 6b: opening a tab ACTIVATES it (the wire decision Plan A left open).
  // -------------------------------------------------------------------------------------------
  test("panel.openTab appends panel_tab_activated too, so the new tab is the active one", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const opened = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });
    const listed = await c.request(METHODS.panelList, { sessionId });
    expect(listed.result.activeTabId).toBe(opened.result.tabId);

    const activated = store.read(sessionId).filter((e) => e.type === "panel_tab_activated") as any[];
    expect(activated.length).toBe(1);
    expect(activated[0].tabId).toBe(opened.result.tabId);
    c.close();
  });

  // The symptom this fixes, end to end: before it, opening a SECOND tab left the panel showing the
  // first one, so pressing "+" again appeared to do nothing at all.
  test("opening a second tab makes the SECOND one active", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const first = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });
    const second = await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });

    const listed = await c.request(METHODS.panelList, { sessionId });
    expect(listed.result.tabs.map((t: any) => t.tabId)).toEqual([first.result.tabId, second.result.tabId]);
    expect(listed.result.activeTabId).toBe(second.result.tabId);
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // diff-tabs Task 7: `diffId` passthrough. `panel.openTab` -> `mintPanelTab` (panel/open-tab.ts)
  // -> the persisted `panel_tab_opened` -> `foldPanelTabs`'s own `PanelTab.diffId` (Task 7's other
  // pin, test/panel/store.test.ts, covers the pure fold in isolation). This is the end-to-end
  // proof over the real RPC + real persisted log, the same depth panel.openTab's other fields
  // (kind/url/title) are already held to above.
  // -------------------------------------------------------------------------------------------
  test("panel.openTab passes diffId through to the persisted panel_tab_opened, and panel.list's fold exposes it", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");
    const diffId = "a".repeat(32);

    const res = await c.request(METHODS.panelOpenTab, { sessionId, kind: "diff", diffId, title: "x.ts" });
    expect(res.error).toBeUndefined();

    const opened = store.read(sessionId).find((e) => e.type === "panel_tab_opened") as any;
    expect(opened.diffId).toBe(diffId);

    const listed = await c.request(METHODS.panelList, { sessionId });
    expect(listed.result.tabs[0].diffId).toBe(diffId);
    c.close();
  });

  test("panel.openTab with no diffId (every non-diff kind): the fold exposes no diffId at all", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    await c.request(METHODS.panelOpenTab, { sessionId, kind: "web" });
    const listed = await c.request(METHODS.panelList, { sessionId });
    expect(listed.result.tabs[0].diffId).toBeUndefined();
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

// ================================================================================================
// B2 Task 2 — `panel.commandResult`, the ANSWER half of the command channel. Own describe block
// with its own boot() because these need a `PanelCommandRegistry` wired into the server, which the
// panel-shell T6 tests above deliberately do not have (and must keep not having: a server built
// without one still has to answer this method sanely).
// ================================================================================================
describe("panel.commandResult (B2 T2)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function bootWithRegistry(): Promise<{
    store: SessionStore; hub: SessionHub; registry: PanelCommandRegistry; logs: string[];
    socketPath: string; harnessToken: string; remoteToken: string;
  }> {
    const home = mkdtempSync(join(tmpdir(), "norma-panel-cmdresult-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const logs: string[] = [];
    // Wired exactly as daemon.ts wires it: emit === hub.broadcastTransient. Anything the registry
    // publishes therefore has to survive the real schema parse the hub performs.
    const registry = new PanelCommandRegistry({
      emit: (event) => { hub.broadcastTransient(event.sessionId, event); },
      log: (line) => { logs.push(line); },
    });
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store, hub, panelCommands: registry,
    });
    stop = () => { server.stop(); store.close(); };
    return { store, hub, registry, logs, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  // -------------------------------------------------------------------------------------------
  // Role. Deliverable 2 of the task is explicitly that the remote allowlists are NOT touched — the
  // pin belongs beside the five-method one above.
  // -------------------------------------------------------------------------------------------
  test("panel.commandResult is NOT remote-allowed", async () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.panelCommandResult)).toBe(false);
  });

  test("a remote connection is role-rejected before it ever reaches the handler", async () => {
    const { socketPath, remoteToken } = await bootWithRegistry();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const res = await c.request(METHODS.panelCommandResult, { sessionId: "s", commandId: "c", ok: true });
    expect(res.error.code).toBe(ERR.UNAUTHORIZED);
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // The round trip, over the real socket.
  // -------------------------------------------------------------------------------------------
  test("a harness result settles the pending command the daemon dispatched", async () => {
    const { store, registry, socketPath, harnessToken } = await bootWithRegistry();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const { commandId, settled } = registry.dispatch({
      sessionId, action: "read", tabId: "t1", deadlineMs: 5000,
    });
    const res = await c.request(METHODS.panelCommandResult, {
      sessionId, commandId, ok: true, result: "Pricing — $20/mo",
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true });
    expect(await settled).toEqual({ kind: "result", ok: true, result: "Pricing — $20/mo" });
    c.close();
  });

  test("TWO results for one commandId: the first wins, the second is dropped with a log line", async () => {
    const { store, registry, logs, socketPath, harnessToken } = await bootWithRegistry();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const { commandId, settled } = registry.dispatch({ sessionId, action: "click", deadlineMs: 5000 });
    const first = await c.request(METHODS.panelCommandResult, { sessionId, commandId, ok: true, result: "clicked" });
    const second = await c.request(METHODS.panelCommandResult, { sessionId, commandId, ok: false, result: "second opinion" });

    // Both are answered {ok:true} — the loser of the race did nothing wrong (see the handler's own
    // comment) — but only the first reached the agent.
    expect(first.result).toEqual({ ok: true });
    expect(second.error).toBeUndefined();
    expect(second.result).toEqual({ ok: true });
    expect(await settled).toEqual({ kind: "result", ok: true, result: "clicked" });
    expect(logs.some((l) => l.includes(commandId) && l.includes("dropped"))).toBe(true);
    c.close();
  });

  test("deadline expiry resolves as a TIMEOUT, and the late result is dropped rather than refused", async () => {
    const { store, registry, logs, socketPath, harnessToken } = await bootWithRegistry();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const { commandId, settled } = registry.dispatch({ sessionId, action: "wait", deadlineMs: 5 });
    expect(await settled).toEqual({ kind: "timeout", deadlineMs: 5 });

    const late = await c.request(METHODS.panelCommandResult, { sessionId, commandId, ok: true, result: "done, eventually" });
    expect(late.error).toBeUndefined();
    expect(logs.some((l) => l.includes(commandId) && l.includes("dropped"))).toBe(true);
    c.close();
  });

  test("a result for a commandId the daemon never issued is refused with NOT_FOUND, not a crash", async () => {
    const { store, socketPath, harnessToken } = await bootWithRegistry();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.panelCommandResult, { sessionId, commandId: "pcmd_never", ok: true });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);

    // The server is still alive and serving after the refusal.
    const after = await c.request(METHODS.panelList, { sessionId });
    expect(after.error).toBeUndefined();
    c.close();
  });

  test("a server built WITHOUT a registry refuses every result rather than throwing", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-panel-noreg-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub });
    stop = () => { server.stop(); store.close(); };

    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "panel-tester");
    const res = await c.request(METHODS.panelCommandResult, { sessionId: store.createSession("global"), commandId: "pcmd_x", ok: true });
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // Wire validation. The caps are refusals, so an over-cap payload never becomes a truncated one.
  // -------------------------------------------------------------------------------------------
  test("an over-cap result/image is refused at the wire, leaving the command to time out", async () => {
    const { store, registry, socketPath, harnessToken } = await bootWithRegistry();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const { commandId, settled } = registry.dispatch({ sessionId, action: "read", deadlineMs: 40 });
    const res = await c.request(METHODS.panelCommandResult, {
      sessionId, commandId, ok: true, result: "x".repeat(PANEL_COMMAND_RESULT_MAX_LENGTH + 1),
    });
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    // Refused, never truncated: the command is still pending and ends as a timeout.
    expect(await settled).toEqual({ kind: "timeout", deadlineMs: 40 });
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // The command's own trip out. `panel_command` is TRANSIENT: attached clients see it live, and the
  // session's JSONL never does.
  // -------------------------------------------------------------------------------------------
  test("a dispatched command reaches an attached harness live and is never persisted", async () => {
    const { store, hub, registry, socketPath, harnessToken } = await bootWithRegistry();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    const seen: any[] = [];
    hub.attach({ clientName: "spy", deliver: (e) => { seen.push(e); return true; } }, sessionId, 0);

    const { commandId } = registry.dispatch({
      sessionId, action: "type", tabId: "t1", args: { selector: "#q", text: "norma" }, deadlineMs: 5000,
    });

    const live = seen.find((e) => e.type === "panel_command");
    expect(live).toBeTruthy();
    expect(live.commandId).toBe(commandId);
    expect(live.action).toBe("type");
    expect(live.args).toEqual({ selector: "#q", text: "norma" });
    expect(store.read(sessionId).some((e) => e.type === "panel_command")).toBe(false);
    c.close();
  });

  test("an over-cap args object is refused at EMISSION, so a command that cannot be delivered is never registered", async () => {
    const { store, registry, socketPath, harnessToken } = await bootWithRegistry();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const sessionId = store.createSession("global");

    expect(() => registry.dispatch({
      sessionId, action: "type", args: { text: "x".repeat(PANEL_COMMAND_ARGS_MAX_JSON_BYTES) }, deadlineMs: 5000,
    })).toThrow();
    expect(registry.pendingCount).toBe(0);
    c.close();
  });
});
