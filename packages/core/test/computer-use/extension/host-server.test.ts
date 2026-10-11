// Winter for Chrome's daemon end: `<home>/run/browser.sock`, the `host.hello` checks in their pinned order, the
// extension's relayed `hello`, registration by instance, and the connection's lifecycle — over the real unix socket,
// with a fake host (NDJSON), a fake registry and a fake signature verifier.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserHostRequirementFor, EXTENSION_IDS } from "../../../src/computer-use/browser/extension/extension-ids";
import { BrowserHostServer, type BrowserHostServerOptions } from "../../../src/computer-use/browser/extension/host-server";
import { BROWSER_HOST_PROTOCOL, EXTENSION_PROTOCOL } from "../../../src/computer-use/browser/extension/protocol";
import { FakeRegistry } from "./fake-registry";
import { LineClient } from "./line-client";

const DEV_ID = EXTENSION_IDS.dev[0]!;
const ORIGIN = `chrome-extension://${DEV_ID}/`;
const INSTANCE = "3f0c7a52-8d0e-4b1c-9a51-6f1f7b0a2c11";

let dir: string;
let socketPath: string;
let server: BrowserHostServer | undefined;
const clients: LineClient[] = [];

beforeEach(() => {
  // Short: a socket path must fit in 104 bytes.
  dir = mkdtempSync(join(tmpdir(), "wbh-"));
  mkdirSync(join(dir, "run"), { mode: 0o700 });
  socketPath = join(dir, "run", "browser.sock");
});

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  server?.stop();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function start(over: Partial<BrowserHostServerOptions> = {}): { registry: FakeRegistry; verified: { pid: number; requirement: string }[]; logs: string[] } {
  const registry = new FakeRegistry();
  const verified: { pid: number; requirement: string }[] = [];
  const logs: string[] = [];
  server = new BrowserHostServer({
    socketPath,
    profile: "dev",
    daemonVersion: "0.124.0",
    registry: () => registry,
    enabled: () => true,
    verifyHost: (pid, requirement) => { verified.push({ pid, requirement }); return true; },
    log: (l) => logs.push(l),
    ...over,
  });
  server.start();
  return { registry, verified, logs };
}

async function connect(): Promise<LineClient> {
  const c = await LineClient.connect(socketPath);
  clients.push(c);
  return c;
}

const hostHello = (over: Record<string, unknown> = {}) => ({
  protocol: BROWSER_HOST_PROTOCOL, client: "browser-host", hostVersion: "1.9.0", hostPid: 4242, origin: ORIGIN,
  browserBundleId: "com.google.Chrome", browserPid: 4000, ...over,
});

async function readyHost(): Promise<LineClient> {
  const c = await connect();
  const r = await c.request("h1", "host.hello", hostHello());
  expect(r).toMatchObject({ id: "h1", result: { protocol: BROWSER_HOST_PROTOCOL, daemonVersion: "0.124.0" } });
  return c;
}

describe("browser.sock", () => {
  test("is created 0600 at start, replacing a stale file, and removed at stop", () => {
    writeFileSync(socketPath, "stale");
    start();
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    server!.stop();
    server = undefined;
    expect(existsSync(socketPath)).toBe(false);
  });
});

