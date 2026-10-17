import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDescriptor, duplicateDescriptor, FdChannelError, FdLineChannel, FdLineSplitter, FdReceiver, fdChannelSupported, hasCloseOnExec, receiveMessage, sendMessage, setCloseOnExec, setNonBlocking, shutdownDescriptor, socketPair, spawnWithChannel, waitReadable,
  FD_CHANNEL_MAX_RIGHTS,
} from "../../../src/cowork/native/fd-channel";

// bun:ffi against libSystem is bound for macOS on Apple silicon only (CI runs there). Elsewhere these tests have nothing to bind to.
const supported = fdChannelSupported();
const live = supported ? test : test.skip;

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(run => { try { run(); } catch { /* already closed */ } }); });
const open = (fd: number) => { try { fstatSync(fd); return true; } catch { return false; } };
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (value: string) => new TextEncoder().encode(value);
function files(count: number): { fds: number[]; names: string[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "winter-fd-channel-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const names = Array.from({ length: count }, (_, index) => join(dir, `file-${index}`)), fds: number[] = [];
  names.forEach((name, index) => { writeFileSync(name, "x".repeat(10 + index)); const fd = openSync(name, "r+"); fds.push(fd); cleanup.push(() => closeSync(fd)); });
  return { fds, names, dir };
}
function pair(kind: "stream" | "dgram"): [number, number] {
  const [a, b] = socketPair(kind); cleanup.push(() => closeDescriptor(a)); cleanup.push(() => closeDescriptor(b)); return [a, b];
}
/** The error a promise rejects with. Not `expect(promise).rejects`: Bun spins its loop synchronously there and a rejection that depends
 * on a worker thread's message may never be delivered (the test then times out and the process never exits). */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error("expected a rejection");
}
function refusal(body: () => unknown): FdChannelError {
  try { body(); } catch (error) { expect(error).toBeInstanceOf(FdChannelError); return error as FdChannelError; }
  throw new Error("expected an FdChannelError");
}

