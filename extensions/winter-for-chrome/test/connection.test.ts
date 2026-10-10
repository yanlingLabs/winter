// The native port: connectNative to the build's host, hello on `host.status connected`, the daemon's requests answered
// through the controller, the status the toolbar shows, and the 1 s → 30 s reconnect backoff.
import { beforeEach, describe, expect, test } from "bun:test";
import { HostConnection } from "../src/connection";
import { ExtensionController } from "../src/controller";
import { EXTENSION_PROTOCOL } from "../src/protocol";
import { StatusBoard } from "../src/status";
import { FakeChrome, flush, ManualClock, type FakePort } from "./fake-chrome";

let chrome: FakeChrome;
let clock: ManualClock;
let status: StatusBoard;
let conn: HostConnection;
let controller: ExtensionController;

beforeEach(async () => {
  chrome = new FakeChrome();
  clock = new ManualClock();
  status = new StatusBoard(chrome);
  controller = new ExtensionController(chrome, { notify: (m, p) => conn.notify(m, p), clock });
  await controller.start();
  conn = new HostConnection(chrome, controller, status, { hostName: "com.winter.browser.dev", clock });
});

function port(): FakePort { return chrome.ports.at(-1)!; }

async function connected(): Promise<FakePort> {
  conn.start();
  await port().deliver({ method: "host.status", params: { daemon: "connected" } });
  const hello = port().sent.at(-1)!;
  await port().deliver({ id: hello.id, result: { protocol: EXTENSION_PROTOCOL, backend: { id: "chrome", name: "Google Chrome" } } });
  return port();
}

