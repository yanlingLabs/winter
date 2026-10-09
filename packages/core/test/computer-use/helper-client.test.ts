// ComputerV2: the daemon's connection to the helper (`computer-use/helper-client.ts`) — launch through the
// injected launcher, hello, the pid verification, typed `HelperUnavailableError`, notifications, cancel, close.
// A FAKE helper throughout; the real SecCode check is exercised against an Apple-signed process at the end.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperClient } from "../../src/computer-use/helper-client";
import { processSatisfiesRequirement } from "../../src/computer-use/helper-verify";
import { HELPER_PROTOCOL, HelperProtocolMismatchError, HelperRpcError, HelperUnavailableError, helperAppNameFor, helperAppPathFor, helperBundleIdFor, helperProtocolMismatchMessage, helperRequirementFor, helperSocketPath } from "../../src/computer-use/protocol";
import type { HelperNotification } from "../../src/computer-use/protocol";
import { FakeHelper, FakeHelperError } from "./fake-helper";

const home = () => mkdtempSync(join(tmpdir(), "winter-cu-client-"));

function client(fake: FakeHelper, extra: Partial<ConstructorParameters<typeof HelperClient>[0]> = {}) {
  const notes: HelperNotification[] = [];
  let disconnects = 0;
  const c = new HelperClient({
    home: home(), profile: "dev", launchAllowed: true,
    transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier,
    onNotification: (n) => notes.push(n), onDisconnect: () => { disconnects++; },
    connectTimeoutMs: 500,
    ...extra,
  });
  return { c, notes, disconnects: () => disconnects };
}