describe("bun:ffi sendmsg/recvmsg with SCM_RIGHTS", () => {
  live("two descriptors ride one line over a stream socket and arrive as the same open files, CLOEXEC set, originals untouched", () => {
    const { fds } = files(2), [a, b] = pair("stream");
    sendMessage(a, encode('{"line":1}\n'), fds);
    const got = receiveMessage(b, 256, 2)!;
    expect(text(got.data)).toBe('{"line":1}\n'); expect(got.rights).toHaveLength(2);
    got.rights.forEach(fd => cleanup.push(() => closeDescriptor(fd)));
    got.rights.forEach((fd, index) => { const sent = fstatSync(fds[index]!), received = fstatSync(fd); expect([received.dev, received.ino, received.size]).toEqual([sent.dev, sent.ino, sent.size]); expect(hasCloseOnExec(fd)).toBe(true); expect(fd).not.toBe(fds[index]); });
    expect(fds.every(open)).toBe(true);
  });
  live("a datagram is one atomic message with its descriptors", () => {
    const { fds } = files(2), [a, b] = pair("dgram");
    sendMessage(a, new Uint8Array(72).fill(7), fds);
    const got = receiveMessage(b, 128, 2)!; got.rights.forEach(fd => cleanup.push(() => closeDescriptor(fd)));
    expect([got.data.length, got.rights.length]).toEqual([72, 2]);
  });
  live("descriptors belong to the first byte of their own message, never to the data before or after it", () => {
    const { fds } = files(2), [a, b] = pair("stream");
    sendMessage(a, encode("first\n"));
    sendMessage(a, encode("second\n"), fds);
    sendMessage(a, encode("third\n"));
    const seen: { data: string; rights: number }[] = [];
    for (let attempt = 0; attempt < 20 && seen.map(item => item.data).join("").length < "first\nsecond\nthird\n".length; attempt++) {
      const got = receiveMessage(b, 256, 2); if (!got) { waitReadable(b, 50); continue; }
      got.rights.forEach(fd => cleanup.push(() => closeDescriptor(fd))); seen.push({ data: text(got.data), rights: got.rights.length });
    }
    // The kernel never hands a rights message together with bytes that were sent before it.
    const withRights = seen.filter(item => item.rights > 0);
    expect(withRights).toHaveLength(1);
    expect(withRights[0]!.rights).toBe(2);
    expect(withRights[0]!.data.startsWith("second\n") || withRights[0]!.data.startsWith("s")).toBe(true);
    expect(seen.map(item => item.data).join("")).toBe("first\nsecond\nthird\n");
  });
  live("a rights-free path refuses any descriptor and closes every one it was given", () => {
    const { fds } = files(2), [a, b] = pair("stream");
    sendMessage(a, encode("sneaky\n"), fds);
    const before = new Set<number>(); for (let fd = 3; fd < 200; fd++) if (open(fd)) before.add(fd);
    expect(refusal(() => receiveMessage(b, 64, 0)).code).toBe("unexpected_rights");
    // Whatever was installed by the kernel was closed again: no new descriptor is left behind.
    for (let fd = 3; fd < 200; fd++) if (open(fd) && !before.has(fd)) throw new Error(`leaked descriptor ${fd}`);
  });
  live("more descriptors than the cap is unexpected_rights and none leak", () => {
    const { fds } = files(3), [a, b] = pair("stream");
    sendMessage(a, encode("three\n"), fds);
    const before = new Set<number>(); for (let fd = 3; fd < 200; fd++) if (open(fd)) before.add(fd);
    expect(refusal(() => receiveMessage(b, 64, 2)).code).toBe("unexpected_rights");
    for (let fd = 3; fd < 200; fd++) if (open(fd) && !before.has(fd)) throw new Error(`leaked descriptor ${fd}`);
  });
  live("a truncated control buffer is FATAL and closes everything that was visible", () => {
    const { fds } = files(3), [a, b] = pair("stream");
    sendMessage(a, encode("three\n"), fds);
    const before = new Set<number>(); for (let fd = 3; fd < 200; fd++) if (open(fd)) before.add(fd);
    const error = refusal(() => receiveMessage(b, 64, 3, 1));
    expect([error.code, error.fatal]).toEqual(["rights_truncated", true]);
    // macOS may have installed descriptors nobody can see (that is exactly why this is fatal): sweep them so later tests start clean.
    for (let fd = 3; fd < 200; fd++) if (open(fd) && !before.has(fd)) closeDescriptor(fd);
  });
  live("a datagram larger than the receive buffer is data_truncated and its descriptors are closed", () => {
    const { fds } = files(1), [a, b] = pair("dgram");
    sendMessage(a, new Uint8Array(100).fill(1), fds);
    const before = new Set<number>(); for (let fd = 3; fd < 200; fd++) if (open(fd)) before.add(fd);
    expect(refusal(() => receiveMessage(b, 50, 2)).code).toBe("data_truncated");
    for (let fd = 3; fd < 200; fd++) if (open(fd) && !before.has(fd)) throw new Error(`leaked descriptor ${fd}`);
  });
  live("an idle socket is null, a closed peer is empty data, and a write to a closed peer is an error never a signal", () => {
    const [a, b] = pair("stream");
    expect(receiveMessage(b, 64, 0)).toBeNull();
    expect(waitReadable(b, 10)).toBe(false);
    closeDescriptor(a);
    expect(waitReadable(b, 1000)).toBe(true);
    expect(receiveMessage(b, 64, 0)!.data).toHaveLength(0);
    expect(refusal(() => sendMessage(b, encode("into the void\n"))).code).toBe("closed");
  });
  live("argument bounds: no rights without data, no more than the cap, no negative descriptor", () => {
    const [a] = pair("stream"), { fds } = files(1);
    expect(refusal(() => sendMessage(a, new Uint8Array(0), fds)).code).toBe("invalid");
    expect(refusal(() => sendMessage(a, encode("x"), Array(FD_CHANNEL_MAX_RIGHTS + 1).fill(fds[0]!))).code).toBe("invalid");
    expect(refusal(() => sendMessage(a, encode("x"), [-1])).code).toBe("invalid");
    expect(refusal(() => receiveMessage(a, 0, 0)).code).toBe("invalid");
    expect(refusal(() => receiveMessage(a, 64, FD_CHANNEL_MAX_RIGHTS + 1)).code).toBe("invalid");
  });
  live("sending a bad descriptor number fails and leaves the channel usable", () => {
    const [a, b] = pair("stream");
    expect(refusal(() => sendMessage(a, encode("x\n"), [9999])).code).toBe("syscall");
    sendMessage(a, encode("still fine\n")); expect(text(receiveMessage(b, 64, 0)!.data)).toBe("still fine\n");
  });
  live("fcntl flags round trip through the variadic binding", () => {
    const [a] = pair("stream");
    setCloseOnExec(a, false); expect(hasCloseOnExec(a)).toBe(false); setCloseOnExec(a, true); expect(hasCloseOnExec(a)).toBe(true);
    setNonBlocking(a, false); setNonBlocking(a, true);
  });
});