describe("hello", () => {
  test("connects to the build's host and says hello once Winter is reachable", async () => {
    conn.start();
    expect(chrome.calls.find((c) => c.api === "runtime.connectNative")?.args).toEqual(["com.winter.browser.dev"]);
    expect(port().sent).toEqual([]);
    await port().deliver({ method: "host.status", params: { daemon: "connected" } });
    const hello = port().sent[0]!;
    expect(hello).toMatchObject({ jsonrpc: "2.0", method: "hello", params: { protocol: EXTENSION_PROTOCOL, extensionVersion: "1.0.0" } });
    expect(hello.id).toMatch(/^e\d+$/);
    expect(hello.params.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    await port().deliver({ id: hello.id, result: { protocol: EXTENSION_PROTOCOL, backend: { id: "chrome", name: "Google Chrome" } } });
    expect(status.get()).toEqual({ state: "connected", backend: { id: "chrome", name: "Google Chrome" } });
    expect(chrome.calls.filter((c) => c.api === "action.setBadgeText").at(-1)?.args).toEqual([{ text: "" }]);
  });

  test("the instance id is kept: a new connection (a restarted worker) says the same one", async () => {
    await connected();
    const first = port().sent[0]!.params.instanceId;
    const again = new HostConnection(chrome, controller, status, { hostName: "com.winter.browser.dev", clock });
    again.start();
    await port().deliver({ method: "host.status", params: { daemon: "connected" } });
    expect(port().sent[0]!.params.instanceId).toBe(first);
  });

  test("protocol mismatch → the badge and the popup say which side to update", async () => {
    conn.start();
    await port().deliver({ method: "host.status", params: { daemon: "connected" } });
    await port().deliver({ id: port().sent[0]!.id, error: { code: -32000, message: "update Winter for Chrome", data: { code: "protocol_mismatch", expected: 2 } } });
    expect(status.get()).toEqual({ state: "mismatch", message: "update Winter for Chrome" });
    expect(chrome.calls.filter((c) => c.api === "action.setBadgeText").at(-1)?.args).toEqual([{ text: "!" }]);
    expect(String((chrome.calls.filter((c) => c.api === "action.setTitle").at(-1)?.args[0] as { title: string }).title)).toContain("update Winter for Chrome");
  });

  test("a hello refused for a passing reason is said again 30 s later", async () => {
    conn.start();
    await port().deliver({ method: "host.status", params: { daemon: "connected" } });
    await port().deliver({ id: port().sent[0]!.id, error: { code: -32000, message: "this Winter cannot drive browser tabs yet", data: { code: "unavailable" } } });
    expect(status.get()).toEqual({ state: "unavailable", message: "this Winter cannot drive browser tabs yet" });
    await clock.advance(29_000);
    expect(port().sent).toHaveLength(1);
    await clock.advance(1_000);
    expect(port().sent).toHaveLength(2);
    expect(port().sent[1]).toMatchObject({ method: "hello" });
  });

  test("host.status unavailable / unverified / refused: the status says so and every debugger detaches", async () => {
    const p = await connected();
    await p.deliver({ id: "d1", method: "debugger.attach", params: { tabKey: "101" } });
    expect(chrome.attachedDebuggers.has(101)).toBe(true);
    await p.deliver({ method: "host.status", params: { daemon: "unavailable" } });
    expect(status.get()).toEqual({ state: "no-daemon" });
    expect(chrome.attachedDebuggers.size).toBe(0);
    await p.deliver({ method: "host.status", params: { daemon: "unverified" } });
    expect(status.get()).toEqual({ state: "unverified" });
    await p.deliver({ method: "host.status", params: { daemon: "refused", reason: "Computer Use is turned off in Winter's settings" } });
    expect(status.get()).toEqual({ state: "refused", message: "Computer Use is turned off in Winter's settings" });
  });
});

describe("the daemon's requests", () => {
  test("answered through the controller: results, typed errors, unknown methods", async () => {
    const p = await connected();
    await p.deliver({ id: "d1", method: "ping", params: {} });
    expect(p.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: "d1", result: {} });
    await p.deliver({ id: "d2", method: "tabs.close", params: { tabKey: "100" } });
    expect(p.sent.at(-1)).toMatchObject({ id: "d2", error: { code: -32000, message: "Winter closes only the tabs it opened", data: { code: "not_allowed" } } });
    await p.deliver({ id: "d3", method: "tabs.activate", params: { tabKey: "100" } });
    expect(p.sent.at(-1)).toMatchObject({ id: "d3", error: { code: -32601 } });
    await p.deliver({ id: "d4", method: "tabs.list", params: {} });
    expect((p.sent.at(-1)!.result as { tabs: unknown[] }).tabs).toHaveLength(2);
  });

  test("notifications flow back on the same port", async () => {
    const p = await connected();
    await p.deliver({ id: "d1", method: "debugger.attach", params: { tabKey: "101" } });
    await chrome.userCancelsInfobar(101);
    expect(p.sent.at(-1)).toEqual({ jsonrpc: "2.0", method: "debugger.detached", params: { tabKey: "101", reason: "canceled_by_user" } });
  });
});

describe("reconnecting", () => {
  test("a lost host: status, debuggers detached, reconnect after 1 s, 2 s, 4 s … at most 30 s", async () => {
    const p = await connected();
    await p.deliver({ id: "d1", method: "debugger.attach", params: { tabKey: "101" } });
    chrome.lastErrorMessage = "Native host has exited.";
    p.drop();
    await flush();
    expect(status.get()).toEqual({ state: "host-missing", detail: "Native host has exited." });
    expect(chrome.attachedDebuggers.size).toBe(0);
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const n = chrome.ports.length;
      delays.push(clock.pending()[0]!);
      await clock.advance(clock.pending()[0]!);
      expect(chrome.ports.length).toBe(n + 1);
      port().drop();
      await flush();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  test("a successful hello resets the backoff", async () => {
    conn.start();
    port().drop();
    await clock.advance(1000);
    port().drop();
    await clock.advance(2000);
    await port().deliver({ method: "host.status", params: { daemon: "connected" } });
    await port().deliver({ id: port().sent[0]!.id, result: { protocol: EXTENSION_PROTOCOL, backend: { id: "chrome", name: "Google Chrome" } } });
    port().drop();
    await flush();
    expect(clock.pending()[0]).toBe(1000);
  });

  test("a host that cannot be started at all is retried too", async () => {
    chrome.connectNativeThrows = true;
    conn.start();
    expect(status.get()).toEqual({ state: "host-missing" });
    chrome.connectNativeThrows = false;
    await clock.advance(1000);
    expect(chrome.ports).toHaveLength(1);
  });
});
