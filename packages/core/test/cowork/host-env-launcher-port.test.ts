import { afterEach, describe, expect, test } from "bun:test";
import { createCoworkLauncherPort, type CoworkLauncherPortOptions, type SpawnedLauncher } from "../../src/cowork/host-env/launcher-port";
import { FdLineChannel, closeDescriptor, fdChannelSupported, sendMessage, socketPair } from "../../src/cowork/native/fd-channel";
import { COWORK_NATIVE_LIMITS, serializeCoworkNativeLauncherLine, type CoworkNativeToDaemon } from "../../src/cowork/native/protocol";
import type { ProcessInspection } from "../../src/cowork/native/admission-probes";

// The launcher port over an in-process socketpair: no child process, nothing named launcher is ever executed.
const supported = fdChannelSupported();
const cleanups: (() => void)[] = [];
// Closing a descriptor makes the shared receiver hub post a late `end` for it. Wait for those to land INSIDE the test that caused them: the descriptor-count test of
// fd-channel.test.ts counts the whole process, and a late close landing in a later file reads as a leak (or a vanished descriptor) there.
afterEach(async () => { cleanups.splice(0).reverse().forEach(run => { try { run(); } catch { /* closed */ } }); await new Promise<void>(resolve => setTimeout(resolve, 100)); });

const HELLO: CoworkNativeToDaemon = { t: "hello", launcherInstanceId: "launcher-synthetic1", hostBootId: "boot-synthetic", parentVerified: true };
const line = (message: CoworkNativeToDaemon): Uint8Array => Buffer.from(serializeCoworkNativeLauncherLine(message, "to-daemon"), "utf8");
// A descriptor number is reused as soon as it is closed, so a double close would close somebody else's socket: every close in this file goes through here.
const closedFds = new Set<number>();
const closeOnce = (fd: number): void => { if (closedFds.has(fd)) return; closedFds.add(fd); closeDescriptor(fd); };
const settle = (ms = 10) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface Rig { port: ReturnType<typeof createCoworkLauncherPort>; peer: FdLineChannel; peerFd: number; calls: { argv: string[][]; killed: number; verified: [number, string][]; closed: number[]; opened: number[]; executables: string[] }; options: Partial<CoworkLauncherPortOptions>; exit: () => void }
function rig(over: Partial<CoworkLauncherPortOptions> & { present?: ProcessInspection; verify?: boolean } = {}): Rig {
  const [daemonEnd, peerFd] = socketPair("stream");
  const peer = new FdLineChannel(peerFd, { maxLine: COWORK_NATIVE_LIMITS.muxLineBytes, maxRights: 0 });
  let exit!: () => void; const exited = new Promise<void>(resolve => { exit = resolve; });
  const calls = { argv: [] as string[][], killed: 0, verified: [] as [number, string][], closed: [] as number[], opened: [] as number[], executables: [] as string[] };
  const spawn = (argv: string[]): SpawnedLauncher => { calls.argv.push(argv); return { channel: daemonEnd, pid: 4242, kill: () => { calls.killed += 1; }, exited }; };
  const options: CoworkLauncherPortOptions = {
    launcherPath: "/opt/winter/Helpers/WinterCowork/winter-cowork-launcher", workerPath: "/opt/winter/Helpers/WinterCowork/winter-cowork-worker", receiptDirectory: "/var/synthetic/coordination/cowork-receipts/home_x",
    requirement: 'identifier "com.winter.cowork.launcher" and anchor apple generic and certificate leaf[subject.OU] = "TEAMSYNTH1"',
    processes: { inspect: () => over.present ?? { kind: "present", startSeconds: 77, startMicroseconds: 5, zombie: false } },
    spawn,
    openChannel: fd => { calls.opened.push(fd); return new FdLineChannel(fd, { maxLine: COWORK_NATIVE_LIMITS.muxLineBytes, maxRights: 0 }); },
    closeChannelDescriptor: fd => { calls.closed.push(fd); closedFds.delete(fd); closeOnce(fd); },
    verifyProcess: (pid, requirement) => { calls.verified.push([pid, requirement]); return over.verify ?? true; },
    checkExecutable: path => { calls.executables.push(path); return true; },
    helloTimeoutMs: 200, ...over,
  };
  closedFds.delete(peerFd); closedFds.delete(daemonEnd);
  cleanups.push(() => { closeOnce(peerFd); closeOnce(daemonEnd); });
  return { port: createCoworkLauncherPort(options), peer, peerFd, calls, options, exit };
}
const request = { workspaceId: "workspace_a", incarnationId: "inc-1", leaseEpoch: 1 };