describe("Bun.spawn passes a descriptor above 2 and nothing else", () => {
  live("the child sees the socket as fd 3, writes to it, and the daemon end reads it event-driven", async () => {
    const child = spawnWithChannel(["/bin/sh", "-c", "echo hello-from-child >&3"]);
    cleanup.push(() => closeDescriptor(child.channel));
    const channel = new FdLineChannel(child.channel, { maxLine: 1024 }); cleanup.push(() => { void channel.close(); });
    const lines: string[] = []; for await (const line of channel) lines.push(line);
    expect(lines).toEqual(["hello-from-child\n"]);
    await child.subprocess.exited;
  });
  live("the child inherits no other descriptor from the daemon, and the launcher dying produces EOF", async () => {
    const [extra] = pair("stream"), probe = [4, 5, 6, 7, 8, 9, extra].map(n => `[ -e /dev/fd/${n} ] && echo open-${n}`).join("; ");
    const child = spawnWithChannel(["/bin/sh", "-c", `echo ready >&3; ${probe} >&3; exit 0`]);
    cleanup.push(() => closeDescriptor(child.channel));
    const channel = new FdLineChannel(child.channel, { maxLine: 1024 }); cleanup.push(() => { void channel.close(); });
    const lines: string[] = []; for await (const line of channel) lines.push(line);
    expect(lines).toEqual(["ready\n"]); // EOF arrived because the parent closed its copy of the child's end
    expect((await child.subprocess.exited)).toBe(0);
  });
  live("a child killed outright still yields EOF on the daemon end", async () => {
    const child = spawnWithChannel(["/bin/sh", "-c", "echo up >&3; exec sleep 30"]);
    cleanup.push(() => closeDescriptor(child.channel));
    const channel = new FdLineChannel(child.channel, { maxLine: 1024 }); cleanup.push(() => { void channel.close(); });
    const iterator = channel.lines();
    expect((await iterator.next()).value).toBe("up\n");
    child.subprocess.kill(9);
    expect((await iterator.next()).done).toBe(true);
  });
  live("descriptors reach the child only if the caller lists them", async () => {
    const { fds, names } = files(1), [daemonEnd, childEnd] = pair("stream");
    const child = Bun.spawn(["/bin/sh", "-c", `for n in ${fds[0]}; do [ -e /dev/fd/$n ] && echo leaked >&3; done; echo done >&3`], { stdio: ["ignore", "ignore", "ignore", childEnd] });
    closeDescriptor(childEnd);
    const channel = new FdLineChannel(daemonEnd, { maxLine: 64 }); cleanup.push(() => { void channel.close(); });
    const lines: string[] = []; for await (const line of channel) lines.push(line);
    expect(lines).toEqual(["done\n"]); expect(names).toHaveLength(1);
    await child.exited;
  });
});

