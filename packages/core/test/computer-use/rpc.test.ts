// ComputerV2: Settings → Computer Use's local-only RPCs (`computerUse.status`, `.requestPermission`,
// `.apps.list`, `.apps.set`, `.setSettings`) through a real IPC server and the real computer-use runtime
// (`computer-use/wiring.ts`) over a FAKE helper and a temp home — plus the settings readers and writes.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnWriter, ERR, LineDecoder, METHODS, PROTOCOL_VERSION, encodeLine, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { createComputerUseRuntime } from "../../src/computer-use/wiring";
import { REMOTE_ALLOWED_METHODS, startIpcServer } from "../../src/ipc/server";
import { SessionHub } from "../../src/sessions/hub";
import { SessionStore } from "../../src/sessions/store";
import {
  computerUseAllowAllAppsFrom, computerUseAppsFrom, computerUseLegacyComputerFrom, computerUseMirrorFrom, computerUsePrivateEventPathFrom,
  loadSettings, setComputerUseApp, setComputerUseFlags, Settings,
} from "../../src/settings";
import { FakeHelper } from "./fake-helper";

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
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
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

const CU_METHODS = [METHODS.computerUseStatus, METHODS.computerUseRequestPermission, METHODS.computerUseAppsList, METHODS.computerUseAppsSet, METHODS.computerUseSetSettings];