describe.skipIf(!supported)("spawn: identity first, then hello", () => {
  test("argv is exactly the launcher and its two arguments, the live process is verified against the launcher's requirement, and the session carries hello's facts and the process table's start token", async () => {
    const r = rig();
    sendMessage(r.peerFd, line(HELLO));
    const session = await r.port.spawn(request);
    expect(r.calls.argv).toEqual([["/opt/winter/Helpers/WinterCowork/winter-cowork-launcher", "--worker-path", "/opt/winter/Helpers/WinterCowork/winter-cowork-worker", "--receipt-dir", "/var/synthetic/coordination/cowork-receipts/home_x"]]);
    expect(r.calls.verified).toEqual([[4242, r.options.requirement!]]);
    expect(session).toMatchObject({ launcherInstanceId: "launcher-synthetic1", hostBootId: "boot-synthetic", pid: 4242, startToken: "77.000005" });
    expect(session.isLive()).toBe(true);
    expect(r.calls.killed).toBe(0);
  });
  test("a process that does not satisfy the requirement is killed (its own handle only) before a single byte is read, and the descriptor is closed", async () => {
    const r = rig({ verify: false });
    sendMessage(r.peerFd, line(HELLO));
    await expect(r.port.spawn(request)).rejects.toMatchObject({ code: "launcher_identity" });
    expect(r.calls.killed).toBe(1); expect(r.calls.opened).toEqual([]); expect(r.calls.closed).toHaveLength(1);
  });
  test("a verifier that returns a truthy non-boolean is a refusal: only exactly true passes", async () => {
    for (const answer of [1, "true", {}, [] ] as unknown[]) {
      const r = rig({ verify: answer as never });
      sendMessage(r.peerFd, line(HELLO));
      await expect(r.port.spawn(request)).rejects.toMatchObject({ code: "launcher_identity" });
      expect(r.calls.killed).toBe(1); expect(r.calls.opened).toEqual([]);
    }
  });
  test("a verifier that throws is a refusal, not a pass", async () => {
    const r = rig({ verifyProcess: () => { throw new Error("sec failure"); } });
    await expect(r.port.spawn(request)).rejects.toMatchObject({ code: "launcher_identity" });
    expect(r.calls.killed).toBe(1);
  });
  test("a launcher the process table cannot see (already gone, or unknowable) is refused and killed", async () => {
    for (const present of [{ kind: "absent" } as const, { kind: "unknown" } as const]) {
      const r = rig({ present });
      await expect(r.port.spawn(request)).rejects.toMatchObject({ code: "launcher_gone" });
      expect(r.calls.killed).toBe(1);
      cleanups.splice(0).forEach(run => run());
    }
  });
  test("the executables must exist before anything is spawned", async () => {
    const r = rig({ checkExecutable: () => false });
    await expect(r.port.spawn(request)).rejects.toMatchObject({ code: "launcher_missing" });
    expect(r.calls.argv).toEqual([]);
  });
  test("relative or NUL-bearing paths are refused when the port is built", () => {
    for (const bad of ["relative/launcher", "/ok\0bad", ""]) expect(() => createCoworkLauncherPort({ ...rig().options as CoworkLauncherPortOptions, launcherPath: bad })).toThrow();
  });
  test("hello must be the first line, valid, and say parentVerified; anything else is refused and the launcher is killed", async () => {
    for (const first of [Buffer.from("{\"v\":2,\"t\":\"pong\",\"id\":\"x\"}\n"), Buffer.from("not json\n"), Buffer.from("{\"v\":2,\"t\":\"hello\",\"launcherInstanceId\":\"l\",\"hostBootId\":\"b\",\"parentVerified\":false}\n"), line({ t: "pong", id: "req-1" })]) {
      const r = rig();
      sendMessage(r.peerFd, first);
      await expect(r.port.spawn(request)).rejects.toMatchObject({ code: "launcher_hello_invalid" });
      expect(r.calls.killed).toBe(1);
      cleanups.splice(0).forEach(run => run());
    }
  });
  test("a silent launcher times out, and one that closes without a word is refused", async () => {
    const silent = rig();
    await expect(silent.port.spawn(request)).rejects.toMatchObject({ code: "launcher_hello_failed" });
    expect(silent.calls.killed).toBe(1);
    cleanups.splice(0).forEach(run => run());
    const closed = rig();
    void closed.peer.close(); closeOnce(closed.peerFd);
    await expect(closed.port.spawn(request)).rejects.toMatchObject({ code: "launcher_hello_eof" });
    expect(closed.calls.killed).toBe(1);
  });
  test("a descriptor sent with the hello ends the channel: it is never installed, and the spawn is refused", async () => {
    const r = rig();
    const [extra, extraPeer] = socketPair("stream");
    closedFds.delete(extra); closedFds.delete(extraPeer); cleanups.push(() => { closeOnce(extra); closeOnce(extraPeer); });
    sendMessage(r.peerFd, line(HELLO), [extra]);
    await expect(r.port.spawn(request)).rejects.toBeDefined();
    expect(r.calls.killed).toBe(1);
  });
});