describe("FdLineChannel and FdReceiver", () => {
  live("reassembles lines split across writes and keeps order, then ends at EOF", async () => {
    const [a, b] = pair("stream"), channel = new FdLineChannel(b, { maxLine: 64 }); cleanup.push(() => { void channel.close(); });
    const iterator = channel.lines();
    sendMessage(a, encode("alp")); await Bun.sleep(5); sendMessage(a, encode("ha\nbe")); await Bun.sleep(5); sendMessage(a, encode("ta\ngamma\n"));
    expect([(await iterator.next()).value, (await iterator.next()).value, (await iterator.next()).value]).toEqual(["alpha\n", "beta\n", "gamma\n"]);
    closeDescriptor(a);
    expect((await iterator.next()).done).toBe(true);
  });
  live("a line over its bound ends the channel with oversize, with or without a newline in sight", async () => {
    const [a, b] = pair("stream"), channel = new FdLineChannel(b, { maxLine: 16 }); cleanup.push(() => { void channel.close(); });
    sendMessage(a, encode("x".repeat(40)));
    expect(await failure(channel.lines().next())).toMatchObject({ code: "oversize" });
    const [c, d] = pair("stream"), second = new FdLineChannel(d, { maxLine: 16 }); cleanup.push(() => { void second.close(); });
    sendMessage(c, encode(`${"y".repeat(20)}\n`));
    expect(await failure(second.lines().next())).toMatchObject({ code: "oversize" });
  });
  live("a peer that closes in the middle of a line is a truncation, not a clean end", async () => {
    const [a, b] = pair("stream"), channel = new FdLineChannel(b, { maxLine: 64 }); cleanup.push(() => { void channel.close(); });
    sendMessage(a, encode("half a li")); closeDescriptor(a);
    expect(await failure(channel.lines().next())).toMatchObject({ code: "closed" });
  });
  live("close ends iteration, closes only the receiver's own duplicates and is idempotent", async () => {
    const [a, b] = pair("stream"), channel = new FdLineChannel(b, { maxLine: 64 }), iterator = channel.lines();
    sendMessage(a, encode("one\n")); expect((await iterator.next()).value).toBe("one\n");
    await Promise.all([channel.close(), channel.close()]);
    expect(open(b)).toBe(true); expect(open(a)).toBe(true);
    const stranger = duplicateDescriptor(a); cleanup.push(() => closeDescriptor(stranger));
    await channel.close(); expect(open(stranger)).toBe(true);
  });
  live("a descriptor sent to a channel that takes none is CLOSED, never left installed, and the channel ends unexpected_rights", async () => {
    const { fds } = files(1), [a, b] = pair("stream"), channel = new FdLineChannel(b, { maxLine: 64 }), iterator = channel.lines();
    // A round trip proves the worker thread is up, so everything it (and Bun) allocates exists before the snapshot is taken.
    sendMessage(a, encode("hello\n")); expect((await iterator.next()).value).toBe("hello\n");
    const before = new Set<number>(); for (let fd = 3; fd < 300; fd++) if (open(fd)) before.add(fd);
    sendMessage(a, encode("with-rights\n"), fds);
    expect(await failure(iterator.next())).toMatchObject({ code: "unexpected_rights" });
    await channel.close();
    for (let fd = 3; fd < 300; fd++) if (open(fd) && !before.has(fd)) throw new Error(`leaked descriptor ${fd}`);
  });
  live("a receiver that is closed releases every private descriptor it made (Bun itself keeps one per Worker, which is not ours)", async () => {
    const [a, b] = pair("stream"), receiver = new FdReceiver(b, { maxBytes: 64, maxRights: 0 }, () => {});
    await Bun.sleep(30);
    expect(receiver.descriptors.every(open)).toBe(true);
    await receiver.close();
    expect(receiver.descriptors.some(open)).toBe(false);
    expect(open(a) && open(b)).toBe(true);
  });
  test("the splitter alone: pure, bounded, exact", () => {
    const splitter = new FdLineSplitter(8);
    expect(splitter.push(encode("ab\ncd"))).toEqual(["ab\n"]); expect(splitter.partial).toBe(2);
    expect(splitter.push(encode("e\n\n"))).toEqual(["cde\n", "\n"]);
    expect(() => new FdLineSplitter(4).push(encode("abcdef\n"))).toThrow("oversize");
    expect(() => new FdLineSplitter(8).push(Uint8Array.from([0xff, 0x0a]))).toThrow();
    // a byte order mark is part of the line, never skipped: the protocol parser then refuses the line
    expect(new FdLineSplitter(16).push(Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x0a]))).toEqual(["\ufeff{\n"]);
  });
});