describe("the helper client", () => {
  test("identities: per-profile bundle id, a stated DR with Winter's team, the socket under run/", () => {
    expect(helperBundleIdFor("dist")).toBe("com.winter.computeruse");
    expect(helperBundleIdFor("dev")).toBe("com.winter.computeruse.dev");
    expect(helperRequirementFor("dev", "TEAM")).toBe('identifier "com.winter.computeruse.dev" and anchor apple generic and certificate leaf[subject.OU] = "TEAM"');
    expect(helperSocketPath("/h")).toBe("/h/run/computer-use.sock");
  });

  test("connects, says hello with the daemon's home, and answers requests", async () => {
    const fake = new FakeHelper();
    const { c } = client(fake);
    const res = await c.request<{ apps: unknown[] }>("apps.list", {});
    expect(res.apps.length).toBeGreaterThan(0);
    expect(fake.requests[0]).toMatchObject({ method: "hello", params: { protocol: 1, client: "daemon" } });
    expect(typeof fake.requests[0]!.params.home).toBe("string");
    expect(c.connected).toBe(true);
    expect(c.version).toBe("1.0-test");
  });

  test("the helper app's path: dist inside Winter.app's Helpers, dev beside the dev daemon, an env override", () => {
    expect(helperAppPathFor("dist", {}, "/Applications/Winter.app/Contents/MacOS/winter-core")).toBe("/Applications/Winter.app/Contents/Helpers/Winter Computer Use.app");
    expect(helperAppPathFor("dev", {})).toMatch(/\/dist\/dev\/Winter Computer Use Dev\.app$/);
    expect(helperAppPathFor("dist", { WINTER_COMPUTER_USE_APP: "/tmp/X.app" })).toBe("/tmp/X.app");
    expect(helperAppNameFor("dev")).toBe("Winter Computer Use Dev.app");
  });

  test("not running: launches it BY PATH through the launcher, then connects", async () => {
    const fake = new FakeHelper();
    fake.running = false;
    const { c } = client(fake);
    await c.ensure();
    expect(fake.launched).toEqual([expect.stringMatching(/dist\/dev\/Winter Computer Use Dev\.app$/)]);
  });

  test("never launches when launching is not allowed (a test daemon's temp home)", async () => {
    const fake = new FakeHelper();
    fake.running = false;
    const { c } = client(fake, { launchAllowed: false });
    await expect(c.ensure()).rejects.toBeInstanceOf(HelperUnavailableError);
    expect(fake.launched).toEqual([]);
  });

  test("not installed / never comes up: typed HelperUnavailable", async () => {
    const fake = new FakeHelper();
    fake.running = false;
    fake.installed = false;
    await expect(client(fake).c.ensure()).rejects.toThrow("bun run dev:helper");
    await expect(client(fake, { profile: "dist" }).c.ensure()).rejects.toThrow("not installed");
    const slow = new FakeHelper();
    slow.running = false;
    slow.launcher.launch = async () => { /* launched, but it never listens */ };
    await expect(client(slow).c.ensure()).rejects.toThrow("did not start in time");
  });

  test("a helper that fails verification is dropped: helper_unavailable, not retryable", async () => {
    const fake = new FakeHelper();
    fake.verifyOk = false;
    const { c } = client(fake);
    const err = await c.ensure().catch((e) => e);
    expect(err).toBeInstanceOf(HelperUnavailableError);
    expect(err.code).toBe("helper_unavailable");
    expect(err.message).toContain("not a verified Winter Computer Use");
    expect(c.connected).toBe(false);
  });

  test("a protocol mismatch or a refused hello is helper_unavailable", async () => {
    const fake = new FakeHelper();
    fake.helloProtocol = 2;
    await expect(client(fake).c.ensure()).rejects.toThrow("protocol 2");
    const refusing = new FakeHelper();
    refusing.handlers.hello = () => { throw new FakeHelperError("home_mismatch", "wrong home"); };
    await expect(client(refusing).c.ensure()).rejects.toThrow("home_mismatch");
  });

  describe("protocol compatibility at hello (apple/ComputerUse/PROTOCOL.md)", () => {
    test("a helper that refuses our number with an OLDER one of its own: too old — update Winter, typed, never retried", async () => {
      const fake = new FakeHelper();
      fake.handlers.hello = () => { throw new FakeHelperError("protocol_mismatch", "this helper speaks protocol 0, not 1", { expected: 0, helperVersion: "0.9.0" }); };
      const { c } = client(fake);
      const err = (await c.ensure().catch((e: unknown) => e)) as HelperProtocolMismatchError;
      expect(err).toBeInstanceOf(HelperProtocolMismatchError);
      expect(err).toBeInstanceOf(HelperUnavailableError); // every existing surface still reports it
      expect(err.code).toBe("helper_unavailable");
      expect(err.reason).toBe("protocol_mismatch");
      expect(err.retryable).toBe(false);
      expect(err.message).toBe("Winter Computer Use is too old for this Winter (it speaks helper protocol 0, Winter speaks 1) — update Winter");
      expect(err.mismatch).toEqual({ helperProtocol: 0, helperVersion: "0.9.0", winterProtocol: 1, message: err.message });
      expect(c.connected).toBe(false);
    });

    test("a helper that is NEWER: too new — update Winter", async () => {
      const fake = new FakeHelper();
      fake.handlers.hello = () => { throw new FakeHelperError("protocol_mismatch", "this helper speaks protocol 2, not 1", { expected: 2, helperVersion: "2.0.0" }); };
      const err = (await client(fake).c.ensure().catch((e: unknown) => e)) as HelperProtocolMismatchError;
      expect(err.message).toBe("Winter Computer Use is too new for this Winter (it speaks helper protocol 2, Winter speaks 1) — update Winter");
    });

    test("a hello RESULT in another protocol is the same typed mismatch; one that names none says so", async () => {
      const fake = new FakeHelper();
      fake.helloProtocol = 2;
      const err = (await client(fake).c.ensure().catch((e: unknown) => e)) as HelperProtocolMismatchError;
      expect(err).toBeInstanceOf(HelperProtocolMismatchError);
      expect(err.mismatch.helperProtocol).toBe(2);
      expect(err.mismatch.helperVersion).toBe("1.0-test");
      expect(helperProtocolMismatchMessage(undefined)).toBe("Winter Computer Use speaks a different helper protocol than this Winter (1) — update Winter");
      const unreadable = new FakeHelper();
      unreadable.handlers.hello = () => { throw new FakeHelperError("protocol_mismatch", "the first request must be hello"); };
      const e2 = (await client(unreadable).c.ensure().catch((e: unknown) => e)) as HelperProtocolMismatchError;
      expect(e2.message).toBe(helperProtocolMismatchMessage(undefined));
    });

    test("status() reports a running helper it cannot use, until a handshake succeeds", async () => {
      const fake = new FakeHelper();
      fake.helloProtocol = 2;
      const { c } = client(fake);
      await c.ensure().catch(() => undefined);
      const st = await c.status();
      expect(st.running).toBe(true);
      expect(st.protocolMismatch?.message).toContain("too new for this Winter");
      expect(st.protocolMismatch?.winterProtocol).toBe(HELPER_PROTOCOL);
      fake.running = false; // the incompatible helper idle-quit: still incompatible, no longer running
      const quit = await c.status();
      expect(quit.running).toBe(false);
      expect(quit.protocolMismatch?.message).toContain("too new for this Winter");
      fake.running = true;
      fake.helloProtocol = HELPER_PROTOCOL; // Winter was updated (or the helper)
      const ok = await c.status();
      expect(ok.protocolMismatch).toBeUndefined();
      expect(ok.running).toBe(true);
    });
  });

  test("a helper error arrives as HelperRpcError with its data.code and data", async () => {
    const fake = new FakeHelper();
    fake.handlers["target.act"] = () => { throw new FakeHelperError("stale_ref", "gone", { ref: 12 }); };
    const err = (await client(fake).c.request("target.act", {}).then(() => undefined, (e: unknown) => e)) as HelperRpcError;
    expect(err).toBeInstanceOf(HelperRpcError);
    expect(err.code).toBe("stale_ref");
    expect(err.data.ref).toBe(12);
  });

  test("notifications reach the handler; permissionsChanged is cached", async () => {
    const fake = new FakeHelper();
    const { c, notes } = client(fake);
    await c.ensure();
    fake.notify("escPressed", { sessionIds: ["s1"] });
    fake.notify("permissionsChanged", { permissions: { accessibility: true, screenRecording: true } });
    await Bun.sleep(5);
    expect(notes.map((n) => n.method)).toEqual(["escPressed", "permissionsChanged"]);
    expect(c.permissions).toEqual({ accessibility: true, screenRecording: true });
  });

  test("the helper going away rejects in-flight calls (retryable) and reports the disconnect", async () => {
    const fake = new FakeHelper();
    fake.handlers["target.waitFor"] = () => new Promise(() => {});
    const { c, disconnects } = client(fake);
    const p = c.request("target.waitFor", {});
    await Bun.sleep(5);
    fake.quit();
    const err = (await p.then(() => undefined, (e: unknown) => e)) as HelperUnavailableError;
    expect(err).toBeInstanceOf(HelperUnavailableError);
    expect(err.retryable).toBe(true);
    expect(disconnects()).toBe(1);
    expect(c.connected).toBe(false);
  });

  test("an aborted request tells the helper to cancel that call id and answers cancelled", async () => {
    const fake = new FakeHelper();
    let release!: () => void;
    fake.handlers["target.waitIdle"] = () => new Promise((resolve) => { release = () => resolve({ settled: false, waitedMs: 1 }); });
    fake.handlers.cancel = () => { queueMicrotask(() => release?.()); return {}; };
    const { c } = client(fake);
    const ac = new AbortController();
    const p = c.request("target.waitIdle", {}, { signal: ac.signal, callId: "cv2_1" });
    await Bun.sleep(5);
    ac.abort();
    await p.catch(() => {});
    expect(fake.calls("cancel")).toEqual([{ callId: "cv2_1" }]);
  });

  test("tell() never launches the helper; status() never launches it either", async () => {
    const fake = new FakeHelper();
    fake.running = false;
    const { c } = client(fake);
    c.tell("turn.ended", { sessionId: "s1" });
    const st = await c.status();
    expect(st).toEqual({ installed: true, running: false });
    expect(fake.launched).toEqual([]);
    fake.running = true;
    const st2 = await c.status();
    expect(st2).toEqual({ installed: true, running: true, version: "1.0-test", permissions: { accessibility: true, screenRecording: false } });
  });
});

describe("the SecCode check (bun:ffi)", () => {
  test("a running Apple-signed process satisfies `anchor apple` and not the helper's requirement", async () => {
    if (process.platform !== "darwin") return;
    const child = spawn("/bin/sleep", ["5"]);
    try {
      await Bun.sleep(100);
      expect(processSatisfiesRequirement(child.pid!, "anchor apple")).toBe(true);
      expect(processSatisfiesRequirement(child.pid!, helperRequirementFor("dist"))).toBe(false);
      expect(processSatisfiesRequirement(999_999, "anchor apple")).toBe(false);
      expect(processSatisfiesRequirement(-1, "anchor apple")).toBe(false);
    } finally { child.kill(); }
  });
});