describe.skipIf(!supported)("the session", () => {
  async function opened() {
    const r = rig();
    sendMessage(r.peerFd, line(HELLO));
    const session = await r.port.spawn(request);
    return { r, session };
  }
  test("messages buffered before the first subscriber are delivered to it, in order; later ones live", async () => {
    const { r, session } = await opened();
    sendMessage(r.peerFd, line({ t: "pong", id: "req-1" })); sendMessage(r.peerFd, line({ t: "pong", id: "req-2" }));
    await settle();
    const seen: string[] = [];
    session.onMessage(message => { if (message.t === "pong") seen.push(message.id); });
    expect(seen).toEqual(["req-1", "req-2"]);
    sendMessage(r.peerFd, line({ t: "pong", id: "req-3" }));
    await settle();
    expect(seen).toEqual(["req-1", "req-2", "req-3"]);
  });
  test("sends are canonical L1 lines with the descriptors attached to the one line that carries them", async () => {
    const { r, session } = await opened();
    session.send({ t: "ping", id: "req-9" });
    const lines = r.peer.lines();
    const first = await lines.next();
    expect(first.value).toBe(serializeCoworkNativeLauncherLine({ t: "ping", id: "req-9" }, "to-launcher"));
  });
  test("a second hello, an unparseable line or a descriptor ends the session; onClose fires once", async () => {
    for (const trouble of ["hello", "garbage", "rights"] as const) {
      const { r, session } = await opened();
      let closes = 0;
      session.onClose(() => { closes += 1; });
      if (trouble === "hello") sendMessage(r.peerFd, line(HELLO));
      else if (trouble === "garbage") sendMessage(r.peerFd, Buffer.from("{\"v\":2,\"t\":\"nonsense\"}\n"));
      else { const [extra, extraPeer] = socketPair("stream"); closedFds.delete(extra); closedFds.delete(extraPeer); cleanups.push(() => { closeOnce(extra); closeOnce(extraPeer); }); sendMessage(r.peerFd, line({ t: "pong", id: "req-1" }), [extra]); }
      await settle(30);
      expect(`${trouble}:${closes}:${session.isLive()}`).toBe(`${trouble}:1:false`);
      expect(() => session.send({ t: "ping", id: "req-1" })).toThrow();
      cleanups.splice(0).reverse().forEach(run => { try { run(); } catch { /* closed */ } });
    }
  });
  test("EOF from the launcher ends the session, and so does its exit; close() closes the daemon's end and kills nothing", async () => {
    const eof = await opened();
    let closed = false; eof.session.onClose(() => { closed = true; });
    void eof.r.peer.close(); closeOnce(eof.r.peerFd); // the peer channel holds its own duplicate; both must go for the socket to end
    await settle(30);
    expect(closed).toBe(true);
    const exits = await opened();
    exits.r.exit();
    await settle(30);
    expect(exits.session.isLive()).toBe(false);
    const closing = await opened();
    closing.session.close();
    await settle(30);
    expect(closing.session.isLive()).toBe(false); expect(closing.r.calls.killed).toBe(0); expect(closing.r.calls.closed.length).toBeGreaterThanOrEqual(1);
    closing.session.close(); // idempotent
  });
  test("a handler that throws does not end the session or starve the others", async () => {
    const { r, session } = await opened();
    const seen: string[] = [];
    session.onMessage(() => { throw new Error("consumer fault"); });
    session.onMessage(message => { if (message.t === "pong") seen.push(message.id); });
    sendMessage(r.peerFd, line({ t: "pong", id: "req-1" }));
    await settle();
    expect(seen).toEqual(["req-1"]); expect(session.isLive()).toBe(true);
  });
});