describe("computerUse.* (local-only RPCs)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(initial: Record<string, unknown> = {}) {
    const home = mkdtempSync(join(tmpdir(), "winter-cu-rpc-"));
    const settingsPath = join(home, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, ...initial }));
    let live: Settings | null = loadSettings(settingsPath);
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const fake = new FakeHelper();
    fake.running = false;
    const runtime = createComputerUseRuntime({
      home, profile: "dev", settings: () => live, settingsPath, approvals: new ApprovalBroker(), hub, store,
      launchAllowed: true, inject: { transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier },
    });
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, computerUse: runtime.control });
    stop = () => { server.stop(); runtime.stop(); store.close(); };
    return { home, settingsPath, socketPath, tokens, fake, runtime, setLive: (s: Settings | null) => { live = s; } };
  }

  test("status: the settings and the helper — never launches it to answer", async () => {
    const { socketPath, tokens, fake } = await boot({ computerUse: { mirror: false } });
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "app");
    const r1 = await c.request(METHODS.computerUseStatus, {});
    expect(r1.result).toEqual({ enabled: true, allowAllApps: true, legacyComputer: false, mirror: false, privateEventPath: true, helper: { installed: true, running: false } });
    expect(fake.launched).toEqual([]);
    fake.running = true;
    const r2 = await c.request(METHODS.computerUseStatus, {});
    expect(r2.result.helper).toEqual({ installed: true, running: true, version: "1.7.0", permissions: { accessibility: true, screenRecording: false } });
    c.close();
  });

  test("requestPermission launches the helper and forwards permissions.request", async () => {
    const { socketPath, tokens, fake } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "app");
    const r = await c.request(METHODS.computerUseRequestPermission, { kind: "screenRecording" });
    expect(r.result).toEqual({ ok: true });
    expect(fake.launched).toEqual([expect.stringMatching(/dist\/dev\/Winter Computer Use Dev\.app$/)]);
    expect(fake.calls("permissions.request")).toEqual([{ kind: "screenRecording" }]);
    fake.quit();
    fake.installed = false;
    const r2 = await c.request(METHODS.computerUseRequestPermission, { kind: "accessibility" });
    expect(r2.error.code).toBe(ERR.RETRY);
    expect(r2.error.data.code).toBe("helper_unavailable");
    c.close();
  });

  test("apps.set writes settings.json (hot — served at once); apps.list lists EXCEPTIONS only; an empty row is deleted", async () => {
    const { socketPath, tokens, settingsPath, runtime, home } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "app");
    expect((await c.request(METHODS.computerUseAppsSet, { bundleId: "com.apple.Notes", name: "Notes", access: "click" })).result).toEqual({ ok: true });
    expect((await c.request(METHODS.computerUseAppsSet, { bundleId: "com.apple.TextEdit", grant: "always" })).result).toEqual({ ok: true });
    expect(computerUseAppsFrom(loadSettings(settingsPath))).toEqual({ "com.apple.Notes": { access: "click", name: "Notes" }, "com.apple.TextEdit": { grant: "always" } });
    // Served before the watcher swaps the live holder: the policy sees it now.
    expect(runtime.policy.accessFor("com.apple.Notes")).toBe("click");
    expect(runtime.policy.hasAlwaysGrant("com.apple.TextEdit")).toBe(true);
    // A recently used app with no exception is NOT listed; a listed one carries its lastUsedAt (ms).
    const { RecentApps } = await import("../../src/computer-use/recent-apps");
    const before = Date.now();
    new RecentApps(home).note("com.apple.Safari", "Safari");
    new RecentApps(home).note("com.apple.Notes", "Notes");
    const list = (await c.request(METHODS.computerUseAppsList, {})).result.apps as Array<Record<string, unknown>>;
    expect(list.find((a) => a.bundleId === "com.apple.Safari")).toBeUndefined();
    expect(list.find((a) => a.bundleId === "com.apple.Notes")).toMatchObject({ name: "Notes", access: "click", grant: null, isDefault: false });
    expect((list.find((a) => a.bundleId === "com.apple.Notes")!.lastUsedAt as number)).toBeGreaterThanOrEqual(before);
    // A row only for its Always-allow grant: access null.
    expect(list.find((a) => a.bundleId === "com.apple.TextEdit")).toEqual({ bundleId: "com.apple.TextEdit", name: "com.apple.TextEdit", access: null, grant: "always", isDefault: false });
    // Every row carries the documented fields.
    for (const row of list) expect(Object.keys(row).sort()).toEqual(expect.arrayContaining(["access", "bundleId", "grant", "isDefault", "name"]));
    // "Remove always-allow": grant:null — nothing remains, so the row goes (and leaves the list).
    await c.request(METHODS.computerUseAppsSet, { bundleId: "com.apple.TextEdit", grant: null });
    expect(Object.hasOwn(computerUseAppsFrom(loadSettings(settingsPath)), "com.apple.TextEdit")).toBe(false);
    expect((await c.request(METHODS.computerUseAppsList, {})).result.apps.find((a: any) => a.bundleId === "com.apple.TextEdit")).toBeUndefined();
    // access:null removes an ordinary app's exception: the row (name only left) goes.
    await c.request(METHODS.computerUseAppsSet, { bundleId: "com.apple.Notes", access: null });
    expect(Object.hasOwn(computerUseAppsFrom(loadSettings(settingsPath)), "com.apple.Notes")).toBe(false);
    expect(runtime.policy.accessFor("com.apple.Notes")).toBe("full");
    // A bad bundle id is the caller's error; so is an access outside the four.
    expect((await c.request(METHODS.computerUseAppsSet, { bundleId: "../evil", access: "deny" })).error.code).toBe(ERR.INVALID_PARAMS);
    expect((await c.request(METHODS.computerUseAppsSet, { bundleId: "a.b", access: "sometimes" })).error.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  test("the built-in default exceptions are listed (isDefault): password managers deny, terminals and System Settings click", async () => {
    const { socketPath, tokens, runtime } = await boot({ computerUse: { apps: { "com.bitwarden.desktop": { access: "full" } } } });
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "app");
    const apps = (await c.request(METHODS.computerUseAppsList, {})).result.apps as Array<Record<string, unknown>>;
    const byId = new Map(apps.map((a) => [a.bundleId as string, a]));
    for (const id of ["com.1password.1password", "com.agilebits.onepassword7", "com.dashlane.dashlanephonefinal", "com.dashlane.Dashlane", "com.lastpass.LastPass", "org.keepassxc.keepassxc", "me.proton.pass.electron", "in.sinew.Enpass-Desktop", "com.apple.Passwords"]) {
      expect(byId.get(id)).toMatchObject({ access: "deny", grant: null, isDefault: true });
    }
    for (const id of ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty", "net.kovidgoyal.kitty", "org.alacritty", "com.github.wez.wezterm", "com.apple.systempreferences"]) {
      expect(byId.get(id)).toMatchObject({ access: "click", grant: null, isDefault: true });
    }
    expect(byId.get("com.1password.1password")!.name).toBe("1Password");
    expect(byId.get("com.apple.systempreferences")!.name).toBe("System Settings");
    // Bitwarden: the user allowed it — their exception, not the default.
    expect(byId.get("com.bitwarden.desktop")).toMatchObject({ access: "full", isDefault: false });
    // Nothing else: exceptions only, and the old flag is gone.
    expect(apps).toHaveLength(18);
    for (const a of apps) expect(a.defaultDeny).toBeUndefined();
    // Blacked out of whole-screen shots unless the user set otherwise.
    const ex = runtime.policy.excludedFromScreen();
    expect(ex).toContain("com.apple.Passwords");
    expect(ex).not.toContain("com.bitwarden.desktop");
    expect(ex).not.toContain("com.apple.Terminal");
    c.close();
  });

  test("a built-in default can be changed, removed (stored as removed: the switch decides) and re-added", async () => {
    const { socketPath, tokens, settingsPath, runtime } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "app");
    const pm = "com.1password.1password";
    const row = async (id: string) => (await c.request(METHODS.computerUseAppsList, {})).result.apps.find((a: any) => a.bundleId === id);
    expect(runtime.policy.accessFor(pm)).toBe("deny");
    // Changed: stored explicitly, no longer the default.
    expect((await c.request(METHODS.computerUseAppsSet, { bundleId: pm, access: "full" })).result).toEqual({ ok: true });
    expect(computerUseAppsFrom(loadSettings(settingsPath))[pm]).toEqual({ access: "full" });
    expect(runtime.policy.accessFor(pm)).toBe("full");
    expect(await row(pm)).toMatchObject({ access: "full", isDefault: false });
    // Removed: `removed: true`, the master switch decides (on → full), and it leaves the list.
    await c.request(METHODS.computerUseAppsSet, { bundleId: pm, access: null });
    expect(computerUseAppsFrom(loadSettings(settingsPath))[pm]).toEqual({ removed: true });
    expect(runtime.policy.accessFor(pm)).toBe("full");
    expect(await row(pm)).toBeUndefined();
    expect(runtime.policy.excludedFromScreen()).not.toContain(pm);
    // …and with the switch off, a removed default is deny like any other app.
    await c.request(METHODS.computerUseSetSettings, { allowAllApps: false });
    expect(runtime.policy.accessFor(pm)).toBe("deny");
    await c.request(METHODS.computerUseSetSettings, { allowAllApps: true });
    // Re-added: an access on a removed default clears `removed`.
    await c.request(METHODS.computerUseAppsSet, { bundleId: pm, access: "deny" });
    expect(computerUseAppsFrom(loadSettings(settingsPath))[pm]).toEqual({ access: "deny" });
    expect(runtime.policy.accessFor(pm)).toBe("deny");
    expect(await row(pm)).toMatchObject({ access: "deny", isDefault: false });
    // A removed default keeps its row for an Always-allow grant (access null), and the removal survives a grant
    // round trip.
    const term = "com.apple.Terminal";
    await c.request(METHODS.computerUseAppsSet, { bundleId: term, access: null, grant: "always" });
    expect(computerUseAppsFrom(loadSettings(settingsPath))[term]).toEqual({ removed: true, grant: "always" });
    expect(await row(term)).toMatchObject({ access: null, grant: "always", isDefault: false, name: "Terminal" });
    await c.request(METHODS.computerUseAppsSet, { bundleId: term, grant: null });
    expect(computerUseAppsFrom(loadSettings(settingsPath))[term]).toEqual({ removed: true });
    expect(runtime.policy.accessFor(term)).toBe("full");
    // A default with only a grant (not removed) is listed at its default access.
    await c.request(METHODS.computerUseAppsSet, { bundleId: "com.apple.systempreferences", grant: "always" });
    expect(await row("com.apple.systempreferences")).toMatchObject({ access: "click", grant: "always", isDefault: true });
    c.close();
  });

  test("setSettings writes only the keys it carries; hot", async () => {
    const { socketPath, tokens, settingsPath, runtime } = await boot({ computerUse: { screenshotMaxDim: 900 } });
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "app");
    expect((await c.request(METHODS.computerUseSetSettings, { mirror: false })).result).toEqual({ ok: true });
    const s1 = loadSettings(settingsPath);
    expect(s1.computerUse).toEqual({ screenshotMaxDim: 900, mirror: false });
    expect(computerUseMirrorFrom(runtime.settings())).toBe(false);
    await c.request(METHODS.computerUseSetSettings, { enabled: false, privateEventPath: false });
    expect(loadSettings(settingsPath).computerUse).toEqual({ screenshotMaxDim: 900, mirror: false, enabled: false, privateEventPath: false });
    expect((await c.request(METHODS.computerUseStatus, {})).result).toMatchObject({ enabled: false, allowAllApps: true, mirror: false, privateEventPath: false });
    c.close();
  });

  test("allowAllApps: the master switch round-trips through setSettings and status, and the policy reads it at once", async () => {
    const { socketPath, tokens, settingsPath, runtime } = await boot({ computerUse: { apps: { "com.apple.Notes": { access: "view" } } } });
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "app");
    expect(runtime.policy.accessFor("com.apple.TextEdit")).toBe("full");
    expect((await c.request(METHODS.computerUseSetSettings, { allowAllApps: false })).result).toEqual({ ok: true });
    expect(loadSettings(settingsPath).computerUse).toMatchObject({ allowAllApps: false, apps: { "com.apple.Notes": { access: "view" } } });
    expect(computerUseAllowAllAppsFrom(runtime.settings())).toBe(false);
    expect((await c.request(METHODS.computerUseStatus, {})).result.allowAllApps).toBe(false);
    // Off: an app with no exception is deny; the exceptions keep theirs.
    expect(runtime.policy.accessFor("com.apple.TextEdit")).toBe("deny");
    expect(runtime.policy.accessFor("com.apple.Notes")).toBe("view");
    expect(runtime.policy.accessFor("com.apple.Terminal")).toBe("click");
    expect(runtime.policy.accessFor("com.1password.1password")).toBe("deny");
    // apps.list is the same exceptions list whatever the switch says.
    const ids = ((await c.request(METHODS.computerUseAppsList, {})).result.apps as Array<{ bundleId: string }>).map((a) => a.bundleId);
    expect(ids).toContain("com.apple.Notes");
    expect(ids).not.toContain("com.apple.TextEdit");
    await c.request(METHODS.computerUseSetSettings, { allowAllApps: true });
    expect(runtime.policy.accessFor("com.apple.TextEdit")).toBe("full");
    expect((await c.request(METHODS.computerUseStatus, {})).result.allowAllApps).toBe(true);
    // A non-boolean is the caller's error.
    expect((await c.request(METHODS.computerUseSetSettings, { allowAllApps: "no" })).error.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  test("local role only: never remote, refused for any other role", async () => {
    for (const m of CU_METHODS) expect(REMOTE_ALLOWED_METHODS.has(m)).toBe(false);
    const { socketPath, tokens } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.remote, "phone", "remote");
    for (const m of CU_METHODS) {
      const r = await c.request(m, m === METHODS.computerUseRequestPermission ? { kind: "accessibility" } : m === METHODS.computerUseAppsSet ? { bundleId: "a.b" } : {});
      expect(r.error).toBeDefined();
    }
    c.close();
  });
});