describe("host.hello", () => {
  test("a first request that is not host.hello → protocol_mismatch, then closed", async () => {
    start();
    const c = await connect();
    const r = await c.request("e1", "hello", { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId: INSTANCE });
    expect(r).toMatchObject({ error: { data: { code: "protocol_mismatch", expected: BROWSER_HOST_PROTOCOL } } });
    expect(await c.closed()).toBe(true);
  });

  test("another protocol → protocol_mismatch with the expected number, then closed", async () => {
    start();
    const c = await connect();
    const r = await c.request("h1", "host.hello", hostHello({ protocol: BROWSER_HOST_PROTOCOL + 1 }));
    expect(r).toMatchObject({ id: "h1", error: { data: { code: "protocol_mismatch", expected: BROWSER_HOST_PROTOCOL } } });
    expect(await c.closed()).toBe(true);
  });

  test("an origin outside the profile's allowlist → not_allowed/origin (checked before the browser and the signature)", async () => {
    const { verified } = start();
    for (const origin of ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/", `chrome-extension://${DEV_ID}`, `https://${DEV_ID}/`, 7]) {
      const c = await connect();
      const r = await c.request("h1", "host.hello", hostHello({ origin, browserBundleId: "com.example.NotABrowser" }));
      expect(r).toMatchObject({ error: { data: { code: "not_allowed", reason: "origin" } } });
      expect(await c.closed()).toBe(true);
    }
    expect(verified).toEqual([]);
  });

  test("the dist profile accepts no extension until the store ids exist", async () => {
    start({ profile: "dist", allowedExtensionIds: undefined });
    const c = await connect();
    const r = await c.request("h1", "host.hello", hostHello());
    expect(r).toMatchObject({ error: { data: { code: "not_allowed", reason: "origin" } } });
  });

  test("a browser outside the Chromium families → not_allowed/browser (checked before the signature)", async () => {
    const { verified } = start();
    const c = await connect();
    const r = await c.request("h1", "host.hello", hostHello({ browserBundleId: "com.apple.Safari" }));
    expect(r).toMatchObject({ error: { data: { code: "not_allowed", reason: "browser" } } });
    expect(verified).toEqual([]);
  });

  test("the host's code is checked by the pid it reports, against the host's stated requirement", async () => {
    const { verified } = start({ verifyHost: (pid, requirement) => { verified.push({ pid, requirement }); return false; } });
    const c = await connect();
    const r = await c.request("h1", "host.hello", hostHello({ hostPid: 777 }));
    expect(r).toMatchObject({ error: { data: { code: "not_allowed", reason: "signature" } } });
    expect(verified).toEqual([{ pid: 777, requirement: browserHostRequirementFor("dev") }]);
    expect(browserHostRequirementFor("dev")).toBe('identifier "com.winter.browserhost.dev" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ"');
    expect(await c.closed()).toBe(true);
  });

  test("a non-positive or missing pid is never verified", async () => {
    const { verified } = start();
    for (const hostPid of [0, -1, 1.5, "12"]) {
      const c = await connect();
      const r = await c.request("h1", "host.hello", hostHello({ hostPid }));
      expect(r).toMatchObject({ error: { data: { code: "not_allowed", reason: "signature" } } });
    }
    expect(verified).toEqual([]);
  });

  test("computer use turned off → disabled", async () => {
    start({ enabled: () => false });
    const c = await connect();
    const r = await c.request("h1", "host.hello", hostHello());
    expect(r).toMatchObject({ error: { data: { code: "disabled" } } });
    expect(await c.closed()).toBe(true);
  });

  test("every family's bundle id is accepted, case-insensitively (lane B's rule); Chrome for Testing is Chrome", async () => {
    start();
    for (const browserBundleId of ["com.google.Chrome", "com.google.Chrome.canary", "com.google.chrome.for.testing", "COM.GOOGLE.CHROME", "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.brave.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "company.thebrowser.Browser", "org.chromium.Chromium"]) {
      const c = await connect();
      const r = await c.request("h1", "host.hello", hostHello({ browserBundleId }));
      expect({ browserBundleId, r }).toMatchObject({ browserBundleId, r: { result: { protocol: BROWSER_HOST_PROTOCOL } } });
    }
  });

  test("a browser registers under its family's id but its CHANNEL's own name (lane B's table): Brave, Chrome Beta, Edge Dev, Chrome for Testing", async () => {
    const { registry } = start();
    const cases = [
      { bundleId: "com.brave.Browser", id: "brave", name: "Brave" },
      { bundleId: "com.google.Chrome.beta", id: "chrome", name: "Google Chrome Beta" },
      { bundleId: "com.microsoft.edgemac.Dev", id: "edge", name: "Microsoft Edge Dev" },
      { bundleId: "COM.GOOGLE.CHROME.FOR.TESTING", id: "chrome#2", name: "Google Chrome for Testing (2)" },
    ];
    for (const [i, k] of cases.entries()) {
      const t = await connect();
      await t.request("h1", "host.hello", hostHello({ browserBundleId: k.bundleId }));
      const r = await t.request("e1", "hello", { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId: `0b8f2b7e-1111-4c4c-8888-00000000001${i}` });
      expect({ bundleId: k.bundleId, r }).toMatchObject({ bundleId: k.bundleId, r: { result: { backend: { id: k.id, name: k.name } } } });
      // The family and the bundle id the host reported are what the registry keeps (the per-app grant's key).
      expect(registry.list().find((b) => b.id === k.id)).toMatchObject({ family: k.id.split("#")[0], bundleId: k.bundleId });
    }
    // A channel's name reaches the "update" sentence too.
    const old = await connect();
    await old.request("h1", "host.hello", hostHello({ browserBundleId: "com.microsoft.edgemac.Canary" }));
    await old.request("e1", "hello", { protocol: EXTENSION_PROTOCOL - 1, extensionVersion: "0.9.0", instanceId: "0b8f2b7e-1111-4c4c-8888-000000000020" });
    expect(registry.unavailable.at(-1)).toMatchObject({ family: "edge", name: "Microsoft Edge Canary", bundleId: "com.microsoft.edgemac.Canary" });
  });

  test("no host.hello in time → closed", async () => {
    start({ helloTimeoutMs: 100 });
    const c = await connect();
    expect(await c.closed(1500)).toBe(true);
  });

  test("a line that is not JSON-RPC → closed", async () => {
    start();
    const c = await connect();
    c.writeRaw("not json\n");
    expect(await c.closed()).toBe(true);
  });
});

describe("the extension's hello", () => {
  test("registers an ExtensionTransport under the instance, and answers its backend", async () => {
    const { registry } = start();
    const c = await readyHost();
    const r = await c.request("e1", "hello", { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId: INSTANCE });
    expect(r).toEqual({ jsonrpc: "2.0", id: "e1", result: { protocol: EXTENSION_PROTOCOL, backend: { id: "chrome", name: "Google Chrome" } } });
    expect(registry.registrations).toEqual([{ id: "chrome", instanceKey: INSTANCE }]);
    const t = registry.get("chrome")!;
    expect(t.connected).toBe(true);
    expect(t.backend).toBe("chrome");
    expect(t.family).toBe("chrome");
    expect(registry.list()).toEqual([{ id: "chrome", family: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome", connected: true }]);
  });

  test("an older extension → protocol_mismatch, listed unavailable with \"update Winter for Chrome\"; a newer one → \"update Winter\"", async () => {
    const { registry } = start();
    const c = await readyHost();
    const old = await c.request("e1", "hello", { protocol: 0, extensionVersion: "0.9.0", instanceId: INSTANCE });
    expect(old).toMatchObject({ error: { message: "update Winter for Chrome", data: { code: "protocol_mismatch", expected: EXTENSION_PROTOCOL } } });
    const newer = await c.request("e2", "hello", { protocol: EXTENSION_PROTOCOL + 1, extensionVersion: "2.0.0", instanceId: INSTANCE });
    expect(newer).toMatchObject({ error: { message: "update Winter", data: { code: "protocol_mismatch", expected: EXTENSION_PROTOCOL } } });
    expect(registry.unavailable.map((u) => u.reason)).toEqual([
      "Winter for Chrome in Google Chrome is too old — ask the user to update Winter for Chrome",
      "Winter for Chrome in Google Chrome is newer than this Winter — ask the user to update Winter",
    ]);
    expect(registry.unavailable[0]).toMatchObject({ family: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome" });
    expect(registry.registrations).toEqual([]);
    // The connection stays open: a hello that matches still registers.
    const ok = await c.request("e3", "hello", { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId: INSTANCE });
    expect(ok).toMatchObject({ result: { backend: { id: "chrome" } } });
  });

  test("no engine in this daemon → unavailable, nothing registered", async () => {
    start({ registry: () => undefined });
    const c = await readyHost();
    const r = await c.request("e1", "hello", { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId: INSTANCE });
    expect(r).toMatchObject({ error: { data: { code: "unavailable" } } });
  });

  test("an instanceId that is not a UUID is refused", async () => {
    const { registry } = start();
    const c = await readyHost();
    for (const instanceId of ["", "x", "../../etc", 5]) {
      const r = await c.request("e1", "hello", { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId });
      expect(r).toMatchObject({ error: { data: { code: "invalid_params" } } });
    }
    expect(registry.registrations).toEqual([]);
  });

  test("the same instance on a new connection keeps its BackendId; the old connection is retired and closed", async () => {
    const { registry } = start();
    const first = await readyHost();
    await first.request("e1", "hello", { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId: INSTANCE });
    const before = registry.get("chrome")!;
    const second = await readyHost();
    const r = await second.request("e1", "hello", { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId: INSTANCE });
    expect(r).toMatchObject({ result: { backend: { id: "chrome" } } });
    expect(before.connected).toBe(false);
    expect(await first.closed()).toBe(true);
    // The old connection's close must not unregister the new transport.
    await new Promise((res) => setTimeout(res, 50));
    expect(registry.get("chrome")?.connected).toBe(true);
    expect(registry.get("chrome")).not.toBe(before);
  });

  test("a second profile of the same family gets #2", async () => {
    const { registry } = start();
    const a = await readyHost();
    await a.request("e1", "hello", { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId: INSTANCE });
    const b = await readyHost();
    const r = await b.request("e1", "hello", { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId: "0b8f2b7e-1111-4c4c-8888-000000000002" });
    expect(r).toMatchObject({ result: { backend: { id: "chrome#2", name: "Google Chrome (2)" } } });
    expect(registry.get("chrome")?.connected).toBe(true);
  });

  test("the connection closing unregisters it and disconnects its transport", async () => {
    const { registry } = start();
    const c = await readyHost();
    await c.request("e1", "hello", { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId: INSTANCE });
    const t = registry.get("chrome")!;
    c.close();
    for (let i = 0; i < 50 && registry.get("chrome") !== undefined; i++) await new Promise((r) => setTimeout(r, 20));
    expect(registry.get("chrome")).toBeUndefined();
    expect(t.connected).toBe(false);
    await expect(t.listTabs()).rejects.toMatchObject({ code: "disconnected" });
  });

  test("a transport round trip: the daemon's request reaches the host, the extension's answer comes back", async () => {
    const { registry } = start();
    const c = await readyHost();
    await c.request("e1", "hello", { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId: INSTANCE });
    const t = registry.get("chrome")!;
    const listing = t.listTabs();
    const req = await c.next();
    expect(req).toMatchObject({ jsonrpc: "2.0", method: "tabs.list", params: {} });
    const reqId = String((req as Record<string, unknown>).id);
    expect(reqId).toMatch(/^d\d+$/);
    c.send({ id: reqId, result: { tabs: [{ tabKey: "418", url: "https://example.com/", title: "Example", active: true, agent: false }] } });
    expect(await listing).toEqual([{ tabKey: "418", url: "https://example.com/", title: "Example", active: true, agent: false }]);
  });

  test("an unknown request from the extension → method not found; the connection stays", async () => {
    start();
    const c = await readyHost();
    await c.request("e1", "hello", { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId: INSTANCE });
    const r = await c.request("e2", "session.list", {});
    expect(r).toMatchObject({ id: "e2", error: { code: -32601 } });
    const again = await c.request("e3", "nope", {});
    expect(again).toMatchObject({ id: "e3", error: { code: -32601 } });
  });

  test("stop() disconnects every transport", async () => {
    const { registry } = start();
    const c = await readyHost();
    await c.request("e1", "hello", { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0", instanceId: INSTANCE });
    const t = registry.get("chrome")!;
    server!.stop();
    server = undefined;
    expect(t.connected).toBe(false);
    expect(await c.closed()).toBe(true);
  });
});