// --------------------------------------------------------------------------------------------------------------------
// Against an independent C implementation of the same syscalls. Needs clang, so it is gated: CI skips it cleanly, and the
// local results are recorded in the pull request. The peer starts no VM and touches no Hypervisor.framework call.
const peerTests = supported && process.env.WINTER_COWORK_NATIVE_FFI === "1" ? describe : describe.skip;
peerTests("against the compiled C echo peer (WINTER_COWORK_NATIVE_FFI=1)", () => {
  let binary = "", directory = "";
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "winter-fd-peer-")); binary = join(directory, "fd-echo-peer");
    const result = Bun.spawnSync(["clang", "-Wall", "-Werror", "-o", binary, join(import.meta.dir, "fd-echo-peer.c")]);
    if (result.exitCode !== 0) throw new Error(`clang failed: ${result.stderr.toString()}`);
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  const build = (): string => binary;
  interface Echo { bytes: number; items: number; ctrunc: number; trunc: number; rights: { dev: number; ino: number; mode: number; size: number; cloexec: number; acc: number }[] }
  async function start(kind: "stream" | "dgram", slots: number) {
    const [daemonEnd, childEnd] = socketPair(kind);
    const proc = Bun.spawn([build(), String(slots)], { stdio: ["ignore", "ignore", "pipe", childEnd] });
    closeDescriptor(childEnd);
    cleanup.push(() => { closeDescriptor(daemonEnd); proc.kill(9); });
    const read = async (): Promise<string> => {
      for (let attempt = 0; attempt < 200; attempt++) { if (waitReadable(daemonEnd, 50)) { const got = receiveMessage(daemonEnd, 8192, 2); if (got && got.data.length) { got.rights.forEach(fd => cleanup.push(() => closeDescriptor(fd))); (read as unknown as { last: number[] }).last = got.rights; return text(got.data); } } await Bun.sleep(1); }
      throw new Error("peer silent");
    };
    return { daemonEnd, proc, read: async () => { const out = await read(); return { text: out, rights: (read as unknown as { last: number[] }).last }; } };
  }
  test("the peer reports the same two files the daemon sent, sizes and inodes included", async () => {
    const { fds } = files(2), peer = await start("stream", 16);
    sendMessage(peer.daemonEnd, encode("two files\n"), fds);
    const echo = JSON.parse((await peer.read()).text) as Echo;
    expect([echo.bytes, echo.items, echo.ctrunc, echo.trunc]).toEqual([10, 1, 0, 0]);
    expect(echo.rights.map(item => [item.dev, item.ino, item.size])).toEqual(fds.map(fd => { const st = fstatSync(fd); return [st.dev, st.ino, st.size]; }));
    expect(echo.rights.every(item => item.acc === 2)).toBe(true); // O_RDWR survives the transfer
    sendMessage(peer.daemonEnd, encode("quit"));
  });
  test("a datagram with descriptors works the same way", async () => {
    const { fds } = files(2), peer = await start("dgram", 16);
    sendMessage(peer.daemonEnd, encode("dgram"), fds);
    const echo = JSON.parse((await peer.read()).text) as Echo;
    expect([echo.items, echo.rights.length, echo.ctrunc]).toEqual([1, 2, 0]);
    sendMessage(peer.daemonEnd, encode("quit"));
  });
  test("the peer sees ancillary truncation when its control buffer is too small, which is why the worker must exit on it", async () => {
    const { fds } = files(3), peer = await start("stream", 1);
    sendMessage(peer.daemonEnd, encode("three files\n"), fds);
    const echo = JSON.parse((await peer.read()).text) as Echo;
    expect(echo.ctrunc).toBe(1);
    expect(echo.rights.length).toBeLessThan(3);
    sendMessage(peer.daemonEnd, encode("quit"));
  });
  test("recvmsg in TypeScript receives a descriptor the C peer sends back, as the same open file", async () => {
    const { fds } = files(1), peer = await start("stream", 16);
    sendMessage(peer.daemonEnd, encode("echo-fd please\n"), fds);
    const echo = JSON.parse((await peer.read()).text) as Echo; expect(echo.rights).toHaveLength(1);
    let back: { data: Uint8Array; rights: number[] } | null = null;
    for (let attempt = 0; attempt < 200 && !back; attempt++) { waitReadable(peer.daemonEnd, 50); back = receiveMessage(peer.daemonEnd, 64, 1); if (back && back.data.length === 0) back = null; }
    expect(back).not.toBeNull(); back!.rights.forEach(fd => cleanup.push(() => closeDescriptor(fd)));
    expect(text(back!.data)).toBe("F"); expect(back!.rights).toHaveLength(1);
    const sent = fstatSync(fds[0]!), received = fstatSync(back!.rights[0]!);
    expect([received.dev, received.ino]).toEqual([sent.dev, sent.ino]);
    sendMessage(peer.daemonEnd, encode("quit"));
  });
  test("the peer dying yields EOF on the daemon end, because the parent closed the child's copy", async () => {
    const peer = await start("stream", 16);
    sendMessage(peer.daemonEnd, encode("quit"));
    await peer.proc.exited;
    expect(waitReadable(peer.daemonEnd, 1000)).toBe(true);
    expect(receiveMessage(peer.daemonEnd, 64, 0)!.data).toHaveLength(0);
  });
});