describe("the computerUse settings — one reader each, hot writes", () => {
  test("defaults: mirror on, private path on, legacy off, all apps allowed; apps normalized, an unknown access reads as deny", () => {
    expect(computerUseAllowAllAppsFrom(null)).toBe(true);
    expect(computerUseAllowAllAppsFrom({ computerUse: { allowAllApps: false } } as unknown as Settings)).toBe(false);
    expect(computerUseMirrorFrom(null)).toBe(true);
    expect(computerUsePrivateEventPathFrom(undefined)).toBe(true);
    expect(computerUseLegacyComputerFrom(null)).toBe(false);
    const s = { computerUse: { legacyComputer: true, mirror: false, apps: { a: { access: "view", grant: "always", name: "A" }, b: { access: "bogus", grant: "sometimes" }, c: "not-a-row", d: { removed: true }, e: { removed: "yes" } } } } as unknown as Settings;
    expect(computerUseLegacyComputerFrom(s)).toBe(true);
    expect(computerUseMirrorFrom(s)).toBe(false);
    expect(computerUseAppsFrom(s)).toEqual({ a: { access: "view", grant: "always", name: "A" }, b: { access: "deny" }, d: { removed: true }, e: {} });
  });

  test("the schema keeps apps loose: a hand-edited bad row never invalidates settings.json", () => {
    const r = Settings.safeParse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, computerUse: { apps: { x: 5, y: { access: 3 } } } });
    expect(r.success).toBe(true);
  });

  test("setComputerUseApp / setComputerUseFlags are pure and leave other keys alone", () => {
    const base = { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, computerUse: { screenshotMaxDim: 800 } } as unknown as Settings;
    const a = setComputerUseApp(base, "com.apple.Notes", { access: "view", name: "Notes" });
    expect(a.computerUse).toEqual({ screenshotMaxDim: 800, apps: { "com.apple.Notes": { access: "view", name: "Notes" } } });
    // Every access is stored explicitly — `full` included (it overrides the switch when the switch is off).
    const b = setComputerUseApp(a, "com.apple.Notes", { access: "full", grant: "always" });
    expect(b.computerUse?.apps).toEqual({ "com.apple.Notes": { access: "full", name: "Notes", grant: "always" } });
    const c = setComputerUseApp(b, "com.apple.Notes", { grant: null });
    expect(c.computerUse?.apps).toEqual({ "com.apple.Notes": { access: "full", name: "Notes" } });
    // access:null with no built-in default: the row (name only) is deleted, and the empty `apps` block with it.
    expect(setComputerUseApp(c, "com.apple.Notes", { access: null }).computerUse).toEqual({ screenshotMaxDim: 800 });
    // access:null on an app WITH a built-in default: `removed: true` is stored; an access clears it again.
    const r = setComputerUseApp(base, "com.apple.Terminal", { access: null }, { hasDefault: true });
    expect(r.computerUse?.apps).toEqual({ "com.apple.Terminal": { removed: true } });
    expect(setComputerUseApp(r, "com.apple.Terminal", { grant: "always" }, { hasDefault: true }).computerUse?.apps).toEqual({ "com.apple.Terminal": { removed: true, grant: "always" } });
    expect(setComputerUseApp(r, "com.apple.Terminal", { access: "view" }, { hasDefault: true }).computerUse?.apps).toEqual({ "com.apple.Terminal": { access: "view" } });
    // A hand-edited unknown key in a row rides through.
    const odd = { ...base, computerUse: { apps: { x: { access: "view", note: "mine" } } } } as unknown as Settings;
    expect(setComputerUseApp(odd, "x", { grant: "always" }).computerUse?.apps).toEqual({ x: { access: "view", note: "mine", grant: "always" } });
    expect(base.computerUse).toEqual({ screenshotMaxDim: 800 });
    expect(setComputerUseFlags(base, { mirror: false }).computerUse).toEqual({ screenshotMaxDim: 800, mirror: false });
    expect(setComputerUseFlags(base, { allowAllApps: false }).computerUse).toEqual({ screenshotMaxDim: 800, allowAllApps: false });
  });

  test("the per-app card's Always allow persists through the runtime and is served before the watcher catches up", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-cu-always-"));
    const settingsPath = join(home, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }));
    const live = loadSettings(settingsPath);
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const approvals = new ApprovalBroker();
    const sessionId = store.createSession("t", { cwd: home, approvalPolicy: "ask", mode: "code" });
    hub.addObserver((e) => {
      if (e.type === "approval_requested") queueMicrotask(() => approvals.resolve(e.sessionId, (e as { callId: string }).callId, true, "app", "always"));
    });
    const runtime = createComputerUseRuntime({ home, profile: "dev", settings: () => live, settingsPath, approvals, hub, store, launchAllowed: false });
    try {
      const { newRunGrants } = await import("../../src/computer-use/policy");
      await runtime.policy.authorize(newRunGrants(sessionId), { bundleId: "com.apple.Notes", name: "Notes" }, { kind: "bind" });
      expect(JSON.parse(readFileSync(settingsPath, "utf8")).computerUse.apps["com.apple.Notes"]).toEqual({ grant: "always", name: "Notes" });
      expect(runtime.policy.hasAlwaysGrant("com.apple.Notes")).toBe(true);
      const logged = store.read(sessionId).map((e) => e.type);
      expect(logged).toContain("approval_requested");
      expect(logged).toContain("approval_resolved");
    } finally { runtime.stop(); store.close(); }
  });
});
